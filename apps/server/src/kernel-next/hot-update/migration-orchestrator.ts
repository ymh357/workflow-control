// Migration orchestrator — Stage 5B design §2.1.
// End-to-end: proposal pre-check → per-task lock → INTERRUPT + awaitTermination
// → wire-reachable supersede set → snapshot pre-status → supersede TX → resume
// via startPipelineRun. On resume failure: reverse supersede.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { taskRegistry } from "../runtime/task-registry.js";
import { computeWireTransitiveReaders } from "./wire-reachable.js";
import { startPipelineRun } from "../runtime/start-pipeline-run.js";
import type { KernelNextBroadcaster } from "../sse/broadcaster.js";
import type { PipelineIR } from "../ir/schema.js";
import type {
  MigrationOutcome, PreSupersedeSnapshot,
} from "./migration-types.js";
import type { TerminationReason } from "../runtime/task-registry.js";

const DEFAULT_INTERRUPT_WAIT_MS = 30_000;

// Per-process per-task migration lock. Second concurrent migrateTask on
// the same taskId returns MIGRATION_IN_PROGRESS without touching state.
// Replaces the obsolete `migrationInProgress` map that used to live in
// mcp/kernel.ts (retired in Task 8).
const orchestratorLocks = new Map<
  string,
  { proposalId: string; acquiredAt: number }
>();

export function __resetOrchestratorLocksForTest(): void {
  orchestratorLocks.clear();
}

export interface OrchestratorInput {
  db: DatabaseSync;
  taskId: string;
  proposalId: string;
  broadcaster?: KernelNextBroadcaster;
  /** Override for tests to keep INTERRUPT_WAIT_MS snappy. */
  interruptWaitMsOverride?: number;
  /** Inject a stand-in startPipelineRun so orchestrator tests don't
   *  launch a real runner. Signature matches startPipelineRun. */
  startRunnerOverride?: typeof startPipelineRun;
}

export async function executeMigration(
  input: OrchestratorInput,
): Promise<MigrationOutcome> {
  const { db, taskId, proposalId } = input;
  const interruptMs = input.interruptWaitMsOverride ?? DEFAULT_INTERRUPT_WAIT_MS;
  const startRunner = input.startRunnerOverride ?? startPipelineRun;

  // --- 1-4: Pre-check proposal + acquire lock --------------------------
  const proposalRow = db.prepare(
    `SELECT base_version, proposed_version, status, rerun_from,
            migrate_running, actor
     FROM pipeline_proposals WHERE proposal_id = ?`,
  ).get(proposalId) as
    | {
        base_version: string;
        proposed_version: string | null;
        status: string;
        rerun_from: string | null;
        migrate_running: string | null;
        actor: string;
      }
    | undefined;

  if (!proposalRow) {
    return {
      ok: false,
      code: "PROPOSAL_NOT_FOUND",
      message: `proposal '${proposalId}' not found`,
    };
  }
  if (proposalRow.status !== "approved") {
    return {
      ok: false,
      code: "PROPOSAL_ALREADY_RESOLVED",
      message: `proposal '${proposalId}' status is '${proposalRow.status}', not 'approved'`,
    };
  }
  if (!proposalRow.proposed_version) {
    return {
      ok: false,
      code: "PATCH_APPLY_ERROR",
      message: `proposal '${proposalId}' has no proposed_version`,
    };
  }

  const mig = parseMigrateRunning(proposalRow.migrate_running);
  const inList =
    mig === "all" || (Array.isArray(mig) && mig.includes(taskId));
  if (!inList) {
    return {
      ok: false,
      code: "PATCH_APPLY_ERROR",
      message: `task '${taskId}' is not in proposal.migrateRunningTasks`,
      context: { migrateRunning: mig },
    };
  }

  const held = orchestratorLocks.get(taskId);
  if (held) {
    return {
      ok: false,
      code: "MIGRATION_IN_PROGRESS",
      message:
        `task '${taskId}' is already migrating under proposal ` +
        `'${held.proposalId}' (acquired ${Date.now() - held.acquiredAt}ms ago)`,
      context: {
        holdingProposalId: held.proposalId,
        acquiredAt: held.acquiredAt,
      },
    };
  }
  orchestratorLocks.set(taskId, { proposalId, acquiredAt: Date.now() });

  const fromVersion = proposalRow.base_version;
  const toVersion = proposalRow.proposed_version;
  const rerunFrom = proposalRow.rerun_from;

  try {
    // --- 5-6: INTERRUPT + awaitTermination ---------------------------
    const interruptStart = Date.now();
    const isRunning = taskRegistry.get(taskId) !== undefined;
    let terminationReason: TerminationReason | null = null;

    if (isRunning) {
      const dispatcher = taskRegistry.get(taskId)!;
      try {
        dispatcher.send({ type: "INTERRUPT" } as never);
      } catch {
        // Dispatcher may have shut down between get() and send() — treat
        // as already-terminated and fall through to awaitTermination,
        // which returns never_started immediately in that case.
      }
      const awaited = await taskRegistry.awaitTermination(taskId, interruptMs);
      if (awaited.kind === "never_started") {
        // Timeout: registry returns never_started for both "no such task"
        // and "timed out waiting". Since isRunning was true moments ago,
        // this is the timeout branch.
        writeAuditFailed(db, {
          taskId,
          fromVersion,
          toVersion,
          proposalId,
          actor: proposalRow.actor,
          rerunFrom,
          startedAt: interruptStart,
          diagnostic: {
            __kind: "migration-failed-v1",
            reason: "INTERRUPT_TIMEOUT",
            interruptWaitMs: Date.now() - interruptStart,
          },
        });
        return {
          ok: false,
          code: "MIGRATION_INTERRUPT_TIMEOUT",
          message:
            `runner for task '${taskId}' did not terminate within ` +
            `${interruptMs}ms after INTERRUPT`,
        };
      }
      terminationReason = awaited;
    }
    const interruptWaitMs = Date.now() - interruptStart;

    // --- 7-9: Compute supersede set, snapshot, TX --------------------
    const proposedIR = loadIR(db, toVersion);
    if (!proposedIR) {
      return {
        ok: false,
        code: "PATCH_APPLY_ERROR",
        message: `proposed version '${toVersion}' IR not found`,
      };
    }

    const supersedeSet = rerunFrom
      ? computeWireTransitiveReaders(proposedIR, rerunFrom)
      : new Set<string>();

    // Snapshot pre-supersede status of every affected attempt for reverse.
    const snapshot: PreSupersedeSnapshot[] = [];
    if (supersedeSet.size > 0) {
      const stmt = db.prepare(
        `SELECT attempt_id, stage_name, status FROM stage_attempts
         WHERE task_id = ? AND stage_name = ?
           AND status IN ('success','running','error')`,
      );
      for (const s of supersedeSet) {
        const rows = stmt.all(taskId, s) as Array<{
          attempt_id: string;
          stage_name: string;
          status: string;
        }>;
        for (const r of rows) {
          snapshot.push({
            attemptId: r.attempt_id,
            stageName: r.stage_name,
            status: r.status as "success" | "running" | "error",
          });
        }
      }
    }

    const eventId = randomUUID();
    const startedAt = Date.now();
    const diagSuccess = JSON.stringify({
      __kind: "migration-executed-v1",
      supersedeSet: Array.from(supersedeSet).sort(),
      resumeFromStage: rerunFrom,
      interruptWaitMs,
      terminationReasonKind: terminationReason?.kind ?? null,
    });

    try {
      db.exec("BEGIN");
      if (supersedeSet.size > 0) {
        const upd = db.prepare(
          `UPDATE stage_attempts SET status = 'superseded'
           WHERE task_id = ? AND stage_name = ?
             AND status IN ('success','running','error')`,
        );
        for (const s of supersedeSet) upd.run(taskId, s);
      }
      db.prepare(
        `INSERT INTO hot_update_events
         (event_id, task_id, from_version, to_version, actor, proposal_id,
          rerun_from_stage, status, started_at, finished_at, diagnostic_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'success', ?, ?, ?)`,
      ).run(
        eventId,
        taskId,
        fromVersion,
        toVersion,
        proposalRow.actor,
        proposalId,
        rerunFrom,
        startedAt,
        Date.now(),
        diagSuccess,
      );
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      const message = err instanceof Error ? err.message : String(err);
      writeAuditFailed(db, {
        taskId,
        fromVersion,
        toVersion,
        proposalId,
        actor: proposalRow.actor,
        rerunFrom,
        startedAt,
        diagnostic: {
          __kind: "migration-failed-v1",
          reason: "SUPERSEDE_TX_FAILED",
          error: message,
        },
      });
      return {
        ok: false,
        code: "PATCH_APPLY_ERROR",
        message: `supersede tx failed: ${message}`,
      };
    }

    // --- 10: Resume -------------------------------------------------
    if (!rerunFrom) {
      // Forward-only proposal with no rerunFrom → no new stages to kick
      // off for this task. New task submissions may use toVersion; this
      // task's existing attempts remain intact on fromVersion.
      return {
        ok: true,
        eventId,
        taskId,
        fromVersion,
        toVersion,
        supersededStages: [],
        resumedFromStage: null,
        interruptWaitMs,
        newRunnerStarted: false,
      };
    }

    try {
      const runResult = await startRunner({
        db,
        broadcaster:
          input.broadcaster ?? ({ publish: () => {} } as unknown as KernelNextBroadcaster),
        taskId,
        versionHash: toVersion,
        resumeFrom: rerunFrom,
      });
      if (runResult.ok !== true) {
        throw new Error(
          `startPipelineRun returned failure: ${runResult.code} ${runResult.message}`,
        );
      }
    } catch (err) {
      // Reverse supersede — restore pre-supersede status on affected attempts.
      const message = err instanceof Error ? err.message : String(err);
      try {
        db.exec("BEGIN");
        const restore = db.prepare(
          `UPDATE stage_attempts SET status = ? WHERE attempt_id = ?`,
        );
        for (const s of snapshot) restore.run(s.status, s.attemptId);
        db.exec("COMMIT");
      } catch {
        try { db.exec("ROLLBACK"); } catch { /* ignore */ }
      }
      writeAuditFailed(db, {
        taskId,
        fromVersion,
        toVersion,
        proposalId,
        actor: proposalRow.actor,
        rerunFrom,
        startedAt: Date.now(),
        diagnostic: {
          __kind: "migration-failed-v1",
          reason: "RESUME_FAILED",
          error: message,
        },
      });
      return {
        ok: false,
        code: "MIGRATION_RESUME_FAILED",
        message: `resume after supersede failed; state reverted: ${message}`,
      };
    }

    return {
      ok: true,
      eventId,
      taskId,
      fromVersion,
      toVersion,
      supersededStages: Array.from(supersedeSet).sort(),
      resumedFromStage: rerunFrom,
      interruptWaitMs,
      newRunnerStarted: true,
    };
  } finally {
    orchestratorLocks.delete(taskId);
  }
}

// ---- helpers --------------------------------------------------------

function parseMigrateRunning(raw: string | null): "all" | "none" | string[] {
  if (raw === null || raw === "") return "none";
  try {
    const parsed = JSON.parse(raw);
    if (parsed === "all" || parsed === "none") return parsed;
    if (Array.isArray(parsed)) return parsed.map(String);
    return "none";
  } catch {
    if (raw === "all" || raw === "none") return raw;
    return "none";
  }
}

function loadIR(db: DatabaseSync, versionHash: string): PipelineIR | null {
  const row = db.prepare(
    `SELECT ir_json FROM pipeline_versions WHERE version_hash = ?`,
  ).get(versionHash) as { ir_json: string } | undefined;
  if (!row) return null;
  return JSON.parse(row.ir_json) as PipelineIR;
}

function writeAuditFailed(
  db: DatabaseSync,
  input: {
    taskId: string;
    fromVersion: string;
    toVersion: string;
    proposalId: string;
    actor: string;
    rerunFrom: string | null;
    startedAt: number;
    diagnostic: Record<string, unknown>;
  },
): void {
  try {
    db.prepare(
      `INSERT INTO hot_update_events
       (event_id, task_id, from_version, to_version, actor, proposal_id,
        rerun_from_stage, status, started_at, finished_at, diagnostic_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?)`,
    ).run(
      randomUUID(),
      input.taskId,
      input.fromVersion,
      input.toVersion,
      input.actor,
      input.proposalId,
      input.rerunFrom,
      input.startedAt,
      Date.now(),
      JSON.stringify(input.diagnostic),
    );
  } catch {
    // Best-effort audit; if this also fails the DB is fully broken and
    // the caller still returns a diagnostic.
  }
}
