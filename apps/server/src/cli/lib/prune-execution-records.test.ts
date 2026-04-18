import {
  describe,
  it,
  expect,
  beforeEach,
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

vi.mock("../../lib/db.js", () => ({
  getDb: () => testDb,
}));

import {
  countExecutionRecords,
  pruneExecutionRecords,
} from "./prune-execution-records.js";

function insertRow(
  attemptId: string,
  taskId: string,
  startedAtIso: string,
): void {
  testDb
    .prepare(
      `INSERT INTO execution_records (
         attempt_id, task_id, stage_name, attempt_index,
         started_at, engine, prompt_blob, reads_snapshot, last_heartbeat_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      attemptId,
      taskId,
      "stage",
      1,
      startedAtIso,
      "claude",
      "{}",
      "{}",
      startedAtIso,
    );
}

beforeEach(() => {
  testDb.exec("DELETE FROM execution_records");
});

describe("countExecutionRecords", () => {
  it("returns 0 for empty table under either filter", () => {
    expect(countExecutionRecords({ taskId: "x" })).toBe(0);
    expect(countExecutionRecords({ olderThanMs: 1_000 })).toBe(0);
  });

  it("counts by task-id", () => {
    insertRow("a1", "t-one", new Date().toISOString());
    insertRow("a2", "t-one", new Date().toISOString());
    insertRow("a3", "t-two", new Date().toISOString());
    expect(countExecutionRecords({ taskId: "t-one" })).toBe(2);
    expect(countExecutionRecords({ taskId: "t-two" })).toBe(1);
    expect(countExecutionRecords({ taskId: "t-none" })).toBe(0);
  });

  it("counts by older-than", () => {
    const oldTs = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const freshTs = new Date().toISOString();
    insertRow("old-1", "t", oldTs);
    insertRow("old-2", "t", oldTs);
    insertRow("new-1", "t", freshTs);
    // Older than 5 days -> 2 rows
    expect(
      countExecutionRecords({ olderThanMs: 5 * 24 * 60 * 60 * 1000 }),
    ).toBe(2);
    // Older than 30 days -> none
    expect(
      countExecutionRecords({ olderThanMs: 30 * 24 * 60 * 60 * 1000 }),
    ).toBe(0);
  });

  it("combines taskId + olderThan with AND semantics", () => {
    const oldTs = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    insertRow("a", "t-one", oldTs);
    insertRow("b", "t-two", oldTs);
    expect(
      countExecutionRecords({
        taskId: "t-one",
        olderThanMs: 5 * 24 * 60 * 60 * 1000,
      }),
    ).toBe(1);
  });

  it("empty filter returns 0 (no-op safety)", () => {
    insertRow("x", "t", new Date().toISOString());
    expect(countExecutionRecords({})).toBe(0);
  });
});

describe("pruneExecutionRecords", () => {
  it("deletes rows matching task-id and returns count", () => {
    insertRow("a1", "t-one", new Date().toISOString());
    insertRow("a2", "t-one", new Date().toISOString());
    insertRow("a3", "t-two", new Date().toISOString());
    const deleted = pruneExecutionRecords({ taskId: "t-one" });
    expect(deleted).toBe(2);
    const remaining = (testDb
      .prepare("SELECT COUNT(*) as n FROM execution_records")
      .get() as { n: number }).n;
    expect(remaining).toBe(1);
  });

  it("deletes rows older than cutoff", () => {
    const oldTs = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const freshTs = new Date().toISOString();
    insertRow("old", "t", oldTs);
    insertRow("fresh", "t", freshTs);
    const deleted = pruneExecutionRecords({
      olderThanMs: 30 * 24 * 60 * 60 * 1000,
    });
    expect(deleted).toBe(1);
    const survivors = testDb
      .prepare("SELECT attempt_id FROM execution_records")
      .all() as Array<{ attempt_id: string }>;
    expect(survivors.map((r) => r.attempt_id)).toEqual(["fresh"]);
  });

  it("empty filter is a safe no-op (deletes nothing)", () => {
    insertRow("a", "t", new Date().toISOString());
    const deleted = pruneExecutionRecords({});
    expect(deleted).toBe(0);
    const remaining = (testDb
      .prepare("SELECT COUNT(*) as n FROM execution_records")
      .get() as { n: number }).n;
    expect(remaining).toBe(1);
  });
});
