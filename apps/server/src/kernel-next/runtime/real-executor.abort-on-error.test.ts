// F22 — abort-on-error tests.
//
// Verify that the AbortController plumbed into the SDK via buildSdkBaseOptions
// is aborted when doAttempt terminates with status='error'. This prevents the
// SDK subprocess from writing port_values rows tied to an attempt that is
// already terminal (the round-9 dogfood bug: MCP_STARTUP_FAILED fires, attempt
// marked error, SDK keeps running ~100s, calls write_port, corrupts downstream
// port reads).
//
// Strategy: inject a queryFn that captures options.abortController from its
// invocation args. After executeStage resolves with status='error', assert
// abortController.signal.aborted === true.
//
// Note: the MCP_STARTUP_FAILED path triggers the F22 #1 retry budget (3 free
// retries with 2s/5s/10s backoffs). To keep tests fast and avoid ~17s waits,
// the primary abort test uses a stream that terminates with error_max_turns
// (a normal error not subject to the MCP retry budget). The abort invariant
// is the same for both paths — the finishAttempt(error) call site in the
// outer catch always runs abortController.abort() before delegating.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { RealStageExecutor } from "./real-executor.js";
import { PortRuntime } from "./port-runtime.js";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { versionHash } from "../ir/canonical.js";
import type { PipelineIR } from "../ir/schema.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

function oneStageIR(): PipelineIR {
  return {
    name: "abort-on-error-test",
    stages: [
      {
        name: "S",
        type: "agent",
        inputs: [],
        outputs: [],
        config: { promptRef: "do stuff" },
      },
    ],
    wires: [],
  };
}

/** Stream that yields a non-MCP error so the attempt fails without hitting
 *  the MCP_STARTUP_FAILED retry budget. */
async function* errorMaxTurnsStream() {
  yield { type: "system", subtype: "init", uuid: "u0", session_id: "s" };
  yield { type: "result", subtype: "error_max_turns", error_message: "turns exhausted", session_id: "s" };
}

describe("RealStageExecutor — abortController aborted on error (F22)", () => {
  it("abortController.signal.aborted is true after executeStage returns error", async () => {
    const db = makeDb();
    const ir = oneStageIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const portRuntime = new PortRuntime(db, { send: () => { /* inert */ } });

    let capturedAbortController: AbortController | undefined;

    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      queryFn: ((_args: { prompt: string; options: { abortController?: AbortController } }) => {
        // Capture the abortController passed in via options so we can
        // assert its state after executeStage resolves.
        capturedAbortController = _args.options?.abortController;
        return errorMaxTurnsStream() as unknown as ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").query>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    });

    const result = await executor.executeStage({
      ir,
      stageName: "S",
      taskId: "t-abort-on-error",
      versionHash: hash,
      portValues: {},
      handlers: {},
      portRuntime,
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected error result");
    expect(result.error).toContain("turns exhausted");

    // Primary invariant (F22): SDK controller must be aborted so the
    // subprocess cannot write port_values after the attempt is terminal.
    expect(capturedAbortController).toBeDefined();
    expect(capturedAbortController!.signal.aborted).toBe(true);

    db.close();
  });

  it("abortController is aborted on schema non-compliance (port not written)", async () => {
    const db = makeDb();
    // Stage with a declared output port — agent completes but doesn't write it.
    const ir: PipelineIR = {
      name: "schema-abort-test",
      stages: [
        {
          name: "S",
          type: "agent",
          inputs: [],
          outputs: [{ name: "x", type: "string" }],
          config: { promptRef: "do stuff" },
        },
      ],
      wires: [],
    };
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const portRuntime = new PortRuntime(db, { send: () => { /* inert */ } });

    let capturedAbortController: AbortController | undefined;

    async function* successStreamNoPortWrite() {
      yield { type: "system", subtype: "init", uuid: "u0", session_id: "s" };
      yield { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s" };
    }

    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      queryFn: ((_args: { prompt: string; options: { abortController?: AbortController } }) => {
        capturedAbortController = _args.options?.abortController;
        return successStreamNoPortWrite() as unknown as ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").query>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    });

    const result = await executor.executeStage({
      ir,
      stageName: "S",
      taskId: "t-schema-abort",
      versionHash: hash,
      portValues: {},
      handlers: {},
      portRuntime,
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected error result");
    expect(result.error).toMatch(/schema non-compliant.*'x'/);

    // AbortController must be aborted even on schema compliance failures.
    expect(capturedAbortController).toBeDefined();
    expect(capturedAbortController!.signal.aborted).toBe(true);

    db.close();
  });

  it("abortController is a fresh instance per doAttempt call (not shared across retries)", async () => {
    const db = makeDb();
    const ir = oneStageIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const portRuntime = new PortRuntime(db, { send: () => { /* inert */ } });

    const capturedControllers: AbortController[] = [];

    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      maxRetries: 1, // 2 attempts total
      queryFn: ((_args: { prompt: string; options: { abortController?: AbortController } }) => {
        if (_args.options?.abortController) {
          capturedControllers.push(_args.options.abortController);
        }
        return errorMaxTurnsStream() as unknown as ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").query>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    });

    await executor.executeStage({
      ir,
      stageName: "S",
      taskId: "t-retry-isolation",
      versionHash: hash,
      portValues: {},
      handlers: {},
      portRuntime,
    });

    // Should have two separate controller instances — one per attempt.
    expect(capturedControllers.length).toBe(2);
    expect(capturedControllers[0]).not.toBe(capturedControllers[1]);
    // Both should be aborted after their respective doAttempt frames completed.
    expect(capturedControllers[0]!.signal.aborted).toBe(true);
    expect(capturedControllers[1]!.signal.aborted).toBe(true);

    db.close();
  });
});
