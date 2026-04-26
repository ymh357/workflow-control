// A4 dry_run_stage — run a SINGLE stage against caller-supplied inputs,
// with no requirement that a prior attempt or task exist. This is the
// "try before you wire" path for AI-driven pipeline editing: propose_
// pipeline_fix suggests a change, an AI calls dry_run_stage to see
// whether the proposed stage actually behaves the way it intended,
// without running the whole pipeline.
//
// Relationship to replay_stage:
//   replay_stage   — needs a source attempt_id; reproduces its inputs;
//                     writes kind='replay' + replayed_from_attempt_id.
//   dry_run_stage  — no source attempt; caller supplies inputs as
//                     Record<portName, value>; writes kind='dry_run'
//                     under a synthetic task_id prefixed 'dry_run-'.
//
// Invariants:
//   1. Pure probe from the caller's perspective: success/failure does
//      not affect any real task. The attempt row IS persisted (so a
//      later prune CLI + debug UI can surface it), but no events
//      propagate to any XState actor — an inert dispatcher handles
//      PORT_WRITTEN.
//   2. Works only on agent and script stages. Gates require a running
//      task + human interaction; external/fanout_element etc. are not
//      user-visible stage types.
//   3. All declared inputs must be supplied. Missing inputs are
//      rejected up-front with MISSING_INPUT; we do not invent defaults
//      or read from any global store.
//
// Out of scope:
//   - Multi-stage dry-runs (use propose_pipeline_fix preview for that).
//   - Running under the real Claude SDK without network access.
//     Callers are responsible for executor selection.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { PipelineIR, AgentStage, ScriptStage } from "../ir/schema.js";
import type { StageExecutor } from "../runtime/executor.js";
import {
  PortRuntime,
  type EventDispatcher,
} from "../runtime/port-runtime.js";
import { getPipelineIR } from "../ir/sql.js";

export type DryRunFailureCode =
  | "PIPELINE_VERSION_NOT_FOUND"
  | "STAGE_NOT_FOUND"
  | "STAGE_NOT_DRY_RUNNABLE"
  | "MISSING_INPUT"
  | "EXECUTOR_THREW";

export interface DryRunStageInput {
  db: DatabaseSync;
  /** version_hash of the pipeline that declares the target stage. */
  pipelineVersion: string;
  /** Stage name within that pipeline. */
  stageName: string;
  /**
   * Values for every input port the stage declares. Keyed by port name;
   * callers do not need to know about wires or external/stage source
   * semantics. Missing required inputs are rejected.
   */
  inputs: Record<string, unknown>;
  /** Executor to run the stage under. Mock or real. */
  executor: StageExecutor;
  /**
   * Handlers to pass through to executor.executeStage. MockStageExecutor
   * uses these; RealStageExecutor ignores them. Default {}.
   */
  handlers?: Parameters<StageExecutor["executeStage"]>[0]["handlers"];
}

export interface DryRunStageSuccess {
  ok: true;
  /** Synthetic task id this dry-run was booked under. */
  taskId: string;
  /** The fresh attempt_id written to stage_attempts. */
  attemptId: string;
  attemptIdx: number;
  status: "success" | "error";
  error?: string;
  writes: Array<{ port: string; value: unknown }>;
}

export interface DryRunStageFailure {
  ok: false;
  code: DryRunFailureCode;
  message: string;
}

export type DryRunStageResult = DryRunStageSuccess | DryRunStageFailure;

const inertDispatcher: EventDispatcher = { send: () => { /* no-op */ } };

function loadDryRunContext(
  db: DatabaseSync,
  pipelineVersion: string,
  stageName: string,
):
  | {
      ok: true;
      ir: PipelineIR;
      stage: AgentStage | ScriptStage;
    }
  | DryRunStageFailure {
  const ir = getPipelineIR(db, pipelineVersion);
  if (!ir) {
    return {
      ok: false,
      code: "PIPELINE_VERSION_NOT_FOUND",
      message: `version_hash='${pipelineVersion}' not found in pipeline_versions`,
    };
  }
  const stage = ir.stages.find((s) => s.name === stageName);
  if (!stage) {
    return {
      ok: false,
      code: "STAGE_NOT_FOUND",
      message: `stage '${stageName}' not found in IR at version_hash='${pipelineVersion}'`,
    };
  }
  if (stage.type !== "agent" && stage.type !== "script") {
    return {
      ok: false,
      code: "STAGE_NOT_DRY_RUNNABLE",
      message: `stage '${stageName}' is type='${stage.type}' — only agent and script stages can be dry-run`,
    };
  }
  return { ok: true, ir, stage };
}

/**
 * Build the portValues bag the executor expects — keyed by
 * `${fromStageKey}.${fromPort}` — from the flat `inputs` record.
 *
 * Resolution:
 *   - If the target input has a wire, use `wire.from` to derive the
 *     key prefix (external vs stage).
 *   - If the target input has no wire (entry stage, or wires removed by
 *     a patch proposal), fall back to `__external__.<portName>`. This
 *     keeps dry_run usable on entry stages without synthesising fake
 *     wires in the IR.
 */
function buildPortValues(
  ir: PipelineIR,
  stage: AgentStage | ScriptStage,
  flatInputs: Record<string, unknown>,
): { ok: true; portValues: Record<string, unknown> } | DryRunStageFailure {
  const portValues: Record<string, unknown> = {};
  for (const p of stage.inputs) {
    if (!(p.name in flatInputs)) {
      return {
        ok: false,
        code: "MISSING_INPUT",
        message: `stage '${stage.name}' declares input '${p.name}' but the dry-run inputs record has no such key`,
      };
    }
    const wire = ir.wires.find(
      (w) => w.to.stage === stage.name && w.to.port === p.name,
    );
    const key = wire
      ? `${wire.from.source === "external" ? "__external__" : wire.from.stage}.${wire.from.port}`
      : `__external__.${p.name}`;
    portValues[key] = flatInputs[p.name];
  }
  return { ok: true, portValues };
}

/**
 * Run a stage once against caller-supplied inputs. Writes a row to
 * stage_attempts with kind='dry_run' under a fresh synthetic task_id.
 */
export async function dryRunStage(
  input: DryRunStageInput,
): Promise<DryRunStageResult> {
  const ctx = loadDryRunContext(input.db, input.pipelineVersion, input.stageName);
  if (!("ok" in ctx) || ctx.ok !== true) {
    return ctx as DryRunStageFailure;
  }

  const pv = buildPortValues(ctx.ir, ctx.stage, input.inputs);
  if (!pv.ok) return pv;

  const dryRuntime = new PortRuntime(input.db, inertDispatcher, "dry_run");
  const taskId = `dry_run-${randomUUID()}`;

  let execResult;
  try {
    const baseArgs = {
      ir: ctx.ir,
      stageName: ctx.stage.name,
      taskId,
      versionHash: input.pipelineVersion,
      portValues: pv.portValues,
      portRuntime: dryRuntime,
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

  const writes = input.db.prepare(
    `SELECT port_name, value_json FROM port_values
     WHERE attempt_id = ? AND direction = 'out'
     ORDER BY written_at ASC`,
  ).all(execResult.attemptId) as Array<{ port_name: string; value_json: string }>;

  // Narrow the discriminated union: treat secret_pending as an error so
  // DryRunStageSuccess.status stays "success" | "error".
  const status: "success" | "error" =
    execResult.status === "success" ? "success" : "error";
  const error: string | undefined =
    execResult.status === "error" ? execResult.error
    : execResult.status === "secret_pending"
      ? `MCP_ENV_MISSING: stage needs envKeys [${execResult.missingKeys.join(", ")}]`
      : undefined;
  return {
    ok: true,
    taskId,
    attemptId: execResult.attemptId,
    attemptIdx: execResult.attemptIdx,
    status,
    error,
    writes: writes.map((r) => {
      let value: unknown;
      try { value = JSON.parse(r.value_json); } catch { value = r.value_json; }
      return { port: r.port_name, value };
    }),
  };
}
