// Stage 5B design §2.2 — real rollback execution.
//
// Synthesizes an "approved" proposal from the task's current version to
// the target version, then delegates to executeMigration. Supports
// jump-rollback across multiple historical migrations (rollback from v3
// directly to v1, skipping v2) because divergence is computed from the
// IR diff, not from hot_update_events replay.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Diagnostic, PipelineIR } from "../ir/schema.js";
import { findEarliestDivergence } from "./divergence.js";
import {
  executeMigration,
  type OrchestratorInput,
} from "./migration-orchestrator.js";
import type { MigrationOutcome } from "./migration-types.js";

export interface RollbackInput {
  db: DatabaseSync;
  taskId: string;
  toVersion: string;
  actor: string;
  /** Forwarded to executeMigration when the synthetic proposal triggers
   *  a migration. Useful in tests to keep timing bounded. */
  interruptWaitMsOverride?: number;
  startRunnerOverride?: OrchestratorInput["startRunnerOverride"];
}

export type RollbackOutcome =
  | {
      ok: true;
      eventId: string;
      taskId: string;
      rolledTo: string;
      divergenceStage: string | null;
      migrationEventId: string;
    }
  | {
      ok: false;
      diagnostics: Diagnostic[];
    };

export async function executeRollback(
  input: RollbackInput,
): Promise<RollbackOutcome> {
  const { db, taskId, toVersion, actor } = input;

  // 1. Validate toVersion is in the task's migration history.
  const history = db.prepare(
    `SELECT from_version, to_version FROM hot_update_events
     WHERE task_id = ? ORDER BY started_at DESC`,
  ).all(taskId) as Array<{ from_version: string; to_version: string }>;
  const known = new Set<string>();
  for (const row of history) {
    known.add(row.from_version);
    known.add(row.to_version);
  }
  if (!known.has(toVersion)) {
    return {
      ok: false,
      diagnostics: [{
        code: "VERSION_NOT_IN_HISTORY",
        message:
          `task '${taskId}' has no migration history including version ` +
          `'${toVersion}' (known=${Array.from(known).join(", ") || "<empty>"})`,
        context: { taskId, toVersion },
      }],
    };
  }

  // 2. Determine current version from the task's most recent attempt.
  const currentRow = db.prepare(
    `SELECT version_hash FROM stage_attempts
     WHERE task_id = ? ORDER BY started_at DESC LIMIT 1`,
  ).get(taskId) as { version_hash: string } | undefined;
  if (!currentRow) {
    return {
      ok: false,
      diagnostics: [{
        code: "PATCH_APPLY_ERROR",
        message: `task '${taskId}' has no stage_attempts — nothing to rollback`,
      }],
    };
  }
  const currentVersion = currentRow.version_hash;

  // 3. Load IRs for current and target.
  const baseIR = loadIR(db, currentVersion);
  const proposedIR = loadIR(db, toVersion);
  if (!baseIR || !proposedIR) {
    return {
      ok: false,
      diagnostics: [{
        code: "PATCH_APPLY_ERROR",
        message:
          `failed to load IR for currentVersion='${currentVersion}' ` +
          `or toVersion='${toVersion}'`,
      }],
    };
  }

  // 4. Compute earliest divergence stage.
  const divergenceStage = findEarliestDivergence(baseIR, proposedIR);
  if (divergenceStage === null) {
    return {
      ok: false,
      diagnostics: [{
        code: "ROLLBACK_EMPTY_DIFF",
        message:
          `currentVersion '${currentVersion}' and toVersion '${toVersion}' ` +
          `IRs are equivalent; rollback is a no-op`,
        context: { currentVersion, toVersion },
      }],
    };
  }

  // 5. Synthesize an approved proposal and INSERT it.
  const syntheticProposalId = randomUUID();
  const diagnosticJson = JSON.stringify({
    __kind: "rollback-v1",
    originTaskId: taskId,
    rolledTo: toVersion,
    fromCurrent: currentVersion,
    divergenceStage,
  });
  db.prepare(
    `INSERT INTO pipeline_proposals
     (proposal_id, base_version, proposed_version, actor, status,
      diagnostic_json, created_at, rerun_from, migrate_running)
     VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?)`,
  ).run(
    syntheticProposalId,
    currentVersion,
    toVersion,
    actor,
    diagnosticJson,
    Date.now(),
    divergenceStage,
    JSON.stringify([taskId]),
  );

  // 6. Delegate to migration orchestrator (same lock + supersede + resume path).
  const migration: MigrationOutcome = await executeMigration({
    db,
    taskId,
    proposalId: syntheticProposalId,
    interruptWaitMsOverride: input.interruptWaitMsOverride,
    startRunnerOverride: input.startRunnerOverride,
  });
  if (!migration.ok) {
    return {
      ok: false,
      diagnostics: [{
        code: "PATCH_APPLY_ERROR",
        message: `rollback migration failed: ${migration.message}`,
        context: {
          syntheticProposalId,
          migrationCode: migration.code,
        },
      }],
    };
  }

  // 7. Write a dedicated rollback audit row on top of the migration's
  //    success row. Consumers filtering hot_update_events by
  //    status='rolled_back' find only these, regardless of how many
  //    migration-executed-v1 rows preceded them.
  const rollbackEventId = randomUUID();
  db.prepare(
    `INSERT INTO hot_update_events
     (event_id, task_id, from_version, to_version, actor, proposal_id,
      rerun_from_stage, status, started_at, finished_at, diagnostic_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'rolled_back', ?, ?, ?)`,
  ).run(
    rollbackEventId,
    taskId,
    currentVersion,
    toVersion,
    actor,
    syntheticProposalId,
    divergenceStage,
    Date.now(),
    Date.now(),
    JSON.stringify({
      __kind: "rollback-v1",
      migrationEventId: migration.eventId,
      divergenceStage,
    }),
  );

  return {
    ok: true,
    eventId: rollbackEventId,
    taskId,
    rolledTo: toVersion,
    divergenceStage,
    migrationEventId: migration.eventId,
  };
}

function loadIR(db: DatabaseSync, versionHash: string): PipelineIR | null {
  const row = db.prepare(
    `SELECT ir_json FROM pipeline_versions WHERE version_hash = ?`,
  ).get(versionHash) as { ir_json: string } | undefined;
  if (!row) return null;
  return JSON.parse(row.ir_json) as PipelineIR;
}
