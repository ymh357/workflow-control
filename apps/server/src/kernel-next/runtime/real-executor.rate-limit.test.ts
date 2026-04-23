// P5.3 / D7 — Integration tests for RealStageExecutor SSE publish path.
//
// Verifies that when the SDK emits rate_limit_event messages with
// utilization crossing the 0.9 threshold, the executor calls
// broadcaster.publish with a well-formed `rate_limit_backoff` event.
// Also verifies that sub-threshold signals produce NO publish calls.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { RealStageExecutor } from "./real-executor.js";
import { PortRuntime } from "./port-runtime.js";
import { DbPromptResolver } from "./db-prompt-resolver.js";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelService } from "../mcp/kernel.js";
import type { PipelineIR } from "../ir/schema.js";
import type { KernelNextSSEEvent } from "../sse/types.js";
import type { KernelNextBroadcaster } from "../sse/broadcaster.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

function oneStageIR(): PipelineIR {
  return {
    name: "rate-limit-test",
    stages: [
      {
        name: "S",
        type: "agent",
        inputs: [],
        outputs: [{ name: "x", type: "number" }],
        config: { promptRef: "p-prompt" },
      },
    ],
    wires: [],
  };
}

function setupHarness(): {
  db: DatabaseSync;
  ir: PipelineIR;
  versionHash: string;
  portRuntime: PortRuntime;
  makeExecutor: (
    queryFn: unknown,
    broadcaster?: KernelNextBroadcaster,
  ) => RealStageExecutor;
  writePortForCurrentAttempt: (value: unknown) => void;
} {
  const db = makeDb();
  const ir = oneStageIR();
  const svc = new KernelService(db, { skipTypeCheck: true });
  const submitRes = svc.submit(ir, { prompts: { "p-prompt": "prompt body" } });
  if (!submitRes.ok) throw new Error("submit failed: " + JSON.stringify(submitRes.diagnostics));
  const portRuntime = new PortRuntime(db, { send: () => { /* inert */ } });
  const writePortForCurrentAttempt = (value: unknown) => {
    const row = db.prepare(
      `SELECT attempt_id FROM stage_attempts WHERE stage_name = 'S' ORDER BY attempt_idx DESC LIMIT 1`,
    ).get() as { attempt_id: string } | undefined;
    if (!row) return;
    portRuntime.writePort({
      attemptId: row.attempt_id, stageName: "S", portName: "x", value,
    });
  };
  const makeExecutor = (
    queryFn: unknown,
    broadcaster?: KernelNextBroadcaster,
  ) =>
    new RealStageExecutor({
      mcpServerFactory: () => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryFn: queryFn as any,
      promptResolver: new DbPromptResolver(db, submitRes.versionHash),
      broadcaster,
    });
  return {
    db, ir, versionHash: submitRes.versionHash,
    portRuntime, makeExecutor, writePortForCurrentAttempt,
  };
}

/**
 * Build a mock broadcaster that captures all publish() calls.
 */
function makeMockBroadcaster(): {
  broadcaster: KernelNextBroadcaster;
  publishes: KernelNextSSEEvent[];
} {
  const publishes: KernelNextSSEEvent[] = [];
  const broadcaster = {
    publish: (e: KernelNextSSEEvent) => publishes.push(e),
  } as unknown as KernelNextBroadcaster;
  return { broadcaster, publishes };
}

/**
 * Emit a minimal SDK stream that:
 *  1. Sends N rate_limit_event messages with the given utilizations.
 *  2. Then writes the stage output and terminates successfully.
 */
function makeRateLimitStream(
  utilizations: number[],
  writePorts: () => void,
) {
  async function* gen() {
    yield { type: "system", subtype: "init", uuid: "u0", session_id: "s" };
    for (const util of utilizations) {
      yield {
        type: "rate_limit_event",
        rate_limit_info: { utilization: util },
        session_id: "s",
      };
    }
    yield {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "w1", name: "write_port", input: {} }],
      },
      session_id: "s",
    };
    writePorts();
    yield {
      type: "user",
      message: { content: [{ type: "tool_result", id: "w1", content: "ok" }] },
      session_id: "s",
    };
    yield {
      type: "result",
      subtype: "success",
      total_cost_usd: 0.001,
      num_turns: 1,
      session_id: "s",
    };
  }
  return gen();
}

describe("RealStageExecutor: rate_limit_backoff SSE publishing", () => {
  it("publishes rate_limit_backoff when utilization >= 0.9", async () => {
    const h = setupHarness();
    const { broadcaster, publishes } = makeMockBroadcaster();

    const executor = h.makeExecutor(
      (_args: unknown) =>
        makeRateLimitStream([0.95], () => h.writePortForCurrentAttempt(1)),
      broadcaster,
    );

    const result = await executor.executeStage({
      ir: h.ir, stageName: "S", taskId: "t1", versionHash: h.versionHash,
      portValues: {}, handlers: {}, portRuntime: h.portRuntime,
    });
    expect(result.status).toBe("success");

    const backoffs = publishes.filter((e) => e.type === "rate_limit_backoff");
    expect(backoffs.length).toBe(1);

    const event = backoffs[0]!;
    expect(event.type).toBe("rate_limit_backoff");
    // data fields
    const data = (event as { type: string; data: Record<string, unknown> }).data;
    expect(data.stage).toBe("S");
    expect(data.utilization).toBe(0.95);
    expect(data.signalCount).toBe(1);
    // rateLimitBackoffMs(1) = 500ms (base * 2^0)
    expect(data.delayMs).toBe(500);

    h.db.close();
  });

  it("does NOT publish when utilization < 0.9", async () => {
    const h = setupHarness();
    const { broadcaster, publishes } = makeMockBroadcaster();

    const executor = h.makeExecutor(
      (_args: unknown) =>
        makeRateLimitStream([0.5], () => h.writePortForCurrentAttempt(2)),
      broadcaster,
    );

    const result = await executor.executeStage({
      ir: h.ir, stageName: "S", taskId: "t1", versionHash: h.versionHash,
      portValues: {}, handlers: {}, portRuntime: h.portRuntime,
    });
    expect(result.status).toBe("success");

    const backoffs = publishes.filter((e) => e.type === "rate_limit_backoff");
    expect(backoffs.length).toBe(0);

    h.db.close();
  });

  it("increments signalCount on consecutive high-util signals", async () => {
    const h = setupHarness();
    const { broadcaster, publishes } = makeMockBroadcaster();

    const executor = h.makeExecutor(
      (_args: unknown) =>
        makeRateLimitStream([0.95, 0.92], () => h.writePortForCurrentAttempt(3)),
      broadcaster,
    );

    const result = await executor.executeStage({
      ir: h.ir, stageName: "S", taskId: "t1", versionHash: h.versionHash,
      portValues: {}, handlers: {}, portRuntime: h.portRuntime,
    });
    expect(result.status).toBe("success");

    const backoffs = publishes.filter((e) => e.type === "rate_limit_backoff");
    expect(backoffs.length).toBe(2);

    const first = (backoffs[0] as { type: string; data: Record<string, unknown> }).data;
    expect(first.signalCount).toBe(1);
    // rateLimitBackoffMs(1) = 500
    expect(first.delayMs).toBe(500);

    const second = (backoffs[1] as { type: string; data: Record<string, unknown> }).data;
    expect(second.signalCount).toBe(2);
    // rateLimitBackoffMs(2) = 1000
    expect(second.delayMs).toBe(1000);

    h.db.close();
  });
});
