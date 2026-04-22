// A4 replay_stage — synchronously re-execute a specific stage attempt
// with the same inputs and prompt context, producing a NEW attempt
// tagged kind='replay' so queries can distinguish it from canonical
// pipeline execution.
//
// Use case: debugging flaky agent stages. An AI agent (or a human via
// the CLI) identifies a past attempt_id that failed or produced
// surprising output and calls replay_stage to reproduce it under
// current conditions (same inputs, possibly different model/prompt
// revisions if the caller tweaked them).
//
// Invariants:
//   1. Replays are OPT-IN. Nothing calls replay-stage automatically.
//   2. Replays do NOT touch the original attempt (no UPDATE on its
//      row, no mutation of its port_values).
//   3. Replay attempts use their own PortRuntime with an INERT
//      dispatcher — PORT_WRITTEN events are not delivered to any
//      XState machine, so the parent task's lifecycle is unaffected.
//   4. Replay attempts get kind='replay' and replayed_from_attempt_id
//      pointing at the source. attempt_idx still increments from the
//      stage's max, so lineage queries see them in order.
//   5. The executor is injected (constructor dependency) so tests
//      never call a real Claude SDK. Production uses RealStageExecutor;
//      tests pass a MockStageExecutor with canned handlers.
//
// Out of scope here:
//   - Cross-pipeline replay (replay on a different pipeline version):
//     callers must fetch the correct IR; we use the IR matching the
//     source attempt's version_hash by default.
//   - Time-travel: replay always runs against current external state
//     (current git worktree, current MCP servers, current model).

import type { DatabaseSync } from "node:sqlite";
import type { PipelineIR, AgentStage, ScriptStage } from "../ir/schema.js";
import type { StageExecutor } from "../runtime/executor.js";
import {
  PortRuntime,
  type EventDispatcher,
} from "../runtime/port-runtime.js";
import { getPipelineIR } from "../ir/sql.js";

export type ReplayFailureCode =
  | "SOURCE_ATTEMPT_NOT_FOUND"
  | "SOURCE_IR_MISSING"
  | "SOURCE_STAGE_MISSING"
  | "SOURCE_STAGE_NOT_REPLAYABLE"
  | "EXECUTOR_THREW";

export interface ReplayStageInput {
  db: DatabaseSync;
  /** attempt_id of the attempt to reproduce. */
  sourceAttemptId: string;
  /** Executor to run the replay under. */
  executor: StageExecutor;
  /**
   * Handlers to pass through to executor.executeStage. MockStageExecutor
   * uses these; RealStageExecutor ignores them. Default {}.
   */
  handlers?: Parameters<StageExecutor["executeStage"]>[0]["handlers"];
  /**
   * Override for portValues passed to executor. When omitted, the core
   * reconstructs inputs from the source attempt's port_values reads
   * (direction='in'); this puts the replay's agent in the exact same
   * input context as the source.
   */
  portValuesOverride?: Record<string, unknown>;
}

export interface ReplayStageSuccess {
  ok: true;
  sourceAttemptId: string;
  newAttemptId: string;
  newAttemptIdx: number;
  status: "success" | "error";
  error?: string;
  writes: Array<{ port: string; value: unknown }>;
}

export interface ReplayStageFailure {
  ok: false;
  code: ReplayFailureCode;
  message: string;
}

export type ReplayStageResult = ReplayStageSuccess | ReplayStageFailure;

const inertDispatcher: EventDispatcher = { send: () => { /* no-op */ } };

/**
 * Load the attempt row + reconstruct its inputs. Stage must be of a
 * type the executor can re-run (agent or script). gates/external/
 * fanout_element/fanout_aggregate attempts reject with
 * SOURCE_STAGE_NOT_REPLAYABLE.
 */
function loadReplayContext(
  db: DatabaseSync,
  sourceAttemptId: string,
):
  | {
      ok: true;
      taskId: string;
      versionHash: string;
      stageName: string;
      ir: PipelineIR;
      stage: AgentStage | ScriptStage;
      reconstructedInputs: Record<string, unknown>;
    }
  | ReplayStageFailure {
  const row = db.prepare(
    `SELECT task_id, version_hash, stage_name, kind
     FROM stage_attempts
     WHERE attempt_id = ?`,
  ).get(sourceAttemptId) as
    | { task_id: string; version_hash: string; stage_name: string; kind: string }
    | undefined;
  if (!row) {
    return {
      ok: false,
      code: "SOURCE_ATTEMPT_NOT_FOUND",
      message: `no stage_attempts row with attempt_id='${sourceAttemptId}'`,
    };
  }
  if (row.kind !== "regular") {
    return {
      ok: false,
      code: "SOURCE_STAGE_NOT_REPLAYABLE",
      message:
        `attempt_id='${sourceAttemptId}' has kind='${row.kind}' — only 'regular' attempts are replayable ` +
        `(external seed / fanout / replay / gate attempts cannot be replayed)`,
    };
  }

  const ir = getPipelineIR(db, row.version_hash);
  if (!ir) {
    return {
      ok: false,
      code: "SOURCE_IR_MISSING",
      message: `version_hash='${row.version_hash}' not found in pipeline_versions`,
    };
  }
  const stage = ir.stages.find((s) => s.name === row.stage_name);
  if (!stage) {
    return {
      ok: false,
      code: "SOURCE_STAGE_MISSING",
      message: `stage '${row.stage_name}' not found in IR at version_hash='${row.version_hash}'`,
    };
  }
  if (stage.type !== "agent" && stage.type !== "script") {
    return {
      ok: false,
      code: "SOURCE_STAGE_NOT_REPLAYABLE",
      message: `stage '${row.stage_name}' is type='${stage.type}' — only agent and script stages are replayable`,
    };
  }

  // Reconstruct inputs from the lineage rows the source attempt read.
  // These reads capture what the upstream producer had emitted at the
  // moment the source stage fired. Using them (rather than the
  // "current" port value) is critical for reproducibility: upstream
  // stages may have re-written their ports in later attempts, and we
  // want the source's exact input snapshot.
  const readRows = db.prepare(
    `SELECT port_name, value_json FROM port_values
     WHERE attempt_id = ? AND direction = 'in'`,
  ).all(sourceAttemptId) as Array<{ port_name: string; value_json: string }>;
  const reconstructedInputs: Record<string, unknown> = {};
  for (const r of readRows) {
    // Keys match the compiler's portValues convention:
    //   `${fromStage}.${fromPort}` maps into a keyed bag.
    // But the executor only sees inputs by port-name. Look up the
    // wire definition to key the resolved value correctly in the
    // portValues record the executor receives below.
    const input = stage.inputs.find((p) => p.name === r.port_name);
    if (!input) continue; // stray read (should never happen in practice)
    const wire = ir.wires.find(
      (w) => w.to.stage === stage.name && w.to.port === input.name,
    );
    if (!wire) continue;
    const fromStageKey =
      wire.from.source === "external" ? "__external__" : wire.from.stage;
    const key = `${fromStageKey}.${wire.from.port}`;
    try {
      reconstructedInputs[key] = JSON.parse(r.value_json);
    } catch {
      reconstructedInputs[key] = r.value_json;
    }
  }

  return {
    ok: true,
    taskId: row.task_id,
    versionHash: row.version_hash,
    stageName: row.stage_name,
    ir,
    stage,
    reconstructedInputs,
  };
}

/**
 * Synchronously replay a stage attempt. Returns a Promise that
 * resolves with the new attempt's summary (success or error) or a
 * failure code if preflight checks rejected the replay.
 */
export async function replayStage(
  input: ReplayStageInput,
): Promise<ReplayStageResult> {
  const ctx = loadReplayContext(input.db, input.sourceAttemptId);
  if (!("ok" in ctx) || ctx.ok !== true) {
    // Narrow to the failure shape.
    return ctx as ReplayStageFailure;
  }

  const portValues = input.portValuesOverride ?? ctx.reconstructedInputs;

  // Build an isolated PortRuntime with an inert dispatcher so port
  // writes hit port_values (lineage) but do NOT wake any task-level
  // XState machine.
  const replayRuntime = new PortRuntime(input.db, inertDispatcher, "replay");

  // startAttempt will flag this attempt as kind='replay' and record
  // replayed_from_attempt_id. We DON'T call it directly — the executor
  // will, because the executor owns attempt lifecycle. But we need to
  // pass the replayedFromAttemptId hint through. PortRuntime.startAttempt
  // takes a single args object; executors invoke it without our flag.
  //
  // Solution: wrap the PortRuntime to inject the replayedFromAttemptId
  // into every startAttempt call from the executor during this replay.
  // This also forces kind='replay' even if the executor passes kind.
  const wrappedRuntime = wrapRuntimeForReplay(replayRuntime, input.sourceAttemptId);

  let execResult;
  try {
    // MockStageExecutor uses `args.handlers ?? this.handlers`, so
    // passing `{}` would clobber its constructor default. Only include
    // a `handlers` key when the caller supplied one, letting the
    // undefined spread fall through to the executor's own default.
    const baseArgs = {
      ir: ctx.ir,
      stageName: ctx.stageName,
      taskId: ctx.taskId,
      versionHash: ctx.versionHash,
      portValues,
      portRuntime: wrappedRuntime,
    };
    const executeArgs = input.handlers !== undefined
      ? { ...baseArgs, handlers: input.handlers }
      : (baseArgs as Parameters<StageExecutor["executeStage"]>[0]);
    execResult = await input.executor.executeStage(executeArgs);
  } catch (err) {
    return {
      ok: false,
      code: "EXECUTOR_THREW",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // Gather the writes the replay produced for reporting.
  const writes = input.db.prepare(
    `SELECT port_name, value_json FROM port_values
     WHERE attempt_id = ? AND direction = 'out'
     ORDER BY written_at ASC`,
  ).all(execResult.attemptId) as Array<{ port_name: string; value_json: string }>;

  return {
    ok: true,
    sourceAttemptId: input.sourceAttemptId,
    newAttemptId: execResult.attemptId,
    newAttemptIdx: execResult.attemptIdx,
    status: execResult.status,
    error: execResult.error,
    writes: writes.map((r) => {
      let value: unknown;
      try { value = JSON.parse(r.value_json); } catch { value = r.value_json; }
      return { port: r.port_name, value };
    }),
  };
}

/**
 * Thin wrapper that intercepts startAttempt calls during a replay to
 * force kind='replay' + replayedFromAttemptId. Other PortRuntime
 * methods (writePort, recordRead, finishAttempt, getDb, getDispatcher)
 * pass through unchanged. This is cheaper than adding a "replay mode"
 * flag to PortRuntime itself and keeps the replay concern localised.
 */
function wrapRuntimeForReplay(
  inner: PortRuntime,
  sourceAttemptId: string,
): PortRuntime {
  const proxy = Object.create(inner) as PortRuntime;
  proxy.startAttempt = function (args) {
    return inner.startAttempt({
      ...args,
      kind: "replay",
      replayedFromAttemptId: sourceAttemptId,
    });
  };
  return proxy;
}
