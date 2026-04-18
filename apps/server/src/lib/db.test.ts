import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";

const loggerWarnSpy = vi.fn();
const loggerInfoSpy = vi.fn();

vi.mock("./logger.js", () => ({
  logger: {
    info: loggerInfoSpy,
    warn: loggerWarnSpy,
    error: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

let tmpDir: string;
const mockLoadSystemSettings = vi.fn();

vi.mock("./config-loader.js", () => ({
  loadSystemSettings: (...args: unknown[]) => mockLoadSystemSettings(...args),
}));

beforeEach(async () => {
  tmpDir = await mkdtemp(join(os.tmpdir(), "db-test-"));
  mockLoadSystemSettings.mockReturnValue({
    paths: { data_dir: tmpDir },
  });
  loggerWarnSpy.mockClear();
  loggerInfoSpy.mockClear();
});

afterEach(async () => {
  // Reset module so db singleton is cleared between tests
  vi.resetModules();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("getDb", () => {
  it("creates and returns a database instance", async () => {
    const { getDb } = await import("./db.js");
    const db = getDb();
    expect(db).toBeDefined();
  });

  it("returns the same instance on subsequent calls", async () => {
    const { getDb } = await import("./db.js");
    const db1 = getDb();
    const db2 = getDb();
    expect(db1).toBe(db2);
  });

  it("creates sse_messages table", async () => {
    const { getDb } = await import("./db.js");
    const db = getDb();
    const stmt = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sse_messages'",
    );
    const row = stmt.get() as { name: string } | undefined;
    expect(row?.name).toBe("sse_messages");
  });

  it("creates pending_questions table", async () => {
    const { getDb } = await import("./db.js");
    const db = getDb();
    const stmt = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='pending_questions'",
    );
    const row = stmt.get() as { name: string } | undefined;
    expect(row?.name).toBe("pending_questions");
  });
});

// Tier 1 hotfix #3 — schema drift detection.
describe("assertExecutionRecordsSchema", () => {
  it("does NOT warn when the expected schema is present (full DDL)", async () => {
    const { getDb } = await import("./db.js");
    getDb(); // triggers the internal assert during init
    // Initial init must not log a drift warning — the DDL covers every
    // expected column, so the check should be silent.
    const driftWarnings = loggerWarnSpy.mock.calls.filter((call) =>
      typeof call[1] === "string" && call[1].includes("SQLite schema drift"),
    );
    expect(driftWarnings).toHaveLength(0);
  });

  it("warns loudly when a required column is missing (simulates forgetful rm -rf)", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { assertExecutionRecordsSchema } = await import("./db.js");

    const stale = new DatabaseSync(":memory:");
    // Intentionally drop `decisions` and `workflow_control_version` to
    // simulate an old DB that predates T1.2 / T1.5.
    stale.exec(`
      CREATE TABLE execution_records (
        attempt_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        stage_name TEXT NOT NULL,
        attempt_index INTEGER NOT NULL,
        pipeline_version_hash TEXT,
        started_at TEXT NOT NULL,
        terminated_at TEXT,
        termination_reason TEXT,
        engine TEXT NOT NULL,
        model TEXT,
        session_id TEXT,
        prompt_blob TEXT NOT NULL,
        reads_snapshot TEXT NOT NULL,
        tool_calls TEXT NOT NULL DEFAULT '[]',
        agent_stream TEXT NOT NULL DEFAULT '[]',
        writes_parsed TEXT,
        writes_committed TEXT,
        worktree_diff TEXT,
        worktree_diff_truncated INTEGER NOT NULL DEFAULT 0,
        scratch_pad_snapshot TEXT,
        cost_usd REAL,
        token_input INTEGER,
        token_output INTEGER,
        duration_ms INTEGER,
        last_heartbeat_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    assertExecutionRecordsSchema(stale, "/fake/path/workflow.db");

    const driftCalls = loggerWarnSpy.mock.calls.filter((call) =>
      typeof call[1] === "string" && call[1].includes("SQLite schema drift"),
    );
    expect(driftCalls.length).toBeGreaterThan(0);

    const firstCall = driftCalls[0]!;
    const missing = (firstCall[0] as { missing: string[] }).missing;
    expect(missing).toContain("decisions");
    expect(missing).toContain("workflow_control_version");
  });
});

describe("cleanupOldData", () => {
  it("deletes records older than specified days", async () => {
    const { getDb, cleanupOldData } = await import("./db.js");
    const db = getDb();

    // Insert an old record
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      "INSERT INTO sse_messages (task_id, type, timestamp, data, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("task-1", "log", oldDate, "{}", oldDate);

    // Insert a recent record
    const recentDate = new Date().toISOString();
    db.prepare(
      "INSERT INTO sse_messages (task_id, type, timestamp, data, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("task-2", "log", recentDate, "{}", recentDate);

    cleanupOldData(7);

    const rows = db.prepare("SELECT * FROM sse_messages").all();
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).task_id).toBe("task-2");
  });

  it("deletes old pending_questions", async () => {
    const { getDb, cleanupOldData } = await import("./db.js");
    const db = getDb();

    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      "INSERT INTO pending_questions (question_id, task_id, question, created_at) VALUES (?, ?, ?, ?)",
    ).run("q-old", "task-1", "old question?", oldDate);

    const recentDate = new Date().toISOString();
    db.prepare(
      "INSERT INTO pending_questions (question_id, task_id, question, created_at) VALUES (?, ?, ?, ?)",
    ).run("q-new", "task-2", "new question?", recentDate);

    cleanupOldData(7);

    const rows = db.prepare("SELECT * FROM pending_questions").all();
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).question_id).toBe("q-new");
  });

  it("handles empty tables without error", async () => {
    const { cleanupOldData } = await import("./db.js");
    expect(() => cleanupOldData(7)).not.toThrow();
  });
});

describe("startPeriodicCleanup", () => {
  it("runs periodic cleanup and deletes old data", async () => {
    vi.useFakeTimers();

    const { startPeriodicCleanup, getDb } = await import("./db.js");
    const db = getDb();

    // Insert an old record (20 days old)
    const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      "INSERT INTO sse_messages (task_id, type, timestamp, data, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("task-cleanup", "log", oldDate, "{}", oldDate);

    // Start cleanup with 1-hour interval, 7-day retention
    startPeriodicCleanup(1, 7);

    // Before interval fires, old record should still be there
    const beforeRows = db.prepare("SELECT * FROM sse_messages WHERE task_id = ?").all("task-cleanup");
    expect(beforeRows).toHaveLength(1);

    // Advance 1 hour
    vi.advanceTimersByTime(60 * 60 * 1000);

    // After cleanup, old record should be deleted
    const afterRows = db.prepare("SELECT * FROM sse_messages WHERE task_id = ?").all("task-cleanup");
    expect(afterRows).toHaveLength(0);

    vi.useRealTimers();
  });

  it("does not crash when cleanup encounters an error", async () => {
    vi.useFakeTimers();

    const { startPeriodicCleanup, getDb } = await import("./db.js");
    getDb();

    // Start cleanup - even if internal errors occur, setInterval should not crash
    startPeriodicCleanup(1, 7);

    // Advancing multiple intervals should not throw
    expect(() => {
      vi.advanceTimersByTime(3 * 60 * 60 * 1000);
    }).not.toThrow();

    vi.useRealTimers();
  });
});
