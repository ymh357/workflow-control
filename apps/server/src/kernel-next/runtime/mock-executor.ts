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
  const { ir, stageName, taskId, versionHash, portValues, handlers, portRuntime, fanoutElementIdx } = args;
  const stage = ir.stages.find((s) => s.name === stageName);
  if (!stage) throw new Error(`Stage '${stageName}' not in IR`);

  // 1. Start attempt. Forward fanoutElementIdx so fanout_element rows
  //    get their idx populated (B17 full).
  const { attemptId, attemptIdx } = portRuntime.startAttempt({
    taskId, versionHash, stageName, fanoutElementIdx,
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
 *
 * Optional hooks:
 *   - onExecute(args): invoked before each stage delegation; receives
 *     the full ExecuteStageArgs (including segmentContinuation set by
 *     the runner). Used by tests to assert what the runner passed.
 *   - persistSessionIdMap: per-stage entry can be a bare session_id
 *     string (num_turns defaults to 0) or { sessionId, numTurns } so
 *     multi-stage segment tests can verify segment-wide priorNumTurns
 *     summing. After a stage succeeds, inserts a synthetic
 *     agent_execution_details row so the runner's segment lookup can
 *     resolve prior-stage session IDs in subsequent stages. Mirrors
 *     what RealStageExecutor does via writer.updateSessionId.
 */
export type MockSessionPersistEntry =
  | string
  | { sessionId: string; numTurns?: number };

export class MockStageExecutor implements StageExecutor {
  private readonly handlers: StageHandlerMap;
  private readonly onExecute?: (args: ExecuteStageArgs) => void;
  private readonly persistSessionIdMap?: Record<string, MockSessionPersistEntry>;

  constructor(options: {
    handlers: StageHandlerMap;
    onExecute?: (args: ExecuteStageArgs) => void;
    persistSessionIdMap?: Record<string, MockSessionPersistEntry>;
  }) {
    this.handlers = options.handlers;
    this.onExecute = options.onExecute;
    this.persistSessionIdMap = options.persistSessionIdMap;
  }

  async executeStage(args: ExecuteStageArgs): Promise<ExecuteStageResult> {
    this.onExecute?.(args);

    // When persistSessionIdMap is set for this stage, we need to insert the
    // agent_execution_details row BEFORE portRuntime.writePort fires the
    // PORT_WRITTEN event that triggers downstream stage execution. If we
    // insert after executeStage returns, a microtask race makes the next
    // stage's segmentContinuationFor SQL run before the row is committed.
    // Achieve ordering by running the stage inline and inserting between the
    // handler call and the port writes.
    const entry = this.persistSessionIdMap?.[args.stageName];
    if (entry !== undefined) {
      const sessionId = typeof entry === "string" ? entry : entry.sessionId;
      const numTurns = typeof entry === "string" ? 0 : (entry.numTurns ?? 0);
      return this.executeStageWithSessionPersist(args, sessionId, numTurns);
    }

    return executeStage({
      ...args,
      handlers: args.handlers ?? this.handlers,
    });
  }

  /**
   * Inline execution path used when persistSessionIdMap includes this stage.
   * Mirrors the top-level executeStage logic but inserts the synthetic
   * agent_execution_details row BEFORE writing ports so the DB is consistent
   * by the time PORT_WRITTEN triggers downstream stage evaluation.
   *
   * KNOWN DUPLICATION: ~70 lines of input gathering, handler invocation,
   * and output filtering are copy-pasted from the top-level `executeStage`
   * above. The duplication is mock-test-only code and the surface is
   * narrow (only persistSessionIdMap callers reach this path). A cleaner
   * factoring would expose a `beforePortWrite?: (attemptId, sessionId)
   * => void` hook on the top-level executeStage so this becomes a
   * 3-line wrapper. Deferred — see Task 7 code-review I-1 (2026-04-25).
   */
  private async executeStageWithSessionPersist(
    args: ExecuteStageArgs,
    sessionId: string,
    numTurns: number,
  ): Promise<ExecuteStageResult> {
    const { ir, stageName, taskId, versionHash, portValues, portRuntime, fanoutElementIdx } = args;
    const handlers = args.handlers ?? this.handlers;

    const stage = ir.stages.find((s) => s.name === stageName);
    if (!stage) throw new Error(`Stage '${stageName}' not in IR`);

    const { attemptId, attemptIdx } = portRuntime.startAttempt({
      taskId, versionHash, stageName, fanoutElementIdx,
    });

    // Gather inputs (same as top-level executeStage).
    const inputs: Record<string, unknown> = {};
    for (const p of stage.inputs) {
      const wire = ir.wires.find(
        (w) => w.to.stage === stageName && w.to.port === p.name,
      );
      if (!wire) continue;
      const fromStage = wire.from.source === "external" ? "__external__" : wire.from.stage;
      const srcKey = `${fromStage}.${wire.from.port}`;
      const value = portValues[srcKey];
      inputs[p.name] = value;
      portRuntime.recordRead({ attemptId, stageName, portName: p.name, value });
    }

    // Invoke handler.
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

    // Insert agent_execution_details BEFORE writing ports so the row is
    // visible to downstream segmentContinuationFor SQL when PORT_WRITTEN
    // triggers the next stage's invoke (XState dispatches synchronously).
    const db = portRuntime.getDb();
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO prompt_contents (content_hash, content, created_at)
       VALUES (?, ?, ?)`,
    ).run("mock-hash", "(mock)", now);
    // Build a synthetic agent_stream_json containing one result message
    // with the requested num_turns, so segment-wide priorNumTurns sums
    // correctly in tests that exercise multi-stage segments.
    const streamBlob = JSON.stringify(
      numTurns > 0
        ? [{ type: "result", subtype: "success", num_turns: numTurns, session_id: sessionId }]
        : [],
    );
    // No try/catch: any FK / NOT NULL violation here is a real bug in the
    // mock helper, and surfacing it as a thrown SQLite error is the correct
    // diagnostic — silently swallowing would produce confusing
    // "expected sess-X, got undefined" failures elsewhere.
    db.prepare(
      `INSERT INTO agent_execution_details (
         attempt_id, prompt_ref, prompt_content_hash, prompt_content,
         model, session_id, started_at, last_heartbeat_at,
         tool_calls_json, agent_stream_json, compact_events_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, '[]')`,
    ).run(
      attemptId, "mock-ref", "mock-hash", "(mock)", "mock-model",
      sessionId, now, now, streamBlob,
    );

    // Write declared outputs (triggers PORT_WRITTEN → machine evaluates next stage).
    const declaredOutPorts = new Set(stage.outputs.map((p) => p.name));
    for (const [key, value] of Object.entries(outputs)) {
      if (!declaredOutPorts.has(key)) continue;
      portRuntime.writePort({ attemptId, stageName, portName: key, value });
    }

    portRuntime.finishAttempt(attemptId, "success");
    return { attemptId, attemptIdx, status: "success" };
  }
}
