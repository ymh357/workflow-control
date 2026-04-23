// runner-fanout.ts — Fanout stage orchestration extracted from runner.ts (D34).
//
// Orchestrates a fanout stage: iterates the source port's array, executes
// the stage once per element against a silent PortRuntime, then aggregates
// every declared output into an array and dispatches one PORT_WRITTEN per
// output via the live dispatcher.
//
// Why this is not a StageExecutor (i.e. not routed through
// CompositeStageExecutor):
//   - CompositeStageExecutor picks a per-stage-type delegate (agent /
//     script / gate) to run ONE execution of ONE stage. Its
//     ExecuteStageArgs surface deliberately has no access to db /
//     livePortRuntime / the aggregate-attempt concept.
//   - Fanout is not "another stage type". It is an orchestration
//     pattern that runs the underlying agent/script executor N times
//     against a silent PortRuntime, then opens a separate aggregate
//     attempt (kind='fanout_aggregate') to materialise T[] outputs and
//     wake downstream guards. It spans N+1 stage_attempts for one
//     stage-region transition.
//   - Forcing it into Composite would either leak runtime internals
//     (db, livePortRuntime) into every ExecuteStageArgs or wrap this
//     function in a closure-based StageExecutor whose implementation
//     still lives in runner — change in shape, not in substance.
//
// It therefore sits alongside the invoke-driven per-stage execution
// path, not inside it. Composite is the execution layer; this is the
// orchestration layer.
//
// Scope (A3.3): sequential execution, first element error fails the
// stage. Preserves existing lineage (each attempt writes its own
// port_values rows normally; attempt kind is set via the silent
// runtime's defaultKind — see Debt #7).
//
// P5.1 — concurrency cap. FanoutSpec.concurrency (default 3, max 20)
// bounds simultaneous per-element executions via a worker-pool pattern.
// Protects against Anthropic rate limits when a fanout source is large.
// First-error semantics preserved: on error, no NEW elements are taken,
// already-in-flight elements are awaited, and the first error observed
// fails the stage.

import type { DatabaseSync } from "node:sqlite";
import { PortRuntime, type EventDispatcher } from "./port-runtime.js";
import type { StageHandlerMap } from "./mock-executor.js";
import type { StageExecutor } from "./executor.js";
import type { PipelineIR, AgentStage, ScriptStage } from "../ir/schema.js";

export interface RunFanoutArgs {
  ir: PipelineIR;
  stageDef: AgentStage | ScriptStage;
  taskId: string;
  versionHash: string;
  basePortValues: Record<string, unknown>;
  handlers: StageHandlerMap;
  db: DatabaseSync;
  // Live PortRuntime — used to open an aggregate attempt and write the
  // aggregated array to port_values (so read_port / query_lineage see it)
  // AND dispatch PORT_WRITTEN to the machine. Per-element attempts still
  // go through a silent runtime to avoid premature downstream dispatch.
  livePortRuntime: PortRuntime;
  executor: StageExecutor;
}

export type FanoutResult =
  | { status: "success" }
  | { status: "error"; error: string };

export async function orchestrateFanoutStage(args: RunFanoutArgs): Promise<FanoutResult> {
  const { ir, stageDef, taskId, versionHash, basePortValues, handlers, db, livePortRuntime, executor } = args;
  const fanout = stageDef.fanout;
  if (!fanout) {
    return { status: "error", error: `stage '${stageDef.name}' has no fanout config` };
  }

  // Locate the fanout input port and its source wire.
  const fanoutPort = stageDef.inputs.find((p) => p.name === fanout.input);
  if (!fanoutPort) {
    return {
      status: "error",
      error: `fanout.input '${fanout.input}' is not a declared input port on stage '${stageDef.name}'`,
    };
  }
  const wire = ir.wires.find(
    (w) => w.to.stage === stageDef.name && w.to.port === fanout.input,
  );
  if (!wire) {
    return {
      status: "error",
      error: `no inbound wire to '${stageDef.name}.${fanout.input}' — cannot fan out`,
    };
  }

  // Bridge: Task 1.2 introduced WireSource. Task 1.3+ will resolve external
  // fanout sources from the external-inputs namespace.
  const fromStage = wire.from.source === "external" ? "__external__" : wire.from.stage;
  const sourceKey = `${fromStage}.${wire.from.port}`;
  const sourceValue = basePortValues[sourceKey];
  if (!Array.isArray(sourceValue)) {
    return {
      status: "error",
      error: `fanout source '${sourceKey}' is not an array (got ${typeof sourceValue})`,
    };
  }

  // Silent dispatcher: writes go to DB lineage but do NOT advance the
  // machine. The machine only learns about this fanout stage's outputs
  // after aggregation (below). defaultKind='fanout_element' (Debt #7)
  // tags every per-element attempt so provenance is queryable without
  // inferring it from stage shape.
  const silentDispatcher: EventDispatcher = { send: () => { /* inert */ } };
  const silentRuntime = new PortRuntime(db, silentDispatcher, "fanout_element");

  const declaredOutputs = stageDef.outputs.map((p) => p.name);
  // P5.1 — pre-sized to source length so workers can assign by index
  // (out-of-order completion under parallelism still preserves input
  // order in the aggregate).
  const aggregated: Record<string, unknown[]> = {};
  for (const name of declaredOutputs) aggregated[name] = new Array(sourceValue.length);

  // B17 full — discover fanout_element attempts that already succeeded
  // for this (task, stage) on a prior pipeline version. These survived
  // the migration supersede (see migration-orchestrator §7.4 B17 T2).
  // Fetch their idx + output port values so we can skip re-executing
  // them and still produce an N-length aggregate.
  //
  // Index filter (`fanout_element_idx < sourceValue.length`) guards
  // against a shrunk source array — out-of-range preserved attempts
  // are not relevant to this run.
  const preservedRows = db.prepare(
    `SELECT sa.attempt_id, sa.fanout_element_idx
       FROM stage_attempts sa
       WHERE sa.task_id = ?
         AND sa.stage_name = ?
         AND sa.kind = 'fanout_element'
         AND sa.status = 'success'
         AND sa.fanout_element_idx IS NOT NULL
         AND sa.fanout_element_idx < ?`,
  ).all(taskId, stageDef.name, sourceValue.length) as Array<{ attempt_id: string; fanout_element_idx: number }>;
  const preservedByIdx = new Map<number, Record<string, unknown>>();
  for (const r of preservedRows) {
    // Read the attempt's declared output port values from port_values.
    const outs = db.prepare(
      `SELECT port_name, value_json FROM port_values
         WHERE attempt_id = ? AND direction = 'out'`,
    ).all(r.attempt_id) as Array<{ port_name: string; value_json: string }>;
    const map: Record<string, unknown> = {};
    for (const o of outs) map[o.port_name] = JSON.parse(o.value_json);
    preservedByIdx.set(r.fanout_element_idx, map);
  }

  // P5.1 — concurrency cap. Default 3 when unspecified. min() against
  // source length avoids spawning idle workers for small arrays.
  const configuredCap = fanout.concurrency ?? 3;
  const cap = Math.max(1, Math.min(configuredCap, sourceValue.length));

  // Shared cursor + abort state drive the worker pool. `firstError` is
  // the first error message observed; once set, workers stop taking
  // new elements (in-flight elements still complete — we always await
  // the pool before returning).
  let nextIdx = 0;
  let firstError: string | null = null;

  const runElement = async (i: number): Promise<void> => {
    // B17 full — if an earlier successful fanout_element attempt
    // already covered this index, reuse its outputs instead of
    // re-running the executor. Keeps lineage intact (the preserved
    // attempt row remains; we don't open a new one) and avoids
    // redoing expensive agent work after a hot-update migration.
    const preserved = preservedByIdx.get(i);
    if (preserved) {
      for (const name of declaredOutputs) {
        aggregated[name]![i] = preserved[name];
      }
      return;
    }

    // Override the fanout source in the executor's portValues view so
    // the executor reads a single element (typed T) instead of T[].
    const elementPortValues = { ...basePortValues, [sourceKey]: sourceValue[i] };

    const result = await executor.executeStage({
      ir,
      stageName: stageDef.name,
      taskId,
      versionHash,
      portValues: elementPortValues,
      handlers,
      portRuntime: silentRuntime,
      // B17 full — tag the per-element attempt with its 0-based index.
      // PortRuntime.startAttempt writes it to stage_attempts.fanout_element_idx
      // so migration re-runs can skip indices that already succeeded.
      fanoutElementIdx: i,
    });

    if (result.status === "error") {
      // Record the first error; later errors are discarded (they can
      // occur concurrently when cap > 1). The pool will drain naturally
      // — remaining workers see firstError !== null and stop taking
      // new indices.
      if (firstError === null) {
        firstError = `fanout element ${i}/${sourceValue.length} failed: ${result.error ?? "unspecified"}`;
      }
      return;
    }

    // Collect this attempt's output port values from the DB. Write by
    // index (not push) so the aggregated array preserves input order
    // even when elements finish out-of-order under parallelism.
    const rows = silentRuntime.readWritesForAttempt(result.attemptId);
    const byPort = new Map<string, unknown>();
    for (const r of rows) byPort.set(r.port, r.value);
    for (const name of declaredOutputs) {
      aggregated[name]![i] = byPort.get(name);
    }
  };

  const worker = async (): Promise<void> => {
    while (true) {
      if (firstError !== null) return;
      const i = nextIdx++;
      if (i >= sourceValue.length) return;
      await runElement(i);
    }
  };

  await Promise.all(Array.from({ length: cap }, () => worker()));

  if (firstError !== null) {
    return { status: "error", error: firstError };
  }

  // Open an "aggregate attempt" on the live PortRuntime and write each
  // declared output's aggregated array. This does two things in one call
  // (writePort): (a) persists the T[] to port_values so read_port /
  // query_lineage / diff_runs return the aggregate, and (b) dispatches
  // PORT_WRITTEN to the live machine so downstream stages' guards
  // re-evaluate against T[]. Prior to this fix the aggregate only
  // reached machine context and was invisible to external observers
  // (Reviewer critical #2 / plan §2.2).
  const aggregateAttempt = livePortRuntime.startAttempt({
    taskId,
    versionHash,
    stageName: stageDef.name,
    kind: "fanout_aggregate",
    // Synthetic aggregate attempt opens and closes within this
    // function — it records lineage but does not represent agent
    // work on the worktree. Skip checkpoint capture.
    suppressHooks: true,
  });
  try {
    for (const name of declaredOutputs) {
      livePortRuntime.writePort({
        attemptId: aggregateAttempt.attemptId,
        stageName: stageDef.name,
        portName: name,
        value: aggregated[name]!,
      });
    }
    livePortRuntime.finishAttempt(aggregateAttempt.attemptId, "success");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    livePortRuntime.finishAttempt(aggregateAttempt.attemptId, "error", message, { silent: true });
    return { status: "error", error: `fanout aggregate failed: ${message}` };
  }

  return { status: "success" };
}
