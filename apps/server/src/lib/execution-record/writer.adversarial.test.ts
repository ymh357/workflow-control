import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { DatabaseSync } from "node:sqlite";

const testDb = new DatabaseSync(":memory:");
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

vi.mock("../db.js", () => ({
  getDb: () => testDb,
}));

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createExecutionRecordWriter } from "./writer.js";
import type { OpenRecordInput, PromptBlob } from "./types.js";

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
});

function baseOpen(overrides: Partial<OpenRecordInput> = {}): OpenRecordInput {
  const promptBlob: PromptBlob = {
    tier1: "",
    systemPromptFull: "",
    stagePrompt: "",
    invariants: [],
    fragments: [],
    outputSchema: null,
  };
  return {
    taskId: "t",
    stageName: "s",
    attemptIndex: 1,
    pipelineVersionHash: null,
    engine: "claude",
    model: null,
    sessionId: null,
    promptBlob,
    readsSnapshot: {},
    ...overrides,
  };
}

function readRow(attemptId: string): Record<string, unknown> | undefined {
  return testDb
    .prepare("SELECT * FROM execution_records WHERE attempt_id = ?")
    .get(attemptId) as Record<string, unknown> | undefined;
}

describe("ExecutionRecordWriter adversarial", () => {
  it("completeToolCall on unknown id is a silent no-op", () => {
    const writer = createExecutionRecordWriter(baseOpen({ attemptId: "a1" }));
    writer.completeToolCall("missing-id", { result: "x" });
    writer.close({ terminationReason: "natural_completion" });
    const row = readRow("a1")!;
    expect(JSON.parse(row.tool_calls as string)).toEqual([]);
  });

  it("JSON-unsafe values in readsSnapshot do not break open (stored as string)", () => {
    // Circular reference would throw in JSON.stringify — the constructor
    // catches that and falls back to no-op.
    const circular: any = { x: 1 };
    circular.self = circular;
    const writer = createExecutionRecordWriter(
      baseOpen({ attemptId: "a-circ", readsSnapshot: circular }),
    );
    expect(writer.isNoop).toBe(true);
  });

  it("appendAgentStream with empty text is accepted", () => {
    const writer = createExecutionRecordWriter(baseOpen({ attemptId: "a2" }));
    writer.appendAgentStream({ type: "text", text: "", timestamp: "t0" });
    writer.close({ terminationReason: "natural_completion" });
    const row = readRow("a2")!;
    const stream = JSON.parse(row.agent_stream as string);
    expect(stream).toHaveLength(1);
    expect(stream[0].text).toBe("");
  });

  it("appendToolCall with very large input is persisted intact", () => {
    const bigInput = { payload: "x".repeat(50_000) };
    const writer = createExecutionRecordWriter(baseOpen({ attemptId: "a3" }));
    writer.appendToolCall({
      id: "t-big",
      name: "BigTool",
      input: bigInput,
      result: null,
      isError: false,
      tokenIn: null,
      tokenOut: null,
      durationMs: null,
      startedAt: "t0",
      finishedAt: null,
    });
    writer.close({ terminationReason: "natural_completion" });
    const row = readRow("a3")!;
    const calls = JSON.parse(row.tool_calls as string);
    expect(calls[0].input.payload.length).toBe(50_000);
  });

  it("close() with undefined optional fields leaves DB nulls", () => {
    const writer = createExecutionRecordWriter(baseOpen({ attemptId: "a4" }));
    writer.close({ terminationReason: "natural_completion" });
    const row = readRow("a4")!;
    expect(row.writes_parsed).toBeNull();
    expect(row.writes_committed).toBeNull();
    expect(row.worktree_diff).toBeNull();
    expect(row.scratch_pad_snapshot).toBeNull();
    expect(row.cost_usd).toBeNull();
    expect(row.token_input).toBeNull();
    expect(row.token_output).toBeNull();
    expect(row.duration_ms).toBeNull();
  });

  it("close() with explicit null writesParsed/Committed keeps them NULL", () => {
    const writer = createExecutionRecordWriter(baseOpen({ attemptId: "a5" }));
    writer.close({
      terminationReason: "natural_completion",
      writesParsed: null,
      writesCommitted: null,
    });
    const row = readRow("a5")!;
    expect(row.writes_parsed).toBeNull();
    expect(row.writes_committed).toBeNull();
  });

  it("appendToolCall does nothing on a no-op writer (flag off)", () => {
    process.env.ENABLE_EXECUTION_RECORD = "false";
    const writer = createExecutionRecordWriter(baseOpen({ attemptId: "a6" }));
    expect(writer.isNoop).toBe(true);
    writer.appendToolCall({
      id: "t",
      name: "x",
      input: {},
      result: null,
      isError: false,
      tokenIn: null,
      tokenOut: null,
      durationMs: null,
      startedAt: "t",
      finishedAt: null,
    });
    // No exception; nothing inserted
    const row = readRow("a6");
    expect(row).toBeUndefined();
  });

  it("updateCost with all-undefined patch still marks dirty (no-op flush)", () => {
    const writer = createExecutionRecordWriter(baseOpen({ attemptId: "a7" }));
    writer.updateCost({});
    writer.__flushForTests();
    const row = readRow("a7")!;
    // Flush wrote cost columns, all NULL — still NULL in DB.
    expect(row.cost_usd).toBeNull();
    expect(row.token_input).toBeNull();
    expect(row.token_output).toBeNull();
    writer.close({ terminationReason: "natural_completion" });
  });

  it("heartbeat after close is a no-op", () => {
    const writer = createExecutionRecordWriter(baseOpen({ attemptId: "a8" }));
    writer.close({ terminationReason: "natural_completion" });
    const before = readRow("a8")!.last_heartbeat_at;
    writer.heartbeat();
    const after = readRow("a8")!.last_heartbeat_at;
    expect(after).toBe(before);
  });

  it("attemptIndex > 1 is persisted (retry scenario)", () => {
    const writer = createExecutionRecordWriter(
      baseOpen({ attemptId: "a9", attemptIndex: 3 }),
    );
    writer.close({ terminationReason: "superseded_by_retry" });
    const row = readRow("a9")!;
    expect(row.attempt_index).toBe(3);
    expect(row.termination_reason).toBe("superseded_by_retry");
  });

  it("pipelineVersionHash is stored when provided", () => {
    const writer = createExecutionRecordWriter(
      baseOpen({ attemptId: "a10", pipelineVersionHash: "sha256-abc" }),
    );
    writer.close({ terminationReason: "natural_completion" });
    const row = readRow("a10")!;
    expect(row.pipeline_version_hash).toBe("sha256-abc");
  });
});
