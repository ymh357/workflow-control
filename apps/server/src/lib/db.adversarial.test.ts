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
  tmpDir = await mkdtemp(join(os.tmpdir(), "db-adv-test-"));
  mockLoadSystemSettings.mockReturnValue({
    paths: { data_dir: tmpDir },
  });
});

afterEach(async () => {
  vi.resetModules();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("db adversarial", () => {
  it("cleanupOldData with 0 days deletes everything", async () => {
    const { getDb, cleanupOldData } = await import("./db.js");
    const db = getDb();

    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO sse_messages (task_id, type, timestamp, data, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("task-1", "log", now, "{}", now);

    cleanupOldData(0);

    const rows = db.prepare("SELECT * FROM sse_messages").all();
    expect(rows).toHaveLength(0);
  });

  it("cleanupOldData with negative days deletes everything (future cutoff)", async () => {
    const { getDb, cleanupOldData } = await import("./db.js");
    const db = getDb();

    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO sse_messages (task_id, type, timestamp, data, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("task-1", "log", now, "{}", now);

    cleanupOldData(-1);

    const rows = db.prepare("SELECT * FROM sse_messages").all();
    expect(rows).toHaveLength(0);
  });

  it("concurrent getDb calls return the same singleton", async () => {
    const { getDb } = await import("./db.js");
    const [db1, db2, db3] = [getDb(), getDb(), getDb()];
    expect(db1).toBe(db2);
    expect(db2).toBe(db3);
  });

  it("insert and query large data payload in sse_messages", async () => {
    const { getDb } = await import("./db.js");
    const db = getDb();

    const largeData = JSON.stringify({ payload: "x".repeat(50_000) });
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO sse_messages (task_id, type, timestamp, data, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("big-task", "log", now, largeData, now);

    const row = db.prepare("SELECT data FROM sse_messages WHERE task_id = ?").get("big-task") as any;
    expect(row.data).toBe(largeData);
  });

  it("pending_questions enforces PRIMARY KEY uniqueness on question_id", async () => {
    const { getDb } = await import("./db.js");
    const db = getDb();

    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO pending_questions (question_id, task_id, question, created_at) VALUES (?, ?, ?, ?)",
    ).run("q-dup", "t1", "question?", now);

    expect(() => {
      db.prepare(
        "INSERT INTO pending_questions (question_id, task_id, question, created_at) VALUES (?, ?, ?, ?)",
      ).run("q-dup", "t2", "another?", now);
    }).toThrow();
  });

  it("WAL mode is enabled after initialization", async () => {
    const { getDb } = await import("./db.js");
    const db = getDb();

    const row = db.prepare("PRAGMA journal_mode").get() as any;
    expect(row.journal_mode).toBe("wal");
  });

  it("fallback data_dir when settings path is not configured", async () => {
    vi.resetModules();
    mockLoadSystemSettings.mockReturnValue({ paths: {} });

    const { getDb } = await import("./db.js");
    // Should use /tmp/workflow-control-data as fallback
    const db = getDb();
    expect(db).toBeDefined();
  });

  it("special characters in task_id and question are stored correctly", async () => {
    const { getDb } = await import("./db.js");
    const db = getDb();

    const specialTaskId = "task-with-'quotes'-and-\"doubles\"";
    const specialQuestion = "What about <html> & SQL' OR 1=1 --?";
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO pending_questions (question_id, task_id, question, created_at) VALUES (?, ?, ?, ?)",
    ).run("q-special", specialTaskId, specialQuestion, now);

    const row = db.prepare("SELECT * FROM pending_questions WHERE question_id = ?").get("q-special") as any;
    expect(row.task_id).toBe(specialTaskId);
    expect(row.question).toBe(specialQuestion);
  });
});
