import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
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
