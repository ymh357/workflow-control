// A1 field #8 — compact_events capture by RealStageExecutor.
// Streams a fake SDK with one compact_boundary → verify sidecar
// accumulates a {trigger, preTokens, startedAt, endedAt} entry.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { RealStageExecutor } from "./real-executor.js";
import { PortRuntime } from "./port-runtime.js";
import { DbPromptResolver } from "./db-prompt-resolver.js";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelService } from "../mcp/kernel.js";
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
  makeExecutor: (queryFn: unknown) => RealStageExecutor;
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
  const makeExecutor = (queryFn: unknown) => new RealStageExecutor({
    mcpServerFactory: () => ({}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queryFn: queryFn as any,
    promptResolver: new DbPromptResolver(db, submitRes.versionHash),
  });
  return {
    db, ir, versionHash: submitRes.versionHash,
    portRuntime, makeExecutor, writePortForCurrentAttempt,
  };
}

/**
 * Fake SDK stream with a compact_boundary event between two assistant
 * turns. `onBoundaryConsumed` fires once as the write_port side-effect.
 */
function makeCompactStream(opts: {
  writePorts: () => void;
  trigger: "auto" | "manual";
  preTokens: number;
  /**
   * If true, end the stream while STILL inside the compact window
   * (no follow-up non-compact message). Forces endedAt = null in the
   * sidecar record.
   */
  endInCompact?: boolean;
}) {
  async function* gen() {
    yield { type: "system", subtype: "init", uuid: "u0", session_id: "s" };
    yield {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: opts.trigger, pre_tokens: opts.preTokens },
      session_id: "s",
    };
    if (!opts.endInCompact) {
      yield {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "w1", name: "write_port", input: {} }] },
        session_id: "s",
      };
      opts.writePorts();
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
    } else {
      opts.writePorts();
    }
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

describe("RealStageExecutor compact events", () => {
  it("records an auto-compact with startedAt + endedAt when stream resumes", async () => {
    const h = setupHarness();
    const executor = h.makeExecutor((_args: unknown) => makeCompactStream({
      trigger: "auto", preTokens: 45_000,
      writePorts: () => h.writePortForCurrentAttempt(1),
    }));

    const result = await executor.executeStage({
      ir: h.ir, stageName: "S", taskId: "t1", versionHash: h.versionHash,
      portValues: {}, handlers: {}, portRuntime: h.portRuntime,
    });
    expect(result.status).toBe("success");

    const aed = h.db.prepare(
      `SELECT compact_events_json FROM agent_execution_details WHERE attempt_id = ?`,
    ).get(result.attemptId) as { compact_events_json: string };
    const events = JSON.parse(aed.compact_events_json) as Array<{
      trigger: string; preTokens: number; startedAt: string; endedAt: string | null;
    }>;
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      trigger: "auto", preTokens: 45_000,
    });
    expect(events[0]!.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(events[0]!.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    h.db.close();
  });

  it("records a manual compact trigger correctly", async () => {
    // The adapter emits a synthetic COMPACT_ENDED before any non-compact
    // message that follows compact_boundary, so in normal streams endedAt
    // always gets filled. The "ends inside compact" (endedAt=null) case
    // only arises when the stream is truncated by error/interrupt before
    // any follow-up message; that path is covered in the writer unit
    // tests. Here we assert the manual trigger is captured as-is.
    const h = setupHarness();
    const executor = h.makeExecutor((_args: unknown) => makeCompactStream({
      trigger: "manual", preTokens: 1234,
      writePorts: () => h.writePortForCurrentAttempt(2),
    }));
    const result = await executor.executeStage({
      ir: h.ir, stageName: "S", taskId: "t1", versionHash: h.versionHash,
      portValues: {}, handlers: {}, portRuntime: h.portRuntime,
    });
    expect(result.status).toBe("success");
    const aed = h.db.prepare(
      `SELECT compact_events_json FROM agent_execution_details WHERE attempt_id = ?`,
    ).get(result.attemptId) as { compact_events_json: string };
    const events = JSON.parse(aed.compact_events_json) as Array<{
      trigger: string; preTokens: number; startedAt: string; endedAt: string | null;
    }>;
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      trigger: "manual", preTokens: 1234,
    });
    expect(events[0]!.endedAt).not.toBeNull();
    h.db.close();
  });

  it("no compact events → empty JSON array", async () => {
    const h = setupHarness();
    async function* noCompact() {
      yield { type: "system", subtype: "init", uuid: "u0", session_id: "s" };
      yield {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "w1", name: "write_port", input: {} }] },
        session_id: "s",
      };
      h.writePortForCurrentAttempt(7);
      yield {
        type: "user",
        message: { content: [{ type: "tool_result", id: "w1", content: "ok" }] },
        session_id: "s",
      };
      yield {
        type: "result",
        subtype: "success",
        total_cost_usd: 0.001, num_turns: 1, session_id: "s",
      };
    }
    const executor = h.makeExecutor((_args: unknown) => noCompact());
    const result = await executor.executeStage({
      ir: h.ir, stageName: "S", taskId: "t1", versionHash: h.versionHash,
      portValues: {}, handlers: {}, portRuntime: h.portRuntime,
    });
    expect(result.status).toBe("success");
    const aed = h.db.prepare(
      `SELECT compact_events_json FROM agent_execution_details WHERE attempt_id = ?`,
    ).get(result.attemptId) as { compact_events_json: string };
    expect(JSON.parse(aed.compact_events_json)).toEqual([]);
    h.db.close();
  });
});
