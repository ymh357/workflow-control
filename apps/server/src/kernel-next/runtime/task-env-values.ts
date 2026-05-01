// task-env-values.ts
//
// Per-task SQLite-backed storage for environment variable values supplied at
// run_pipeline time. Used to expand ${VAR} placeholders in stage.config.mcpServers
// when the executor wires external MCPs into the SDK options (P3.5).
//
// Lifetime: populated on task creation (P3.4); deleted on task termination (P3.6).

import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "../ir/with-transaction.js";

export function storeTaskEnvValues(
  db: DatabaseSync,
  taskId: string,
  values: Record<string, string>,
): void {
  const entries = Object.entries(values);
  if (entries.length === 0) return;
  const upsert = db.prepare(
    `INSERT INTO task_env_values (task_id, key, value, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(task_id, key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`,
  );
  const now = Date.now();
  // Bug 62 (c12+ review Wave 2 T2): pre-fix this hand-rolled
  // BEGIN/COMMIT/ROLLBACK; if BEGIN itself threw, the catch's
  // ROLLBACK threw "no transaction is active" and masked the real
  // BEGIN failure. withTransaction routes BEGIN failures through
  // the helper so the caller sees the underlying error.
  withTransaction(db, () => {
    for (const [k, v] of entries) {
      upsert.run(taskId, k, v, now);
    }
  });
}

export function loadTaskEnvValues(db: DatabaseSync, taskId: string): Record<string, string> {
  const rows = db
    .prepare("SELECT key, value FROM task_env_values WHERE task_id = ?")
    .all(taskId) as Array<{ key: string; value: string }>;
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function deleteTaskEnvValues(db: DatabaseSync, taskId: string): void {
  db.prepare("DELETE FROM task_env_values WHERE task_id = ?").run(taskId);
}
