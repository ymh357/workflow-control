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
import type { StageExecutor, ExecuteStageResult } from "./executor.js";
import type { PipelineIR, AgentStage, ScriptStage } from "../ir/schema.js";
import { wireSourceKeyPrefix } from "../ir/wire-helpers.js";

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
  // Bug 81 (dogfood-13 2026-05-03): outer INTERRUPT signal. When the
  // runner-level dispatcher observes INTERRUPT (from
  // taskRegistry.cancelTask / migration-orchestrator / etc.), it
  // aborts this signal. The fanout main loop checks signal.aborted
  // between elements and exits early; per-element controllers
  // listen too so the SDK abort path tears down in-flight LLM calls.
  // Pre-fix, fanout ignored INTERRUPT entirely — the actor.stop()
  // 1500ms grace period in runner.ts is no help because fanout
  // promises live OUTSIDE the actor (detached executorPromises),
  // so stopping the actor leaves the fanout queue running.
  interruptSignal?: AbortSignal;
}

export type FanoutResult =
  | { status: "success" }
  | { status: "error"; error: string }
  | { status: "secret_pending"; missingKeys: string[] };

export async function orchestrateFanoutStage(args: RunFanoutArgs): Promise<FanoutResult> {
  const { ir, stageDef, taskId, versionHash, basePortValues, handlers, db, livePortRuntime, executor, interruptSignal } = args;
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
  const sourceKey = `${wireSourceKeyPrefix(wire)}.${wire.from.port}`;
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
  // Bug 3 fix (c12+ review): pre-fix the SELECT had no ORDER BY. If
  // multiple rows existed for the same idx (which can happen when a
  // Promise.race timeout detached an executor that later succeeded —
  // see Bug 3 / runElement loop below — or after a botched migration
  // path), the resulting Map iteration was non-deterministic and
  // future re-runs reused outputs at random. Order by attempt_idx DESC
  // (most recent attempt for that idx wins) and dedupe via
  // setIfAbsent so the latest success row is the canonical one.
  const preservedRows = db.prepare(
    `SELECT sa.attempt_id, sa.fanout_element_idx
       FROM stage_attempts sa
       WHERE sa.task_id = ?
         AND sa.stage_name = ?
         AND sa.kind = 'fanout_element'
         AND sa.status = 'success'
         AND sa.fanout_element_idx IS NOT NULL
         AND sa.fanout_element_idx < ?
       ORDER BY sa.attempt_idx DESC, sa.started_at DESC`,
  ).all(taskId, stageDef.name, sourceValue.length) as Array<{ attempt_id: string; fanout_element_idx: number }>;
  const preservedByIdx = new Map<number, Record<string, unknown>>();
  for (const r of preservedRows) {
    // Bug 3 fix (c12+ review): rows are pre-sorted DESC by attempt_idx
    // / started_at, so the FIRST row for any given idx is the most
    // recent. Skip subsequent rows for the same idx (they would be
    // stale duplicates from a race or a botched supersede).
    if (preservedByIdx.has(r.fanout_element_idx)) continue;
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
  //
  // F17/F19: secret_pending is a non-error pause signal. If ANY element
  // returns secret_pending, we collect its missingKeys, stop scheduling
  // new elements (workers gate on secretPendingObserved), and once the
  // pool drains we return the pause result instead of attempting
  // aggregation — partial element outputs are kept in the silent runtime
  // and survive into the resumed run via stage_attempts. (executor.ts
  // already finishAttempt'd the element as secret_pending and wrote a
  // secret_gate_queue row covering its missingKeys.)
  let nextIdx = 0;
  let firstError: string | null = null;
  let secretPendingObserved = false;
  const allMissingKeys = new Set<string>();

  // P4 (2026-04-29) — per-element retry on transient executor error.
  // 0 means "fail fast" (legacy behaviour). Spec is bounded 0..5 by
  // FanoutSpecSchema; we additionally clamp here so an undefined
  // value resolves to the documented default.
  const elementRetries = Math.max(0, fanout.elementRetries ?? 0);

  // C10 (2026-04-30) — per-element wall-clock timeout. Without this, a
  // wedged Claude SDK session (observed: streaming response that never
  // resolves) leaves a `running` stage_attempts row that no one ever
  // closes. The runner's global 90-min budget protects the run as a
  // whole, but the fanout aggregate above never finalises because
  // Promise.all on the worker pool doesn't return until every element
  // settles — so the run sits idle until global timeout. Per-element
  // timeout abort()'s the executor's signal so doAttempt's stream
  // listener throws and the element fails normally (then enters the
  // elementRetries loop).
  //
  // Default 30 minutes: covers the worst observed agent stage in c9.6
  // (~5 min for analyzing under retry pressure) with a 6x safety margin.
  // Authors can override via FanoutSpec.elementTimeoutMs.
  const DEFAULT_FANOUT_ELEMENT_TIMEOUT_MS = 30 * 60 * 1000;
  const elementTimeoutMs = fanout.elementTimeoutMs ?? DEFAULT_FANOUT_ELEMENT_TIMEOUT_MS;

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

    // Bug 81 (dogfood-13 2026-05-03): bail out if the runner-level
    // INTERRUPT was already delivered before this worker picked up
    // the element. Without this check, a fanout that was mid-flight
    // when migration/cancel issued INTERRUPT would still spawn fresh
    // elements as workers cycled — defeating the whole point of
    // INTERRUPT. Surface as a synthetic error so firstError is set
    // and the worker pool drains cleanly via the existing path.
    if (interruptSignal?.aborted) {
      // Setting firstError here matches the in-loop error path so
      // sibling workers stop pulling new indices.
      if (!firstError) {
        firstError = `fanout element[${i}] aborted by INTERRUPT before start`;
      }
      return;
    }

    // Override the fanout source in the executor's portValues view so
    // the executor reads a single element (typed T) instead of T[].
    const elementPortValues = { ...basePortValues, [sourceKey]: sourceValue[i] };

    // P4 — retry loop. `attemptsLeft = elementRetries + 1` covers the
    // initial attempt plus N retries. Each iteration opens a fresh
    // stage_attempt (PortRuntime.startAttempt is invoked inside
    // executor.executeStage), so DB lineage records every try as a
    // distinct row (the failed ones with status='error', the final one
    // with status='success'). secret_pending and success short-circuit
    // the loop; only `result.status === "error"` is retryable.
    let lastError: string | null = null;
    let succeeded = false;
    let secretPending: { missingKeys: string[] } | null = null;
    const attemptsLeft = elementRetries + 1;
    let lastAttemptId: string | null = null;
    for (let tryIdx = 0; tryIdx < attemptsLeft; tryIdx++) {
      // C10 (2026-04-30) — per-element timeout via Promise.race. We can't
      // rely on executor responding to AbortSignal alone (mock executor
      // doesn't, and even real-executor's SDK stream listener may stall
      // before the next chunk lets it observe abort). The race
      // unblocks the runner deterministically; we still abort() so the
      // executor's own cleanup paths (real-executor: aborts SDK
      // controller in finally) tear down the upstream promise.
      //
      // Note: when timeout wins the race, the underlying executor
      // promise may still be in flight. We swallow its eventual outcome
      // via the .catch() — its stage_attempts row is already opened by
      // PortRuntime, and either (a) the executor reaches its finally
      // and writes status=error/success normally (DB stays consistent,
      // we just ignore the late result), or (b) the executor never
      // resolves (process exit cleans up). Critically: our retry loop
      // moves on instead of waiting indefinitely.
      const elementController = new AbortController();
      // Bug 81: parent INTERRUPT signal aborts the element controller
      // so the SDK / mock executor's signal-aware code paths tear
      // down promptly instead of waiting for the C10 30-min timeout.
      // If the parent is already aborted at this point, abort
      // synchronously so executor.executeStage observes it before
      // its first tick.
      const onParentInterrupt = (): void => elementController.abort();
      if (interruptSignal) {
        if (interruptSignal.aborted) {
          elementController.abort();
        } else {
          interruptSignal.addEventListener("abort", onParentInterrupt, { once: true });
        }
      }

      const TIMEOUT_SENTINEL = Symbol("fanout-element-timeout");
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
        timeoutHandle = setTimeout(() => {
          elementController.abort();
          resolve(TIMEOUT_SENTINEL);
        }, elementTimeoutMs);
      });

      const executorPromise = executor.executeStage({
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
        signal: elementController.signal,
      });

      const raceResult = await Promise.race([executorPromise, timeoutPromise]);
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      // Bug 81: detach the parent-INTERRUPT listener once this attempt
      // has resolved. removeEventListener is a no-op when the listener
      // already fired (we used { once: true }) but cleans up the
      // dangling reference in the not-yet-aborted case.
      if (interruptSignal) {
        interruptSignal.removeEventListener("abort", onParentInterrupt);
      }

      if (raceResult === TIMEOUT_SENTINEL) {
        // Detach the still-pending executor promise so it doesn't
        // surface as an unhandled rejection when it eventually settles
        // (esp. if it throws after abort).
        executorPromise.catch(() => { /* timeout already resolved the race */ });
        // Bug 3 fix (c12+ review): force-finalise any orphan
        // status='running' row this element opened. silentRuntime's
        // startAttempt (called inside executor.executeStage early)
        // already inserted a stage_attempts row; if the executor
        // doesn't observe the abort (mock executor; SDK stalled
        // mid-tool-call), the row stays 'running' forever and pollutes
        // future preservedByIdx queries. By writing status='error'
        // first, any LATER writeAttempt(success) from the detached
        // executor still wins the row (UPDATE stage_attempts SET
        // status='success' is unconditional in port-runtime), but the
        // common case where the executor never resolves at all leaves
        // a clean error row. ORDER BY in preservedByIdx (post-fix)
        // also tolerates the rare case where both an error and a
        // later success coexist for the same idx.
        db.prepare(
          `UPDATE stage_attempts
              SET status = 'error',
                  ended_at = ?
            WHERE task_id = ?
              AND stage_name = ?
              AND fanout_element_idx = ?
              AND status = 'running'`,
        ).run(Date.now(), taskId, stageDef.name, i);
        lastError = `fanout element[${i}] timed out after ${elementTimeoutMs}ms`;
        continue;
      }

      const result: ExecuteStageResult = raceResult;

      if (result.status === "error") {
        lastError = result.error ?? "unspecified";
        // Continue the retry loop. If this was the last try, fall
        // through to the post-loop firstError assignment.
        continue;
      }

      if (result.status === "secret_pending") {
        // F17/F19: per-element missing-envKey pause. Don't retry —
        // the executor isn't going to start a new SDK session if
        // envKeys are still missing. Resume happens after the user
        // provides secrets and the kernel re-enters the stage.
        secretPending = { missingKeys: result.missingKeys };
        break;
      }

      // Success. Record attempt id for output collection below and exit
      // the retry loop. Earlier failed attempts in this loop remain in
      // the DB as kind='fanout_element', status='error' rows with the
      // same fanout_element_idx — readers (lineage / dashboards) can
      // see the retry history.
      lastAttemptId = result.attemptId;
      succeeded = true;
      break;
    }

    if (secretPending) {
      secretPendingObserved = true;
      for (const k of secretPending.missingKeys) allMissingKeys.add(k);
      return;
    }

    if (!succeeded) {
      // Retries exhausted. Record the first stage-level error (later
      // errors are discarded — they can occur concurrently when cap > 1).
      // The pool will drain naturally; remaining workers see firstError
      // !== null and stop taking new indices.
      if (firstError === null) {
        firstError = elementRetries > 0
          ? `fanout element[${i}] of ${sourceValue.length} failed after ${elementRetries + 1} attempts: ${lastError ?? "unspecified"}`
          : `fanout element[${i}] of ${sourceValue.length} failed: ${lastError ?? "unspecified"}`;
      }
      return;
    }

    // Collect this attempt's output port values from the DB. Write by
    // index (not push) so the aggregated array preserves input order
    // even when elements finish out-of-order under parallelism.
    const rows = silentRuntime.readWritesForAttempt(lastAttemptId!);
    const byPort = new Map<string, unknown>();
    for (const r of rows) byPort.set(r.port, r.value);
    for (const name of declaredOutputs) {
      aggregated[name]![i] = byPort.get(name);
    }
  };

  const worker = async (): Promise<void> => {
    while (true) {
      if (firstError !== null || secretPendingObserved) return;
      const i = nextIdx++;
      if (i >= sourceValue.length) return;
      await runElement(i);
    }
  };

  await Promise.all(Array.from({ length: cap }, () => worker()));

  if (firstError !== null) {
    return { status: "error", error: firstError };
  }

  if (secretPendingObserved) {
    // F17/F19: don't attempt aggregation — at least one element
    // pause-failed on missing envKeys. The executor already wrote a
    // secret_gate_queue row per affected element. Return upward; the
    // runner sets secretPendingObserved on its own flag and dispatches
    // STAGE_FAILED so the machine resolves out of `executing`.
    return { status: "secret_pending", missingKeys: Array.from(allMissingKeys).sort() };
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
