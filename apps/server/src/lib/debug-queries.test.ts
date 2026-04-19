import { describe, it, expect, beforeEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

const testDb = new DatabaseSync(":memory:");
testDb.exec("PRAGMA journal_mode = WAL");
testDb.exec(`
  CREATE TABLE IF NOT EXISTS execution_records (
    attempt_id              TEXT PRIMARY KEY,
    task_id                 TEXT NOT NULL,
    stage_name              TEXT NOT NULL,
    attempt_index           INTEGER NOT NULL,
    pipeline_version_hash   TEXT,
    workflow_control_version TEXT,
    started_at              TEXT NOT NULL,
    terminated_at           TEXT,
    termination_reason      TEXT,
    engine                  TEXT NOT NULL,
    model                   TEXT,
    session_id              TEXT,
    prompt_blob             TEXT NOT NULL,
    reads_snapshot          TEXT NOT NULL,
    tool_calls              TEXT NOT NULL DEFAULT '[]',
    agent_stream            TEXT NOT NULL DEFAULT '[]',
    decisions               TEXT NOT NULL DEFAULT '[]',
    writes_parsed           TEXT,
    writes_committed        TEXT,
    worktree_diff           TEXT,
    worktree_diff_truncated INTEGER NOT NULL DEFAULT 0,
    scratch_pad_snapshot    TEXT,
    cost_usd                REAL,
    token_input             INTEGER,
    token_output            INTEGER,
    duration_ms             INTEGER,
    last_heartbeat_at       TEXT NOT NULL,
    created_at              TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

vi.mock("./db.js", () => ({
  getDb: () => testDb,
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  analyzeTaskFailure,
  diffExecutions,
  getStageExecutionRecord,
} from "./debug-queries.js";

interface InsertRowOptions {
  attemptId: string;
  taskId: string;
  stageName: string;
  attemptIndex: number;
  terminationReason?: string | null;
  terminatedAt?: string | null;
  startedAt?: string;
  lastHeartbeatAt?: string;
  engine?: string;
  model?: string | null;
  pipelineVersionHash?: string | null;
  promptBlob?: Record<string, unknown>;
  readsSnapshot?: Record<string, unknown>;
  writesCommitted?: Record<string, unknown> | null;
  toolCalls?: unknown[];
  agentStream?: unknown[];
  decisions?: unknown[];
  costUsd?: number | null;
  tokenInput?: number | null;
  tokenOutput?: number | null;
  durationMs?: number | null;
}

function insertRow(opts: InsertRowOptions): void {
  const promptBlob = opts.promptBlob ?? {
    tier1: "",
    systemPromptFull: "",
    stagePrompt: "",
    invariants: [],
    fragments: [],
    outputSchema: null,
  };
  testDb
    .prepare(
      `INSERT INTO execution_records (
         attempt_id, task_id, stage_name, attempt_index,
         pipeline_version_hash, workflow_control_version,
         started_at, terminated_at, termination_reason,
         engine, model, session_id,
         prompt_blob, reads_snapshot,
         tool_calls, agent_stream, decisions,
         writes_parsed, writes_committed,
         worktree_diff, worktree_diff_truncated,
         scratch_pad_snapshot,
         cost_usd, token_input, token_output, duration_ms,
         last_heartbeat_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.attemptId,
      opts.taskId,
      opts.stageName,
      opts.attemptIndex,
      opts.pipelineVersionHash ?? null,
      "0.0.1",
      opts.startedAt ?? "2026-01-01T00:00:00Z",
      opts.terminatedAt ?? null,
      opts.terminationReason ?? null,
      opts.engine ?? "claude",
      opts.model ?? "sonnet",
      null,
      JSON.stringify(promptBlob),
      JSON.stringify(opts.readsSnapshot ?? {}),
      JSON.stringify(opts.toolCalls ?? []),
      JSON.stringify(opts.agentStream ?? []),
      JSON.stringify(opts.decisions ?? []),
      null,
      opts.writesCommitted !== undefined
        ? opts.writesCommitted === null
          ? null
          : JSON.stringify(opts.writesCommitted)
        : null,
      null,
      0,
      null,
      opts.costUsd ?? null,
      opts.tokenInput ?? null,
      opts.tokenOutput ?? null,
      opts.durationMs ?? null,
      opts.lastHeartbeatAt ?? opts.startedAt ?? "2026-01-01T00:00:00Z",
    );
}

beforeEach(() => {
  testDb.exec("DELETE FROM execution_records");
});

describe("analyzeTaskFailure", () => {
  it("returns found=false with zero_attempts hint when no rows", () => {
    const r = analyzeTaskFailure("unknown-task");
    expect(r.found).toBe(false);
    expect(r.totalAttempts).toBe(0);
    expect(r.hints).toHaveLength(1);
    expect(r.hints[0]!.kind).toBe("zero_attempts");
  });

  it("summarizes stages, last attempt wins", () => {
    insertRow({
      attemptId: "a1",
      taskId: "t1",
      stageName: "analyze",
      attemptIndex: 0,
      terminationReason: "natural_completion",
      terminatedAt: "2026-01-01T00:01:00Z",
      costUsd: 0.01,
      tokenInput: 100,
      tokenOutput: 50,
      writesCommitted: { analysis: { title: "x" } },
    });
    insertRow({
      attemptId: "a2",
      taskId: "t1",
      stageName: "implement",
      attemptIndex: 0,
      terminationReason: "natural_completion",
      terminatedAt: "2026-01-01T00:02:00Z",
      costUsd: 0.02,
      writesCommitted: { result: { summary: "done" } },
    });
    const r = analyzeTaskFailure("t1");
    expect(r.found).toBe(true);
    expect(r.totalAttempts).toBe(2);
    expect(r.totalCostUsd).toBeCloseTo(0.03, 6);
    expect(r.stages).toHaveLength(2);
    expect(r.failingStages).toEqual([]);
    expect(r.hints).toEqual([]);
  });

  it("flags stuck_open stage (terminated_at null)", () => {
    insertRow({
      attemptId: "a1",
      taskId: "t1",
      stageName: "analyze",
      attemptIndex: 0,
      terminationReason: null,
      terminatedAt: null,
      lastHeartbeatAt: "2026-01-01T00:00:30Z",
    });
    const r = analyzeTaskFailure("t1");
    expect(r.failingStages).toEqual(["analyze"]);
    expect(r.stages[0]!.isStuckOpen).toBe(true);
    expect(r.hints[0]!.kind).toBe("stuck_open");
    expect(r.hints[0]!.attemptId).toBe("a1");
  });

  it("flags exceeded_retries and scans agent_stream for error markers", () => {
    insertRow({
      attemptId: "a1",
      taskId: "t1",
      stageName: "implement",
      attemptIndex: 0,
      terminationReason: "error_exceeded_retries",
      terminatedAt: "2026-01-01T00:05:00Z",
      agentStream: [
        { type: "text", text: "trying approach A", timestamp: "t" },
        { type: "text", text: "Error: cannot find module 'foo'", timestamp: "t" },
      ],
    });
    const r = analyzeTaskFailure("t1");
    expect(r.failingStages).toEqual(["implement"]);
    const kinds = r.hints.map((h) => h.kind);
    expect(kinds).toContain("exceeded_retries");
    expect(kinds).toContain("error_in_stream");
    const errHint = r.hints.find((h) => h.kind === "error_in_stream")!;
    expect(errHint.detail).toContain("cannot find module");
  });

  it("flags no_writes on natural completion with empty writes", () => {
    insertRow({
      attemptId: "a1",
      taskId: "t1",
      stageName: "analyze",
      attemptIndex: 0,
      terminationReason: "natural_completion",
      terminatedAt: "2026-01-01T00:01:00Z",
      writesCommitted: {},
    });
    const r = analyzeTaskFailure("t1");
    expect(r.hints.some((h) => h.kind === "no_writes")).toBe(true);
  });

  it("firstStartedAt is the earliest across all stages", () => {
    insertRow({
      attemptId: "a1",
      taskId: "t1",
      stageName: "analyze",
      attemptIndex: 0,
      startedAt: "2026-01-02T00:00:00Z",
      terminationReason: "natural_completion",
      terminatedAt: "2026-01-02T00:01:00Z",
      writesCommitted: { analysis: { ok: true } },
    });
    insertRow({
      attemptId: "a2",
      taskId: "t1",
      stageName: "implement",
      attemptIndex: 0,
      startedAt: "2026-01-01T00:00:00Z",
      terminationReason: "natural_completion",
      terminatedAt: "2026-01-01T00:01:00Z",
      writesCommitted: { result: { ok: true } },
    });
    const r = analyzeTaskFailure("t1");
    expect(r.firstStartedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("uses last attempt per stage when multiple exist", () => {
    insertRow({
      attemptId: "a1",
      taskId: "t1",
      stageName: "analyze",
      attemptIndex: 0,
      terminationReason: "error_exceeded_retries",
      terminatedAt: "2026-01-01T00:01:00Z",
    });
    insertRow({
      attemptId: "a2",
      taskId: "t1",
      stageName: "analyze",
      attemptIndex: 1,
      terminationReason: "natural_completion",
      terminatedAt: "2026-01-01T00:02:00Z",
      writesCommitted: { analysis: { ok: true } },
    });
    const r = analyzeTaskFailure("t1");
    expect(r.stages[0]!.attempts).toBe(2);
    expect(r.stages[0]!.lastAttemptIndex).toBe(1);
    expect(r.stages[0]!.lastTerminationReason).toBe("natural_completion");
    expect(r.failingStages).toEqual([]);
  });
});

describe("getStageExecutionRecord", () => {
  it("returns found=false with empty availableAttempts when no rows", () => {
    const r = getStageExecutionRecord("t1", "analyze");
    expect(r.found).toBe(false);
    expect(r.availableAttempts).toEqual([]);
    expect(r.record).toBeNull();
  });

  it("returns latest attempt by default", () => {
    insertRow({ attemptId: "a1", taskId: "t1", stageName: "s", attemptIndex: 0, terminationReason: "natural_completion" });
    insertRow({ attemptId: "a2", taskId: "t1", stageName: "s", attemptIndex: 1, terminationReason: "natural_completion" });
    insertRow({ attemptId: "a3", taskId: "t1", stageName: "s", attemptIndex: 2, terminationReason: "error_exceeded_retries" });
    const r = getStageExecutionRecord("t1", "s");
    expect(r.found).toBe(true);
    expect(r.attempt).toBe(2);
    expect(r.record?.attemptId).toBe("a3");
    expect(r.availableAttempts).toEqual([0, 1, 2]);
  });

  it("returns specific attempt when requested", () => {
    insertRow({ attemptId: "a1", taskId: "t1", stageName: "s", attemptIndex: 0, terminationReason: "natural_completion" });
    insertRow({ attemptId: "a2", taskId: "t1", stageName: "s", attemptIndex: 1, terminationReason: "natural_completion" });
    const r = getStageExecutionRecord("t1", "s", { attempt: 0 });
    expect(r.found).toBe(true);
    expect(r.record?.attemptId).toBe("a1");
  });

  it("returns found=false when attempt index doesn't exist", () => {
    insertRow({ attemptId: "a1", taskId: "t1", stageName: "s", attemptIndex: 0, terminationReason: "natural_completion" });
    const r = getStageExecutionRecord("t1", "s", { attempt: 99 });
    expect(r.found).toBe(false);
    expect(r.availableAttempts).toEqual([0]);
  });

  it("reconstructs nested JSON fields correctly", () => {
    insertRow({
      attemptId: "a1",
      taskId: "t1",
      stageName: "s",
      attemptIndex: 0,
      terminationReason: "natural_completion",
      promptBlob: {
        tier1: "hello",
        systemPromptFull: "sys",
        stagePrompt: "stage",
        invariants: ["inv1"],
        fragments: [{ id: "f1", contentHash: "h1" }],
        outputSchema: { type: "object" },
      },
      readsSnapshot: { foo: "bar" },
      writesCommitted: { out: { x: 1 } },
      decisions: [{
        timestamp: "t", context: "c", optionsConsidered: ["a", "b"],
        chosen: "a", reasoning: "because",
      }],
      toolCalls: [{
        id: "tu1", name: "Read", input: { path: "/x" }, result: null,
        isError: false, tokenIn: null, tokenOut: null,
        durationMs: null, startedAt: "t", finishedAt: null,
      }],
    });
    const r = getStageExecutionRecord("t1", "s");
    expect(r.record?.promptBlob.invariants).toEqual(["inv1"]);
    expect(r.record?.readsSnapshot).toEqual({ foo: "bar" });
    expect(r.record?.writesCommitted).toEqual({ out: { x: 1 } });
    expect(r.record?.decisions).toHaveLength(1);
    expect(r.record?.toolCalls).toHaveLength(1);
  });
});

describe("diffExecutions", () => {
  it("reports missing attempts", () => {
    const r = diffExecutions("nope1", "nope2");
    expect(r.found).toBe(false);
    expect(r.missing).toEqual(["nope1", "nope2"]);
    expect(r.differences).toBeNull();
  });

  it("reports identical=true when records match", () => {
    const row = {
      promptBlob: {
        tier1: "x",
        systemPromptFull: "s",
        stagePrompt: "p",
        invariants: [],
        fragments: [],
        outputSchema: null,
      },
      readsSnapshot: { a: 1 },
      writesCommitted: { out: 2 },
      terminationReason: "natural_completion",
      costUsd: 0.01,
      durationMs: 1000,
    };
    insertRow({ attemptId: "a1", taskId: "t1", stageName: "s", attemptIndex: 0, ...row });
    insertRow({ attemptId: "a2", taskId: "t1", stageName: "s", attemptIndex: 1, ...row });
    const r = diffExecutions("a1", "a2");
    expect(r.found).toBe(true);
    expect(r.identical).toBe(true);
    expect(r.differences?.promptBlob).toEqual([]);
    expect(r.differences?.readsSnapshot.changed).toEqual([]);
  });

  it("flags identical=false when shared tool_call counts differ", () => {
    const base = {
      promptBlob: {
        tier1: "x", systemPromptFull: "s", stagePrompt: "p",
        invariants: [], fragments: [], outputSchema: null,
      },
      readsSnapshot: {},
      writesCommitted: {},
      terminationReason: "natural_completion",
    };
    insertRow({
      attemptId: "a1", taskId: "t1", stageName: "s", attemptIndex: 0, ...base,
      toolCalls: [
        { id: "t1", name: "Read", input: {}, result: null, isError: false, tokenIn: null, tokenOut: null, durationMs: null, startedAt: "t", finishedAt: null },
      ],
    });
    insertRow({
      attemptId: "a2", taskId: "t1", stageName: "s", attemptIndex: 1, ...base,
      toolCalls: [
        { id: "t2", name: "Read", input: {}, result: null, isError: false, tokenIn: null, tokenOut: null, durationMs: null, startedAt: "t", finishedAt: null },
        { id: "t3", name: "Read", input: {}, result: null, isError: false, tokenIn: null, tokenOut: null, durationMs: null, startedAt: "t", finishedAt: null },
      ],
    });
    const r = diffExecutions("a1", "a2");
    expect(r.found).toBe(true);
    expect(r.identical).toBe(false);
    expect(r.differences!.toolCalls.countByName.shared.Read).toEqual({ a: 1, b: 2 });
  });

  it("catches prompt, reads, writes, decisions, and tool_call diffs", () => {
    insertRow({
      attemptId: "a1",
      taskId: "t1",
      stageName: "s",
      attemptIndex: 0,
      terminationReason: "error_exceeded_retries",
      promptBlob: {
        tier1: "v1",
        systemPromptFull: "s1",
        stagePrompt: "p",
        invariants: ["i1"],
        fragments: [],
        outputSchema: null,
      },
      readsSnapshot: { a: 1, b: 2 },
      writesCommitted: { x: "old" },
      decisions: [
        { timestamp: "t", context: "c1", optionsConsidered: ["a", "b"], chosen: "a", reasoning: "r" },
      ],
      toolCalls: [
        { id: "t1", name: "Read", input: {}, result: null, isError: false, tokenIn: null, tokenOut: null, durationMs: null, startedAt: "t", finishedAt: null },
        { id: "t2", name: "Read", input: {}, result: null, isError: false, tokenIn: null, tokenOut: null, durationMs: null, startedAt: "t", finishedAt: null },
      ],
      costUsd: 0.05,
      durationMs: 5000,
    });
    insertRow({
      attemptId: "a2",
      taskId: "t1",
      stageName: "s",
      attemptIndex: 1,
      terminationReason: "natural_completion",
      promptBlob: {
        tier1: "v2",
        systemPromptFull: "s1",
        stagePrompt: "p",
        invariants: ["i1", "i2"],
        fragments: [],
        outputSchema: null,
      },
      readsSnapshot: { a: 1, c: 3 },
      writesCommitted: { x: "new", y: "added" },
      decisions: [
        { timestamp: "t", context: "c1", optionsConsidered: ["a", "b"], chosen: "b", reasoning: "r" },
      ],
      toolCalls: [
        { id: "t3", name: "Read", input: {}, result: null, isError: false, tokenIn: null, tokenOut: null, durationMs: null, startedAt: "t", finishedAt: null },
        { id: "t4", name: "Edit", input: {}, result: null, isError: false, tokenIn: null, tokenOut: null, durationMs: null, startedAt: "t", finishedAt: null },
      ],
      costUsd: 0.07,
      durationMs: 6000,
    });
    const r = diffExecutions("a1", "a2");
    expect(r.found).toBe(true);
    expect(r.identical).toBe(false);
    const d = r.differences!;
    expect(d.promptBlob.find((x) => x.field === "promptBlob.tier1")).toBeDefined();
    expect(d.promptBlob.find((x) => x.field === "promptBlob.invariants")).toBeDefined();
    expect(d.readsSnapshot.onlyInA).toEqual(["b"]);
    expect(d.readsSnapshot.onlyInB).toEqual(["c"]);
    expect(d.readsSnapshot.unchanged).toEqual(["a"]);
    expect(d.writesCommitted.changed[0]?.key).toBe("x");
    expect(d.writesCommitted.onlyInB).toEqual(["y"]);
    expect(d.decisions.onlyInA[0]?.chosen).toBe("a");
    expect(d.decisions.onlyInB[0]?.chosen).toBe("b");
    expect(d.toolCalls.countByName.shared.Read).toEqual({ a: 2, b: 1 });
    expect(d.toolCalls.countByName.onlyInB.Edit).toBe(1);
    expect(d.termination[0]?.field).toBe("terminationReason");
    expect(d.cost.deltaUsd).toBeCloseTo(0.02, 6);
    expect(d.durationMs.deltaMs).toBe(1000);
  });
});
