// SQL helpers for the execution-record CLI. Extracted here so they can
// be unit-tested against an in-memory SQLite without spinning up the CLI
// harness.

import { getDb } from "../../lib/db.js";

export interface PruneFilter {
  taskId?: string;
  olderThanMs?: number;
}

function buildWhere(filter: PruneFilter): {
  clause: string;
  params: Array<string | number>;
} {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.taskId) {
    clauses.push("task_id = ?");
    params.push(filter.taskId);
  }
  if (filter.olderThanMs !== undefined) {
    const cutoff = new Date(Date.now() - filter.olderThanMs).toISOString();
    clauses.push("started_at < ?");
    params.push(cutoff);
  }
  // buildWhere callers must always supply at least one filter — the CLI
  // refuses to prune otherwise. But keep a safe no-op fallback in case of
  // future callers.
  const clause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "WHERE 1 = 0";
  return { clause, params };
}

export function countExecutionRecords(filter: PruneFilter): number {
  const { clause, params } = buildWhere(filter);
  const row = getDb()
    .prepare(`SELECT COUNT(*) as n FROM execution_records ${clause}`)
    .get(...params) as { n: number };
  return row.n;
}

export function pruneExecutionRecords(filter: PruneFilter): number {
  const { clause, params } = buildWhere(filter);
  const result = getDb()
    .prepare(`DELETE FROM execution_records ${clause}`)
    .run(...params);
  return result.changes as number;
}
