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

import { createActor } from "xstate";
import type { DatabaseSync } from "node:sqlite";
import { compileIRToMachine } from "../compiler/ir-to-machine.js";
import type { MachineContext, MachineEvent } from "../compiler/ir-to-machine.js";
import { PortRuntime, type EventDispatcher } from "./port-runtime.js";
import { MockStageExecutor, type StageHandlerMap } from "./mock-executor.js";
import type { StageExecutor } from "./executor.js";
import type { PipelineIR, GateStage } from "../ir/schema.js";
import { KernelService } from "../mcp/kernel.js";
import { taskRegistry } from "./task-registry.js";

export interface RunnerOptions {
  db: DatabaseSync;
  ir: PipelineIR;
  taskId: string;
  versionHash: string;
  handlers: StageHandlerMap;
  executor?: StageExecutor;
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
  stageErrors: Array<{ stage: string; message: string }>;
}

export async function runPipeline(opts: RunnerOptions, timeoutMs = 10_000): Promise<RunResult> {
  const executor: StageExecutor =
    opts.executor ?? new MockStageExecutor({ handlers: opts.handlers });
  const { machine } = compileIRToMachine(opts.ir, { taskId: opts.taskId });
  const actor = createActor(machine, {
    input: undefined,
  });

  // Build a dispatcher that forwards to the actor. We can't use
  // createActorDispatcher directly here because actor isn't the right
  // ActorRef shape for the type param; just wrap inline.
  const dispatcher: EventDispatcher = {
    send: (event: MachineEvent) => actor.send(event),
  };

  const portRuntime = new PortRuntime(opts.db, dispatcher);

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

  actor.subscribe((snapshot) => {
    // Top-level final states -> capture, drain executors, then resolve.
    if ((snapshot.value === "completed" || snapshot.value === "failed") && !machineEnded) {
      machineEnded = true;
      clearTimeout(timer);
      const ctx = snapshot.context as MachineContext;
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
          snapshot.value === "failed" || errorRow.n > 0 || drainErrors.length > 0
            ? "failed"
            : "completed";
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
          // The attempt row stays status='running' until answerGate marks
          // it success. That finalization is handled out-of-band (A1.2b.2
          // answer path + later phases); during A1 we leave the row in
          // 'running' and let the machine continue once GATE_ANSWERED
          // arrives.
          continue;
        }

        const ctx = snapshot.context as MachineContext;
        const p = executor.executeStage({
          ir: opts.ir,
          stageName,
          taskId: opts.taskId,
          versionHash: opts.versionHash,
          portValues: ctx.portValues,
          handlers: opts.handlers,
          portRuntime,
        }).then((result) => {
          if (result.status === "error") {
            stageErrors.push({ stage: stageName, message: result.error ?? "unspecified" });
          }
        }, (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          if (!machineEnded) {
            // Pre-end errors reject the whole run — something went wrong
            // before the pipeline had a chance to converge.
            clearTimeout(timer);
            rejectRun(err instanceof Error ? err : new Error(message));
          } else {
            // Post-end (drain) errors: machine already finalized. Collect
            // for the RunResult.drainErrors payload so callers can act on
            // them (tests, observability). Do NOT swallow silently.
            drainErrors.push({ stage: stageName, message });
          }
        });
        executorPromises.push(p);
      }
    }
  });

  actor.start();
  actor.send({ type: "START" });
  return done.finally(() => {
    actor.stop();
    taskRegistry.unregister(opts.taskId);
  });
}
