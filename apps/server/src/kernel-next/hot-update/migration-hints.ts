// migration_hints — B9-A (partial B9) helpers.
//
// A migration_hint carries context from a superseded attempt to the
// successor attempt that the hot-update orchestrator opens on the new
// pipeline version. Written by migration-orchestrator right after the
// supersede SQL lands; consumed (and marked consumed_at) by
// RealStageExecutor when it opens the replacement attempt.
//
// This is the first half of roadmap B9 ("Worktree 切换"). Full B9
// also calls `git reset --hard before_sha` to rewind the worktree,
// but that requires a task-worktree ownership contract kernel-next
// does not yet implement (see Phase 5C follow-up). For now we only
// propagate the diff as advisory context; the agent decides whether
// to re-apply changes.
//
// Invariant: each hint is single-use. The "unconsumed" partial index
// on (task_id, stage_name) WHERE consumed_at IS NULL gives O(1)
// lookup on the executor hot path; consumeHint flips the flag.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export interface MigrationHintWrite {
  taskId: string;
  stageName: string;
  fromVersion: string;
  toVersion: string;
  previousAttemptId: string | null;
  previousDiffText: string | null;
  previousDiffBytes: number | null;
  note: string | null;
}

export interface MigrationHint extends MigrationHintWrite {
  hintId: string;
  createdAt: number;
  consumedAt: number | null;
}

/**
 * INSERT a migration_hints row. Returns the newly created hint_id so
 * callers can reference it in logs / events.
 *
 * Idempotency note: the orchestrator may be retried within the same
 * overall migration in adversarial tests. We do not deduplicate here;
 * each call creates a fresh row. consumeHint picks the most recently
 * created unconsumed row, so older siblings stay as audit trail.
 */
export function writeMigrationHint(
  db: DatabaseSync,
  hint: MigrationHintWrite,
  now: () => number = () => Date.now(),
): string {
  const hintId = randomUUID();
  db.prepare(
    `INSERT INTO migration_hints
     (hint_id, task_id, stage_name, from_version, to_version,
      previous_attempt_id, previous_diff_text, previous_diff_bytes,
      note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hintId,
    hint.taskId,
    hint.stageName,
    hint.fromVersion,
    hint.toVersion,
    hint.previousAttemptId,
    hint.previousDiffText,
    hint.previousDiffBytes,
    hint.note,
    now(),
  );
  return hintId;
}

/**
 * Read the most recent unconsumed hint for (taskId, stageName) but do
 * NOT flip consumed_at. Used by callers that want to peek without
 * committing to consumption (debug queries, tests).
 */
export function peekUnconsumedHint(
  db: DatabaseSync,
  taskId: string,
  stageName: string,
): MigrationHint | null {
  const row = db.prepare(
    `SELECT hint_id, task_id, stage_name, from_version, to_version,
            previous_attempt_id, previous_diff_text, previous_diff_bytes,
            note, created_at, consumed_at
     FROM migration_hints
     WHERE task_id = ? AND stage_name = ? AND consumed_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
  ).get(taskId, stageName) as
    | {
        hint_id: string;
        task_id: string;
        stage_name: string;
        from_version: string;
        to_version: string;
        previous_attempt_id: string | null;
        previous_diff_text: string | null;
        previous_diff_bytes: number | null;
        note: string | null;
        created_at: number;
        consumed_at: number | null;
      }
    | undefined;
  if (!row) return null;
  return {
    hintId: row.hint_id,
    taskId: row.task_id,
    stageName: row.stage_name,
    fromVersion: row.from_version,
    toVersion: row.to_version,
    previousAttemptId: row.previous_attempt_id,
    previousDiffText: row.previous_diff_text,
    previousDiffBytes: row.previous_diff_bytes,
    note: row.note,
    createdAt: row.created_at,
    consumedAt: row.consumed_at,
  };
}

/**
 * Atomic take-once: read the most recent unconsumed hint for
 * (taskId, stageName) AND mark it consumed. Returns null when none
 * available.
 *
 * Uses a single UPDATE ... RETURNING with a subquery that selects by
 * recency, so a second caller observes the already-consumed state
 * even under concurrent access (single-DB single-process in practice,
 * but worth keeping atomic for clarity).
 */
export function consumeHint(
  db: DatabaseSync,
  taskId: string,
  stageName: string,
  now: () => number = () => Date.now(),
): MigrationHint | null {
  const target = db.prepare(
    `SELECT hint_id FROM migration_hints
     WHERE task_id = ? AND stage_name = ? AND consumed_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
  ).get(taskId, stageName) as { hint_id: string } | undefined;
  if (!target) return null;

  const update = db.prepare(
    `UPDATE migration_hints
     SET consumed_at = ?
     WHERE hint_id = ? AND consumed_at IS NULL
     RETURNING hint_id, task_id, stage_name, from_version, to_version,
               previous_attempt_id, previous_diff_text, previous_diff_bytes,
               note, created_at, consumed_at`,
  ).get(now(), target.hint_id) as
    | {
        hint_id: string;
        task_id: string;
        stage_name: string;
        from_version: string;
        to_version: string;
        previous_attempt_id: string | null;
        previous_diff_text: string | null;
        previous_diff_bytes: number | null;
        note: string | null;
        created_at: number;
        consumed_at: number;
      }
    | undefined;
  if (!update) return null;
  return {
    hintId: update.hint_id,
    taskId: update.task_id,
    stageName: update.stage_name,
    fromVersion: update.from_version,
    toVersion: update.to_version,
    previousAttemptId: update.previous_attempt_id,
    previousDiffText: update.previous_diff_text,
    previousDiffBytes: update.previous_diff_bytes,
    note: update.note,
    createdAt: update.created_at,
    consumedAt: update.consumed_at,
  };
}
