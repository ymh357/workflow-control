// A2.2 — RealStageExecutor driven by AgentMachine (no real SDK).
//
// We inject a fake `queryFn` that yields a synthetic SDK message stream.
// Port writes happen in the fake (standing in for what the real MCP
// write_port handler would do during tool_use). These tests verify:
//   - Success path: adapter → AgentMachine → done → executor records
//     success + returns status 'success'.
//   - Error path: RESULT_ERROR surfaces as stage_attempt status='error'
//     with the SDK diagnostic message threaded through.
//   - Schema compliance still fails the stage when a declared output
//     port is never written, even if the SDK returns RESULT_SUCCESS.
//
// No subprocess, no CLI, no network.

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
    name: "one-agent",
    stages: [
      {
        name: "S",
        type: "agent",
        inputs: [],
        outputs: [{ name: "x", type: "number" }],
        config: { promptRef: "do stuff" },
      },
    ],
    wires: [],
  };
}

// Factory for an SDK-like message async iterable. Ports are written via
// the provided writeCb (stand-in for MCP write_port handler).
function makeFakeStream(
  subtype: "success" | "error_max_turns",
  opts: { writePorts?: () => void; errorMessage?: string } = {},
) {
  async function* gen() {
    yield { type: "system", subtype: "init", uuid: "u0", session_id: "s" };
    yield {
      type: "assistant",
      message: { content: [{ type: "thinking" }] },
      session_id: "s",
    };
    yield {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "w1", name: "write_port", input: {} }] },
      session_id: "s",
    };
    // Simulate MCP handler side-effect mid-tool.
    opts.writePorts?.();
    yield {
      type: "user",
      message: { content: [{ type: "tool_result", id: "w1", content: "ok" }] },
      session_id: "s",
    };
    yield {
      type: "assistant",
      message: { content: [{ type: "text", text: "done" }] },
      session_id: "s",
    };
    if (subtype === "success") {
      yield {
        type: "result",
        subtype: "success",
        total_cost_usd: 0.005,
        num_turns: 3,
        session_id: "s",
      };
    } else {
      yield {
        type: "result",
        subtype,
        error_message: opts.errorMessage ?? "turns exhausted",
        session_id: "s",
      };
    }
  }
  // Match the SDK's Query shape loosely — cast through unknown.
  return gen() as unknown as ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").query>;
}

describe("RealStageExecutor — AgentMachine-driven (A2.2)", () => {
  it("success: RESULT_SUCCESS + declared port written → stage returns status=success", async () => {
    const db = makeDb();
    const ir = oneStageIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    // Inert dispatcher (no machine listening).
    const portRuntime = new PortRuntime(db, { send: () => { /* inert */ } });

    let writeSideEffect: (() => void) | null = null;
    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryFn: ((_args: any) => makeFakeStream("success", {
        writePorts: () => writeSideEffect?.(),
      })) as never,
    });

    // Hook: once startAttempt runs inside executeStage, we'll need the
    // attemptId to write the port. Do this by patching writeSideEffect
    // right before invocation, reading attemptId from the most-recent row.
    writeSideEffect = () => {
      const row = db.prepare(
        `SELECT attempt_id FROM stage_attempts WHERE stage_name = 'S' ORDER BY attempt_idx DESC LIMIT 1`,
      ).get() as { attempt_id: string } | undefined;
      if (!row) return;
      portRuntime.writePort({
        attemptId: row.attempt_id,
        stageName: "S",
        portName: "x",
        value: 42,
      });
    };

    const result = await executor.executeStage({
      ir, stageName: "S", taskId: "t1", versionHash: hash,
      portValues: {}, handlers: {}, portRuntime,
    });

    expect(result.status).toBe("success");
    const row = db.prepare(
      `SELECT status FROM stage_attempts WHERE attempt_id = ?`,
    ).get(result.attemptId) as { status: string };
    expect(row.status).toBe("success");
    db.close();
  });

  it("error: RESULT_ERROR surfaces as stage error with diagnostic message", async () => {
    const db = makeDb();
    const ir = oneStageIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const portRuntime = new PortRuntime(db, { send: () => { /* inert */ } });

    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryFn: ((_args: any) => makeFakeStream("error_max_turns", {
        errorMessage: "turn cap hit",
      })) as never,
    });

    const result = await executor.executeStage({
      ir, stageName: "S", taskId: "t1", versionHash: hash,
      portValues: {}, handlers: {}, portRuntime,
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("turn cap hit");
    db.close();
  });

  it("success but port missing → schema non-compliance error", async () => {
    const db = makeDb();
    const ir = oneStageIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const portRuntime = new PortRuntime(db, { send: () => { /* inert */ } });

    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      // No writePorts callback — agent "finished" without producing x.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryFn: ((_args: any) => makeFakeStream("success")) as never,
    });

    const result = await executor.executeStage({
      ir, stageName: "S", taskId: "t1", versionHash: hash,
      portValues: {}, handlers: {}, portRuntime,
    });

    expect(result.status).toBe("error");
    expect(result.error).toMatch(/schema non-compliant.*'x'/);
    db.close();
  });
});
