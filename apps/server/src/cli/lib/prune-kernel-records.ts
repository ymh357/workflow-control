// SQL helpers for prune-kernel-records CLI. Operates on kernel-next.db
// (the kernel-next-era schema) — NOT the legacy workflow.db.execution_records
// which was removed in Stage 4a.
//
// Table chain anchored on stage_attempts:
//
//   stage_attempts                        <-- primary row to delete
//     ├── agent_execution_details  (FK ON DELETE RESTRICT)
//     ├── script_execution_details (FK ON DELETE RESTRICT)
//     ├── stage_checkpoints        (FK ON DELETE CASCADE)
//     ├── port_values              (FK NO ACTION = blocks)
//     └── gate_queue               (FK NO ACTION = blocks)
//
//   migration_hints                        <-- task_id referenced (no FK)
//
// Because four of the five attempt-linked children block deletion, prune
// runs in a transaction that deletes children first
// (agent_execution_details, script_execution_details, port_values,
// gate_queue) then the parent stage_attempts row (which CASCADE-drops
// stage_checkpoints). migration_hints is deleted by task_id when the
// filter includes taskId (or unconditionally for the matched attempt's
// task_ids under an olderThan filter).
//
// hot_update_events has a task_id reference but no FK (standalone audit
// trail), so it is NOT touched by prune. Callers who want to purge the
// audit trail can do it separately.
//
// Filter must supply at least one constraint (taskId or olderThanMs);
// an empty filter is rejected so the CLI can't accidentally nuke every
// attempt row.

import type { DatabaseSync } from "node:sqlite";

export interface PruneFilter {
  taskId?: string;
  olderThanMs?: number;
}

export interface PruneCounts {
  attempts: number;
  agent_execution_details: number;
  script_execution_details: number;
  port_values: number;
  gate_queue: number;
  stage_checkpoints: number;
  migration_hints: number;
}

function assertFilterNonEmpty(filter: PruneFilter): void {
  if (filter.taskId === undefined && filter.olderThanMs === undefined) {
    throw new Error(
      "prune-kernel-records refuses empty filter — pass --task-id=<id> or --older-than=<N>d",
    );
  }
}

/**
 * Build the WHERE clause + params that select the stage_attempts rows
 * eligible for deletion under the given filter.
 */
function buildAttemptSelectWhere(filter: PruneFilter): {
  clause: string;
  params: Array<string | number>;
} {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.taskId !== undefined) {
    clauses.push("task_id = ?");
    params.push(filter.taskId);
  }
  if (filter.olderThanMs !== undefined) {
    const cutoff = Date.now() - filter.olderThanMs;
    clauses.push("started_at < ?");
    params.push(cutoff);
  }
  // Bug 22 (c12+ review): pre-fix, prune deleted lineage rows for ANY
  // attempt matching the filter, including those whose task was still
  // in-flight (no task_finals row). Worst-case symptom: an active
  // long-running task whose first attempt was older than the threshold
  // had its early stage_attempts + AED + port_values nuked mid-run,
  // turning the live task into an orphaned ghost the next time
  // getTaskStatus walked stage_attempts.
  //
  // Require task_finals to exist for every attempt we delete. Tasks
  // still in flight, paused on a gate, or paused on a secret-gate
  // have no task_finals and are now untouchable. Operators who really
  // want to nuke active state have ad-hoc SQL; this tool refuses.
  clauses.push(
    "EXISTS (SELECT 1 FROM task_finals tf WHERE tf.task_id = stage_attempts.task_id)",
  );
  if (clauses.length === 0) {
    // Defense in depth — assertFilterNonEmpty should have caught this.
    return { clause: "WHERE 1 = 0", params };
  }
  return { clause: `WHERE ${clauses.join(" AND ")}`, params };
}

/**
 * Count how many stage_attempts rows the filter would delete (without
 * deleting). Used by --dry-run and by the interactive confirmation.
 */
export function countAttemptsToDelete(
  db: DatabaseSync,
  filter: PruneFilter,
): number {
  assertFilterNonEmpty(filter);
  const { clause, params } = buildAttemptSelectWhere(filter);
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM stage_attempts ${clause}`)
    .get(...params) as { n: number };
  return row.n;
}

/**
 * Delete matching stage_attempts rows and all their FK children.
 *
 * Runs under a single transaction. Returns per-table deletion counts
 * so callers can report what happened. Throws if the transaction
 * fails (SQLite rolls back atomically).
 */
export function pruneAttempts(
  db: DatabaseSync,
  filter: PruneFilter,
): PruneCounts {
  assertFilterNonEmpty(filter);
  const { clause, params } = buildAttemptSelectWhere(filter);

  const counts: PruneCounts = {
    attempts: 0,
    agent_execution_details: 0,
    script_execution_details: 0,
    port_values: 0,
    gate_queue: 0,
    stage_checkpoints: 0,
    migration_hints: 0,
  };

  // Enable FK enforcement for this connection so RESTRICT / CASCADE
  // behave as declared. Tests running against DBs with FKs off would
  // silently bypass the RESTRICT and corrupt lineage.
  db.exec("PRAGMA foreign_keys = ON");

  db.exec("BEGIN");
  try {
    // 1. Resolve target attempt_ids + their task_ids once. Reusing this
    //    list in every child DELETE avoids re-evaluating
    //    buildAttemptSelectWhere against stage_attempts after we start
    //    mutating it.
    const rows = db
      .prepare(`SELECT attempt_id, task_id FROM stage_attempts ${clause}`)
      .all(...params) as Array<{ attempt_id: string; task_id: string }>;
    const ids = rows.map((r) => r.attempt_id);
    const taskIds = Array.from(new Set(rows.map((r) => r.task_id)));
    if (ids.length === 0) {
      db.exec("COMMIT");
      return counts;
    }

    // 2. Build a IN(...) placeholder list once.
    const placeholders = ids.map(() => "?").join(",");

    // 3. Count stage_checkpoints before delete (CASCADE will remove
    //    them automatically; we count first for reporting).
    const cpCount = (db
      .prepare(`SELECT COUNT(*) AS n FROM stage_checkpoints WHERE attempt_id IN (${placeholders})`)
      .get(...ids) as { n: number }).n;
    counts.stage_checkpoints = cpCount;

    // 4. Delete children that do NOT cascade. FK ON DELETE RESTRICT on
    //    agent_execution_details + script_execution_details means the
    //    parent DELETE in step 5 would fail if we skipped these.
    const aedDel = db
      .prepare(`DELETE FROM agent_execution_details WHERE attempt_id IN (${placeholders})`)
      .run(...ids);
    counts.agent_execution_details = Number(aedDel.changes ?? 0);

    const sedDel = db
      .prepare(`DELETE FROM script_execution_details WHERE attempt_id IN (${placeholders})`)
      .run(...ids);
    counts.script_execution_details = Number(sedDel.changes ?? 0);

    const pvDel = db
      .prepare(`DELETE FROM port_values WHERE attempt_id IN (${placeholders})`)
      .run(...ids);
    counts.port_values = Number(pvDel.changes ?? 0);

    const gqDel = db
      .prepare(`DELETE FROM gate_queue WHERE attempt_id IN (${placeholders})`)
      .run(...ids);
    counts.gate_queue = Number(gqDel.changes ?? 0);

    // 5. Delete the parent rows. CASCADE removes stage_checkpoints
    //    automatically; we already counted them above.
    const saDel = db
      .prepare(`DELETE FROM stage_attempts WHERE attempt_id IN (${placeholders})`)
      .run(...ids);
    counts.attempts = Number(saDel.changes ?? 0);

    // 6. Delete migration_hints tied to the now-pruned tasks. These have
    //    no FK relationship with stage_attempts — they reference task_id
    //    directly — so the order relative to step 5 does not matter. We
    //    delete any hint whose task_id appeared in the pruned set.
    const taskPlaceholders = taskIds.map(() => "?").join(",");
    const mhDel = db
      .prepare(`DELETE FROM migration_hints WHERE task_id IN (${taskPlaceholders})`)
      .run(...taskIds);
    counts.migration_hints = Number(mhDel.changes ?? 0);

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return counts;
}

export interface AttemptStats {
  total: number;
  byTask: Array<{ task_id: string; attempts: number }>;
  oldestStartedAt: number | null;
  newestStartedAt: number | null;
  openAgentExecutionDetails: number;
  openScriptExecutionDetails: number;
}

/**
 * Quick descriptive stats used by the `stats` CLI subcommand. Cheap;
 * intended for human inspection before running prune.
 */
export function attemptStats(db: DatabaseSync): AttemptStats {
  const total = (db
    .prepare(`SELECT COUNT(*) AS n FROM stage_attempts`)
    .get() as { n: number }).n;

  const byTask = (db
    .prepare(
      `SELECT task_id, COUNT(*) AS attempts FROM stage_attempts
       GROUP BY task_id
       ORDER BY attempts DESC
       LIMIT 5`,
    )
    .all() as Array<{ task_id: string; attempts: number }>);

  const range = db
    .prepare(
      `SELECT MIN(started_at) AS oldest, MAX(started_at) AS newest FROM stage_attempts`,
    )
    .get() as { oldest: number | null; newest: number | null };

  const openAed = (db
    .prepare(`SELECT COUNT(*) AS n FROM agent_execution_details WHERE ended_at IS NULL`)
    .get() as { n: number }).n;

  const openSed = (db
    .prepare(`SELECT COUNT(*) AS n FROM script_execution_details WHERE ended_at IS NULL`)
    .get() as { n: number }).n;

  return {
    total,
    byTask,
    oldestStartedAt: range.oldest,
    newestStartedAt: range.newest,
    openAgentExecutionDetails: openAed,
    openScriptExecutionDetails: openSed,
  };
}

/**
 * Parse a human-readable duration (e.g. "30d", "12h") into milliseconds.
 * Exported for the CLI entry + tests.
 */
export function parseDuration(raw: string): number {
  const m = raw.trim().match(/^(\d+)\s*([dhms])$/);
  if (!m) {
    throw new Error(
      `Invalid duration "${raw}" (expected e.g. "30d", "12h", "45m", "90s").`,
    );
  }
  const n = Number(m[1]);
  const unit = m[2]!;
  const multipliers: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return n * multipliers[unit]!;
}
