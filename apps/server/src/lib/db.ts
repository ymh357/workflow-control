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

    CREATE TABLE IF NOT EXISTS edge_slots (
      task_id TEXT NOT NULL,
      stage_name TEXT NOT NULL,
      nonce TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, stage_name)
    );

    -- Phase 1 / A1: ExecutionRecord. See docs/execution-record-design.md.
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
    CREATE INDEX IF NOT EXISTS idx_exec_task ON execution_records(task_id);
    CREATE INDEX IF NOT EXISTS idx_exec_task_stage_attempt
      ON execution_records(task_id, stage_name, attempt_index);
    CREATE INDEX IF NOT EXISTS idx_exec_pipeline_hash
      ON execution_records(pipeline_version_hash);
    CREATE INDEX IF NOT EXISTS idx_exec_open
      ON execution_records(last_heartbeat_at)
      WHERE terminated_at IS NULL;

    -- Phase 2 / A2: pipeline_versions. See lib/pipeline-hash/deep-hash.ts.
    CREATE TABLE IF NOT EXISTS pipeline_versions (
      version_hash     TEXT PRIMARY KEY,
      pipeline_name    TEXT NOT NULL,
      canonical_json   TEXT NOT NULL,
      first_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_versions_name
      ON pipeline_versions(pipeline_name, last_seen_at DESC);
  `);

  logger.info({ dbPath }, "SQLite database initialized");
  return db;
}

export function cleanupOldData(days: number): void {
  const d = getDb();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const sseResult = d.prepare("DELETE FROM sse_messages WHERE created_at < ?").run(cutoff);
  const qResult = d.prepare("DELETE FROM pending_questions WHERE created_at < ?").run(cutoff);
  const slotResult = d.prepare("DELETE FROM edge_slots WHERE created_at < ?").run(cutoffMs);
  logger.info({ days, sseDeleted: sseResult.changes, questionsDeleted: qResult.changes, slotsDeleted: slotResult.changes }, "Cleaned up old data");
}

export function closeDb(): void {
  if (db) {
    try { db.close(); } catch { /* best-effort */ }
    db = undefined;
  }
}

export function startPeriodicCleanup(intervalHours = 1, retentionDays = 7): void {
  const timer = setInterval(() => {
    try { cleanupOldData(retentionDays); }
    catch (err) { logger.error({ err }, "Periodic cleanup failed"); }
  }, intervalHours * 60 * 60 * 1000);
  timer.unref();
}
