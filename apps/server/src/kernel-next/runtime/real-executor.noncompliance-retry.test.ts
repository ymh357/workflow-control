// In-attempt continuation retry on schema non-compliance.
//
// Real regression: 9 of the system's failed tasks (including 4
// pipeline-generator runs) shared the root cause "agent did not call
// write_port for port 'X'". The fix is in-attempt retry — resume the
// SDK session, send a targeted feedback prompt, and let the agent fix
// only the missing port without redoing the rest.
//
// These tests pin the contract:
//   1. round-0 success keeps legacy behaviour (no extra round).
//   2. round-0 missing-port + maxNoncomplianceFeedback>=1 → second
//      query() called with options.resume = round-0 sessionId AND a
//      feedback prompt mentioning the missing port; if round-1 writes
//      the port, the attempt succeeds (status=success).
//   3. all rounds miss → fail with "after N feedback retries" message
//      enumerating the remaining missing ports.
//   4. maxNoncomplianceFeedback=0 → legacy single-port wording (so
//      existing dashboards / matchers don't break).

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

function twoOutputIR(): PipelineIR {
  return {
    name: "feedback-test",
    stages: [
      {
        name: "S",
        type: "agent",
        inputs: [],
        outputs: [
          { name: "alpha", type: "string" },
          { name: "beta", type: "number" },
        ],
        config: { promptRef: "do stuff" },
      },
    ],
    wires: [],
  };
}

// Build an SDK-like stream that returns RESULT_SUCCESS, optionally
// runs a side-effect mid-stream (so the test can write port_values
// representing the agent's tool calls), and reports a sessionId.
function makeStream(opts: {
  sessionId: string;
  writePorts?: () => void;
}) {
  async function* gen() {
    yield { type: "system", subtype: "init", uuid: "u0", session_id: opts.sessionId };
    yield {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "w1", name: "write_port", input: {} }],
      },
      session_id: opts.sessionId,
    };
    opts.writePorts?.();
    yield {
      type: "user",
      message: { content: [{ type: "tool_result", id: "w1", content: "ok" }] },
      session_id: opts.sessionId,
    };
    yield {
      type: "result",
      subtype: "success",
      total_cost_usd: 0.001,
      num_turns: 1,
      session_id: opts.sessionId,
    };
  }
  return gen() as unknown as ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").query>;
}

describe("RealStageExecutor — noncompliance retry-with-feedback", () => {
  it("round-0 success: no second query, legacy behaviour preserved", async () => {
    const db = makeDb();
    const ir = twoOutputIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const portRuntime = new PortRuntime(db, { send: () => { /* inert */ } });

    const queryCalls: Array<{ prompt: unknown; resume?: string }> = [];
    const writeBoth = () => {
      const row = db.prepare(
        `SELECT attempt_id FROM stage_attempts WHERE stage_name = 'S' ORDER BY attempt_idx DESC LIMIT 1`,
      ).get() as { attempt_id: string } | undefined;
      if (!row) return;
      portRuntime.writePort({ attemptId: row.attempt_id, stageName: "S", portName: "alpha", value: "ok" });
      portRuntime.writePort({ attemptId: row.attempt_id, stageName: "S", portName: "beta", value: 7 });
    };
    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryFn: ((args: any) => {
        queryCalls.push({ prompt: args.prompt, resume: args.options?.resume });
        return makeStream({ sessionId: "session-0", writePorts: writeBoth });
      }) as never,
      maxNoncomplianceFeedback: 2,
    });

    const result = await executor.executeStage({
      ir, stageName: "S", taskId: "t-happy", versionHash: hash,
      portValues: {}, handlers: {}, portRuntime,
    });

    expect(result.status).toBe("success");
    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]!.resume).toBeUndefined();
    db.close();
  });

  it("round-0 missing 'alpha' → round-1 feedback prompt resumes session and writes alpha → success", async () => {
    const db = makeDb();
    const ir = twoOutputIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const portRuntime = new PortRuntime(db, { send: () => { /* inert */ } });

    let queryCallIdx = 0;
    const queryCalls: Array<{ prompt: unknown; resume?: string }> = [];
    const writeBetaOnly = () => {
      const row = db.prepare(
        `SELECT attempt_id FROM stage_attempts WHERE stage_name = 'S' ORDER BY attempt_idx DESC LIMIT 1`,
      ).get() as { attempt_id: string } | undefined;
      if (!row) return;
      portRuntime.writePort({ attemptId: row.attempt_id, stageName: "S", portName: "beta", value: 7 });
    };
    const writeAlpha = () => {
      const row = db.prepare(
        `SELECT attempt_id FROM stage_attempts WHERE stage_name = 'S' ORDER BY attempt_idx DESC LIMIT 1`,
      ).get() as { attempt_id: string } | undefined;
      if (!row) return;
      portRuntime.writePort({ attemptId: row.attempt_id, stageName: "S", portName: "alpha", value: "filled-in" });
    };

    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryFn: ((args: any) => {
        queryCalls.push({ prompt: args.prompt, resume: args.options?.resume });
        const idx = queryCallIdx++;
        if (idx === 0) {
          // Round 0: only writes beta; alpha missing → triggers retry.
          return makeStream({ sessionId: "session-0", writePorts: writeBetaOnly });
        }
        // Round 1: agent now writes the missing alpha.
        return makeStream({ sessionId: "session-1", writePorts: writeAlpha });
      }) as never,
      maxNoncomplianceFeedback: 2,
    });

    const result = await executor.executeStage({
      ir, stageName: "S", taskId: "t-feedback", versionHash: hash,
      portValues: {}, handlers: {}, portRuntime,
    });

    expect(result.status).toBe("success");
    // Two queries fired: original + 1 continuation.
    expect(queryCalls).toHaveLength(2);
    // Round-1 query MUST resume from round-0's reported session_id.
    expect(queryCalls[1]!.resume).toBe("session-0");
    // Round-1 prompt MUST mention the missing port name. We don't pin
    // the exact wording (intentional flex room), but 'alpha' should be
    // referenced clearly and 'beta' (which was successfully written)
    // should NOT be re-flagged as missing.
    const feedbackPrompt = String(queryCalls[1]!.prompt);
    expect(feedbackPrompt).toContain("alpha");
    expect(feedbackPrompt).toContain("write_port");
    expect(feedbackPrompt).not.toMatch(/Missing write_port[^]*'beta'/);

    // Stage attempt row final status is success.
    const row = db.prepare(
      `SELECT status FROM stage_attempts WHERE attempt_id = ?`,
    ).get(result.attemptId) as { status: string };
    expect(row.status).toBe("success");
    db.close();
  });

  it("all rounds miss → fail with 'after N feedback retries' wording listing remaining missing ports", async () => {
    const db = makeDb();
    const ir = twoOutputIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const portRuntime = new PortRuntime(db, { send: () => { /* inert */ } });

    const queryCalls: Array<{ resume?: string }> = [];
    let queryCallIdx = 0;
    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryFn: ((args: any) => {
        queryCalls.push({ resume: args.options?.resume });
        const sid = `session-${queryCallIdx++}`;
        // Never writes any port → every round fails schema check.
        return makeStream({ sessionId: sid });
      }) as never,
      maxNoncomplianceFeedback: 2,
    });

    const result = await executor.executeStage({
      ir, stageName: "S", taskId: "t-hopeless", versionHash: hash,
      portValues: {}, handlers: {}, portRuntime,
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected error");
    // 1 original + 2 feedback retries.
    expect(queryCalls).toHaveLength(3);
    // The 2nd and 3rd queries must resume from prior round's session.
    expect(queryCalls[1]!.resume).toBe("session-0");
    expect(queryCalls[2]!.resume).toBe("session-1");
    expect(result.error).toMatch(/after 2 feedback retries/);
    expect(result.error).toContain("alpha");
    expect(result.error).toContain("beta");
    db.close();
  });

  it("maxNoncomplianceFeedback=0 preserves legacy single-port wording for backward compat", async () => {
    const db = makeDb();
    const ir = twoOutputIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const portRuntime = new PortRuntime(db, { send: () => { /* inert */ } });

    const queryCalls: Array<unknown> = [];
    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryFn: ((args: any) => {
        queryCalls.push(args.options?.resume);
        return makeStream({ sessionId: "session-only" });
      }) as never,
      maxNoncomplianceFeedback: 0,
    });

    const result = await executor.executeStage({
      ir, stageName: "S", taskId: "t-legacy", versionHash: hash,
      portValues: {}, handlers: {}, portRuntime,
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected error");
    expect(queryCalls).toHaveLength(1);
    // Legacy form: "schema non-compliant: agent did not call write_port for port 'alpha'"
    expect(result.error).toMatch(/schema non-compliant: agent did not call write_port for port '(alpha|beta)'/);
    expect(result.error).not.toMatch(/feedback retr/);
    db.close();
  });
});
