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
import { taskRegistry } from "./task-registry.js";
import { evaluateGuard } from "./guard-evaluator.js";
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

export async function runPipeline(opts: RunnerOptions, timeoutMs = 10_000): Promise<RunResult> {
  const executor: StageExecutor =
    opts.executor ?? new MockStageExecutor({ handlers: opts.handlers });
  const { machine, stageMeta } = compileIRToMachine(opts.ir, {
    taskId: opts.taskId,
    // Task 1.8 — inline seedValues into initial context.portValues so
    // stage guards see external inputs on the actor's very first
    // snapshot. The DB-side seed phase below handles lineage + SSE.
    seedValues: opts.seedValues,
  });

  // A2.3.2 — non-gate, non-fanout agent/script stages are now invoked as
  // XState children. The compiler places `invoke: { src: 'execute_stage' }`
  // in each such region's executing state; we supply the actor logic here
  // via machine.provide(). The promise body is a thin adapter that calls
  // the already-constructed executor (mock or real) with the input passed
  // through from the invoke. Post-execution side-effects (stageErrors,
  // STAGE_FAILED dispatch on error) still flow through the subscribe()
  // loop below — the invoke's onDone/onError are intentionally shallow
  // because the machine already reaches its final state via PORT_WRITTEN
  // + allOutboundPresent (always guard) as soon as writePort fires.
  //
  // Variable order: we must define dispatcher/portRuntime/stageErrors
  // BEFORE constructing executeStageLogic (which closes over them), but
  // dispatcher needs `actor` (forward ref). We use a `let actor` + an
  // indirection function so the closure resolves actor at call time,
  // after createActor has run.
  interface ExecuteStageInvokeInput {
    stageName: string;
    taskId: string;
    versionHash: string;
    portValues: Record<string, unknown>;
  }
  let actor: ReturnType<typeof createActor<typeof machine>> | null = null;
  const dispatcher: EventDispatcher = {
    send: (event: MachineEvent) => {
      if (actor) actor.send(event);
    },
  };
  const portRuntime = new PortRuntime(
    opts.db,
    dispatcher,
    "regular",
    // Slice 2 — publish port_written on every live write. valuePreview
    // stays small (PREVIEW_BYTES=200) so the event stream never blows
    // up with raw port payloads. Hook is only installed when a
    // broadcaster is provided so non-observed runs pay zero cost.
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

  // Register this run's dispatcher so answer_gate (MCP/REST) can route
  // GATE_ANSWERED events back into our actor. Unregistered in the
  // .finally() below so we never leak across runs even if the machine
  // throws mid-flight.
  taskRegistry.register(opts.taskId, dispatcher);

  // Kernel service used for gate_queue writes when a gate stage activates.
  // skipTypeCheck is fine — the IR was already validated before runPipeline
  // was called and we're only writing gate rows, not re-validating pipelines.
  const kernel = new KernelService(opts.db, { skipTypeCheck: true });

  // Track which stages we've already dispatched an executor for, to avoid
  // double-launching when the actor emits multiple snapshots with the same
  // "executing" state.
  const dispatched = new Set<string>();

  // Track in-flight executor promises so we drain them before resolving
  // the run. Without this, a stage's writePort can fire AFTER the
  // machine transitions to completed (because the final port write is
  // what made the machine enter completed in the first place), causing
  // db writes to race with db.close() in tests.
  const executorPromises: Array<Promise<void>> = [];
  // Drain-time errors: executor promises that reject after finalResult is
  // already set (typical: final writePort -> machine completed -> executor
  // cleanup code throws). Surfaced on the returned RunResult so callers
  // aren't blind.
  const drainErrors: Array<{ stage: string | null; message: string }> = [];
  // Per-stage errors captured from executor results (status="error"). Unlike
  // drainErrors these are the expected "agent produced bad output" path, not
  // executor crashes. Surfacing these lets harnesses distinguish
  // schema-non-compliant failures per stage without a second DB probe.
  const stageErrors: Array<{ stage: string; message: string }> = [];

  // Slice 2 — tiny publish helper. No-op when broadcaster is absent.
  // Centralising event construction keeps timestamps monotonic in
  // publish order (not event-origin order) and prevents accidental
  // KernelNextSSEEvent shape drift across call sites. Errors are
  // shallow-caught because the broadcaster already isolates listener
  // exceptions, but a broken broadcaster itself must not abort the
  // runner's state-machine loop.
  const publish = (event: AnyKernelNextSSEEvent): void => {
    if (!opts.broadcaster) return;
    try {
      opts.broadcaster.publish(event as KernelNextSSEEvent);
    } catch { /* broadcaster failure must not abort the run */ }
  };
  const isoNow = (): string => new Date().toISOString();

  // Track the top-level state we last published, so state transitions
  // emit exactly one task_state event each. idle is published on
  // first observation (not pre-emptively) to stay aligned with the
  // actor's own initial snapshot.
  let lastTopState: TaskTopLevelState | null = null;
  // Track which stage regions we've already published executing /
  // done / error for, so noisy snapshot deliveries don't produce
  // duplicate events.
  const publishedStageExecuting = new Set<string>();
  const publishedStageFinal = new Set<string>();

  let resolveRun: (result: RunResult) => void;
  let rejectRun: (err: Error) => void;
  let machineEnded = false;
  const done = new Promise<RunResult>((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
  });

  const timer = setTimeout(() => {
    rejectRun(new Error(`runPipeline timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  // Task 1.8 — seed phase (externalInputs).
  //
  // Before actor.start(), persist each declared external input as
  // port_values rows under a kind="external" stage_attempts row
  // (stage_name='__external__'). The compiler has already inlined
  // seedValues into initial context.portValues (see compileIRToMachine
  // above), so this block is strictly for lineage (query_lineage /
  // diff_runs / read_port) + SSE (port_written events via the
  // livePortRuntime's onPortWritten hook).
  //
  // Why the DB-side seed must come BEFORE actor.start():
  //   - Writing via portRuntime.writePort after the actor started would
  //     re-deliver PORT_WRITTEN to the machine — but the compiler
  //     already pre-populated context.portValues with the same keys,
  //     so a second delivery is redundant (harmless but wasteful).
  //   - Here, actor is still null; dispatcher.send() is guarded by
  //     `if (actor)` and silently drops — which is the exact behavior
  //     we want: DB writes happen, machine isn't touched twice.
  const externalInputs = opts.ir.externalInputs ?? [];
  if (externalInputs.length > 0) {
    const seedValues = opts.seedValues ?? {};
    // Reject before opening any attempt — keeps failure path clean.
    for (const port of externalInputs) {
      if (!(port.name in seedValues)) {
        clearTimeout(timer);
        taskRegistry.unregister(opts.taskId);
        throw new Error(
          `SEED_VALUES_MISSING_KEY: external input '${port.name}' has no seed value`,
        );
      }
    }
    // Warn on extra keys — not fatal because the pipeline still has
    // every declared input satisfied, but surface the mismatch so an
    // operator can correct a typo or a stale seedValues caller.
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
    // Iterate externalInputs (declaration order) rather than
    // Object.keys(seedValues) so port_values insertion order is
    // deterministic regardless of how the caller constructed the
    // seedValues object.
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

  // A2.3.2 + A2.3.3 — build the executor-as-actor logic. fromCallback
  // replaces A2.3.2's fromPromise so the child can receive INTERRUPT
  // events from the parent's sendTo forward (compiler places
  // `on: INTERRUPT` on each agent stage's executing state). Cancellation
  // is expressed as an AbortSignal the executor consumes; real-executor
  // translates the abort into an INTERRUPT event for its nested
  // AgentMachine per design §4.2.
  //
  // fromCallback doesn't carry `output` on xstate.done.actor — A2.3.2's
  // invoke.onDone/onError were already inert (the region reaches `done`
  // via the allOutboundPresent `always` guard, not via invoke output),
  // so dropping output is harmless. Errors still surface through
  // STAGE_FAILED via the in-body dispatcher.send below.
  const executeStageLogic = fromCallback<
    { type: "INTERRUPT" },
    ExecuteStageInvokeInput
  >(({ input, receive }) => {
    const stageDef = opts.ir.stages.find((s) => s.name === input.stageName);
    if (!stageDef) {
      // Treat as a runner-level bug. The promise below will reject;
      // dispatching a STAGE_FAILED is pointless because the IR is
      // corrupt. Throwing inside fromCallback is recorded by XState as
      // an error.actor event which the region's invoke.onError catches.
      throw new Error(`invoke: stage '${input.stageName}' not found in IR`);
    }
    if (stageDef.type === "gate") {
      throw new Error(`invoke: gate stage '${input.stageName}' should not reach execute_stage`);
    }
    if ((stageDef.type === "agent" || stageDef.type === "script") && stageDef.fanout) {
      // Fanout stages run through the subscribe loop's orchestrateFanoutStage
      // path; this invoke is a no-op for them. No executor work, no
      // interrupt forwarding. The region reaches `done` via the always
      // guard once orchestrateFanoutStage writes the aggregated array.
      return;
    }

    // versionHash — input.versionHash comes from machine context, which
    // the compiler seeds as "" and the runner does not currently
    // overwrite. Prefer opts.versionHash so stage_attempts.version_hash
    // is correctly populated.
    const versionHash = input.versionHash || opts.versionHash;

    // AbortController bridges XState INTERRUPT events → executor signal.
    // The executor listens on `signal.aborted` + the `abort` event to
    // cancel its in-flight work (real-executor translates this into an
    // INTERRUPT event for the nested AgentMachine).
    const ac = new AbortController();

    // Subscribe to events from the parent. The compiler's sendTo on
    // INTERRUPT lands here; we translate it to an AbortController abort.
    // Any other event type is ignored (none are defined at A2.3.3).
    receive((ev) => {
      if (ev.type === "INTERRUPT") ac.abort();
    });

    // Track executor completion so cleanup knows whether to abort.
    // Without this, XState's stop-on-region-exit (happens as soon as
    // the always guard transitions to `done`, which is normal for a
    // successful stage) would fire `ac.abort()` for every stage's
    // invoke, poisoning tests that check signal.aborted as a proxy
    // for "external INTERRUPT landed". Only abort on cleanup when
    // the executor hasn't finished yet.
    let executorDone = false;

    // Fire-and-forget the executor. Promise rejections / status='error'
    // both route to STAGE_FAILED + stageErrors so the region reaches
    // its error final and finalState = 'failed'.
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
          if (!machineEnded) {
            dispatcher.send({
              type: "STAGE_FAILED",
              stage: input.stageName,
              error: result.error ?? "unspecified",
            });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        stageErrors.push({ stage: input.stageName, message });
        if (!machineEnded) {
          dispatcher.send({
            type: "STAGE_FAILED",
            stage: input.stageName,
            error: message,
          });
        }
      } finally {
        executorDone = true;
      }
    })();

    // Cleanup fires when XState stops this invoked child (parent
    // region leaves `executing`, or the whole actor stops). Only
    // abort if the executor is still running — a clean completion
    // should not trigger an artificial abort (see executorDone comment).
    return () => {
      if (!executorDone && !ac.signal.aborted) ac.abort();
    };
  });

  const providedMachine = machine.provide({
    actors: { execute_stage: executeStageLogic },
  });
  actor = createActor(providedMachine, { input: undefined });

  actor.subscribe((snapshot) => {
    // Slice 2 — publish task_state on every top-level transition.
    // snapshot.value is a string at top-level final states and an
    // object ({ running: {...} }) while running; we map both to the
    // four TaskTopLevelState values and dedupe via lastTopState.
    const topValue = snapshot.value;
    const topState: TaskTopLevelState =
      topValue === "idle" ? "idle"
      : topValue === "completed" ? "completed"
      : topValue === "failed" ? "failed"
      : "running"; // any object value (e.g. { running: {...} }) collapses to "running"
    if (topState !== lastTopState) {
      lastTopState = topState;
      publish({
        type: "task_state",
        taskId: opts.taskId,
        timestamp: isoNow(),
        data: { state: topState },
      });
    }

    // Slice 2 — publish stage_done / stage_error for each newly-
    // finalized region. Uses ctx.finalizedStages (Debt #3 retire
    // field) as the source of truth so the set matches what we
    // compute into RunResult.stageErrors. Deduped via
    // publishedStageFinal so noisy snapshot re-deliveries don't
    // produce duplicate events.
    {
      const ctx = snapshot.context as MachineContext;
      for (const entry of ctx.finalizedStages) {
        const { name: stageName, outcome, reason } = entry;
        if (publishedStageFinal.has(stageName)) continue;
        publishedStageFinal.add(stageName);
        if (outcome === "done") {
          publish({
            type: "stage_done",
            taskId: opts.taskId,
            timestamp: isoNow(),
            data: { stage: stageName },
          });
        } else {
          // Dispatch by reason recorded at the entering transition. Legacy
          // absence of reason is treated as no_active_wire for backwards
          // compatibility (old fixture snapshots pre-date the field), but
          // all 3 compiler-emitted paths populate it.
          if (reason === "executor_failed") {
            // Executor failed (agent/script returned status=error or
            // threw). The concrete message has already been pushed to
            // stageErrors by executeStageLogic / orchestrateFanoutStage;
            // reuse it here so the SSE carries the real reason instead
            // of the generic NO_ACTIVE_WIRE text.
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
            // no_active_wire — structured diagnostic attaches failedWires[].
            const err = buildNoActiveWireError(stageName, stageMeta, ctx.portValues);
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

    // Top-level final states -> capture, drain executors, then resolve.
    if ((snapshot.value === "completed" || snapshot.value === "failed") && !machineEnded) {
      machineEnded = true;
      clearTimeout(timer);
      const ctx = snapshot.context as MachineContext;
      // Catch stage-region errors that we never observed via the substate
      // path. When parallel.onDone fires synchronously with a child's final
      // transition (e.g. NO_ACTIVE_WIRE on a short pipeline), the top-level
      // value jumps to `completed` in the same snapshot tick that the
      // child reached `error`, so the substate-level observer below never
      // sees it. ctx.finalizedStages is populated atomically with each
      // region's final.entry (compiler/ir-to-machine.ts), so reading it
      // here is the structured equivalent of the retired log-regex scan.
      for (const entry of ctx.finalizedStages) {
        if (entry.outcome !== "error") continue;
        if (dispatched.has(entry.name)) continue;
        dispatched.add(entry.name);
        // executor_failed path already pushed a concrete message into
        // stageErrors from executeStageLogic / orchestrateFanoutStage
        // before the machine reached final — skip to avoid a second
        // (duplicate, generic) entry. Only no_active_wire needs
        // synthesising here because that path never opened an attempt.
        if (entry.reason === "executor_failed") continue;
        stageErrors.push(
          buildNoActiveWireError(entry.name, stageMeta, ctx.portValues),
        );
      }
      // Drain pending executors before resolving so db writes finish.
      Promise.allSettled(executorPromises).then(() => {
        // Promote finalState to 'failed' if any stage's LATEST attempt
        // ended with status='error' for this task. Looking at the latest
        // attempt per stage (not any attempt) is critical once retry is
        // enabled: silent intermediate failures leave error rows in the
        // table even when the stage ultimately succeeded.
        //
        // The subquery picks the row with the highest attempt_idx per
        // (task, stage); the outer count reports stages whose final
        // attempt ended in error. Zero => no stage failed overall.
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
        const finalState: "completed" | "failed" =
          snapshot.value === "failed" ||
          errorRow.n > 0 ||
          drainErrors.length > 0 ||
          // NO_ACTIVE_WIRE and similar runner-captured errors never touch
          // stage_attempts (no attempt was opened), so they only appear on
          // the stageErrors array; include them in the fail verdict.
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
        resolveRun({
          finalState,
          portValues: ctx.portValues,
          log: ctx.log,
          drainErrors,
          stageErrors,
        });
      });
      return;
    }

    // Stage-level dispatch: look into running.<stage>.<substate>.
    const running = (snapshot.value as { running?: Record<string, string> }).running;
    if (!running) return;

    for (const [stageName, substate] of Object.entries(running)) {
      // Stage region reached `error` final. Three entering paths: true
      // NO_ACTIVE_WIRE (dropped wire), or STAGE_FAILED from an executor
      // (agent/script returned error / threw). Executor_failed stages
      // already pushed a concrete message into stageErrors; only
      // synthesise a NO_ACTIVE_WIRE entry when the reason marks this
      // path. We reuse the `dispatched` set as a seen-marker because
      // a stage that never executed won't be in it.
      if (substate === "error" && !dispatched.has(stageName)) {
        dispatched.add(stageName);
        const ctx = snapshot.context as MachineContext;
        const finalized = ctx.finalizedStages.find((f) => f.name === stageName);
        if (finalized?.reason !== "executor_failed") {
          stageErrors.push(
            buildNoActiveWireError(stageName, stageMeta, ctx.portValues),
          );
        }
        continue;
      }
      if (substate === "executing" && !dispatched.has(stageName)) {
        dispatched.add(stageName);

        const stageDef = opts.ir.stages.find((s) => s.name === stageName);
        if (stageDef?.type === "gate") {
          // Gate stages: open a stage_attempt, register a gate_queue row,
          // and do NOT invoke any executor. The machine stays in
          // `executing` until answer_gate fires a GATE_ANSWERED event
          // (dispatched to us via TaskRegistry).
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
          // The attempt row stays status='running' until answerGate marks
          // it success. That finalization is handled out-of-band (A1.2b.2
          // answer path + later phases); during A1 we leave the row in
          // 'running' and let the machine continue once GATE_ANSWERED
          // arrives.
          continue;
        }

        const ctx = snapshot.context as MachineContext;

        // A3.3 — fanout dispatch. When a stage declares `fanout.input`,
        // the runner iterates the source port's array value, running
        // the executor N times (one virtual attempt per element) with
        // a silent PortRuntime so intermediate writes don't advance
        // the machine. After all elements complete, the runner
        // aggregates each declared output into an array and dispatches
        // a single PORT_WRITTEN per output via the live dispatcher.
        // Minimum-viable scope: sequential execution, no concurrency
        // pool, first element error fails the entire stage.
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
              data: { stage: stageName }, // attemptId deferred — orchestrator owns it
            });
          }
          const fanoutStage = stageDef;
          const p = orchestrateFanoutStage({
            ir: opts.ir,
            stageDef: fanoutStage,
            taskId: opts.taskId,
            versionHash: opts.versionHash,
            basePortValues: ctx.portValues,
            handlers: opts.handlers,
            db: opts.db,
            livePortRuntime: portRuntime,
            executor,
          }).then((result) => {
            if (result.status === "error") {
              stageErrors.push({ stage: stageName, message: result.error });
              // Tell the machine this stage failed so the region can
              // reach its `error` final — otherwise the parallel region
              // never converges and the run times out.
              dispatcher.send({
                type: "STAGE_FAILED",
                stage: stageName,
                error: result.error,
              });
            }
          }, (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            if (!machineEnded) {
              clearTimeout(timer);
              rejectRun(err instanceof Error ? err : new Error(message));
            } else {
              drainErrors.push({ stage: stageName, message });
            }
          });
          executorPromises.push(p);
          continue;
        }

        // A2.3.2 — non-gate, non-fanout agent/script stages are now
        // dispatched by XState's invoke (see compiler: executingBody.invoke).
        // The runner no longer calls executor.executeStage manually here.
        // The invoke's promise body (executeStageLogic, provided above)
        // handles stageErrors + STAGE_FAILED dispatch. We still `dispatched.add`
        // the stage to keep the seen-marker accurate for the subscribe
        // loop's error-final detection.
        //
        // Note: executorPromises / drainErrors are no longer populated for
        // invoke'd stages — XState's actor lifecycle owns the promise now.
        // Run-final draining is still correct because the machine does not
        // reach 'completed' until every region is final, which means every
        // invoke has either resolved or been cancelled by XState.
        if (!publishedStageExecuting.has(stageName)) {
          publishedStageExecuting.add(stageName);
          publish({
            type: "stage_executing",
            taskId: opts.taskId,
            timestamp: isoNow(),
            data: { stage: stageName }, // attemptId lives inside the executor
          });
        }
      }
    }
  });

  actor!.start();
  actor!.send({ type: "START" });
  return done.finally(() => {
    actor!.stop();
    taskRegistry.unregister(opts.taskId);
  });
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
