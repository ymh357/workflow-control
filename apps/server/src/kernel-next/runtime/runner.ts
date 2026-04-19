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
  finalState: "completed" | "failed" | "timeout";
  portValues: Record<string, unknown>;
  log: string[];
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

  let resolveRun: (result: RunResult) => void;
  let rejectRun: (err: Error) => void;
  let finalResult: RunResult | null = null;
  const done = new Promise<RunResult>((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
  });

  const timer = setTimeout(() => {
    rejectRun(new Error(`runPipeline timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  actor.subscribe((snapshot) => {
    // Top-level final states -> capture, drain executors, then resolve.
    if ((snapshot.value === "completed" || snapshot.value === "failed") && !finalResult) {
      clearTimeout(timer);
      const ctx = snapshot.context as MachineContext;
      finalResult = {
        finalState: snapshot.value,
        portValues: ctx.portValues,
        log: ctx.log,
      };
      // Drain pending executors before resolving so db writes finish.
      Promise.allSettled(executorPromises).then(() => {
        resolveRun(finalResult!);
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
        }).then(() => { /* discard */ }, (err) => {
          // Swallow here: we surface errors via the finalResult drain.
          // Individual stage failures are already recorded as
          // stage_attempts.status='error' by mock-executor.
          if (!finalResult) {
            clearTimeout(timer);
            rejectRun(err);
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
