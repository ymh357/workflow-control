import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPromptContent } from "../ir/sql.js";
import { openExecutionRecordWriter } from "./execution-record-writer.js";

function seedAttempt(db: DatabaseSync, attemptId: string): void {
  db.prepare(
    `INSERT INTO pipeline_versions (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
     VALUES ('v1','t',0,NULL,'{}','')`,
  ).run();
  db.prepare(
    `INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status)
     VALUES (?, 'tk', 'v1', 'analyzing', 1, 0, 'running')`,
  ).run(attemptId);
  insertPromptContent(db, "hash-1", "prompt body");
}

describe("execution-record-writer", () => {
  it("opens a row with prompt context and initial defaults", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seedAttempt(db, "a1");

    const w = openExecutionRecordWriter(db, {
      attemptId: "a1",
      promptRef: "analyzing",
      promptContentHash: "hash-1",
      promptContent: "prompt body",
      model: "claude-haiku-4-5",
    });

    const row = db.prepare("SELECT * FROM agent_execution_details WHERE attempt_id = ?").get("a1") as Record<string, unknown>;
    expect(row.prompt_ref).toBe("analyzing");
    expect(row.prompt_content_hash).toBe("hash-1");
    expect(row.model).toBe("claude-haiku-4-5");
    expect(row.tool_calls_json).toBe("[]");
    expect(row.agent_stream_json).toBe("[]");
    expect(row.started_at).toBeGreaterThan(0);
    expect(row.ended_at).toBeNull();

    w.close({ terminationReason: "natural_completion" });
  });

  it("appendToolCall + completeToolCall persist via flush", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seedAttempt(db, "a2");

    const w = openExecutionRecordWriter(db, {
      attemptId: "a2",
      promptRef: "r",
      promptContentHash: "hash-1",
      promptContent: "p",
      model: "m",
    });

    w.appendToolCall({
      id: "t1",
      name: "write_port",
      input: { port: "x", value: 1 },
      result: null,
      isError: false,
      tokenIn: null,
      tokenOut: null,
      durationMs: null,
      startedAt: "2026-04-24T00:00:00Z",
      finishedAt: null,
    });
    w.completeToolCall("t1", { result: "ok", finishedAt: "2026-04-24T00:00:01Z", durationMs: 1000 });
    w.__flushForTests();

    const row = db.prepare("SELECT tool_calls_json FROM agent_execution_details WHERE attempt_id = ?").get("a2") as { tool_calls_json: string };
    const calls = JSON.parse(row.tool_calls_json) as Array<Record<string, unknown>>;
    expect(calls.length).toBe(1);
    expect(calls[0]!.id).toBe("t1");
    expect(calls[0]!.result).toBe("ok");
    expect(calls[0]!.durationMs).toBe(1000);

    w.close({ terminationReason: "natural_completion" });
  });

  it("appendAgentStream accumulates text and thinking events", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seedAttempt(db, "a3");
    const w = openExecutionRecordWriter(db, {
      attemptId: "a3", promptRef: "r", promptContentHash: "hash-1",
      promptContent: "p", model: "m",
    });
    w.appendAgentStream({ type: "text", text: "hello", timestamp: "t1" });
    w.appendAgentStream({ type: "thinking", text: "think", timestamp: "t2" });
    w.__flushForTests();
    const row = db.prepare("SELECT agent_stream_json FROM agent_execution_details WHERE attempt_id = ?").get("a3") as { agent_stream_json: string };
    const events = JSON.parse(row.agent_stream_json);
    expect(events.length).toBe(2);
    expect(events[0].type).toBe("text");
    expect(events[1].type).toBe("thinking");
    w.close({ terminationReason: "natural_completion" });
  });

  it("close sets ended_at, termination_reason, cost, duration_ms", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seedAttempt(db, "a4");
    const w = openExecutionRecordWriter(db, {
      attemptId: "a4", promptRef: "r", promptContentHash: "hash-1",
      promptContent: "p", model: "m",
    });
    w.close({ terminationReason: "natural_completion", costUsd: 0.03, tokenInput: 500, tokenOutput: 200, sessionId: "sess-1" });
    const row = db.prepare("SELECT * FROM agent_execution_details WHERE attempt_id = ?").get("a4") as Record<string, unknown>;
    expect(row.ended_at).not.toBeNull();
    expect(row.termination_reason).toBe("natural_completion");
    expect(row.cost_usd).toBe(0.03);
    expect(row.token_input).toBe(500);
    expect(row.token_output).toBe(200);
    expect(row.session_id).toBe("sess-1");
    expect(Number(row.duration_ms)).toBeGreaterThanOrEqual(0);
  });

  it("close is idempotent (second call is a no-op)", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seedAttempt(db, "a5");
    const w = openExecutionRecordWriter(db, {
      attemptId: "a5", promptRef: "r", promptContentHash: "hash-1",
      promptContent: "p", model: "m",
    });
    w.close({ terminationReason: "natural_completion" });
    const row1 = db.prepare("SELECT ended_at FROM agent_execution_details WHERE attempt_id = ?").get("a5") as { ended_at: number };
    w.close({ terminationReason: "superseded" });
    const row2 = db.prepare("SELECT ended_at, termination_reason FROM agent_execution_details WHERE attempt_id = ?").get("a5") as { ended_at: number; termination_reason: string };
    expect(row2.ended_at).toBe(row1.ended_at);  // unchanged
    expect(row2.termination_reason).toBe("natural_completion"); // unchanged
  });

  it("returns no-op writer + logs warning when FK violates (missing stage_attempts row)", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    insertPromptContent(db, "hash-1", "p");

    // No stage_attempts row for "missing-attempt" — FK will fail.
    const w = openExecutionRecordWriter(db, {
      attemptId: "missing-attempt",
      promptRef: "r",
      promptContentHash: "hash-1",
      promptContent: "p",
      model: "m",
    });

    // Calls succeed silently (no-op).
    expect(() => {
      w.appendToolCall({
        id: "t1", name: "write_port", input: {}, result: null, isError: false,
        tokenIn: null, tokenOut: null, durationMs: null, startedAt: "t", finishedAt: null,
      });
      w.appendAgentStream({ type: "text", text: "x", timestamp: "t" });
      w.close({ terminationReason: "natural_completion" });
    }).not.toThrow();

    // No row inserted.
    const row = db.prepare("SELECT COUNT(*) AS n FROM agent_execution_details WHERE attempt_id = ?").get("missing-attempt") as { n: number };
    expect(row.n).toBe(0);
  });

  it("appendCompactEvent + completeCompactEvent persist via flush", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seedAttempt(db, "c1");
    const w = openExecutionRecordWriter(db, {
      attemptId: "c1", promptRef: "r", promptContentHash: "hash-1",
      promptContent: "p", model: "m",
    });
    w.appendCompactEvent({
      trigger: "auto", preTokens: 45000,
      startedAt: "2026-04-24T00:00:00Z",
    });
    w.completeCompactEvent("2026-04-24T00:00:05Z");
    w.__flushForTests();
    const row = db.prepare(
      "SELECT compact_events_json FROM agent_execution_details WHERE attempt_id = ?",
    ).get("c1") as { compact_events_json: string };
    const events = JSON.parse(row.compact_events_json);
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      trigger: "auto", preTokens: 45000,
      startedAt: "2026-04-24T00:00:00Z",
      endedAt: "2026-04-24T00:00:05Z",
    });
    w.close({ terminationReason: "natural_completion" });
  });

  it("completeCompactEvent with no open compact is a no-op", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seedAttempt(db, "c2");
    const w = openExecutionRecordWriter(db, {
      attemptId: "c2", promptRef: "r", promptContentHash: "hash-1",
      promptContent: "p", model: "m",
    });
    // completeCompactEvent before any appendCompactEvent — no row open
    expect(() => w.completeCompactEvent("2026-04-24T00:00:01Z")).not.toThrow();
    w.__flushForTests();
    const row = db.prepare(
      "SELECT compact_events_json FROM agent_execution_details WHERE attempt_id = ?",
    ).get("c2") as { compact_events_json: string };
    expect(JSON.parse(row.compact_events_json)).toEqual([]);
    w.close({ terminationReason: "natural_completion" });
  });

  it("attempt ending while still in compact leaves endedAt null", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seedAttempt(db, "c3");
    const w = openExecutionRecordWriter(db, {
      attemptId: "c3", promptRef: "r", promptContentHash: "hash-1",
      promptContent: "p", model: "m",
    });
    w.appendCompactEvent({
      trigger: "manual", preTokens: 5000,
      startedAt: "2026-04-24T00:01:00Z",
    });
    // close WITHOUT calling completeCompactEvent
    w.close({ terminationReason: "interrupted" });
    const row = db.prepare(
      "SELECT compact_events_json FROM agent_execution_details WHERE attempt_id = ?",
    ).get("c3") as { compact_events_json: string };
    const events = JSON.parse(row.compact_events_json);
    expect(events.length).toBe(1);
    expect(events[0].endedAt).toBeNull();
  });

  it("updateSessionId flushes immediately so session_id survives crash", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seedAttempt(db, "a-sid");
    const w = openExecutionRecordWriter(db, {
      attemptId: "a-sid", promptRef: "r", promptContentHash: "hash-1",
      promptContent: "p", model: "m",
    });
    // Before: sessionId is null
    const before = db.prepare(
      "SELECT session_id FROM agent_execution_details WHERE attempt_id = ?",
    ).get("a-sid") as { session_id: string | null };
    expect(before.session_id).toBeNull();

    // Call updateSessionId — MUST flush synchronously; we do NOT call
    // __flushForTests between the update and the read. A crash (SIGKILL)
    // between updateSessionId and writer.close would otherwise lose the id.
    w.updateSessionId("sess-12345");

    const after = db.prepare(
      "SELECT session_id FROM agent_execution_details WHERE attempt_id = ?",
    ).get("a-sid") as { session_id: string | null };
    expect(after.session_id).toBe("sess-12345");
    w.close({ terminationReason: "natural_completion" });
  });

  it("heartbeat updates last_heartbeat_at without closing", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seedAttempt(db, "a6");
    const w = openExecutionRecordWriter(db, {
      attemptId: "a6", promptRef: "r", promptContentHash: "hash-1",
      promptContent: "p", model: "m",
    });
    const before = db.prepare("SELECT last_heartbeat_at FROM agent_execution_details WHERE attempt_id = ?").get("a6") as { last_heartbeat_at: number };
    // Sleep briefly so heartbeat timestamp can advance.
    const waitMs = 5;
    const start = Date.now();
    while (Date.now() - start < waitMs) { /* spin */ }
    w.heartbeat();
    const after = db.prepare("SELECT last_heartbeat_at, ended_at FROM agent_execution_details WHERE attempt_id = ?").get("a6") as { last_heartbeat_at: number; ended_at: number | null };
    expect(after.last_heartbeat_at).toBeGreaterThanOrEqual(before.last_heartbeat_at);
    expect(after.ended_at).toBeNull();
    w.close({ terminationReason: "natural_completion" });
  });
});
