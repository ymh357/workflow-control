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
import { access } from "node:fs/promises";
import { logger } from "../../lib/logger.js";
import { compileIRToMachine, buildInitialPortValues } from "../compiler/ir-to-machine.js";
import type {
  MachineContext, MachineEvent, StageMeta,
} from "../compiler/ir-to-machine.js";
import { PortRuntime, type EventDispatcher } from "./port-runtime.js";
import type { AttemptHooks } from "./port-runtime.js";
import { MockStageExecutor, type StageHandlerMap } from "./mock-executor.js";
import type { StageExecutor } from "./executor.js";
import { parseNumTurnsFromStream } from "./real-executor.js";
import type { PipelineIR, GateStage } from "../ir/schema.js";
import { wireFromStage } from "../ir/wire-helpers.js";
import { KernelService } from "../mcp/kernel.js";
import { taskRegistry, type TerminationReason } from "./task-registry.js";
import { topoDownstream } from "./topo-downstream.js";
import type { KernelNextBroadcaster } from "../sse/broadcaster.js";
import type {
  AnyKernelNextSSEEvent,
  KernelNextSSEEvent,
  TaskTopLevelState,
} from "../sse/types.js";
import {
  captureBefore,
  captureAfter,
  resolveCheckpointConfig,
} from "./checkpoint/checkpoint.js";
import type { CheckpointConfig, CheckpointDeps } from "./checkpoint/checkpoint.js";
import * as gitCommands from "./checkpoint/git-commands.js";
import { orchestrateFanoutStage } from "./runner-fanout.js";
import {
  buildNoActiveWireError,
  truncateJson,
  type GuardFailure,
  type StageErrorContext,
} from "./runner-wire-resolver.js";
import { deleteTaskEnvValues } from "./task-env-values.js";
import { computeTaskCost } from "./task-cost-aggregator.js";
import { planSegments } from "./segment-planner.js";

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
  /**
   * M-R5 — when resumeFrom names an agent stage that has a stored
   * session_id from a prior attempt, the caller passes it here and
   * the runner forwards it to the executor as
   * ExecuteStageArgs.resumeSessionId. The executor then issues
   * `options.resume` to the Claude Agent SDK so historical turns are
   * not re-billed. When omitted, stage runs fresh.
   */
  resumeSessionId?: string;
  // Phase 4.5 Step 1 — per-task checkpoint config. When omitted,
  // defaults resolve to { enabled: true, workdir: process.cwd(),
  // maxDiffBytes: 5 MiB, timeouts: {5s, 10s, 10s} }. Set
  // enabled: false to disable entirely (no stage_checkpoints rows).
  checkpointConfig?: CheckpointConfig;
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
      // Bug 28: matches MachineEvent.GATE_REJECTED.targetStage — string for
      // single-target reject, string[] for multi-target reject.
      toStage: string | string[];
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

// Runtime safety cap. Not a product SLO — this is the floor that prevents
// a stuck machine from hanging the process forever. Callers who need a
// tighter per-run bound (tests, fast fail-fast mock paths) pass their
// own explicit value. 30 minutes covers every realistic Claude Agent
// session chain in the 4 builtin pipelines; truly long-running tasks
// are expected to use gate-driven resumption rather than uninterrupted
// runs.
//
// Prior default was 10_000ms (P6-2): too short for any real agent,
// fine for mock handlers but catastrophic for HTTP-triggered runs since
// the runner threw mid-agent-turn and only the first stage's DB rows
// survived, which — pre-task_finals (P6-1) — looked like success to
// the status endpoint.
//
// Raised from 30min → 90min on 2026-04-25 (dogfood Finding 6). Real-world
// pipeline-generator runs against complex specs (37K-char input) routinely
// blow past 30min: analyzing alone burns 9-10 min, persisting agent under
// retry pressure can spend 15-20 min iterating on submit_pipeline diagnostics.
// Per-stage `max_turns` and `max_budget_usd` already cap individual stage
// cost; the global wall-clock ceiling is here to catch wedged runners,
// not to enforce stage-level budgets. 90min is comfortably above the
// observed worst case while still preventing forever-stuck tasks.
export const DEFAULT_RUN_TIMEOUT_MS = 90 * 60 * 1000;

export async function runPipeline(opts: RunnerOptions, timeoutMs = DEFAULT_RUN_TIMEOUT_MS): Promise<RunResult> {
  const executor: StageExecutor =
    opts.executor ?? new MockStageExecutor({ handlers: opts.handlers });

  // Compute segment plan once per runPipeline. The IR is immutable for
  // the lifetime of a run, so this is stable across retries.
  const segments = planSegments(opts.ir);

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
  // Bug 81 (dogfood-13 2026-05-03): run-scoped abort controller that
  // INTERRUPT trips. orchestrateFanoutStage receives this signal and
  // aborts in-flight fanout elements + stops scheduling new ones.
  // Without it, INTERRUPT only reached the XState actor via
  // currentActor.send and the actor.stop() grace timeout — but
  // detached fanout promises live OUTSIDE the actor and ignore both.
  // Created per-attempt at runOneAttempt start; abort survives across
  // dispatcher.send invocations within the same attempt.
  let fanoutInterruptController: AbortController | null = null;
  const dispatcher: EventDispatcher = {
    send: (event: MachineEvent) => {
      if (event.type === "INTERRUPT") {
        interruptObserved = true;
        // Continuation 8/9 (2026-04-29): task-wide INTERRUPT (no stage
        // payload) needs two-phase handling because the actor may be in
        // one of two distinct states:
        //   (a) Active stage executor — INTERRUPT must be forwarded so
        //       the stage's region INTERRUPT handler triggers
        //       AbortController.abort(), giving the executor a chance
        //       to run a graceful summary turn (writes its summary
        //       port, RESULT_SUCCESS, region naturally transitions to
        //       done, actor terminates on its own). Force-stopping at
        //       this point would skip the summary turn — the test
        //       migration.graceful-summary covers this exactly.
        //   (b) Parked at a gate — no active region to absorb
        //       INTERRUPT, so the actor sits forever waiting for
        //       GATE_ANSWERED. Migration orchestrator times out with
        //       MIGRATION_INTERRUPT_TIMEOUT.
        // We can't distinguish (a) vs (b) synchronously without a
        // dedicated flag, so we forward the event AND schedule a
        // deferred force-stop: if the actor is still alive after the
        // grace period (case b) we stop it; if a graceful summary
        // already completed (case a) the actor's status will be
        // 'done'/'stopped' and the stop call is a no-op. Stage-targeted
        // INTERRUPT (`{ stage: 'X' }`) is unchanged — forwarded so the
        // per-stage AbortSignal logic still aborts only that stage.
        const stageScope = (event as { stage?: string }).stage;
        if (stageScope === undefined) {
          // Bug 81: abort detached fanout promises FIRST, before the
          // actor's own INTERRUPT handler chain runs. Fanout
          // orchestration lives outside the actor (executorPromises in
          // runOneAttempt push detached chains that resolve into the
          // dispatcher), so neither currentActor.send nor actor.stop()
          // reaches them. Aborting the controller cooperates with
          // orchestrateFanoutStage's interruptSignal check + the per-
          // element controller listener so in-flight LLM calls tear
          // down via their existing AbortSignal paths.
          if (fanoutInterruptController && !fanoutInterruptController.signal.aborted) {
            try { fanoutInterruptController.abort(); } catch { /* already aborted */ }
          }
          if (currentActor) {
            try { currentActor.send(event); } catch { /* already stopped */ }
            // Bound on graceful-summary execution: 1500ms covers
            // abort-signal propagation (~10ms) + summary turn LLM call
            // (typically <1s for short summaries) + write_port +
            // region.onDone. If the executor isn't done by then, we
            // force-stop so migration awaiters can proceed.
            const actorRef = currentActor;
            setTimeout(() => {
              try {
                const snap = actorRef.getSnapshot() as { status?: string } | undefined;
                if (snap?.status === "active") {
                  actorRef.stop();
                }
              } catch { /* already stopped or errored */ }
            }, 1500);
          }
          return;
        }
        // Stage-scoped — fall through to currentActor.send so the
        // machine's stage region's INTERRUPT handler can run.
      }
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
  // ---- Phase 4.5 Step 1: checkpoint hooks ---------------------------
  const cpConfig = resolveCheckpointConfig(opts.checkpointConfig);
  const cpDeps: CheckpointDeps = {
    isGitRepo: gitCommands.isGitRepo,
    gitRevParseHead: gitCommands.gitRevParseHead,
    snapshotWorkTree: gitCommands.snapshotWorkTree,
    gitDiff: gitCommands.gitDiff,
    pathExists: async (p) => access(p).then(() => true).catch(() => false),
    now: () => Date.now(),
  };
  const checkpointInFlight = new Set<Promise<void>>();
  const trackHook = (p: Promise<void>): void => {
    const wrapped = p.finally(() => { checkpointInFlight.delete(wrapped); });
    checkpointInFlight.add(wrapped);
  };
  const attemptHooks: AttemptHooks = cpConfig.enabled
    ? {
        onAttemptStarted: (attemptId) => trackHook(
          captureBefore(opts.db, cpDeps, {
            attemptId,
            workdir: cpConfig.workdir,
            timeouts: cpConfig.timeouts,
          }),
        ),
        onAttemptFinishing: (attemptId) => trackHook(
          captureAfter(opts.db, cpDeps, {
            attemptId,
            maxDiffBytes: cpConfig.maxDiffBytes,
            timeouts: cpConfig.timeouts,
          }),
        ),
      }
    : {};

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
    attemptHooks,
  );
  taskRegistry.register(opts.taskId, dispatcher);

  // Bug 4 fix (c12+ review): pre-fix the registry registration above
  // and the wall-clock activeTimer (set up further below) leaked when
  // any code between registration and the main try/finally block
  // (line 716) threw. Six DB call sites between here and there could
  // realistically throw on FK violation / schema corruption / disk
  // full / circular ref in seedValues. The registry leak meant
  // awaitTermination waiters blocked forever; the activeTimer leak
  // pinned setTimeout closures in the event loop until the timer
  // expired (90 minutes default).
  //
  // Fix: emergency-cleanup helper invoked from catches. Use shared
  // mutable references for activeTimer so the helper can clear it
  // even though it's set up later in the function body.
  const emergencyCleanup = (terminationDetail: string): void => {
    try {
      if (activeTimer !== null) clearTimeout(activeTimer);
    } catch { /* ignore */ }
    try {
      taskRegistry.signalTermination(opts.taskId, {
        kind: "error",
        detail: terminationDetail,
      });
    } catch { /* ignore */ }
    try {
      taskRegistry.unregister(opts.taskId);
    } catch { /* ignore */ }
  };

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
  // Continuation-3 Issue #2 — stageErrors used to be a runner-side
  // array maintained in parallel with MachineContext.finalizedStages.
  // It is now derived from finalizedStages at the points where it is
  // read (SSE diagnostics, RunResult, finalState, task_finals detail
  // string). The push sites that used to mirror compiler-driven
  // transitions are gone; only no_active_wire context is computed
  // by the runner because it depends on stageMeta which is not in
  // MachineContext. See deriveStageErrors() below.
  type StageError = { stage: string; message: string; context?: StageErrorContext };

  // F17 secret-gate: tracks whether any stage paused waiting for secrets.
  // When true, runner skips the task_finals write (the task is paused, not
  // terminated) and exits silently; provide_task_secrets MCP tool resumes
  // via the migration path (synthetic-proposal mechanism in retryTaskFromStage).
  // P3.6 env-cleanup is also skipped — task_env_values are kept so
  // any provide_task_secrets writes already in flight aren't clobbered.
  let secretPendingObserved = false;

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

  // Cross-region cancellation. A stage that enters its `error` final
  // (executor_failed or no_active_wire) leaves every transitive
  // downstream region waiting for inbound wires that will never
  // deliver. Without propagation, parallel.onDone never fires and the
  // run hangs until the wall-clock budget. We compute the transitive
  // downstream set lazily on first failure and dispatch STAGE_CANCELLED
  // for each not-yet-finalized downstream so its region can move to
  // its `error` final and parallel.onDone resolves.
  // The set is per-attempt (cleared on retry-rebuild via the same
  // mechanism that clears publishedStageFinal — see the rollback path)
  // so a retry that re-runs the failed upstream gets a clean slate.
  const cancelledByPropagation = new Set<string>();
  const computeTransitiveDownstreams = (failedStage: string): string[] => {
    // BFS over ir.wires from failedStage. Each wire whose `from.stage`
    // is in the frontier adds its `to.stage` to the downstream set.
    // Match on "stage-sourced" wires: schema preprocess defaults
    // missing source to "stage", but tests / fixtures often skip the
    // preprocess and pass `from: { stage, port }` without source. Mirror
    // mock-executor.ts:69's logic (treat anything not explicitly
    // "external" as stage-sourced) so downstream computation matches
    // wire-delivery semantics.
    const downstream = new Set<string>();
    const frontier = [failedStage];
    while (frontier.length > 0) {
      const cur = frontier.pop()!;
      for (const w of opts.ir.wires) {
        const fromStage = wireFromStage(w);
        if (fromStage === null) continue;
        if (fromStage !== cur) continue;
        const next = w.to.stage;
        if (downstream.has(next) || next === failedStage) continue;
        downstream.add(next);
        frontier.push(next);
      }
    }
    return [...downstream];
  };

  // Continuation-3 Issue #2 — stageMeta lifted to outer scope so the
  // finally block + post-loop derivation can build NO_ACTIVE_WIRE
  // diagnostics from finalizedStages without depending on
  // runOneAttempt's local destructure. Each runOneAttempt overwrites
  // it with its own compile; the IR is invariant across retries
  // (hot-update writes a new task, not a new attempt) so the latest
  // assignment is the right value to read at finalize time.
  // eslint-disable-next-line prefer-const
  let outerStageMeta: Map<string, StageMeta> = new Map();

  // ---- Retry-preserved context (read by next compileIRToMachine) ----
  // Bug 16 (dogfood 2026-05-02): use the compiler's
  // buildInitialPortValues directly, which seeds gate-feedback empty
  // strings + handles optional externalInputs. Pre-fix runner had its
  // own buildInitialPortValuesRunner that ONLY seeded externalInputs,
  // so resume hydration produced a persistentPortValues missing the
  // gate-feedback seeds — and downstream gate-routed stages got stuck
  // because their feedback wires couldn't deliver.
  let persistentPortValues: Record<string, unknown> =
    buildInitialPortValues(opts.ir, opts.seedValues);
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
    // Bug 4 fix (c12+ review): wrap resume-hydration DB reads so a
    // schema-corruption / SQLite-busy / FK-violation throw doesn't
    // leak the registry + activeTimer (the activeTimer is set up below
    // but emergencyCleanup is defensive — it null-checks).
    try {
    // Bug 15 (dogfood 2026-05-02): for fanout stages, the rebuild
    // logic must distinguish stage-level success (fanout_aggregate
    // row exists) from element-level success (some fanout_element
    // rows ran but no aggregate landed). Pre-fix used `SELECT DISTINCT
    // stage_name` which included a fanout stage in finalizedStages
    // as soon as ANY fanout_element row was status='success' —
    // skipping the orchestrator's aggregate phase entirely on resume,
    // and overwriting `tutorialAuthoring.slug` in portValues with
    // the LAST element's single-string value (writeTutorialCache
    // then fails with "input 'slugs' must be string[] (got string)").
    //
    // Mirrors the Bug 58 fix in orphan-reconciler.classifyOrphan but
    // applied at the runner's rebuild path. Fanout stages are now
    // only considered "done" when their kind='fanout_aggregate' row
    // exists with status='success'. Element-only success is a
    // partial state and the resumed runner re-enters the fanout
    // stage so orchestrateFanoutStage's preservedByIdx skips the
    // succeeded elements and only re-runs the missing/superseded
    // indices, then writes the aggregate row.
    const fanoutStageNames = new Set<string>();
    for (const s of opts.ir.stages) {
      if ((s.type === "agent" || s.type === "script") && (s as { fanout?: unknown }).fanout) {
        fanoutStageNames.add(s.name);
      }
    }
    // 1. finalizedStages: every stage_attempt that is still status='success'
    //    for this task. Superseded stages (those the orchestrator just
    //    marked) stay out so the retry loop re-invokes them. For fanout
    //    stages, only count fanout_aggregate success — see Bug 15 above.
    const successRows = opts.db.prepare(
      `SELECT stage_name, kind FROM stage_attempts
       WHERE task_id = ? AND status = 'success'`,
    ).all(opts.taskId) as Array<{ stage_name: string; kind: string }>;
    const completedStageNames = new Set<string>();
    for (const r of successRows) {
      if (fanoutStageNames.has(r.stage_name)) {
        if (r.kind === "fanout_aggregate") completedStageNames.add(r.stage_name);
      } else {
        completedStageNames.add(r.stage_name);
      }
    }
    persistentFinalizedStages = [...completedStageNames].map((name) => ({
      name,
      outcome: "done" as const,
    }));
    // 2. portValues: every port_value row for a stage we now consider
    //    completed (per the fanout-aware filter above). Stored in the
    //    machine-context shape `<stage>.<port>`. For fanout stages we
    //    only read aggregate rows; element rows are partial state and
    //    feeding their per-element values into context would clobber
    //    the array shape downstream.
    const portRows = opts.db.prepare(
      `SELECT pv.stage_name, pv.port_name, pv.value_json, sa.kind
       FROM port_values pv
       INNER JOIN stage_attempts sa ON pv.attempt_id = sa.attempt_id
       WHERE sa.task_id = ? AND sa.status = 'success'
       ORDER BY pv.written_at ASC`,
    ).all(opts.taskId) as Array<{
      stage_name: string; port_name: string; value_json: string; kind: string;
    }>;
    for (const r of portRows) {
      // Bug 15: drop fanout_element port writes during rebuild; only
      // the fanout_aggregate row carries the aggregated array shape
      // downstream stages depend on.
      if (fanoutStageNames.has(r.stage_name) && r.kind !== "fanout_aggregate") continue;
      try {
        persistentPortValues[`${r.stage_name}.${r.port_name}`] = JSON.parse(r.value_json);
      } catch {
        // Corrupt JSON — skip this port value; the new run will fail at
        // its first consumer with NO_ACTIVE_WIRE or similar, which is
        // the correct surface for this rare condition.
      }
    }
    // 3. Hydrate gate answers committed by a previous runner but not
    //    yet forwarded to the machine as GATE_ANSWERED. Server crash
    //    between gate_queue.answer write and dispatcher.send(...) is
    //    the reason this survival path exists — without it, the
    //    resumed runner would re-ask a gate the user already answered.
    const answeredGateRows = opts.db.prepare(
      `SELECT stage_name, answer FROM gate_queue
         WHERE task_id = ? AND answer IS NOT NULL AND answered_at IS NOT NULL`,
    ).all(opts.taskId) as Array<{ stage_name: string; answer: string }>;
    for (const row of answeredGateRows) {
      const gateStage = opts.ir.stages.find(
        (s) => s.name === row.stage_name && s.type === "gate",
      );
      if (!gateStage || gateStage.type !== "gate") continue;
      const target = gateStage.config.routing.routes[row.answer];
      if (target === undefined) continue;
      const targets = Array.isArray(target) ? target : [target];
      for (const t of targets) {
        if (!persistentGateAuthorized.includes(t)) {
          persistentGateAuthorized.push(t);
        }
      }
      if (!persistentFinalizedStages.some((f) => f.name === row.stage_name)) {
        persistentFinalizedStages.push({
          name: row.stage_name,
          outcome: "done" as const,
        });
      }
    }
    // 4. Tell compiler to honour initialContext.
    isRetryRebuild = true;
    } catch (err) {
      emergencyCleanup(
        `resume hydration failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
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

  // P6.1 / D23 — emit cumulative cost/token totals for this task.
  // Called after stage_done and run_final so the dashboard header
  // updates live. Reads agent_execution_details; safe to call even
  // when no attempts have opened yet (aggregator returns zeros).
  const publishTaskCost = (): void => {
    if (!opts.broadcaster) return;
    try {
      const snap = computeTaskCost(opts.db, opts.taskId);
      publish({
        type: "task_cost_update",
        taskId: opts.taskId,
        timestamp: isoNow(),
        data: snap,
      });
    } catch { /* aggregator failure must not abort the run */ }
  };

  // Timer is run-scoped: a retry does not reset the overall budget.
  // Long pipelines should set timeoutMs explicitly.
  //
  // BUG-2 fix: gate wait is human think time, not pipeline execution
  // time. The budget below tracks *active* (non-gate-waiting) time only.
  // When one or more gates enter `executing` the timer is cleared; when
  // every gate in flight has been answered the timer is rearmed with
  // the remaining budget. Snapshot loop below maintains gateInFlight.
  let timedOut = false;
  let remainingBudgetMs = timeoutMs;
  let activeSinceMs = Date.now();
  let gateInFlight = 0;

  // Continuation-3 (Issue #1) — attempt-scoped rejecter exposed to outer
  // scope so the wall-clock timer can reject runPipeline directly,
  // without depending on `actor.subscribe` firing a snapshot. Without
  // this, a stuck or stopped actor that never emits more snapshots
  // leaves runPipeline pending until the test harness's own timeout
  // (observed during cross-region cancellation work pre-fix). Each
  // runOneAttempt's Promise constructor reassigns this; the outer
  // resolveOuter wrapper clears it on terminal verdicts.
  let currentRejectAttempt: ((err: Error) => void) | null = null;

  const fireTimedOut = (): void => {
    timedOut = true;
    // Reject the in-flight attempt synchronously. If no attempt is
    // active (between attempts), the outer while-loop will observe
    // timedOut on the next iteration entry.
    if (currentRejectAttempt) {
      const reject = currentRejectAttempt;
      currentRejectAttempt = null;
      reject(new Error(`runPipeline timeout after ${timeoutMs}ms`));
    }
  };

  let activeTimer: ReturnType<typeof setTimeout> | null = setTimeout(
    fireTimedOut,
    remainingBudgetMs,
  );
  const pauseBudget = (): void => {
    if (activeTimer !== null) {
      clearTimeout(activeTimer);
      activeTimer = null;
      remainingBudgetMs -= Date.now() - activeSinceMs;
      if (remainingBudgetMs < 0) remainingBudgetMs = 0;
    }
  };
  const resumeBudget = (): void => {
    if (activeTimer === null && !timedOut) {
      activeSinceMs = Date.now();
      activeTimer = setTimeout(fireTimedOut, remainingBudgetMs);
    }
  };

  // Task 1.8 — seed phase (externalInputs). Run once (regardless of
  // retries) so lineage and SSE observe the external seeds exactly
  // once. The compiler's initial context.portValues carries the same
  // values so the first attempt's stages see them immediately.
  const externalInputs = opts.ir.externalInputs ?? [];
  if (externalInputs.length > 0 && !opts.resumeFrom) {
    const seedValues = opts.seedValues ?? {};
    for (const port of externalInputs) {
      if (!(port.name in seedValues)) {
        // Bug 7 (2026-04-28): externalInputs[].optional === true means
        // the caller MAY omit the seed value; the runner seeds null
        // instead of failing the run. Required (default) inputs still
        // raise SEED_VALUES_MISSING_KEY as before. This unblocks
        // pipelines like pipeline-modifier whose `failureContext` is
        // semantically optional but was previously rejected.
        if (port.optional === true) continue;
        if (activeTimer !== null) clearTimeout(activeTimer);
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
    // Bug 4 + Bug 14 fix (c12+ review): wrap the seed phase so a throw
    // (circular ref in seedValues during JSON.stringify, FK violation,
    // schema corruption) doesn't leak the synthetic attempt as
    // status='running' nor leak the registry/activeTimer.
    const { attemptId } = portRuntime.startAttempt({
      taskId: opts.taskId,
      versionHash: opts.versionHash,
      stageName: "__external__",
      kind: "external",
      // Synthetic seed attempt that opens and closes synchronously.
      // The attempt records port_values for lineage but does not
      // represent agent work on the worktree, so no checkpoint row
      // should be created for it.
      suppressHooks: true,
    });
    try {
      for (const port of externalInputs) {
        // Bug 7: optional inputs that the caller omitted are seeded as
        // null so downstream wires resolve to a determinate value. Stages
        // wiring from these ports must read their input as `T | null`.
        const value = port.name in seedValues
          ? seedValues[port.name]
          : (port.optional === true ? null : undefined);
        portRuntime.writePort({
          attemptId,
          stageName: "__external__",
          portName: port.name,
          value,
        });
      }
      portRuntime.finishAttempt(attemptId, "success");
    } catch (err) {
      // Mark the synthetic attempt as error so it doesn't sit in
      // 'running' forever. Use silent:true so we don't dispatch
      // STAGE_FAILED for the synthetic seed (no consumer cares).
      try {
        portRuntime.finishAttempt(
          attemptId,
          "error",
          err instanceof Error ? err.message : String(err),
          { silent: true },
        );
      } catch { /* if even finishAttempt throws (e.g. DB locked), give up */ }
      emergencyCleanup(
        `seed phase failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
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
        // A (gate feedback): the rejected gate's `__gate_feedback__` port
        // is the one value we intentionally preserve — it carries the
        // user's correction to the regenerating upstream agent. The gate
        // stage is listed in affectedStages (the reject-rollback prunes
        // the gate itself so it can re-open a fresh question), but its
        // feedback port semantically belongs to the *answered* attempt,
        // not the upcoming fresh one. Dropping it would discard the one
        // signal the rerun needs.
        persistentPortValues = Object.fromEntries(
          Object.entries(contextAtRollback.portValues).filter(([key]) => {
            const [stageName, portName] = key.split(".");
            if (!affected.has(stageName ?? "")) return true;
            if (portName === "__gate_feedback__" && stageName === fromGate) {
              return true;
            }
            return false;
          }),
        );
        // Bug 16 (dogfood-5 2026-05-02): the filter above drops
        // `__gate_feedback__` entries for every affected gate
        // EXCEPT the rejected one (fromGate). But the compiler seeds
        // every gate's `__gate_feedback__` with empty string at
        // first compile so downstream wires reading them can resolve
        // before the gate fires. Without this seed, gate-routed
        // stages whose inbound includes a feedback wire from an
        // affected (i.e. dropped) gate fail wireDelivers and their
        // GATE_ANSWERED transition guard returns false even when
        // the gate they're routed from authorises them. The actor
        // then wedges in `waiting` indefinitely.
        //
        // Re-seed empty-string defaults for every affected gate's
        // feedback port (skipping fromGate which keeps the user's
        // rejection comment).
        for (const stage of opts.ir.stages) {
          if (stage.type !== "gate") continue;
          if (!affected.has(stage.name)) continue;
          if (stage.name === fromGate) continue;
          persistentPortValues[`${stage.name}.__gate_feedback__`] = "";
        }
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
        // SSE dedupe + dispatched sets: clear entries for affected stages
        // so their stage_executing / stage_done / stage_error events can
        // re-emit on the rebuilt actor.
        for (const name of affected) {
          publishedStageExecuting.delete(name);
          publishedStageFinal.delete(name);
          dispatched.delete(name);
          // Bug 10 fix (c12+ review): same parity gap as the retry
          // path. cancelledByPropagation must be cleared on rebuild;
          // pre-fix a stage cancelled in attempt N stayed marked,
          // suppressing STAGE_CANCELLED on subsequent rebuilds.
          cancelledByPropagation.delete(name);
        }
        // 0G dogfood (2026-04-28): supersede prior fanout_element +
        // fanout_aggregate stage_attempts rows for affected fanout
        // stages. orchestrateFanoutStage's `preservedByIdx` query
        // selects ALL `fanout_element` rows with `status='success'` for
        // the (task, stage) pair — it was designed for hot-update
        // migration where preserved attempts were genuinely valid for
        // the new run. In a reject-rollback the upstream agent
        // regenerates with different claims; the preserved rows are
        // stale but their idx still matches, so the fanout silently
        // reuses old outputs and never invokes the executor on the new
        // input array. Marking them superseded knocks them out of the
        // preserved query without touching their port_values / lineage.
        for (const name of affected) {
          const stageDef = opts.ir.stages.find((s) => s.name === name);
          if (!stageDef) continue;
          if (
            (stageDef.type === "agent" || stageDef.type === "script") &&
            stageDef.fanout
          ) {
            opts.db.prepare(
              `UPDATE stage_attempts
                 SET status = 'superseded'
                 WHERE task_id = ?
                   AND stage_name = ?
                   AND kind IN ('fanout_element', 'fanout_aggregate')
                   AND status = 'success'`,
            ).run(opts.taskId, name);
          }
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
      // Bug 16 (dogfood 2026-05-02): re-seed `__gate_feedback__`
      // empty string for every reset gate, mirroring compiler's
      // buildInitialPortValues. Without this, downstream stages
      // whose inbound includes a feedback wire from a reset gate
      // fail wireDelivers when the rebuilt actor tries to advance
      // past a successful gate answer.
      for (const stage of opts.ir.stages) {
        if (stage.type !== "gate") continue;
        if (!toReset.has(stage.name)) continue;
        persistentPortValues[`${stage.name}.__gate_feedback__`] = "";
      }

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

      // Continuation-3 Issue #2 — stageErrors filter used to live here.
      // Now it derives from finalizedStages at output time, and
      // finalizedStages is already filtered above (line 800), so this
      // step is redundant.

      // Bug 1 fix (c12+ review): same fanout-supersede issue the
      // rollback verdict path addresses (see lines 800-826). Pre-fix
      // the retry verdict path reset finalizedStages and portValues
      // for stages in `toReset`, but never marked stale
      // `fanout_element` / `fanout_aggregate` rows as 'superseded'.
      // After a script-stage retry rewinds the run to before a fanout
      // (or to the fanout itself), orchestrateFanoutStage's
      // `preservedByIdx` query reused the prior successful per-element
      // outputs against new upstream inputs. Marking them superseded
      // knocks them out of the preserved query without losing lineage.
      for (const name of toReset) {
        const stageDef = opts.ir.stages.find((s) => s.name === name);
        if (!stageDef) continue;
        if (
          (stageDef.type === "agent" || stageDef.type === "script") &&
          stageDef.fanout
        ) {
          opts.db.prepare(
            `UPDATE stage_attempts
               SET status = 'superseded'
               WHERE task_id = ?
                 AND stage_name = ?
                 AND kind IN ('fanout_element', 'fanout_aggregate')
                 AND status = 'success'`,
          ).run(opts.taskId, name);
        }
      }

      // SSE dedupe sets: clear entries for reset stages.
      for (const name of toReset) {
        publishedStageExecuting.delete(name);
        publishedStageFinal.delete(name);
        dispatched.delete(name);
        // Bug 10 fix (c12+ review): cancelledByPropagation set was
        // never reset on retry rebuild despite the comment at line
        // 423-424 promising it. Stages cancelled in attempt N stayed
        // marked across rebuilds, suppressing STAGE_CANCELLED in
        // attempt N+1.
        cancelledByPropagation.delete(name);
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
    // Drain pending checkpoint captures before tearing down the task
    // so stage_checkpoints rows are committed by the time SSE run_final
    // and downstream queries observe the task's terminal state.
    if (checkpointInFlight.size > 0) {
      await Promise.allSettled([...checkpointInFlight]);
    }
    if (activeTimer !== null) clearTimeout(activeTimer);
    if (currentActor) {
      try { currentActor.stop(); } catch { /* ignore */ }
    }
    // Continuation-3 Issue #2 — derive stageErrors from finalizedStages
    // BEFORE the task_finals upsert so this block can read it. Uses the
    // last observed snapshot context. When finalOutcome is null (e.g.
    // we threw out of runOneAttempt), there is no authoritative
    // finalizedStages list — finalsErrors stays empty and the
    // termination-classification branch falls through to the
    // "no outcome" / timeout / interrupted paths instead. We do NOT
    // run the same-actor-success reconciliation here (it depends on
    // DB state that may still be settling); the second derivation
    // after the finally block applies that filter for the public
    // RunResult and SSE diagnostics.
    const finalsErrors: StageError[] = [];
    if (finalOutcome?.snapshot) {
      const fctx = (finalOutcome.snapshot as { context?: MachineContext }).context;
      if (fctx) {
        for (const entry of fctx.finalizedStages) {
          if (entry.outcome !== "error") continue;
          if (entry.reason === "upstream_cancelled") continue;
          if (entry.reason === "executor_failed") {
            finalsErrors.push({
              stage: entry.name,
              message: entry.message ?? "stage executor failed",
            });
          } else {
            finalsErrors.push(
              buildNoActiveWireError(entry.name, outerStageMeta, fctx.portValues),
            );
          }
        }
      }
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
    // P6-1: task_finals row classification. Mirrors terminationReason but
    // uses a 5-way enum (natural/timeout/interrupted/error/thrown) that
    // the DB CHECK constraint accepts and that callers can distinguish.
    let finalsRow: { state: "completed" | "failed"; reason: "natural" | "timeout" | "interrupted" | "error" | "thrown"; detail: string | null };
    if (timedOut) {
      // Add actionable context: which stage was active when the budget
      // expired, when its writer last heartbeat, how many tool calls
      // it had observed. The 90-minute default is opaque without these
      // hints — operators see "timeout" and can't tell if the stage
      // was making progress (raise the budget) or stuck silent (fix
      // the prompt / external dependency).
      const ctx = describeLastActiveAttempt(opts.db, opts.taskId);
      const detail = ctx
        ? `runPipeline timeout after ${timeoutMs}ms. Last active stage: '${ctx.stageName}'`
          + ` (attempt #${ctx.attemptIdx}); ${ctx.silentForMs ? `silent for ${Math.round(ctx.silentForMs / 1000)}s before timeout` : "no heartbeat recorded"}.`
          + ` Tip: if this stage normally takes longer, raise its budget via stage.config.maxBudgetUsd or pass timeoutMs explicitly to runPipeline.`
          + ` If it hangs silently, run propose_pipeline_fix taskId=${opts.taskId}.`
        : `runPipeline timeout after ${timeoutMs}ms (no active attempt recorded — the runner timed out before any stage started, or the DB query failed).`;
      terminationReason = { kind: "error", detail };
      finalsRow = { state: "failed", reason: "timeout", detail };
    } else if (interruptObserved) {
      terminationReason = { kind: "interrupted" };
      finalsRow = { state: "failed", reason: "interrupted", detail: null };
    } else if (finalOutcome?.verdict === "completed") {
      // XState `parallel` regions fire onDone when every child reaches a
      // final state — both `done` and `error` finals qualify. So a run
      // where every stage region finalised, but at least one finalised
      // via `error`, still yields snapshot.value === "completed" and
      // verdict === "completed". Before P6-1 the runner's own return
      // value (see the L858 `finalState` computation) handled this by
      // also inspecting stageErrors, but the task_finals upsert here
      // trusted verdict alone — producing completed/natural rows for
      // runs that the top-level return value and the dashboard both
      // correctly reported as failed. Bug surfaced during Linear MCP
      // dogfood (2026-04-25): MCP_STARTUP check marked the only stage
      // as `error`, yet task_finals read `completed/natural`. Treat any
      // outstanding stageErrors as authoritative.
      if (finalsErrors.length > 0) {
        const firstErr = finalsErrors[0]!;
        const detail = finalsErrors.length === 1
          ? `stage '${firstErr.stage}': ${firstErr.message}`
          : `${finalsErrors.length} stage error(s); first: '${firstErr.stage}': ${firstErr.message}`;
        terminationReason = { kind: "error", detail };
        finalsRow = { state: "failed", reason: "error", detail };
      } else {
        terminationReason = { kind: "natural" };
        finalsRow = { state: "completed", reason: "natural", detail: null };
      }
    } else if (finalOutcome?.verdict === "failed") {
      terminationReason = { kind: "error", detail: "run ended with failed verdict" };
      finalsRow = { state: "failed", reason: "error", detail: "run ended with failed verdict" };
    } else {
      terminationReason = { kind: "error", detail: "runner exited without reaching final outcome" };
      finalsRow = { state: "failed", reason: "thrown", detail: "runner exited without reaching final outcome" };
    }
    if (secretPendingObserved) {
      // F17: task is paused on a missing secret. Do not write task_finals;
      // the task is not terminal. provide_task_secrets will resume via
      // the migration path (synthetic-proposal mechanism in retryTaskFromStage).
      // P3.6 env-cleanup is also skipped — task_env_values are kept so
      // any provide_task_secrets writes already in flight aren't clobbered.
    } else {
      // Upsert task_finals BEFORE signalTermination so awaitTermination
      // waiters (migration orchestrator) and downstream status readers
      // see the authoritative row as soon as the registry signal fires.
      try {
        opts.db.prepare(
          `INSERT INTO task_finals (task_id, version_hash, final_state, reason, detail, ended_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET
             version_hash = excluded.version_hash,
             final_state  = excluded.final_state,
             reason       = excluded.reason,
             detail       = excluded.detail,
             ended_at     = excluded.ended_at
           -- 'cancelled' is a sticky terminal state: cancel_task writes it
           -- via INSERT OR IGNORE before dispatching INTERRUPT. If our row
           -- lands first we must not flip it back to 'failed'/'interrupted'.
           WHERE task_finals.final_state != 'cancelled'`,
        ).run(
          opts.taskId,
          opts.versionHash,
          finalsRow.state,
          finalsRow.reason,
          finalsRow.detail,
          Date.now(),
        );
      } catch (err) {
        // task_finals write must never mask the real termination reason.
        // Log-and-swallow: signalTermination still fires, callers fall back
        // to the stage_attempts-derived path (pre-P6-1 behavior).
        // eslint-disable-next-line no-console
        console.error(`[runner] task_finals upsert failed for task=${opts.taskId}:`, err);
      }
      // P3.6: plaintext env tokens must not outlive the task lifetime.
      // Run in its own try/catch so a cleanup failure cannot be swallowed
      // by the task_finals catch above. Unconditionally executed — even if
      // task_finals upsert threw, we still want the env row gone.
      try {
        deleteTaskEnvValues(opts.db, opts.taskId);
      } catch (envErr) {
        // eslint-disable-next-line no-console
        console.error(`[runner] deleteTaskEnvValues failed for task=${opts.taskId}:`, envErr);
      }
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

  // Continuation-3 Issue #2 — derive stageErrors from finalizedStages.
  // Reasons:
  //   - executor_failed: use entry.message (set by the STAGE_FAILED
  //     transition action); no context.
  //   - no_active_wire: build structured failedWires diagnostic from
  //     stageMeta + portValues (depends on runner-side data, not on
  //     anything the machine context could carry).
  //   - upstream_cancelled: skip — propagation is bookkeeping, the
  //     root-cause stage's entry already covers the failure.
  //   - done: skip.
  // After the per-entry derivation, drop entries for stages whose
  // LATEST DB attempt status='success' (same-actor retry reached
  // success after the prior failure entered finalizedStages — the
  // context is still authoritative until the success row replaces it).
  const stageErrors: StageError[] = [];
  for (const entry of ctx.finalizedStages) {
    if (entry.outcome !== "error") continue;
    if (succeededStages.has(entry.name)) continue;
    if (entry.reason === "upstream_cancelled") continue;
    if (entry.reason === "executor_failed") {
      stageErrors.push({
        stage: entry.name,
        message: entry.message ?? "stage executor failed",
      });
    } else {
      // no_active_wire (or undefined reason — legacy IR / pre-Slice C
      // shape). Construct the structured diagnostic.
      stageErrors.push(
        buildNoActiveWireError(entry.name, outerStageMeta, ctx.portValues),
      );
    }
  }

  const finalState: "completed" | "failed" =
    snapshot.value === "failed" ||
    errorRow.n > 0 ||
    drainErrors.length > 0 ||
    stageErrors.length > 0
      ? "failed"
      : "completed";

  // Bug 12 (dogfood-2026-04-28): secret_pending is NOT a terminal
  // state — the task is paused waiting for an envKey. The internal
  // snapshot.value is `failed` (because STAGE_FAILED was dispatched
  // to unstick the parallel region), but the task itself is alive
  // and will resume via retryTaskFromStage when secrets land. If we
  // publish a run_final here, the broadcaster's per-task ring buffer
  // captures an authoritative-looking "failed" event that the
  // dashboard later replays on reload, even after a successful
  // resume has written its own run_final and a `completed` row to
  // task_finals. The DB is right, the UI is wrong. Suppress the
  // event entirely on the secret_pending exit path; the resumed
  // runPipeline call will publish its own run_final at its terminal.
  if (!secretPendingObserved) {
    publish({
      type: "run_final",
      taskId: opts.taskId,
      timestamp: isoNow(),
      data: {
        finalState,
        stageErrors: stageErrors.map((e) => ({ stage: e.stage, message: e.message })),
      },
    });
  }
  // P6.1 / D23 — final cost/token snapshot so the dashboard header
  // reflects any cost accrued during the last attempt (stage_done may
  // not have fired for that stage if the run terminated in `error`).
  publishTaskCost();

  // P4.4 / D30 — also emit a diagnostics_emitted batch so the
  // dashboard's <DiagnosticsPanel> can group multi-error failures by
  // code. Fires only when there's something to show. Classification:
  // presence of `context` (populated with failedWires only on the
  // NO_ACTIVE_WIRE path) distinguishes topology failures from
  // executor failures without string-matching messages.
  if (stageErrors.length > 0) {
    publish({
      type: "diagnostics_emitted",
      taskId: opts.taskId,
      timestamp: isoNow(),
      data: {
        source: "runtime",
        diagnostics: stageErrors.map((e) => ({
          code: e.context ? "NO_ACTIVE_WIRE" : "STAGE_ERROR",
          message: `${e.stage}: ${e.message}`,
          severity: "error" as const,
        })),
      },
    });
  }

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
    // Bug 81: per-attempt fanout INTERRUPT controller. Reset on every
    // rebuild (retry / rollback) so a previous attempt's abort doesn't
    // bleed into the new one. The dispatcher's INTERRUPT handler
    // checks this controller and aborts when an external INTERRUPT
    // arrives.
    fanoutInterruptController = new AbortController();

    // Compile a fresh machine. When this is a retry rebuild we pass
    // initialContext so the new machine starts with the preserved
    // portValues / retryCounts / gate authorizations; first-attempt
    // path leaves initialContext undefined so the existing seedValues
    // → buildInitialPortValues codepath still runs.
    const compiled = compileIRToMachine(opts.ir, {
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
    const { machine, stageMeta } = compiled;
    // Continuation-3 Issue #2 — sync outer reference for finally block.
    outerStageMeta = stageMeta;

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
      // Track whether an external INTERRUPT was the reason this callback
      // is being torn down. XState stops the invoked actor automatically
      // when the parent region transitions to `done` (which happens via
      // the `always: allOutboundPresent` guard the moment the final
      // write_port lands), and that stop triggers the cleanup returned
      // below. If we unconditionally abort there, a naturally-completing
      // executor gets interpreted as user-interrupted — the AgentMachine
      // records `interrupted`, the stage is marked error, and the task
      // status falsely shows failure despite correct outputs. Only abort
      // on an actual INTERRUPT event.
      let externalInterrupt = false;
      receive((ev) => {
        if (ev.type === "INTERRUPT") {
          externalInterrupt = true;
          ac.abort();
        }
      });

      let executorDone = false;
      void (async () => {
        try {
          const resumeForThisStage = resumeFieldsForStage(
            opts, input.stageName, input.taskId,
          );
          const result = await executor.executeStage({
            ir: opts.ir,
            stageName: input.stageName,
            taskId: input.taskId,
            versionHash,
            portValues: input.portValues,
            handlers: opts.handlers,
            portRuntime,
            signal: ac.signal,
            ...resumeForThisStage,
            segmentContinuation: segmentContinuationFor(opts, input.stageName, input.taskId, opts.ir, segments),
          });
          if (result.status === "error") {
            // Continuation-3 Issue #2 — STAGE_FAILED transition action
            // captures result.error into finalizedStages.entry.message;
            // no parallel runner-side push needed.
            dispatcher.send({
              type: "STAGE_FAILED",
              stage: input.stageName,
              error: result.error ?? "unspecified",
            });
          } else if (result.status === "secret_pending") {
            // F17: stage is paused waiting for envKeys. Mark the runner-level
            // flag so the finally block skips task_finals; do NOT push to
            // stageErrors (this is not a failure).
            //
            // Dispatch STAGE_FAILED so the machine's stage region transitions
            // from `executing` to its `error` final, which allows the parallel
            // top-level machine to reach its own `failed` final, which
            // resolves the runOneAttempt promise. Without this, the machine
            // stays in `executing` for the secret-pending stage and
            // runPipeline deadlocks.
            //
            // Note: we intentionally skip pushing to stageErrors (this is
            // not an error from the pipeline's perspective) and the
            // secretPendingObserved guard in the finally block ensures
            // task_finals is never written (the task is paused, not
            // terminal). The run appears as `failed` internally but no
            // terminal row is committed; provide_task_secrets will resume
            // the task via retryTaskFromStage.
            //
            // Bug 12 (dogfood-2026-04-28): secret-pending dwell is human-
            // input think-time, not pipeline execution time. Pause the
            // budget — symmetric with the gate-stage pause at L1307. In
            // the common case (non-fanout) runPipeline exits within ms of
            // this point and the pause is moot, but in fanout scenarios
            // a parallel stage may still be running while this stage
            // waits for secrets, and the pause prevents that wall-time
            // from eroding the pipeline's timeout budget.
            secretPendingObserved = true;
            pauseBudget();
            dispatcher.send({
              type: "STAGE_FAILED",
              stage: input.stageName,
              error: "secret_pending",
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Continuation-3 Issue #2 — STAGE_FAILED transition action
          // captures error into finalizedStages.entry.message.
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
        // Only abort on genuine external INTERRUPT. Cleanup fires on every
        // actor stop — including the common natural-completion path where
        // the region's `allOutboundPresent` always-guard has already
        // transitioned to `done`. Aborting then would turn success into
        // `interrupted` (see externalInterrupt declaration above).
        if (!executorDone && !ac.signal.aborted && externalInterrupt) {
          ac.abort();
        }
      };
    });

    const providedMachine = machine.provide({
      actors: { execute_stage: executeStageLogic },
    });

    return new Promise<AttemptVerdict>((rawResolveAttempt, rawRejectAttempt) => {
      // Continuation-3 (Issue #1) — wrap reject/resolve so the outer
      // wall-clock timer can fire reject directly. Clearing
      // currentRejectAttempt on either path makes a late timer fire
      // a no-op when the attempt has already resolved naturally.
      const rejectAttempt = (err: Error): void => {
        currentRejectAttempt = null;
        rawRejectAttempt(err);
      };
      const resolveAttempt = (v: AttemptVerdict): void => {
        currentRejectAttempt = null;
        rawResolveAttempt(v);
      };
      currentRejectAttempt = rejectAttempt;

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

        // BUG-2: track whether any gate stage is currently paused for a
        // human answer. Toggling between "no gates waiting" and "at least
        // one gate waiting" pauses/resumes the timeout budget so that
        // human think time never counts toward timeoutMs.
        {
          const runningMap = (snapshot.value as { running?: Record<string, string> }).running;
          let currentGateCount = 0;
          if (runningMap) {
            for (const [stageName, substate] of Object.entries(runningMap)) {
              if (substate !== "executing") continue;
              const def = opts.ir.stages.find((s) => s.name === stageName);
              if (def?.type === "gate") currentGateCount += 1;
            }
          }
          if (currentGateCount > 0 && gateInFlight === 0) {
            pauseBudget();
          } else if (currentGateCount === 0 && gateInFlight > 0) {
            resumeBudget();
          }
          gateInFlight = currentGateCount;
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
              // P6.1 / D23 — live cost/token header update.
              publishTaskCost();
            } else {
              if (reason === "executor_failed") {
                publish({
                  type: "stage_error",
                  taskId: opts.taskId,
                  timestamp: isoNow(),
                  data: {
                    stage: stageName,
                    // Continuation-3 Issue #2 — message is now carried
                    // on finalizedStages.entry.message (set by the
                    // STAGE_FAILED transition action), no longer
                    // looked up via the parallel runner-side
                    // stageErrors array.
                    message: entry.message ?? "stage executor failed",
                    reason: "executor_failed",
                  },
                });
              } else if (reason === "upstream_cancelled") {
                // A downstream region just transitioned to error after
                // receiving STAGE_CANCELLED. We surface a stage_error
                // event so the dashboard knows the stage will not run,
                // but with a different reason so the UI can distinguish
                // "this stage failed" from "an upstream stage failed".
                publish({
                  type: "stage_error",
                  taskId: opts.taskId,
                  timestamp: isoNow(),
                  data: {
                    stage: stageName,
                    message:
                      `Cancelled because a transitive upstream stage entered its 'error' final. ` +
                      `See the upstream's stage_error event for the root cause.`,
                    reason: "upstream_cancelled",
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

            // Cross-region propagation: a stage just entered its error
            // final via executor_failed or no_active_wire (NOT via
            // upstream_cancelled — that's the propagation itself, no
            // need to fan out twice). Dispatch STAGE_CANCELLED to every
            // transitive downstream that hasn't already finalized in
            // this attempt. Idempotent: cancelledByPropagation guards
            // against re-dispatch, and the region's transition guard
            // matches stage===self so each region only reacts to its
            // own cancellation.
            if (
              outcome === "error" &&
              (reason === "executor_failed" || reason === "no_active_wire")
            ) {
              const downstreams = computeTransitiveDownstreams(stageName);
              for (const ds of downstreams) {
                if (cancelledByPropagation.has(ds)) continue;
                if (publishedStageFinal.has(ds)) continue;
                cancelledByPropagation.add(ds);
                dispatcher.send({
                  type: "STAGE_CANCELLED",
                  stage: ds,
                  upstreamStage: stageName,
                });
              }
            }
          }
        }

        if ((snapshot.value === "completed" || snapshot.value === "failed") && !attemptEnded) {
          attemptEnded = true;
          const ctx2 = snapshot.context as MachineContext;
          // Continuation-3 Issue #2 — used to push NO_ACTIVE_WIRE
          // entries into stageErrors here. Now derived at output time
          // from finalizedStages + stageMeta + portValues. We still
          // mark dispatched so other paths skip duplicate processing.
          for (const entry of ctx2.finalizedStages) {
            if (entry.outcome !== "error") continue;
            if (dispatched.has(entry.name)) continue;
            dispatched.add(entry.name);
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
            // Continuation-3 Issue #2 — stageErrors no longer pushed
            // here. The reason classification stays in finalizedStages
            // (set by the compiler's transition action); deriveStageErrors
            // at output time uses stageMeta + portValues to construct
            // the NO_ACTIVE_WIRE diagnostic.
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
                // Gate attempts are finalised by KernelService.answerGate
                // via a raw SQL UPDATE that bypasses finishAttempt — so
                // onAttemptFinishing would never fire for this row.
                // Suppress the start hook too so no dangling 'capturing'
                // checkpoint row is ever inserted.
                suppressHooks: true,
              });
              const { gateId } = kernel.createGate({
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
                // Separate gate_opened event so external MCP callers
                // (wait_for_task_event) can distinguish "pipeline paused
                // for an answer" from a regular stage start without
                // querying the gate_queue table. answerOptions carries
                // each routing key paired with the GateQuestion.options
                // description (P3.7) — routes are authoritative for what
                // the runner will accept, so the list is anchored on
                // Object.keys(routes) and descriptions are pulled from
                // question.options when the author supplied them.
                const optionDescByValue = new Map<string, string>();
                for (const opt of gateStage.config.question.options ?? []) {
                  if (opt.description !== undefined) {
                    optionDescByValue.set(opt.value, opt.description);
                  }
                }
                publish({
                  type: "gate_opened",
                  taskId: opts.taskId,
                  timestamp: isoNow(),
                  data: {
                    gateId,
                    stage: stageName,
                    questionText: gateStage.config.question.text,
                    answerOptions: Object.keys(gateStage.config.routing.routes).map(
                      (value) => {
                        const description = optionDescByValue.get(value);
                        return description !== undefined
                          ? { value, description }
                          : { value };
                      },
                    ),
                  },
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
                // Bug 81: INTERRUPT delivered via dispatcher.send aborts
                // this signal so in-flight fanout elements tear down
                // and queued elements bail before starting.
                interruptSignal: fanoutInterruptController?.signal,
              }).then((result) => {
                if (result.status === "error") {
                  // Continuation-3 Issue #2 — STAGE_FAILED transition
                  // captures result.error into finalizedStages.entry.message.
                  dispatcher.send({
                    type: "STAGE_FAILED",
                    stage: stageName,
                    error: result.error,
                  });
                } else if (result.status === "secret_pending") {
                  // F17/F19: fanout pause path. Mirror the non-fanout
                  // secret_pending handling in runner.ts:1091. Set the
                  // runner-level flag (suppresses task_finals + env
                  // cleanup), do NOT push to stageErrors, dispatch
                  // STAGE_FAILED so the machine's stage region exits
                  // `executing` and the parallel-region final lets
                  // runOneAttempt resolve. The provideTaskSecrets MCP
                  // tool resumes via retryTaskFromStage as usual.
                  // Bug 12: also pause the watchdog — see the matching
                  // comment block at the non-fanout path above.
                  secretPendingObserved = true;
                  pauseBudget();
                  dispatcher.send({
                    type: "STAGE_FAILED",
                    stage: stageName,
                    error: `MCP_ENV_MISSING: stage '${stageName}' fanout needs envKeys [${result.missingKeys.join(", ")}]`,
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

// M-R5: build the per-invocation resume fields the real executor
// consumes. Only fires for the one stage named by opts.resumeFrom;
// downstream stages run fresh so their attempts get their own
// session_id even on a resumed pipeline.
function resumeFieldsForStage(
  opts: RunnerOptions,
  stageName: string,
  taskId: string,
): { resumeSessionId?: string; priorNumTurns?: number } {
  if (!opts.resumeSessionId || !opts.resumeFrom) return {};
  if (stageName !== opts.resumeFrom) return {};
  const row = opts.db.prepare(
    `SELECT aed.agent_stream_json FROM agent_execution_details aed
       JOIN stage_attempts sa ON sa.attempt_id = aed.attempt_id
      WHERE sa.task_id = ? AND sa.stage_name = ? AND aed.session_id = ?
      ORDER BY aed.started_at DESC
      LIMIT 1`,
  ).get(taskId, stageName, opts.resumeSessionId) as
    | { agent_stream_json: string | null }
    | undefined;
  return {
    resumeSessionId: opts.resumeSessionId,
    priorNumTurns: parseNumTurnsFromStream(row?.agent_stream_json ?? null),
  };
}

// Single-session mode — derive segmentContinuation for a stage.
//
// Spec §3: "the next segment opens a new query with options.resume
// pointing at" the prior segment's session_id. Spec §8.4: stage at the
// start of a new segment uses FULL prompt form even when the SDK
// session is resumed.
//
// Returns undefined only when there is no upstream agent stage with a
// persisted session_id (e.g. this is the very first agent stage of the
// pipeline, or upstream is purely script/external).
//
// Otherwise returns:
//   - resumeSessionId: most recent agent ancestor's persisted session
//   - priorNumTurns + priorAttempts: aggregated across all in-segment
//     stages that already ran (segment-wide budget per spec §4.4)
//   - isContinuationStage:
//       true  — this stage is at idx>0 within its segment (the SDK
//               already saw the segment's first-stage full prompt in
//               this same query, render continuation form)
//       false — this stage is at idx 0 of its segment but resumes a
//               prior segment (fresh SDK query with options.resume,
//               render full prompt form per spec §8.4)
// Exported for direct unit tests; runner-internal callers reach it via
// the closure inside runOneAttempt / executeStageLogic.
export function segmentContinuationFor(
  opts: RunnerOptions,
  stageName: string,
  taskId: string,
  ir: PipelineIR,
  segments: string[][],
):
  | {
      resumeSessionId: string;
      priorNumTurns: number;
      priorAttempts: string[];
      isContinuationStage: boolean;
    }
  | undefined {
  // Multi mode: every stage is independent, no segment continuation.
  // (Multi mode's segments[] is a list of size-1 lists per
  // segment-planner; gating on session_mode is also explicit so the
  // function is correct independent of the planner's invariants.)
  if (ir.session_mode !== "single") return undefined;

  const seg = segments.find((s) => s.includes(stageName));
  if (!seg) return undefined;
  const idx = seg.indexOf(stageName);
  const isContinuationStage = idx > 0;

  // Phase 1: in-segment aggregation. For idx>0, sum priorNumTurns and
  // priorAttempts over preceding stages in this segment, and pick the
  // most recent valid session_id within those.
  //
  // Status filter is critical: exclude `superseded` and `error`
  // attempts so a retry doesn't resume a stale or corrupt SDK
  // conversation. `running` MUST be included — an upstream stage
  // typically only just finished writing its outputs (PORT_WRITTEN
  // dispatched synchronously, triggering this stage) and its
  // status='success' transition happens AFTER its writePort calls.
  // At query time, the upstream attempt is therefore still 'running';
  // its session_id is the current live conversation we want to
  // continue. Tested by:
  //   - "retry path: prefers earlier SUCCESS over later SUPERSEDED"
  //   - "passes segmentContinuation to stage 2 of a single-mode 2-stage segment"
  //     (running upstream is what triggers this case in production).
  let inSegmentSession: string | undefined;
  let priorNumTurns = 0;
  const priorAttempts: string[] = [];
  for (let i = 0; i < idx; i++) {
    const prevName = seg[i];
    const r = opts.db.prepare(
      `SELECT aed.session_id, aed.agent_stream_json, aed.attempt_id, aed.started_at
         FROM agent_execution_details aed
         JOIN stage_attempts sa ON sa.attempt_id = aed.attempt_id
        WHERE sa.task_id = ? AND sa.stage_name = ?
          AND sa.status IN ('success', 'running')
        ORDER BY aed.started_at DESC
        LIMIT 1`,
    ).get(taskId, prevName) as
      | { session_id: string | null; agent_stream_json: string | null; attempt_id: string; started_at: number }
      | undefined;
    if (!r) continue;
    priorAttempts.push(r.attempt_id);
    priorNumTurns += parseNumTurnsFromStream(r.agent_stream_json ?? null);
    if (r.session_id) inSegmentSession = r.session_id;
  }

  if (inSegmentSession) {
    return {
      resumeSessionId: inSegmentSession,
      priorNumTurns,
      priorAttempts,
      isContinuationStage,
    };
  }

  // Phase 2: cross-segment resume (opt-in per 2026-04-26 pivot). The
  // stage is either segment-first (idx 0) OR an in-segment stage whose
  // preceding stages have no persisted session yet. Cross-segment
  // resume is no longer automatic — it requires the stage to declare
  // `cross_segment_resume_from` naming a wire-upstream agent in a
  // different segment. Validator (structural.ts) enforces:
  //   - target stage exists
  //   - target is wire-upstream
  //   - target is in a different segment
  // We do NOT re-check those here; runtime trusts the validated IR.
  const stage = ir.stages.find((s) => s.name === stageName);
  if (!stage || stage.type !== "agent") return undefined;
  const target = stage.config.cross_segment_resume_from;
  if (!target) return undefined;

  const upstreamSession = findStageSession(opts, taskId, target);
  if (!upstreamSession) return undefined;

  return {
    resumeSessionId: upstreamSession,
    priorNumTurns,
    priorAttempts,
    isContinuationStage,
  };
}

// Look up the most recent persisted session_id for a single agent
// stage on a task. Status filter: 'success' OR 'running' — see
// segmentContinuationFor's Phase 1 comment for why 'running' is included
// (an upstream stage typically only just finished writing its outputs;
// its status='success' transition happens AFTER its writePort calls,
// so at query time the upstream attempt is often still 'running').
//
// Replaces the pre-2026-04-26 findUpstreamSessionByWires helper, which
// walked wires upstream by BFS. The cross-segment-resume target is now
// named explicitly via cross_segment_resume_from, so no BFS is needed.
function findStageSession(
  opts: RunnerOptions,
  taskId: string,
  stageName: string,
): string | undefined {
  const r = opts.db.prepare(
    `SELECT aed.session_id
       FROM agent_execution_details aed
       JOIN stage_attempts sa ON sa.attempt_id = aed.attempt_id
      WHERE sa.task_id = ? AND sa.stage_name = ?
        AND aed.session_id IS NOT NULL
        AND sa.status IN ('success', 'running')
      ORDER BY aed.started_at DESC
      LIMIT 1`,
  ).get(taskId, stageName) as { session_id: string } | undefined;
  return r?.session_id;
}

// Bug 16 (dogfood 2026-05-02): buildInitialPortValuesRunner removed —
// runner now uses the compiler-exported buildInitialPortValues
// directly, which seeds gate-feedback empty strings + handles
// optional externalInputs. The previous local copy diverged from the
// compiler version (no gate-feedback seeds, no optional fallback)
// and caused gate-rejection-then-approve flows to wedge.

// 2026-05-06: timeout diagnostics. When the wall-clock budget expires
// we want to tell the operator more than just "runPipeline timeout
// after Xms". Find the most recently started attempt for the task,
// report which stage it belonged to and how long the attempt had been
// silent (no heartbeat) before we killed it. Pure DB read; never
// throws — on any error returns null and the caller falls back to the
// raw timeout message.
export function describeLastActiveAttempt(
  db: import("node:sqlite").DatabaseSync,
  taskId: string,
): { stageName: string; attemptIdx: number; silentForMs: number | null } | null {
  try {
    const row = db
      .prepare(
        `SELECT sa.stage_name, sa.attempt_idx, aed.last_heartbeat_at, sa.started_at
           FROM stage_attempts sa
           LEFT JOIN agent_execution_details aed ON aed.attempt_id = sa.attempt_id
          WHERE sa.task_id = ?
          ORDER BY sa.started_at DESC
          LIMIT 1`,
      )
      .get(taskId) as
      | {
          stage_name: string;
          attempt_idx: number;
          last_heartbeat_at: number | null;
          started_at: number;
        }
      | undefined;
    if (!row) return null;
    const lastSignal = row.last_heartbeat_at ?? row.started_at;
    return {
      stageName: row.stage_name,
      attemptIdx: row.attempt_idx,
      silentForMs: row.last_heartbeat_at === null ? null : Date.now() - lastSignal,
    };
  } catch {
    return null;
  }
}
