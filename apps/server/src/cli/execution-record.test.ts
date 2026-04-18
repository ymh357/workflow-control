import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

// In-memory DB for runStats (stats calls getDb directly).
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
vi.mock("../lib/db.js", () => ({ getDb: () => testDb }));

const pruneMock = vi.hoisted(() => vi.fn());
const countMock = vi.hoisted(() => vi.fn());
vi.mock("./lib/prune-execution-records.js", () => ({
  pruneExecutionRecords: pruneMock,
  countExecutionRecords: countMock,
}));

import { parseDuration, runPrune, runStats } from "./execution-record.js";

beforeEach(() => {
  pruneMock.mockReset();
  countMock.mockReset();
  testDb.exec("DELETE FROM execution_records");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseDuration", () => {
  it("parses days, hours, minutes, seconds", () => {
    expect(parseDuration("30d")).toBe(30 * 24 * 60 * 60_000);
    expect(parseDuration("12h")).toBe(12 * 60 * 60_000);
    expect(parseDuration("45m")).toBe(45 * 60_000);
    expect(parseDuration("90s")).toBe(90_000);
  });

  it("allows whitespace around the value", () => {
    expect(parseDuration("  7d  ")).toBe(7 * 24 * 60 * 60_000);
  });

  it("rejects invalid formats", () => {
    expect(() => parseDuration("30")).toThrow(/Invalid --older-than/);
    expect(() => parseDuration("30 days")).toThrow(/Invalid --older-than/);
    expect(() => parseDuration("d")).toThrow(/Invalid --older-than/);
    expect(() => parseDuration("-5d")).toThrow(/Invalid --older-than/);
  });
});

describe("runPrune", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("refuses to prune without any filter and exits non-zero", async () => {
    const code = await runPrune({ dryRun: false, yes: false });
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    expect(pruneMock).not.toHaveBeenCalled();
  });

  it("prints 'no match' when filter matches 0 rows", async () => {
    countMock.mockReturnValue(0);
    const code = await runPrune({
      taskId: "t",
      dryRun: false,
      yes: true,
    });
    expect(code).toBe(0);
    expect(pruneMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("No execution_records rows match filter"),
    );
  });

  it("dry-run prints count and does not call prune", async () => {
    countMock.mockReturnValue(5);
    const code = await runPrune({
      olderThanMs: 30 * 24 * 60 * 60_000,
      dryRun: true,
      yes: false,
    });
    expect(code).toBe(0);
    expect(pruneMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("[dry-run] Would delete 5 row(s)"),
    );
  });

  it("--yes skips confirmation and deletes", async () => {
    countMock.mockReturnValue(3);
    pruneMock.mockReturnValue(3);
    const code = await runPrune({
      taskId: "t-X",
      dryRun: false,
      yes: true,
    });
    expect(code).toBe(0);
    expect(pruneMock).toHaveBeenCalledWith({
      taskId: "t-X",
      olderThanMs: undefined,
    });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Deleted 3 row(s)"),
    );
  });

  it("combined taskId + olderThan filter is passed through", async () => {
    countMock.mockReturnValue(2);
    pruneMock.mockReturnValue(2);
    const code = await runPrune({
      taskId: "t",
      olderThanMs: 7 * 24 * 60 * 60_000,
      dryRun: false,
      yes: true,
    });
    expect(code).toBe(0);
    expect(pruneMock).toHaveBeenCalledWith({
      taskId: "t",
      olderThanMs: 7 * 24 * 60 * 60_000,
    });
  });
});

describe("runStats", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("prints zero totals on empty table", async () => {
    const code = await runStats();
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith("Total rows:  0");
    expect(logSpy).toHaveBeenCalledWith("Open rows:   0");
  });

  it("counts open rows (terminated_at IS NULL) distinctly from closed", async () => {
    const now = new Date().toISOString();
    testDb
      .prepare(
        `INSERT INTO execution_records
         (attempt_id, task_id, stage_name, attempt_index, started_at, engine, prompt_blob, reads_snapshot, last_heartbeat_at, terminated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("open-1", "task-a", "s", 1, now, "claude", "{}", "{}", now, null);
    testDb
      .prepare(
        `INSERT INTO execution_records
         (attempt_id, task_id, stage_name, attempt_index, started_at, engine, prompt_blob, reads_snapshot, last_heartbeat_at, terminated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("closed-1", "task-a", "s", 1, now, "claude", "{}", "{}", now, now);
    await runStats();
    expect(logSpy).toHaveBeenCalledWith("Total rows:  2");
    expect(logSpy).toHaveBeenCalledWith("Open rows:   1");
  });

  it("lists top tasks by row count", async () => {
    const now = new Date().toISOString();
    const insert = (id: string, taskId: string) => {
      testDb
        .prepare(
          `INSERT INTO execution_records
           (attempt_id, task_id, stage_name, attempt_index, started_at, engine, prompt_blob, reads_snapshot, last_heartbeat_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, taskId, "s", 1, now, "claude", "{}", "{}", now);
    };
    insert("r1", "task-A");
    insert("r2", "task-A");
    insert("r3", "task-A");
    insert("r4", "task-B");
    await runStats();
    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("task-A");
    expect(output).toContain("task-B");
    // task-A first
    expect(output.indexOf("task-A")).toBeLessThan(output.indexOf("task-B"));
  });
});
