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
import { executeStage, type StageHandlerMap } from "./mock-executor.js";
import type { PipelineIR } from "../ir/schema.js";

export interface RunnerOptions {
  db: DatabaseSync;
  ir: PipelineIR;
  taskId: string;
  versionHash: string;
  handlers: StageHandlerMap;
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
}

export async function runPipeline(opts: RunnerOptions, timeoutMs = 10_000): Promise<RunResult> {
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
        // Promote finalState to 'failed' if any stage_attempt ended with
        // status='error' for this task. Covers the §6.1 design intent that
        // XState parallel.onDone alone can't distinguish (since both 'done'
        // and 'error' are region final states).
        const errorRow = opts.db.prepare(
          `SELECT COUNT(*) AS n FROM stage_attempts
           WHERE task_id = ? AND status = 'error'`,
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
        const ctx = snapshot.context as MachineContext;
        const p = executeStage({
          ir: opts.ir,
          stageName,
          taskId: opts.taskId,
          versionHash: opts.versionHash,
          portValues: ctx.portValues,
          handlers: opts.handlers,
          portRuntime,
        }).then(() => { /* discard */ }, (err: unknown) => {
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
  return done.finally(() => actor.stop());
}
