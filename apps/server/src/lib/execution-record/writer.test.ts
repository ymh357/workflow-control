import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { DatabaseSync } from "node:sqlite";

// Real in-memory SQLite with the same DDL as lib/db.ts installs.
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

vi.mock("../db.js", () => ({
  getDb: () => testDb,
}));

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  createExecutionRecordWriter,
  reapOrphanedRecords,
} from "./writer.js";
import type {
  OpenRecordInput,
  PromptBlob,
} from "./types.js";

const ORIGINAL_FLAG = process.env.ENABLE_EXECUTION_RECORD;

beforeEach(() => {
  testDb.exec("DELETE FROM execution_records");
  process.env.ENABLE_EXECUTION_RECORD = "true";
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) {
    delete process.env.ENABLE_EXECUTION_RECORD;
  } else {
    process.env.ENABLE_EXECUTION_RECORD = ORIGINAL_FLAG;
  }
  vi.useRealTimers();
});

function basePromptBlob(): PromptBlob {
  return {
    tier1: "TIER1",
    systemPromptFull: "SYS",
    stagePrompt: "STAGE",
    invariants: [],
    fragments: [],
    outputSchema: null,
  };
}

function baseOpen(overrides: Partial<OpenRecordInput> = {}): OpenRecordInput {
  return {
    taskId: "task-1",
    stageName: "analyze",
    attemptIndex: 1,
    pipelineVersionHash: null,
    engine: "claude",
    model: "claude-sonnet-4-6",
    sessionId: null,
    promptBlob: basePromptBlob(),
    readsSnapshot: { foo: "bar" },
    ...overrides,
  };
}

function readRow(attemptId: string): Record<string, unknown> | undefined {
  const row = testDb
    .prepare("SELECT * FROM execution_records WHERE attempt_id = ?")
    .get(attemptId);
  return row as Record<string, unknown> | undefined;
}

describe("ExecutionRecordWriter — feature flag", () => {
  it("returns a no-op writer when flag is off, no DB row created", () => {
    process.env.ENABLE_EXECUTION_RECORD = "false";
    const writer = createExecutionRecordWriter(baseOpen());
    expect(writer.isNoop).toBe(true);

    // No-op methods are safe to call
    writer.appendAgentStream({
      type: "text",
      text: "hi",
      timestamp: new Date().toISOString(),
    });
    writer.close({ terminationReason: "natural_completion" });

    const count = testDb
      .prepare("SELECT COUNT(*) as n FROM execution_records")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("returns a real writer and inserts row when flag is on", () => {
    const writer = createExecutionRecordWriter(
      baseOpen({ attemptId: "att-1" }),
    );
    expect(writer.isNoop).toBe(false);
    expect(writer.attemptId).toBe("att-1");
    const row = readRow("att-1");
    expect(row).toBeDefined();
    expect(row!.task_id).toBe("task-1");
    expect(row!.stage_name).toBe("analyze");
    expect(row!.terminated_at).toBeNull();
    expect(row!.tool_calls).toBe("[]");
    expect(row!.agent_stream).toBe("[]");
    writer.close({ terminationReason: "natural_completion" });
  });

  // T1.2 — software version must be captured at open time.
  it("captures workflow_control_version on insert", () => {
    const writer = createExecutionRecordWriter(
      baseOpen({ attemptId: "att-wcv" }),
    );
    const row = readRow("att-wcv")!;
    // Format: "0.0.1" or "0.0.1+abc1234" — never null / empty, never "unknown"
    // when running inside the repo with the package.json present.
    expect(row.workflow_control_version).toMatch(/^\d+\.\d+\.\d+(\+[0-9a-f]{7,40})?$/);
    writer.close({ terminationReason: "natural_completion" });
  });
});

describe("ExecutionRecordWriter — open/close basic flow", () => {
  it("closes with terminal fields persisted", () => {
    const writer = createExecutionRecordWriter(
      baseOpen({ attemptId: "att-close" }),
    );
    writer.close({
      terminationReason: "natural_completion",
      writesParsed: { x: 1 },
      writesCommitted: { x: 1, y: 2 },
      costUsd: 0.25,
      tokenInput: 100,
      tokenOutput: 200,
      durationMs: 5_000,
      sessionId: "sess-1",
    });
    const row = readRow("att-close")!;
    expect(row.terminated_at).not.toBeNull();
    expect(row.termination_reason).toBe("natural_completion");
    expect(JSON.parse(row.writes_parsed as string)).toEqual({ x: 1 });
    expect(JSON.parse(row.writes_committed as string)).toEqual({ x: 1, y: 2 });
    expect(row.cost_usd).toBe(0.25);
    expect(row.token_input).toBe(100);
    expect(row.token_output).toBe(200);
    expect(row.duration_ms).toBe(5_000);
    expect(row.session_id).toBe("sess-1");
  });

  it("persists readsSnapshot JSON", () => {
    const writer = createExecutionRecordWriter(
      baseOpen({
        attemptId: "att-reads",
        readsSnapshot: { analysis: { title: "T", count: 3 } },
      }),
    );
    const row = readRow("att-reads")!;
    expect(JSON.parse(row.reads_snapshot as string)).toEqual({
      analysis: { title: "T", count: 3 },
    });
    writer.close({ terminationReason: "natural_completion" });
  });

  it("persists promptBlob JSON verbatim", () => {
    const blob: PromptBlob = {
      tier1: "T1",
      systemPromptFull: "FULL",
      stagePrompt: "SP",
      invariants: ["inv-a", "inv-b"],
      fragments: [{ id: "frag-1", contentHash: "hash-1" }],
      outputSchema: { type: "object" },
    };
    const writer = createExecutionRecordWriter(
      baseOpen({ attemptId: "att-prompt", promptBlob: blob }),
    );
    const row = readRow("att-prompt")!;
    expect(JSON.parse(row.prompt_blob as string)).toEqual(blob);
    writer.close({ terminationReason: "natural_completion" });
  });
});

describe("ExecutionRecordWriter — streaming appends", () => {
  it("flushes buffered tool_calls and agent_stream on close", () => {
    const writer = createExecutionRecordWriter(
      baseOpen({ attemptId: "att-stream" }),
    );
    writer.appendAgentStream({
      type: "text",
      text: "hello",
      timestamp: "2026-04-18T00:00:00Z",
    });
    writer.appendAgentStream({
      type: "thinking",
      text: "hmm",
      timestamp: "2026-04-18T00:00:01Z",
    });
    writer.appendToolCall({
      id: "t1",
      name: "Read",
      input: { path: "/a" },
      result: null,
      isError: false,
      tokenIn: null,
      tokenOut: null,
      durationMs: null,
      startedAt: "2026-04-18T00:00:02Z",
      finishedAt: null,
    });
    writer.completeToolCall("t1", {
      result: "file contents",
      finishedAt: "2026-04-18T00:00:03Z",
      durationMs: 120,
    });
    writer.close({ terminationReason: "natural_completion" });

    const row = readRow("att-stream")!;
    const stream = JSON.parse(row.agent_stream as string);
    expect(stream).toHaveLength(2);
    expect(stream[0]).toMatchObject({ type: "text", text: "hello" });
    expect(stream[1]).toMatchObject({ type: "thinking", text: "hmm" });

    const toolCalls = JSON.parse(row.tool_calls as string);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      id: "t1",
      name: "Read",
      result: "file contents",
      durationMs: 120,
    });
  });

  it("appends ignored after close (no-throw)", () => {
    const writer = createExecutionRecordWriter(
      baseOpen({ attemptId: "att-post-close" }),
    );
    writer.close({ terminationReason: "natural_completion" });
    writer.appendAgentStream({
      type: "text",
      text: "late",
      timestamp: "2026-04-18T00:00:00Z",
    });
    writer.appendToolCall({
      id: "t-late",
      name: "late-tool",
      input: {},
      result: null,
      isError: false,
      tokenIn: null,
      tokenOut: null,
      durationMs: null,
      startedAt: "2026-04-18T00:00:00Z",
      finishedAt: null,
    });
    const row = readRow("att-post-close")!;
    expect(JSON.parse(row.agent_stream as string)).toEqual([]);
    expect(JSON.parse(row.tool_calls as string)).toEqual([]);
  });

  it("repeated close() is a no-op", () => {
    const writer = createExecutionRecordWriter(
      baseOpen({ attemptId: "att-double-close" }),
    );
    writer.close({
      terminationReason: "natural_completion",
      costUsd: 0.1,
    });
    const row1 = readRow("att-double-close")!;
    writer.close({
      terminationReason: "error_exceeded_retries",
      costUsd: 999,
    });
    const row2 = readRow("att-double-close")!;
    expect(row2.termination_reason).toBe(row1.termination_reason);
    expect(row2.cost_usd).toBe(row1.cost_usd);
  });
});

describe("ExecutionRecordWriter — cost and session updates", () => {
  it("updateCost flushes and persists", () => {
    const writer = createExecutionRecordWriter(
      baseOpen({ attemptId: "att-cost" }),
    );
    writer.updateCost({ costUsd: 0.01, tokenInput: 10, tokenOutput: 20 });
    writer.__flushForTests();
    let row = readRow("att-cost")!;
    expect(row.cost_usd).toBe(0.01);
    expect(row.token_input).toBe(10);
    expect(row.token_output).toBe(20);

    writer.updateCost({ costUsd: 0.05 });
    writer.__flushForTests();
    row = readRow("att-cost")!;
    expect(row.cost_usd).toBe(0.05);
    // Unchanged
    expect(row.token_input).toBe(10);
    expect(row.token_output).toBe(20);

    writer.close({ terminationReason: "natural_completion" });
  });

  it("updateSessionId flushes", () => {
    const writer = createExecutionRecordWriter(
      baseOpen({ attemptId: "att-sess" }),
    );
    writer.updateSessionId("sess-abc");
    writer.__flushForTests();
    const row = readRow("att-sess")!;
    expect(row.session_id).toBe("sess-abc");
    writer.close({ terminationReason: "natural_completion" });
  });

  it("close() can still override session/cost at termination", () => {
    const writer = createExecutionRecordWriter(
      baseOpen({ attemptId: "att-sess-close" }),
    );
    writer.updateSessionId("sess-mid");
    writer.updateCost({ costUsd: 0.1 });
    writer.close({
      terminationReason: "natural_completion",
      sessionId: "sess-final",
      costUsd: 0.2,
    });
    const row = readRow("att-sess-close")!;
    expect(row.session_id).toBe("sess-final");
    expect(row.cost_usd).toBe(0.2);
  });
});

describe("ExecutionRecordWriter — scratch pad / precompact", () => {
  it("precompact events accumulate across flush and close", () => {
    const writer = createExecutionRecordWriter(
      baseOpen({ attemptId: "att-pc" }),
    );
    writer.recordPrecompact({
      tokensAtTrigger: 167_000,
      tier1ReInjectedBytes: 8_000,
      timestamp: "2026-04-18T00:00:00Z",
    });
    writer.__flushForTests();
    writer.recordPrecompact({
      tokensAtTrigger: 334_000,
      tier1ReInjectedBytes: 8_000,
      timestamp: "2026-04-18T00:05:00Z",
    });
    writer.close({
      terminationReason: "natural_completion",
      scratchPadSnapshot: {
        openingNote: "opening",
        finalNote: "final",
        precompactEvents: [],
      },
    });
    const row = readRow("att-pc")!;
    const scratch = JSON.parse(row.scratch_pad_snapshot as string);
    expect(scratch.openingNote).toBe("opening");
    expect(scratch.finalNote).toBe("final");
    expect(scratch.precompactEvents).toHaveLength(2);
    expect(scratch.precompactEvents[0].tokensAtTrigger).toBe(167_000);
    expect(scratch.precompactEvents[1].tokensAtTrigger).toBe(334_000);
  });

  it("scratch_pad_snapshot stays NULL when nothing was recorded", () => {
    const writer = createExecutionRecordWriter(
      baseOpen({ attemptId: "att-no-scratch" }),
    );
    writer.close({ terminationReason: "natural_completion" });
    const row = readRow("att-no-scratch")!;
    expect(row.scratch_pad_snapshot).toBeNull();
  });
});

describe("ExecutionRecordWriter — worktree diff", () => {
  it("close persists diff text and truncated flag", () => {
    const writer = createExecutionRecordWriter(
      baseOpen({ attemptId: "att-diff" }),
    );
    writer.close({
      terminationReason: "natural_completion",
      worktreeDiff: { text: "diff --git a b\n+x", truncated: false },
    });
    const row = readRow("att-diff")!;
    expect(row.worktree_diff).toBe("diff --git a b\n+x");
    expect(row.worktree_diff_truncated).toBe(0);
  });

  it("truncated diff sets flag to 1", () => {
    const writer = createExecutionRecordWriter(
      baseOpen({ attemptId: "att-diff-trunc" }),
    );
    writer.close({
      terminationReason: "natural_completion",
      worktreeDiff: { text: "short-text\n[truncated]", truncated: true },
    });
    const row = readRow("att-diff-trunc")!;
    expect(row.worktree_diff).toBe("short-text\n[truncated]");
    expect(row.worktree_diff_truncated).toBe(1);
  });
});

describe("ExecutionRecordWriter — heartbeat + reaper", () => {
  it("heartbeat advances last_heartbeat_at", async () => {
    const writer = createExecutionRecordWriter(
      baseOpen({ attemptId: "att-hb" }),
    );
    const initial = readRow("att-hb")!.last_heartbeat_at;
    await new Promise((r) => setTimeout(r, 1_100)); // SQLite datetime resolution is seconds
    writer.heartbeat();
    const updated = readRow("att-hb")!.last_heartbeat_at;
    expect(updated).not.toBe(initial);
    writer.close({ terminationReason: "natural_completion" });
  });

  it("reapOrphanedRecords finalizes stale open rows with error_exceeded_retries", () => {
    // Directly insert a stale open row.
    const staleTs = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    testDb
      .prepare(
        `INSERT INTO execution_records (
           attempt_id, task_id, stage_name, attempt_index,
           started_at, engine, prompt_blob, reads_snapshot, last_heartbeat_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "stale-1",
        "task-stale",
        "stage-stale",
        1,
        staleTs,
        "claude",
        "{}",
        "{}",
        staleTs,
      );

    const reaped = reapOrphanedRecords({ staleAfterMs: 5 * 60 * 1000 });
    expect(reaped).toBe(1);
    const row = readRow("stale-1")!;
    expect(row.terminated_at).not.toBeNull();
    expect(row.termination_reason).toBe("error_exceeded_retries");
  });

  it("reapOrphanedRecords leaves fresh open rows alone", () => {
    const writer = createExecutionRecordWriter(
      baseOpen({ attemptId: "att-fresh" }),
    );
    const reaped = reapOrphanedRecords({ staleAfterMs: 5 * 60 * 1000 });
    expect(reaped).toBe(0);
    const row = readRow("att-fresh")!;
    expect(row.terminated_at).toBeNull();
    writer.close({ terminationReason: "natural_completion" });
  });

  it("reapOrphanedRecords is a no-op when flag is off", () => {
    process.env.ENABLE_EXECUTION_RECORD = "false";
    const staleTs = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    testDb
      .prepare(
        `INSERT INTO execution_records (
           attempt_id, task_id, stage_name, attempt_index,
           started_at, engine, prompt_blob, reads_snapshot, last_heartbeat_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "stale-2",
        "task-stale-2",
        "stage-stale-2",
        1,
        staleTs,
        "claude",
        "{}",
        "{}",
        staleTs,
      );
    const reaped = reapOrphanedRecords({ staleAfterMs: 5 * 60 * 1000 });
    expect(reaped).toBe(0);
    const row = readRow("stale-2")!;
    expect(row.terminated_at).toBeNull();
  });
});

describe("ExecutionRecordWriter — crash safety & isolation", () => {
  it("INSERT failure (duplicate attemptId) falls back to no-op without throwing", () => {
    const first = createExecutionRecordWriter(
      baseOpen({ attemptId: "dup-att" }),
    );
    expect(first.isNoop).toBe(false);
    // Second call with same id should not throw out of createExecutionRecordWriter.
    const second = createExecutionRecordWriter(
      baseOpen({ attemptId: "dup-att" }),
    );
    expect(second.isNoop).toBe(true);
    first.close({ terminationReason: "natural_completion" });
  });

  it("two concurrent writers do not interfere", () => {
    const a = createExecutionRecordWriter(baseOpen({ attemptId: "a" }));
    const b = createExecutionRecordWriter(
      baseOpen({
        attemptId: "b",
        stageName: "implement",
        taskId: "task-2",
      }),
    );
    a.appendAgentStream({
      type: "text",
      text: "a-text",
      timestamp: "2026-04-18T00:00:00Z",
    });
    b.appendAgentStream({
      type: "text",
      text: "b-text",
      timestamp: "2026-04-18T00:00:00Z",
    });
    a.close({ terminationReason: "natural_completion" });
    b.close({ terminationReason: "superseded_by_retry" });

    const rowA = readRow("a")!;
    const rowB = readRow("b")!;
    expect(JSON.parse(rowA.agent_stream as string)).toHaveLength(1);
    expect(JSON.parse(rowB.agent_stream as string)).toHaveLength(1);
    expect((JSON.parse(rowA.agent_stream as string) as any)[0].text).toBe(
      "a-text",
    );
    expect((JSON.parse(rowB.agent_stream as string) as any)[0].text).toBe(
      "b-text",
    );
    expect(rowA.termination_reason).toBe("natural_completion");
    expect(rowB.termination_reason).toBe("superseded_by_retry");
  });
});
