// Mock stage executor — spike-only.
//
// A "real" executor (phase 2) invokes the Claude Agent SDK with the stage's
// prompt, consumes its output, parses writes, and calls port-runtime to
// persist them. See runtime/real-executor.ts.
//
// The mock version takes a hardcoded `StageHandler` per stage name and calls
// it with the input port values. runner.ts observes stage transitions to
// `executing` and triggers the matching handler via the top-level
// `executeStage` function (kept for back-compat with existing tests), or via
// the `MockStageExecutor` class (new P1 surface that mirrors
// RealStageExecutor).

import type {
  ExecuteStageArgs,
  ExecuteStageResult,
  StageExecutor,
  StageHandlerMap,
} from "./executor.js";

// Re-export shared types so existing importers (runner.ts, tests) keep
// working via `from "./mock-executor.js"`.
export type {
  StageHandler,
  StageHandlerContext,
  StageHandlerMap,
  ExecuteStageArgs,
  ExecuteStageResult,
} from "./executor.js";

export async function executeStage(args: ExecuteStageArgs): Promise<ExecuteStageResult> {
  const { ir, stageName, taskId, versionHash, portValues, handlers, portRuntime } = args;
  const stage = ir.stages.find((s) => s.name === stageName);
  if (!stage) throw new Error(`Stage '${stageName}' not in IR`);

  // 1. Start attempt.
  const { attemptId, attemptIdx } = portRuntime.startAttempt({
    taskId, versionHash, stageName,
  });

  // 2. Gather inputs from wire sources. For each input port, find the wire
  //    whose `to` is (stage, inputPort) and read the source port value.
  const inputs: Record<string, unknown> = {};
  for (const p of stage.inputs) {
    const wire = ir.wires.find(
      (w) => w.to.stage === stageName && w.to.port === p.name,
    );
    if (!wire) continue; // dangling input; real validator catches this, tolerate here
    // Bridge: Task 1.2 introduced WireSource. Task 1.3+ will resolve external
    // sources against the externalInputs namespace.
    const fromStage = wire.from.source === "external" ? "__external__" : wire.from.stage;
    const srcKey = `${fromStage}.${wire.from.port}`;
    const value = portValues[srcKey];
    inputs[p.name] = value;
    // Record lineage: this stage read this input.
    portRuntime.recordRead({
      attemptId, stageName, portName: p.name, value,
    });
  }

  // 3. Invoke handler.
  const handler = handlers[stageName];
  if (!handler) {
    portRuntime.finishAttempt(attemptId, "error", `No handler for stage '${stageName}'`);
    return { attemptId, attemptIdx, status: "error", error: `No handler for stage '${stageName}'` };
  }

  let outputs: Record<string, unknown>;
  try {
    outputs = await handler(inputs, { taskId, stageName, attemptId, attemptIdx });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    portRuntime.finishAttempt(attemptId, "error", msg);
    return { attemptId, attemptIdx, status: "error", error: msg };
  }

  // 4. Write declared outputs. Any undeclared key in `outputs` is ignored
  //    (same stance as legacy kernel's filterStoreWrites).
  const declaredOutPorts = new Set(stage.outputs.map((p) => p.name));
  for (const [key, value] of Object.entries(outputs)) {
    if (!declaredOutPorts.has(key)) continue;
    portRuntime.writePort({ attemptId, stageName, portName: key, value });
  }

  // 5. Finish attempt.
  portRuntime.finishAttempt(attemptId, "success");
  return { attemptId, attemptIdx, status: "success" };
}

/**
 * Class-form wrapper over the top-level `executeStage`. Mirrors
 * RealStageExecutor so callers can pick between mock and real without
 * branching on function vs class. `handlers` is captured at construction
 * time and merged into the args before delegation — callers may still
 * pass `handlers` in args (it takes precedence).
 */
export class MockStageExecutor implements StageExecutor {
  private readonly handlers: StageHandlerMap;

  constructor(options: { handlers: StageHandlerMap }) {
    this.handlers = options.handlers;
  }

  executeStage(args: ExecuteStageArgs): Promise<ExecuteStageResult> {
    return executeStage({
      ...args,
      handlers: args.handlers ?? this.handlers,
    });
  }
}
