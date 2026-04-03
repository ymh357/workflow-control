import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { logger } from "./logger.js";
import { loadSystemSettings } from "./config-loader.js";

let db: DatabaseSync | undefined;

function resolveDataDir(): string {
  const settings = loadSystemSettings();
  return settings.paths?.data_dir || "/tmp/workflow-control-data";
}

export function getDb(): DatabaseSync {
  if (db) return db;

  const dataDir = resolveDataDir();
  const dbPath = join(dataDir, "workflow.db");
  mkdirSync(dataDir, { recursive: true });

  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sse_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sse_task ON sse_messages(task_id);

    CREATE TABLE IF NOT EXISTS pending_questions (
      question_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      question TEXT NOT NULL,
      options TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  logger.info({ dbPath }, "SQLite database initialized");
  return db;
}

export function cleanupOldData(days: number): void {
  const d = getDb();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const sseResult = d.prepare("DELETE FROM sse_messages WHERE created_at < ?").run(cutoff);
  const qResult = d.prepare("DELETE FROM pending_questions WHERE created_at < ?").run(cutoff);
  logger.info({ days, sseDeleted: sseResult.changes, questionsDeleted: qResult.changes }, "Cleaned up old data");
}

export function startPeriodicCleanup(intervalHours = 1, retentionDays = 7): void {
  const timer = setInterval(() => {
    try { cleanupOldData(retentionDays); }
    catch (err) { logger.error({ err }, "Periodic cleanup failed"); }
  }, intervalHours * 60 * 60 * 1000);
  timer.unref();
}
