// Runner — orchestrates machine lifecycle + executor dispatch.
//
// Responsibilities:
//   1. Compile the IR into an XState machine (via compiler/ir-to-machine).
//   2. Create an actor, subscribe to state changes, and dispatch executor
//      invocations when stages enter the `executing` substate.
//   3. Wire the PortRuntime's event dispatcher to the actor (so port writes
//      become PORT_WRITTEN events to the machine).
//   4. Return a promise that resolves when the machine reaches a top-level
//      final state (`completed` or `failed`).
//
// The runner is a small coordinator: no business logic, no retry decisions.
// The mock-executor invokes handlers; the machine decides transitions based
// on port presence.

import { createActor, fromCallback } from "xstate";
import type { DatabaseSync } from "node:sqlite";
import { logger } from "../../lib/logger.js";
import { compileIRToMachine } from "../compiler/ir-to-machine.js";
import type {
  MachineContext, MachineEvent, StageMeta, InboundWireMeta,
} from "../compiler/ir-to-machine.js";
import { PortRuntime, type EventDispatcher } from "./port-runtime.js";
import { MockStageExecutor, type StageHandlerMap } from "./mock-executor.js";
import type { StageExecutor } from "./executor.js";
import type { PipelineIR, GateStage } from "../ir/schema.js";
import { KernelService } from "../mcp/kernel.js";
import { taskRegistry, type TerminationReason } from "./task-registry.js";
import { evaluateGuard } from "./guard-evaluator.js";
import { topoDownstream } from "./topo-downstream.js";
import type { KernelNextBroadcaster } from "../sse/broadcaster.js";
import type {
  AnyKernelNextSSEEvent,
  KernelNextSSEEvent,
  TaskTopLevelState,
} from "../sse/types.js";

export interface RunnerOptions {
  db: DatabaseSync;
  ir: PipelineIR;
  taskId: string;
  versionHash: string;
  handlers: StageHandlerMap;
  executor?: StageExecutor;
  // SSE observability hook (Slice 2). When provided, runner publishes
  // task_state / stage_* / port_written / run_final events so an HTTP
  // SSE route (Slice 3) or any other in-process subscriber can observe
  // the run live. No broadcaster means no publishing — existing test
  // harnesses stay exactly as they were.
  broadcaster?: KernelNextBroadcaster;
  // 2026-04-20 (Task 1.8) — per-port external seed values. Keys must
  // cover every name in ir.externalInputs or runPipeline rejects with
  // SEED_VALUES_MISSING_KEY (surfaces as run_final failed via the
  // kernel-run.ts .catch path). Extra keys produce a logger.warn but
  // are not fatal. The same values are also threaded into the
  // compiler so initial context.portValues is populated on the very
  // first snapshot — this DB-side seed phase exists purely for
  // lineage (port_values rows under stage_name='__external__') +
  // SSE (port_written events).
  seedValues?: Record<string, unknown>;
  // Stage 5B — resume an existing taskId on a (typically NEW) versionHash.
  // When set, runner skips external input seeding and hydrates
  // finalizedStages + portValues from existing stage_attempts / port_values
  // rows so the machine boots as if a retry were pending with every
  // prior-success stage already finalized. New attempts carry opts.versionHash
  // (normally the proposed-version post-migration). The stage named by
  // resumeFrom is expected to re-invoke; stages wire-reachable from it but
  // currently superseded are re-run by the retry machinery.
  resumeFrom?: string;
}

// Design §6.2 — why the inbound wire to a stage failed. NO_ACTIVE_WIRE
// diagnostics attach an array of these so the AI author can see which
// wire was the culprit (which source port, which guard, what value,
// what reason). Kept flat + JSON-serializable for MCP / REST transport.
export interface GuardFailure {
  wire: {
    from: { stage: string; port: string };
    to: { stage: string; port: string };
  };
  // The wire's guard expression. null when the upstream port was never
  // written (so there was no guard to evaluate — the wire is simply
  // dead because its source never fired).
  guardExpr: string | null;
  // JSON-stringified source port value, truncated to 200 bytes so the
  // diagnostic stays inline-friendly. When the upstream never wrote,
  // this is "<never written>".
  valuePreview: string;
  reason:
    | "upstream-not-written"
    | "guard-false"
    | "guard-threw";
  // Present when reason === 'guard-threw'. The Error.message as-is.
  guardError?: string;
}

export interface StageErrorContext {
  // All wires that had an issue. A stage fails NO_ACTIVE_WIRE when EVERY
  // inbound wire is non-deliverable — so the array contains one entry
  // per inbound wire on the stage.
  failedWires: GuardFailure[];
}

export interface RunResult {
  // "completed" = machine reached parallel onDone with no erroring stages.
  // "failed"    = at least one stage recorded status='error'; runner covers
  //              the design-doc §6.1 `failed` intent at the runner layer
  //              because XState parallel `onDone` fires even when a region
  //              ends in its `error` final — see §5.2 review note.
  finalState: "completed" | "failed";
  portValues: Record<string, unknown>;
  log: string[];
  // Non-fatal errors captured from executor promises during drain. A
  // non-empty array implies finalState === "failed".
  drainErrors: Array<{ stage: string | null; message: string }>;
  // Per-stage errors returned as `status: "error"` by the executor. Distinct
  // from drainErrors: these are structured failures (schema non-compliance,
  // no handler, etc.) not executor crashes. Empty on fully-successful runs.
  // NO_ACTIVE_WIRE entries additionally carry structured context per §6.2;
  // executor-originated errors (bad handler, schema mismatch) omit context.
  stageErrors: Array<{ stage: string; message: string; context?: StageErrorContext }>;
}

// Task C5 — retry rebuild support.
//
// The runner orchestrates two nested loops:
//   1. Outer loop (runPipeline): lives for the duration of the run.
//      Owns run-scoped state that must persist across retry rebuilds
//      (portValues that survive, retryCounts, gate authorizations,
//      accumulated log, publishedTopState, SSE dedupe sets for stages
//      whose final hasn't been superseded by a retry).
//   2. Inner loop (runOneAttempt): one XState actor lifecycle. Resolves
//      with either `{verdict: "completed"|"failed"}` or
//      `{verdict: "retry", event}` when a ScriptStage's retry transition
//      raises RETRY_TO_STAGE.
//
// On retry, the outer loop:
//   - filters persistentPortValues to drop the backToStage and every
//     stage transitively downstream of it,
//   - filters persistentFinalizedStages the same way,
//   - bumps retryCounts[failedStageName] by 1 (guard on next failure
//     reads the incremented value),
//   - clears SSE dedupe sets for the reset stages so their executing /
//     done / error events can re-emit on the new attempt,
//   - preserves gateAuthorizedTargets / gateSkippedTargets (an already-
//     approved gate does not need a second approval when a downstream
//     script fails),
//   - compiles a fresh machine with the updated context via
//     CompileOptions.initialContext, and runs the next attempt.

type AttemptVerdict =
  | { verdict: "completed" | "failed"; snapshot: unknown }
  | {
      verdict: "retry";
      // The actor's context snapshot at the moment of retry — captured
      // synchronously in the inspector before the actor is stopped. The
      // outer loop uses this to populate persistentPortValues /
      // persistentFinalizedStages / etc. so that non-reset stages carry
      // their outputs into the rebuilt machine (e.g. a gate that was
      // already answered doesn't need re-answering).
      contextAtRetry: MachineContext;
      event: {
        failedStageName: string;
        backToStage: string;
        retryIdx: number;
        maxRetries: number;
        errorMessage: string;
      };
    }
  | {
      // Reject-rollback (Task 6). Produced by the dispatcher-level
      // handleGateReject when a GATE_REJECTED event arrives on the
      // shared run-scoped dispatcher. The outer loop prunes the affected
      // stages out of persistent state and rebuilds the actor — the
      // rebuilt actor re-enters the gate's `executing` substate so the
      // gate blocks again for a fresh answer. The replay loop consults
      // `fromGate` to skip synthesising a stale GATE_ANSWERED for the
      // rejected gate.
      verdict: "rollback";
      contextAtRollback: MachineContext;
      fromGate: string;
      toStage: string;
      affectedStages: string[];
    };

// Safety cap on retry iterations: the per-stage RetrySpec caps
// maxRetries at 10, so even with every stage retrying in sequence this
// budget is comfortably above any legitimate run. A higher count means
// runner is in a loop it can't escape — throw rather than hang the test.
const MAX_TOTAL_ATTEMPTS = 50;

interface ExecuteStageInvokeInput {
  stageName: string;
  taskId: string;
  versionHash: string;
  portValues: Record<string, unknown>;
}

export async function runPipeline(opts: RunnerOptions, timeoutMs = 10_000): Promise<RunResult> {
  const executor: StageExecutor =
    opts.executor ?? new MockStageExecutor({ handlers: opts.handlers });

  // ---- Run-scoped state (survives retry rebuilds) -------------------
  // Dispatcher must survive rebuilds — answer_gate / MCP route events
  // through taskRegistry once per run, not per attempt. A mutable
  // `currentActor` ref lets the closure forward to whichever actor is
  // alive at dispatch time.
  let currentActor: ReturnType<typeof createActor> | null = null;
  // Attempt-scoped hook: each runOneAttempt installs a handler so the
  // run-scoped dispatcher can deliver GATE_REJECTED to the correct
  // attempt's resolveAttempt. Cleared at attempt teardown.
  let rejectHandler:
    | ((event: Extract<MachineEvent, { type: "GATE_REJECTED" }>) => void)
    | null = null;
  // Stage 5B — track whether an INTERRUPT was delivered so the runner can
  // signal a more specific termination reason to external awaiters
  // (migration orchestrator distinguishes interrupted from natural exit).
  let interruptObserved = false;
  const dispatcher: EventDispatcher = {
    send: (event: MachineEvent) => {
      if (event.type === "INTERRUPT") interruptObserved = true;
      if (event.type === "GATE_REJECTED") {
        // Intercept BEFORE reaching the XState actor — the machine has no
        // handler for this event type. The attempt's handler owns pruning
        // persistent state and resolving with a "rollback" verdict so the
        // outer loop can rebuild the actor.
        if (rejectHandler) rejectHandler(event);
        return;
      }
      if (currentActor) currentActor.send(event);
    },
  };
  // Kernel service + port runtime are run-scoped: one DB handle, one
  // rewriter. The PortRuntime's dispatcher points at currentActor via
  // the shared `dispatcher` above so port writes route to the live
  // actor across rebuilds.
  const portRuntime = new PortRuntime(
    opts.db,
    dispatcher,
    "regular",
    opts.broadcaster
      ? ({ stageName, portName, value }) => {
          try {
            opts.broadcaster!.publish({
              type: "port_written",
              taskId: opts.taskId,
              timestamp: new Date().toISOString(),
              data: {
                stage: stageName,
                port: portName,
                valuePreview: truncateJson(value),
              },
            });
          } catch { /* broadcaster failure must not abort the run */ }
        }
      : undefined,
  );
  taskRegistry.register(opts.taskId, dispatcher);
  const kernel = new KernelService(opts.db, { skipTypeCheck: true });

  // Run-scoped execution bookkeeping. `dispatched` dedupes executor
  // launches and also acts as the seen-marker for error-final
  // detection inside subscribe. On retry, entries for reset stages are
  // cleared so they can re-dispatch.
  const dispatched = new Set<string>();
  // Drain errors carry executor promise rejections that landed after
  // run-final. Run-scoped so rejections on any attempt surface in the
  // final RunResult. (In practice the retry path stops the outgoing
  // actor, cancels its child invokes, and discards their rejections
  // during the cleanup of the prior attempt.)
  const drainErrors: Array<{ stage: string | null; message: string }> = [];
  // Stage errors captured from executor results. On retry we drop
  // entries for stages being reset so the final RunResult only
  // contains errors from the terminal attempt.
  const stageErrors: Array<{ stage: string; message: string }> = [];

  // Run-scoped SSE state. `lastTopState` ensures task_state dedupes
  // across rebuilds (a rebuilt actor emits idle→running again; we
  // don't want duplicate running events on the SSE stream).
  let lastTopState: TaskTopLevelState | null = null;
  // Once a stage has published a stage_executing / final event, we
  // don't re-publish it in the same attempt; the retry path clears
  // entries for reset stages before the next attempt starts so their
  // executing/done/error can emit again on the retry run.
  const publishedStageExecuting = new Set<string>();
  const publishedStageFinal = new Set<string>();

  // ---- Retry-preserved context (read by next compileIRToMachine) ----
  let persistentPortValues: Record<string, unknown> =
    buildInitialPortValuesRunner(opts.ir, opts.seedValues);
  let persistentRetryCounts: Record<string, number> = {};
  let persistentGateAuthorized: string[] = [];
  let persistentGateSkipped: string[] = [];
  let persistentLog: string[] = [];
  let persistentFinalizedStages: MachineContext["finalizedStages"] = [];
  let isRetryRebuild = false; // drives initialContext.portValues override

  // Stage 5B — resume hydration. When opts.resumeFrom is set, rebuild
  // persistent state from the DB so the first compile starts with
  // finalizedStages + portValues matching what was already computed on
  // the previous pipeline version. The retry machinery then re-invokes
  // resumeFrom and its wire-reachable descendants. Anything wire-upstream
  // of resumeFrom stays finalized and is not re-run.
  if (opts.resumeFrom) {
    const stageNames = new Set(opts.ir.stages.map((s) => s.name));
    if (!stageNames.has(opts.resumeFrom)) {
      const reason: TerminationReason = {
        kind: "error",
        detail: `RESUME_FROM_NOT_IN_IR: stage '${opts.resumeFrom}' absent from pipeline`,
      };
      taskRegistry.signalTermination(opts.taskId, reason);
      taskRegistry.unregister(opts.taskId);
      throw new Error(reason.detail);
    }
    // 1. finalizedStages: every stage_attempt that is still status='success'
    //    for this task. Superseded stages (those the orchestrator just
    //    marked) stay out so the retry loop re-invokes them.
    const successRows = opts.db.prepare(
      `SELECT DISTINCT stage_name FROM stage_attempts
       WHERE task_id = ? AND status = 'success'`,
    ).all(opts.taskId) as Array<{ stage_name: string }>;
    persistentFinalizedStages = successRows.map((r) => ({
      name: r.stage_name,
      outcome: "done" as const,
    }));
    // 2. portValues: every port_value row for a success stage of this
    //    task. Stored in the machine-context shape `<stage>.<port>`.
    const portRows = opts.db.prepare(
      `SELECT pv.stage_name, pv.port_name, pv.value_json
       FROM port_values pv
       INNER JOIN stage_attempts sa ON pv.attempt_id = sa.attempt_id
       WHERE sa.task_id = ? AND sa.status = 'success'
       ORDER BY pv.written_at ASC`,
    ).all(opts.taskId) as Array<{
      stage_name: string; port_name: string; value_json: string;
    }>;
    for (const r of portRows) {
      try {
        persistentPortValues[`${r.stage_name}.${r.port_name}`] = JSON.parse(r.value_json);
      } catch {
        // Corrupt JSON — skip this port value; the new run will fail at
        // its first consumer with NO_ACTIVE_WIRE or similar, which is
        // the correct surface for this rare condition.
      }
    }
    // 3. Tell compiler to honour initialContext.
    isRetryRebuild = true;
  }
  // Task 6 — gates that were rejected in the current run. On rebuild,
  // the replay loop skips synthesising a GATE_ANSWERED for these so the
  // gate re-enters `executing` and blocks for a fresh external answer.
  // Scoped to the whole run (not just one attempt): a gate that was
  // rejected earlier must never replay its stale answer on any later
  // rebuild, even if a subsequent retry rebuild sits between the
  // rollback and the approve.
  const rejectFromGates = new Set<string>();

  // The most recent machine context from the subscriber. Updated on
  // every snapshot so the retry inspector can read the latest context
  // without relying on getSnapshot() (which may return a stale snapshot
  // during a microstep). Per-attempt; reset before each attempt.
  let latestContext: MachineContext | null = null;

  // ---- Publishing + run-level coordination --------------------------
  const publish = (event: AnyKernelNextSSEEvent): void => {
    if (!opts.broadcaster) return;
    try {
      opts.broadcaster.publish(event as KernelNextSSEEvent);
    } catch { /* broadcaster failure must not abort the run */ }
  };
  const isoNow = (): string => new Date().toISOString();

  // Timer is run-scoped: a retry does not reset the overall budget.
  // Long pipelines should set timeoutMs explicitly.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // Attempt in flight will observe via currentActor.stop() when the
    // outer loop unwinds; we surface as a thrown error on the outer
    // runPipeline promise.
  }, timeoutMs);

  // Task 1.8 — seed phase (externalInputs). Run once (regardless of
  // retries) so lineage and SSE observe the external seeds exactly
  // once. The compiler's initial context.portValues carries the same
  // values so the first attempt's stages see them immediately.
  const externalInputs = opts.ir.externalInputs ?? [];
  if (externalInputs.length > 0 && !opts.resumeFrom) {
    const seedValues = opts.seedValues ?? {};
    for (const port of externalInputs) {
      if (!(port.name in seedValues)) {
        clearTimeout(timer);
        taskRegistry.signalTermination(opts.taskId, {
          kind: "error",
          detail: `SEED_VALUES_MISSING_KEY: ${port.name}`,
        });
        taskRegistry.unregister(opts.taskId);
        throw new Error(
          `SEED_VALUES_MISSING_KEY: external input '${port.name}' has no seed value`,
        );
      }
    }
    for (const key of Object.keys(seedValues)) {
      if (!externalInputs.some((p) => p.name === key)) {
        logger.warn(
          { taskId: opts.taskId, key },
          "SEED_VALUES_UNEXPECTED_KEY: seedValues contains a key not declared in externalInputs",
        );
      }
    }
    const { attemptId } = portRuntime.startAttempt({
      taskId: opts.taskId,
      versionHash: opts.versionHash,
      stageName: "__external__",
      kind: "external",
    });
    for (const port of externalInputs) {
      portRuntime.writePort({
        attemptId,
        stageName: "__external__",
        portName: port.name,
        value: seedValues[port.name],
      });
    }
    portRuntime.finishAttempt(attemptId, "success");
  }

  // ---- Main retry loop ---------------------------------------------
  let totalAttempts = 0;
  let finalOutcome:
    | { verdict: "completed" | "failed"; snapshot: unknown }
    | null = null;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      totalAttempts += 1;
      if (totalAttempts > MAX_TOTAL_ATTEMPTS) {
        throw new Error(
          `runPipeline retry loop exceeded ${MAX_TOTAL_ATTEMPTS} attempts — likely a bug`,
        );
      }
      const verdict = await runOneAttempt();
      if (verdict.verdict === "completed" || verdict.verdict === "failed") {
        finalOutcome = verdict;
        break;
      } else if (verdict.verdict === "rollback") {
        // Task 6 — reject rollback. Prune every affectedStage out of
        // persistent state and rebuild with isRetryRebuild = true so
        // the next compile honours initialContext. The rejected gate is
        // recorded in rejectFromGates so the gate-replay loop doesn't
        // synthesise a GATE_ANSWERED for it; when the rebuilt machine
        // enters the gate's region it will re-open the gate in
        // `executing` and wait for a fresh external answer.
        const { contextAtRollback, fromGate, affectedStages } = verdict;
        const affected = new Set(affectedStages);

        // Port values: drop every key whose `stageName` prefix is affected.
        // Seeds live under `__external__.<port>` which is never added to
        // affectedStages, so they survive the prune intact.
        persistentPortValues = Object.fromEntries(
          Object.entries(contextAtRollback.portValues).filter(([key]) => {
            const [stageName] = key.split(".");
            return !affected.has(stageName ?? "");
          }),
        );
        // finalizedStages: drop entries for every affected stage so they
        // re-enter `waiting` on the rebuilt actor instead of short-
        // circuiting through the finalized-short-circuit branches.
        persistentFinalizedStages = contextAtRollback.finalizedStages.filter(
          (f) => !affected.has(f.name),
        );
        // Gate authorization state: drop entries that target the affected
        // stages. An unpicked-sibling skip targeting the gate itself is
        // dropped so the gate re-enters its waiting-then-executing path.
        persistentGateAuthorized = contextAtRollback.gateAuthorizedTargets.filter(
          (t) => !affected.has(t),
        );
        persistentGateSkipped = contextAtRollback.gateSkippedTargets.filter(
          (t) => !affected.has(t),
        );
        // Retry counts: drop per-stage counts for affected stages so the
        // rebuilt machine's retry budget starts fresh for those stages.
        persistentRetryCounts = Object.fromEntries(
          Object.entries(contextAtRollback.retryCounts).filter(
            ([stageName]) => !affected.has(stageName),
          ),
        );
        // Log continuity: drop entries for affected stages.
        persistentLog = contextAtRollback.log.filter((entry) => {
          const colonIdx = entry.indexOf(":");
          if (colonIdx < 0) return true;
          const stageName = entry.slice(0, colonIdx);
          return !affected.has(stageName);
        });
        // stageErrors: drop entries for affected stages.
        const preservedStageErrors = stageErrors.filter(
          (e) => !affected.has(e.stage),
        );
        stageErrors.length = 0;
        stageErrors.push(...preservedStageErrors);
        // SSE dedupe + dispatched sets: clear entries for affected stages
        // so their stage_executing / stage_done / stage_error events can
        // re-emit on the rebuilt actor.
        for (const name of affected) {
          publishedStageExecuting.delete(name);
          publishedStageFinal.delete(name);
          dispatched.delete(name);
        }
        // Mark the rejected gate so the replay loop skips it. Stays set
        // across subsequent rebuilds — a rejected gate must never replay
        // its stale answer, even if an unrelated retry rebuild intervenes.
        rejectFromGates.add(fromGate);
        isRetryRebuild = true;
        continue;
      }
      // verdict.verdict === "retry": apply the transformations and loop.
      // Narrow explicitly because TS doesn't propagate control-flow
      // narrowing through the else-if chain above across the `continue`
      // that terminates the rollback branch.
      if (verdict.verdict !== "retry") {
        throw new Error(`runPipeline: unexpected verdict ${JSON.stringify(verdict)}`);
      }
      const { failedStageName, backToStage, retryIdx, maxRetries, errorMessage } =
        verdict.event;
      // contextAtRetry carries the machine context at the moment the retry
      // was triggered — captured in the inspector before actor.stop(). Use
      // it to seed the persistent variables so non-reset stages (upstream
      // agents, already-answered gates) carry their state into the rebuild.
      const retryCtx = verdict.contextAtRetry;

      publish({
        type: "stage_retry",
        taskId: opts.taskId,
        timestamp: isoNow(),
        data: {
          stage: failedStageName,
          backToStage,
          retryIdx,
          maxRetries,
          errorMessage,
        },
      });

      // Compute the downstream closure of backToStage — every stage
      // whose outputs depend on backToStage (transitively). These plus
      // backToStage itself form the set of stages we reset: their port
      // values are cleared (so their downstream waiting.always guards
      // stay false until the upstream re-runs), their finalizedStages
      // entries are dropped, and their SSE dedupe entries are cleared.
      const downstream = topoDownstream(opts.ir.wires, backToStage);
      const toReset = new Set<string>([backToStage, ...downstream]);

      persistentRetryCounts = {
        ...retryCtx.retryCounts,
        [failedStageName]:
          (retryCtx.retryCounts[failedStageName] ?? 0) + 1,
      };

      // Seed from the current actor's portValues, then drop reset stages.
      // Keys are `<stageName>.<port>` so prefix-match on the stage part.
      persistentPortValues = Object.fromEntries(
        Object.entries(retryCtx.portValues).filter(([key]) => {
          const [stageName] = key.split(".");
          return !toReset.has(stageName ?? "");
        }),
      );

      // Seed from the current actor's finalizedStages, then drop reset stages.
      persistentFinalizedStages = retryCtx.finalizedStages.filter(
        (f) => !toReset.has(f.name),
      );

      // Seed gate authorization from the current context (already preserved
      // across retries by design §4.3 — gates don't need re-answering when
      // a downstream script fails). We take it from retryCtx so it's
      // consistent with the rest of the captured state.
      persistentGateAuthorized = [...retryCtx.gateAuthorizedTargets];
      persistentGateSkipped = [...retryCtx.gateSkippedTargets];

      // stageErrors: keep entries for stages NOT being reset (they
      // won't re-run and so are terminal in their own right).
      const preservedStageErrors = stageErrors.filter(
        (e) => !toReset.has(e.stage),
      );
      stageErrors.length = 0;
      stageErrors.push(...preservedStageErrors);

      // SSE dedupe sets: clear entries for reset stages.
      for (const name of toReset) {
        publishedStageExecuting.delete(name);
        publishedStageFinal.delete(name);
        dispatched.delete(name);
      }

      // Log-continuity: seed from the current context, then filter reset
      // stages. Log entries look like `<stageName>:<substate>`; the
      // leading token up to `:` is the stage name.
      persistentLog = retryCtx.log.filter((entry) => {
        const colonIdx = entry.indexOf(":");
        if (colonIdx < 0) return true;
        const stageName = entry.slice(0, colonIdx);
        return !toReset.has(stageName);
      });

      isRetryRebuild = true;
    }
  } finally {
    clearTimeout(timer);
    if (currentActor) {
      try { currentActor.stop(); } catch { /* ignore */ }
    }
    // Stage 5B — signal termination reason before unregister so
    // awaitTermination waiters (migration orchestrator) can distinguish
    // natural completion / interrupt / error paths. Order by priority:
    //   - timedOut: kind=error (runner exceeded timeoutMs)
    //   - interruptObserved: kind=interrupted (external INTERRUPT delivered)
    //   - finalOutcome.verdict='completed': kind=natural
    //   - finalOutcome.verdict='failed': kind=error with stage/message
    //   - else (no outcome reached): kind=error (likely thrown)
    let terminationReason: TerminationReason;
    if (timedOut) {
      terminationReason = { kind: "error", detail: `runPipeline timeout after ${timeoutMs}ms` };
    } else if (interruptObserved) {
      terminationReason = { kind: "interrupted" };
    } else if (finalOutcome?.verdict === "completed") {
      terminationReason = { kind: "natural" };
    } else if (finalOutcome?.verdict === "failed") {
      terminationReason = { kind: "error", detail: "run ended with failed verdict" };
    } else {
      terminationReason = { kind: "error", detail: "runner exited without reaching final outcome" };
    }
    taskRegistry.signalTermination(opts.taskId, terminationReason);
    taskRegistry.unregister(opts.taskId);
  }

  if (timedOut) {
    throw new Error(`runPipeline timeout after ${timeoutMs}ms`);
  }
  if (!finalOutcome) {
    // Should be unreachable — the while(true) only exits via break or throw.
    throw new Error("runPipeline: retry loop exited without a final verdict");
  }

  // ---- Finalization: drain pending promises + compute finalState ----
  // (moved out of runOneAttempt so the draining observes all run-scoped
  // state after the last attempt completed.)
  const snapshot = finalOutcome.snapshot as {
    value: "completed" | "failed";
    context: MachineContext;
  };
  const ctx = snapshot.context;

  // Promote finalState to 'failed' if any stage's LATEST attempt
  // ended with status='error'. The subquery picks the row with the
  // highest attempt_idx per (task, stage); the outer count reports
  // stages whose final attempt ended in error.
  const errorRow = opts.db.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT sa.status FROM stage_attempts sa
       WHERE sa.task_id = ?
         AND sa.attempt_idx = (
           SELECT MAX(sa2.attempt_idx) FROM stage_attempts sa2
           WHERE sa2.task_id = sa.task_id AND sa2.stage_name = sa.stage_name
         )
     ) t
     WHERE t.status = 'error'`,
  ).get(opts.taskId) as { n: number };

  // Task C5 — intra-actor retry reconciliation. The compiler's retry
  // transition targets `waiting`, which re-promotes via waiting.always
  // back into `executing` within the SAME actor before runner's
  // inspector can stop it. Any invoke IIFE that ran between STAGE_FAILED
  // and actor.stop() already pushed to stageErrors. If that stage's
  // LATEST DB attempt ultimately succeeded (via either the same-actor
  // re-entry or a rebuilt-actor attempt), those stageErrors entries are
  // no longer terminal — filter them out so the final RunResult matches
  // the DB truth.
  //
  // The stage-level filter uses a per-stage "latest attempt succeeded"
  // lookup. We cannot do this earlier because an attempt's outcome is
  // only authoritative once the DB row reaches its terminal status.
  const succeededStages = new Set<string>();
  const succeededRows = opts.db.prepare(
    `SELECT sa.stage_name FROM stage_attempts sa
     WHERE sa.task_id = ?
       AND sa.attempt_idx = (
         SELECT MAX(sa2.attempt_idx) FROM stage_attempts sa2
         WHERE sa2.task_id = sa.task_id AND sa2.stage_name = sa.stage_name
       )
       AND sa.status = 'success'`,
  ).all(opts.taskId) as Array<{ stage_name: string }>;
  for (const row of succeededRows) succeededStages.add(row.stage_name);
  const reconciledStageErrors = stageErrors.filter(
    (e) => !succeededStages.has(e.stage),
  );
  stageErrors.length = 0;
  stageErrors.push(...reconciledStageErrors);

  const finalState: "completed" | "failed" =
    snapshot.value === "failed" ||
    errorRow.n > 0 ||
    drainErrors.length > 0 ||
    stageErrors.length > 0
      ? "failed"
      : "completed";

  publish({
    type: "run_final",
    taskId: opts.taskId,
    timestamp: isoNow(),
    data: {
      finalState,
      stageErrors: stageErrors.map((e) => ({ stage: e.stage, message: e.message })),
    },
  });

  return {
    finalState,
    portValues: ctx.portValues,
    log: ctx.log,
    drainErrors,
    stageErrors,
  };

  // ---- runOneAttempt: one actor lifecycle --------------------------
  // Declared as a closure so it can see and mutate all run-scoped
  // state (publish, dispatched, stageErrors, etc.) without a
  // parameter list explosion.
  async function runOneAttempt(): Promise<AttemptVerdict> {
    // Compile a fresh machine. When this is a retry rebuild we pass
    // initialContext so the new machine starts with the preserved
    // portValues / retryCounts / gate authorizations; first-attempt
    // path leaves initialContext undefined so the existing seedValues
    // → buildInitialPortValues codepath still runs.
    const { machine, stageMeta } = compileIRToMachine(opts.ir, {
      taskId: opts.taskId,
      seedValues: opts.seedValues,
      initialContext: isRetryRebuild
        ? {
            portValues: persistentPortValues,
            retryCounts: persistentRetryCounts,
            gateAuthorizedTargets: persistentGateAuthorized,
            gateSkippedTargets: persistentGateSkipped,
            log: persistentLog,
            finalizedStages: persistentFinalizedStages,
          }
        : undefined,
    });

    // Per-attempt executor-promises array. On retry, the outer loop
    // abandons the attempt and merges any drain-time messages into
    // run-scoped drainErrors via the p.catch below. Invoke'd (non-
    // fanout) stages don't populate this array — XState's actor
    // lifecycle owns their cancellation.
    const executorPromises: Array<Promise<void>> = [];

    const executeStageLogic = fromCallback<
      { type: "INTERRUPT" },
      ExecuteStageInvokeInput
    >(({ input, receive }) => {
      const stageDef = opts.ir.stages.find((s) => s.name === input.stageName);
      if (!stageDef) {
        throw new Error(`invoke: stage '${input.stageName}' not found in IR`);
      }
      if (stageDef.type === "gate") {
        throw new Error(`invoke: gate stage '${input.stageName}' should not reach execute_stage`);
      }
      if ((stageDef.type === "agent" || stageDef.type === "script") && stageDef.fanout) {
        return;
      }

      const versionHash = input.versionHash || opts.versionHash;
      const ac = new AbortController();
      receive((ev) => {
        if (ev.type === "INTERRUPT") ac.abort();
      });

      let executorDone = false;
      void (async () => {
        try {
          const result = await executor.executeStage({
            ir: opts.ir,
            stageName: input.stageName,
            taskId: input.taskId,
            versionHash,
            portValues: input.portValues,
            handlers: opts.handlers,
            portRuntime,
            signal: ac.signal,
          });
          if (result.status === "error") {
            stageErrors.push({ stage: input.stageName, message: result.error ?? "unspecified" });
            dispatcher.send({
              type: "STAGE_FAILED",
              stage: input.stageName,
              error: result.error ?? "unspecified",
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          stageErrors.push({ stage: input.stageName, message });
          dispatcher.send({
            type: "STAGE_FAILED",
            stage: input.stageName,
            error: message,
          });
        } finally {
          executorDone = true;
        }
      })();

      return () => {
        if (!executorDone && !ac.signal.aborted) ac.abort();
      };
    });

    const providedMachine = machine.provide({
      actors: { execute_stage: executeStageLogic },
    });

    return new Promise<AttemptVerdict>((resolveAttempt, rejectAttempt) => {
      // Attempt-scoped retry-triggered flag. Prevents double-resolution
      // if another snapshot landed between RETRY_TO_STAGE inspection and
      // the outer while-loop re-entering runOneAttempt.
      let retryTriggered = false;
      // Task 6 — attempt-scoped rollback-triggered flag. Same role as
      // retryTriggered: prevents the subscriber / inspector from racing
      // against the rollback resolve.
      let rollbackTriggered = false;
      let attemptEnded = false;
      // Forward-ref: the actor is assigned below; the inspector needs
      // to call .stop() on it when RETRY_TO_STAGE is observed so the
      // compiler's post-retry `waiting` → (always) → `executing` path
      // doesn't re-fire the executor in the outgoing actor.
      // eslint-disable-next-line prefer-const
      let thisActor: ReturnType<typeof createActor> | null = null;

      // Install the run-scoped rejectHandler so external GATE_REJECTED
      // events routed through `dispatcher.send` land here. The handler
      // captures context from `latestContext` (same technique as the
      // retry inspector), publishes the stage_rolled_back SSE, stops
      // the actor, and resolves the attempt with a "rollback" verdict.
      // The outer loop reads the verdict and performs the persistent-
      // state prune + rebuild.
      rejectHandler = (ev) => {
        if (rollbackTriggered || retryTriggered || attemptEnded) return;
        rollbackTriggered = true;
        const contextAtRollback =
          latestContext
          ?? (thisActor?.getSnapshot() as { context: MachineContext } | undefined)?.context
          ?? null;
        if (!contextAtRollback) {
          // No actor yet — nothing to roll back. Ignore.
          rollbackTriggered = false;
          return;
        }
        publish({
          type: "stage_rolled_back",
          taskId: opts.taskId,
          timestamp: isoNow(),
          data: {
            fromGate: ev.stageName,
            toStage: ev.targetStage,
            affectedStages: ev.affectedStages,
          },
        });
        if (thisActor) {
          try { thisActor.stop(); } catch { /* ignore */ }
        }
        resolveAttempt({
          verdict: "rollback",
          contextAtRollback,
          fromGate: ev.stageName,
          toStage: ev.targetStage,
          affectedStages: ev.affectedStages,
        });
      };

      // Inspector catches raise'd events (the compiler's retry
      // transition uses raise()) which surface on either
      // @xstate.microstep or @xstate.event depending on XState v5's
      // internal routing. The compiler test (Task C1) also matches on
      // both — we reuse the exact shape here.
      const inspector = (inspEvent: { type?: string; event?: unknown }): void => {
        if (retryTriggered || rollbackTriggered || attemptEnded) return;
        if (
          inspEvent.type !== "@xstate.event" &&
          inspEvent.type !== "@xstate.microstep"
        ) {
          return;
        }
        const ev = inspEvent.event as Record<string, unknown> | undefined;
        if (!ev || ev.type !== "RETRY_TO_STAGE") return;
        retryTriggered = true;
        // Capture the current machine context BEFORE stopping the actor.
        // This snapshot includes portValues / finalizedStages / gate
        // authorizations for every stage that ran successfully up to
        // this point — the outer loop uses it to seed persistentPortValues
        // so non-reset stages (e.g. an already-answered gate, upstream
        // agents) carry their outputs into the rebuilt machine without
        // having to re-run.
        // Use the subscriber-tracked latestContext rather than getSnapshot().
        // The subscriber fires on every committed snapshot and captures the
        // most recent machine context; getSnapshot() during a microstep can
        // return a stale snapshot that predates GATE_ANSWERED / other events
        // processed in the same event-loop tick.
        const contextAtRetry = latestContext ?? (thisActor!.getSnapshot() as { context: MachineContext }).context;
        // Stop the outgoing actor SYNCHRONOUSLY. The compiler's retry
        // transition targets `waiting`, so the moment this inspector
        // returns, XState will continue the microstep chain:
        // waiting.always reads portValues (still carrying upstream
        // outputs) and promotes the failed stage right back to
        // `executing`, which in the invoke'd path re-dispatches the
        // executor. That second dispatch is the exact duplicate run
        // we're rebuilding the actor to avoid — stop NOW to cut it off.
        if (thisActor) {
          try { thisActor.stop(); } catch { /* ignore */ }
        }
        resolveAttempt({
          verdict: "retry",
          contextAtRetry,
          event: {
            failedStageName: String(ev.failedStageName),
            backToStage: String(ev.backToStage),
            retryIdx: Number(ev.retryIdx),
            maxRetries: Number(ev.maxRetries),
            errorMessage: String(ev.errorMessage),
          },
        });
      };

      const actor = createActor(providedMachine, { inspect: inspector });
      thisActor = actor;
      currentActor = actor;

      // Reset per-attempt latest context tracker.
      latestContext = null;

      actor.subscribe((snapshot) => {
        // Always update latestContext, even when retryTriggered /
        // rollbackTriggered — the inspector + rejectHandler fire during
        // microstep processing and need the most recent committed
        // snapshot context.
        latestContext = snapshot.context as MachineContext;

        if (retryTriggered || rollbackTriggered || attemptEnded) return;
        if (timedOut) {
          attemptEnded = true;
          // Let the outer .finally handle actor.stop / unregister.
          rejectAttempt(new Error(`runPipeline timeout after ${timeoutMs}ms`));
          return;
        }

        const topValue = snapshot.value;
        const topState: TaskTopLevelState =
          topValue === "idle" ? "idle"
          : topValue === "completed" ? "completed"
          : topValue === "failed" ? "failed"
          : "running";
        // Dedupe across attempts. A rebuilt actor starts in `idle` and
        // immediately transitions to `running`; treat both transitions
        // as no-ops since lastTopState is run-scoped and already
        // reflects the active run state. Only publish monotonic
        // forward transitions (idle → running → completed|failed).
        const shouldPublishTopState =
          topState !== lastTopState &&
          !(lastTopState !== null && topState === "idle") &&
          !(lastTopState === "running" && topState === "running");
        if (shouldPublishTopState) {
          lastTopState = topState;
          publish({
            type: "task_state",
            taskId: opts.taskId,
            timestamp: isoNow(),
            data: { state: topState },
          });
        }

        {
          const ctx2 = snapshot.context as MachineContext;
          for (const entry of ctx2.finalizedStages) {
            const { name: stageName, outcome, reason } = entry;
            if (publishedStageFinal.has(stageName)) continue;
            publishedStageFinal.add(stageName);
            if (outcome === "done") {
              // If this stage was previously rejected (Task 6), its successful
              // re-answer means subsequent retry rebuilds should replay the
              // new approved answer rather than re-opening the gate.
              if (rejectFromGates.has(stageName)) {
                rejectFromGates.delete(stageName);
              }
              publish({
                type: "stage_done",
                taskId: opts.taskId,
                timestamp: isoNow(),
                data: { stage: stageName },
              });
            } else {
              if (reason === "executor_failed") {
                const stageErr = stageErrors.find((e) => e.stage === stageName);
                publish({
                  type: "stage_error",
                  taskId: opts.taskId,
                  timestamp: isoNow(),
                  data: {
                    stage: stageName,
                    message: stageErr?.message ?? "stage executor failed",
                    reason: "executor_failed",
                  },
                });
              } else {
                const err = buildNoActiveWireError(stageName, stageMeta, ctx2.portValues);
                publish({
                  type: "stage_error",
                  taskId: opts.taskId,
                  timestamp: isoNow(),
                  data: {
                    stage: stageName,
                    message: err.message,
                    reason: "no_active_wire",
                    context: err.context,
                  },
                });
              }
            }
          }
        }

        if ((snapshot.value === "completed" || snapshot.value === "failed") && !attemptEnded) {
          attemptEnded = true;
          const ctx2 = snapshot.context as MachineContext;
          for (const entry of ctx2.finalizedStages) {
            if (entry.outcome !== "error") continue;
            if (dispatched.has(entry.name)) continue;
            dispatched.add(entry.name);
            if (entry.reason === "executor_failed") continue;
            stageErrors.push(
              buildNoActiveWireError(entry.name, stageMeta, ctx2.portValues),
            );
          }
          // Persist context for the outer loop's finalization + retry
          // rebuild. These are harmless for the terminal attempt
          // (retry verdict path doesn't reach here) and keep
          // bookkeeping in one place.
          persistentPortValues = ctx2.portValues;
          persistentLog = ctx2.log;
          persistentFinalizedStages = [...ctx2.finalizedStages];
          persistentGateAuthorized = [...ctx2.gateAuthorizedTargets];
          persistentGateSkipped = [...ctx2.gateSkippedTargets];
          persistentRetryCounts = { ...ctx2.retryCounts };

          Promise.allSettled(executorPromises).then(() => {
            resolveAttempt({
              verdict: snapshot.value as "completed" | "failed",
              snapshot,
            });
          });
          return;
        }

        const running = (snapshot.value as { running?: Record<string, string> }).running;
        if (!running) return;

        for (const [stageName, substate] of Object.entries(running)) {
          if (substate === "error" && !dispatched.has(stageName)) {
            dispatched.add(stageName);
            const ctx2 = snapshot.context as MachineContext;
            const finalized = ctx2.finalizedStages.find((f) => f.name === stageName);
            if (finalized?.reason !== "executor_failed") {
              stageErrors.push(
                buildNoActiveWireError(stageName, stageMeta, ctx2.portValues),
              );
            }
            continue;
          }
          if (substate === "executing" && !dispatched.has(stageName)) {
            dispatched.add(stageName);

            const stageDef = opts.ir.stages.find((s) => s.name === stageName);
            if (stageDef?.type === "gate") {
              const gateStage = stageDef as GateStage;
              const { attemptId } = portRuntime.startAttempt({
                taskId: opts.taskId,
                versionHash: opts.versionHash,
                stageName,
              });
              kernel.createGate({
                taskId: opts.taskId,
                stageName,
                attemptId,
                question: gateStage.config.question,
              });
              if (!publishedStageExecuting.has(stageName)) {
                publishedStageExecuting.add(stageName);
                publish({
                  type: "stage_executing",
                  taskId: opts.taskId,
                  timestamp: isoNow(),
                  data: { stage: stageName, attemptId },
                });
              }
              continue;
            }

            const ctx2 = snapshot.context as MachineContext;

            if (
              (stageDef?.type === "agent" || stageDef?.type === "script") &&
              stageDef?.fanout
            ) {
              if (!publishedStageExecuting.has(stageName)) {
                publishedStageExecuting.add(stageName);
                publish({
                  type: "stage_executing",
                  taskId: opts.taskId,
                  timestamp: isoNow(),
                  data: { stage: stageName },
                });
              }
              const fanoutStage = stageDef;
              const p = orchestrateFanoutStage({
                ir: opts.ir,
                stageDef: fanoutStage,
                taskId: opts.taskId,
                versionHash: opts.versionHash,
                basePortValues: ctx2.portValues,
                handlers: opts.handlers,
                db: opts.db,
                livePortRuntime: portRuntime,
                executor,
              }).then((result) => {
                if (result.status === "error") {
                  stageErrors.push({ stage: stageName, message: result.error });
                  dispatcher.send({
                    type: "STAGE_FAILED",
                    stage: stageName,
                    error: result.error,
                  });
                }
              }, (err: unknown) => {
                const message = err instanceof Error ? err.message : String(err);
                if (!attemptEnded) {
                  rejectAttempt(err instanceof Error ? err : new Error(message));
                } else {
                  drainErrors.push({ stage: stageName, message });
                }
              });
              executorPromises.push(p);
              continue;
            }

            if (!publishedStageExecuting.has(stageName)) {
              publishedStageExecuting.add(stageName);
              publish({
                type: "stage_executing",
                taskId: opts.taskId,
                timestamp: isoNow(),
                data: { stage: stageName },
              });
            }
          }
        }
      });

      actor.start();
      actor.send({ type: "START" });

      // Retry-rebuild: re-answer gates that were already resolved in the
      // previous attempt. On the rebuilt machine, every gate stage starts
      // fresh in `waiting` → `executing` regardless of context. A gate
      // in `executing` will block the pipeline until it receives
      // GATE_ANSWERED. For gates already in persistentFinalizedStages,
      // we synthesize the answer from gateAuthorizedTargets so the rebuilt
      // machine can proceed without requiring external re-answering.
      //
      // A gate's "picked" targetStage is recovered by finding the route
      // entry whose value(s) all appear in persistentGateAuthorized.
      // If no route matches (malformed IR), we skip — the gate will
      // block and eventually time out, which is the safe-fail behavior.
      if (isRetryRebuild) {
        for (const finalized of persistentFinalizedStages) {
          if (finalized.outcome !== "done") continue;
          // Task 6 — a gate that was rejected earlier in this run must
          // not replay its stale answer on the rebuilt actor. Defense-
          // in-depth: rejected gates are also pruned out of
          // persistentFinalizedStages at rollback time, so this guard
          // fires only if some later code path re-injects the entry.
          if (rejectFromGates.has(finalized.name)) continue;
          const gateStage = opts.ir.stages.find(
            (s) => s.name === finalized.name && s.type === "gate",
          ) as GateStage | undefined;
          if (!gateStage) continue;
          // Find the route that was taken: all targets are in
          // persistentGateAuthorized.
          let pickedAnswer: string | undefined;
          let pickedTarget: string | string[] | undefined;
          const authorized = new Set(persistentGateAuthorized);
          for (const [answer, target] of Object.entries(
            gateStage.config.routing.routes,
          )) {
            const targets = Array.isArray(target) ? target : [target];
            if (targets.every((t) => authorized.has(t))) {
              pickedAnswer = answer;
              pickedTarget = target;
              break;
            }
          }
          if (pickedAnswer === undefined || pickedTarget === undefined) continue;
          // Dispatch a synthetic GATE_ANSWERED. The gate region will
          // transition to `done`; the root-level handler updates
          // gateAuthorizedTargets (idempotent — targets are already there).
          // We use a deterministic synthetic gateId since the gate_queue
          // row for this rebuilt attempt is not created (dispatched still
          // has the gate's stageName). This id is never stored in the DB.
          logger.debug({ taskId: opts.taskId, stageName: gateStage.name, pickedAnswer }, "runner: dispatching synthetic GATE_ANSWERED for retry rebuild");
          dispatcher.send({
            type: "GATE_ANSWERED",
            gateId: `__retry_synthetic__${gateStage.name}`,
            stageName: gateStage.name,
            answer: pickedAnswer,
            targetStage: pickedTarget,
          });
        }
      }
    }).finally(() => {
      // Task 6 — clear the attempt-scoped reject hook so a late-arriving
      // GATE_REJECTED (e.g. user answered `reject` AFTER the pipeline
      // completed) doesn't invoke a resolver from the previous attempt.
      rejectHandler = null;
      if (currentActor) {
        try { currentActor.stop(); } catch { /* ignore */ }
      }
    });
  }
}

// Local mirror of the compiler-side buildInitialPortValues. Having a
// runner-local copy means we can prime `persistentPortValues` without
// exporting compiler internals; values are identical to what
// compileIRToMachine produces on the first compile.
function buildInitialPortValuesRunner(
  ir: PipelineIR,
  seedValues: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!seedValues || !ir.externalInputs || ir.externalInputs.length === 0) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const port of ir.externalInputs) {
    if (port.name in seedValues) {
      out[`__external__.${port.name}`] = seedValues[port.name];
    }
  }
  return out;
}

interface RunFanoutArgs {
  ir: PipelineIR;
  stageDef: import("../ir/schema.js").AgentStage | import("../ir/schema.js").ScriptStage;
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

type FanoutResult =
  | { status: "success" }
  | { status: "error"; error: string };

/**
 * Orchestrate a fanout stage: iterate the source port's array, execute
 * the stage once per element against a silent PortRuntime, then
 * aggregate every declared output into an array and dispatch one
 * PORT_WRITTEN per output via the live dispatcher.
 *
 * Why this is not a StageExecutor (i.e. not routed through
 * CompositeStageExecutor):
 *   - CompositeStageExecutor picks a per-stage-type delegate (agent /
 *     script / gate) to run ONE execution of ONE stage. Its
 *     ExecuteStageArgs surface deliberately has no access to db /
 *     livePortRuntime / the aggregate-attempt concept.
 *   - Fanout is not "another stage type". It is an orchestration
 *     pattern that runs the underlying agent/script executor N times
 *     against a silent PortRuntime, then opens a separate aggregate
 *     attempt (kind='fanout_aggregate') to materialise T[] outputs and
 *     wake downstream guards. It spans N+1 stage_attempts for one
 *     stage-region transition.
 *   - Forcing it into Composite would either leak runtime internals
 *     (db, livePortRuntime) into every ExecuteStageArgs or wrap this
 *     function in a closure-based StageExecutor whose implementation
 *     still lives in runner — change in shape, not in substance.
 *
 * It therefore sits alongside the invoke-driven per-stage execution
 * path, not inside it. Composite is the execution layer; this is the
 * orchestration layer.
 *
 * Scope (A3.3): sequential execution, no concurrency pool, first
 * element error fails the stage. Preserves existing lineage (each
 * attempt writes its own port_values rows normally; attempt kind is
 * set via the silent runtime's defaultKind — see Debt #7).
 */
async function orchestrateFanoutStage(args: RunFanoutArgs): Promise<FanoutResult> {
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
  const aggregated: Record<string, unknown[]> = {};
  for (const name of declaredOutputs) aggregated[name] = [];

  for (let i = 0; i < sourceValue.length; i++) {
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
    });

    if (result.status === "error") {
      return {
        status: "error",
        error: `fanout element ${i}/${sourceValue.length} failed: ${result.error ?? "unspecified"}`,
      };
    }

    // Collect this attempt's output port values from the DB.
    const rows = silentRuntime.readWritesForAttempt(result.attemptId);
    const byPort = new Map<string, unknown>();
    for (const r of rows) byPort.set(r.port, r.value);
    for (const name of declaredOutputs) {
      aggregated[name]!.push(byPort.get(name));
    }
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

// NO_ACTIVE_WIRE diagnostic builder (design §6.2). When a stage's parallel
// region reaches its `error` final, the compiler has already concluded that
// every inbound wire is non-deliverable. To let the AI author debug it,
// we re-walk the stage's inbound wires here and record, per wire, WHY it
// failed: upstream unwritten, guard evaluated false, or guard threw.
// Stages with no inbound wires never hit this path (they don't have a
// "wires died" failure mode).
const PREVIEW_BYTES = 200;

function buildNoActiveWireError(
  stageName: string,
  stageMeta: Map<string, StageMeta>,
  portValues: Record<string, unknown>,
): { stage: string; message: string; context: StageErrorContext } {
  const meta = stageMeta.get(stageName);
  const failedWires: GuardFailure[] = [];
  if (meta) {
    for (const w of meta.inbound) {
      const desc = describeWireFailure(w, portValues);
      // Deliverable wires (guard true) are not recorded — the AI is
      // debugging the wires that DID NOT deliver. A stage in NO_ACTIVE_
      // WIRE has at least one such wire; we expose them all.
      if (desc) failedWires.push(desc);
    }
  }
  return {
    stage: stageName,
    message: `NO_ACTIVE_WIRE: every inbound wire to '${stageName}' resolved false — stage cannot activate`,
    context: { failedWires },
  };
}

// Returns null when the wire DELIVERED (source written + guard true, or
// guardless + source written); otherwise returns a GuardFailure record
// explaining why it didn't.
function describeWireFailure(
  wire: InboundWireMeta,
  portValues: Record<string, unknown>,
): GuardFailure | null {
  const base = {
    wire: { from: wire.from, to: wire.to },
    guardExpr: wire.guard ?? null,
  };
  if (!(wire.sourceKey in portValues)) {
    return { ...base, valuePreview: "<never written>", reason: "upstream-not-written" };
  }
  const raw = portValues[wire.sourceKey];
  const valuePreview = truncateJson(raw);
  if (!wire.guard) {
    // Guardless + settled → wire delivered. Not a failure.
    return null;
  }
  let threw: Error | undefined;
  const ok = evaluateGuard(wire.guard, raw,
    { wireFrom: wire.from, wireTo: wire.to },
    { onError: (err) => { threw = err instanceof Error ? err : new Error(String(err)); } },
  );
  if (threw) {
    return { ...base, valuePreview, reason: "guard-threw", guardError: threw.message };
  }
  return ok ? null : { ...base, valuePreview, reason: "guard-false" };
}

function truncateJson(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    // Circular or non-JSON values: stringify-coerce.
    s = String(v);
  }
  if (s === undefined) s = "undefined";
  if (s.length <= PREVIEW_BYTES) return s;
  return s.slice(0, PREVIEW_BYTES);
}
