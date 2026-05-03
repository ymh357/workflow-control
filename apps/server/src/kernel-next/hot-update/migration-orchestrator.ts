// Migration orchestrator — Stage 5B design §2.1.
// End-to-end: proposal pre-check → per-task lock → INTERRUPT + awaitTermination
// → wire-reachable supersede set → snapshot pre-status → supersede TX → resume
// via startPipelineRun. On resume failure: reverse supersede.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { taskRegistry } from "../runtime/task-registry.js";
import { computeWireTransitiveReaders } from "./wire-reachable.js";
import { startPipelineRun } from "../runtime/start-pipeline-run.js";
import { writeMigrationHint } from "./migration-hints.js";
import { gitResetHard } from "../runtime/worktree/git-worktree-ops.js";
import { resolveWorktree } from "../runtime/worktree/allocator.js";
import { logger } from "../../lib/logger.js";
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
      message:
        `task '${taskId}' is not in the proposal's migrateRunningTasks ` +
        `(${mig === "none" ? "none" : JSON.stringify(mig)})`,
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
    // Bug 80 (dogfood-10 2026-05-03): a task waiting at a human gate
    // has its dispatcher in taskRegistry AND a stage_attempt row with
    // status='running' (the gate's own attempt sits in `running` while
    // the human deliberates), but the gate stage's executing substate
    // is idle-by-design — it has no invoke and no INTERRUPT handler in
    // the compiled machine (ir-to-machine.ts:878, gate executing only
    // listens for GATE_ANSWERED). Sending {type:"INTERRUPT"} to such
    // an actor is a noop, awaitTermination hits its 30s timeout, and
    // migration fails with MIGRATION_INTERRUPT_TIMEOUT even though
    // there was nothing to interrupt.
    //
    // Skip the INTERRUPT round-trip when every `running` stage_attempt
    // row belongs to a gate stage. This covers gated tasks (and any
    // future stage type whose `executing` substate is idle by design)
    // without the orchestrator having to enumerate task statuses.
    // Migration's correctness rests on the supersede TX below —
    // INTERRUPT is purely an optimisation to stop in-flight executors
    // before their writes become stale; gate attempts aren't writing
    // anything that needs stopping.
    const interruptStart = Date.now();
    const isRunning = taskRegistry.get(taskId) !== undefined;
    let terminationReason: TerminationReason | null = null;

    let hasNonGateRunningAttempt = false;
    if (isRunning) {
      const fromIR = loadIR(db, fromVersion);
      const gateStageNames = new Set(
        fromIR
          ? fromIR.stages.filter((s) => s.type === "gate").map((s) => s.name)
          : [],
      );
      const runningRows = db
        .prepare(
          `SELECT stage_name FROM stage_attempts
           WHERE task_id = ? AND status = 'running'`,
        )
        .all(taskId) as Array<{ stage_name: string }>;
      hasNonGateRunningAttempt = runningRows.some(
        (r) => !gateStageNames.has(r.stage_name),
      );
    }

    if (isRunning && hasNonGateRunningAttempt) {
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
    //
    // B17 (fanout hot-update): a fanout stage produces many attempts —
    //   one per element (kind='fanout_element') plus one aggregate
    //   (kind='fanout_aggregate'). Already-successful fanout elements
    //   are retained as lineage — the roadmap calls for "已跑 item 保留".
    //   Any element that is still running or errored is superseded so
    //   the re-run path can retry it under the new IR, and the
    //   aggregate attempt is always superseded (it would otherwise
    //   carry the outputs array built from the now-partial element
    //   set). Non-fanout attempts (kind='regular' + any non-fanout
    //   success/running/error rows) supersede unchanged.
    const snapshot: PreSupersedeSnapshot[] = [];
    if (supersedeSet.size > 0) {
      const stmt = db.prepare(
        `SELECT attempt_id, stage_name, status, kind FROM stage_attempts
         WHERE task_id = ? AND stage_name = ?
           AND status IN ('success','running','error')
           AND NOT (kind = 'fanout_element' AND status = 'success')`,
      );
      for (const s of supersedeSet) {
        const rows = stmt.all(taskId, s) as Array<{
          attempt_id: string;
          stage_name: string;
          status: string;
          kind: string;
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
        // B17 — preserve successful fanout_element attempts (kept as
        // completed lineage). All other attempt kinds inside the
        // supersede set are superseded as before.
        const upd = db.prepare(
          `UPDATE stage_attempts SET status = 'superseded'
           WHERE task_id = ? AND stage_name = ?
             AND status IN ('success','running','error')
             AND NOT (kind = 'fanout_element' AND status = 'success')`,
        );
        for (const s of supersedeSet) upd.run(taskId, s);

        // Bug 23 (c12+ review): close any unresolved gate_queue rows
        // referencing attempts we just superseded. Pre-fix the gate
        // rows stayed open with answered_at IS NULL, so a stale
        // answer_gate call (e.g. a user clicking the gate UI between
        // the supersede and the new runner opening a fresh gate) would
        // try to resolve routes against the OLD IR — and potentially
        // route to a stage that no longer exists in the new pipeline.
        // Mark these gates as cancelled-by-supersede with the migration
        // event timestamp; answerGate's `answered_at IS NULL` guard
        // then refuses the stale call cleanly.
        const closeGate = db.prepare(
          `UPDATE gate_queue
              SET answered_at = ?,
                  answer = COALESCE(answer, '__superseded_by_migration__')
            WHERE task_id = ?
              AND stage_name = ?
              AND answered_at IS NULL`,
        );
        for (const s of supersedeSet) closeGate.run(Date.now(), taskId, s);
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

    // --- 9b: Migration hint for rerunFrom stage (B9 partial) --------
    // After supersede lands but before the new runner starts, capture the
    // latest diff from the superseded rerunFrom attempt and stage it as
    // a migration_hint. RealStageExecutor consumes it when opening the
    // replacement attempt and injects the diff into that attempt's
    // system prompt as advisory context.
    if (rerunFrom) {
      try {
        writeB9MigrationHint(db, {
          taskId, stageName: rerunFrom,
          fromVersion, toVersion,
        });
      } catch (err) {
        // Hint-write failures must NOT fail the migration. Log shape only.
        // Downstream agent just loses the diff context, which is advisory.
        // (Orchestrator has no logger handle; swallow silently — the
        //  hot_update_events audit row still captures the overall outcome.)
      }
    }

    // --- 9c: Worktree reset to before_sha (B9 full, Phase 5C+) --------
    // When the task has an active task_worktrees row AND the supersede
    // rerunFrom stage has a stage_checkpoint with before_sha populated,
    // rewind the owned workdir to that SHA so the resume starts from a
    // clean slate matching the pre-stage state. Complementary to 9b:
    // hint tells the agent what happened (advisory); reset actually
    // restores file state (authoritative).
    //
    // Graceful skip when: no ownership row, status != 'active',
    // no checkpoint, before_sha NULL, or git reset fails. Migration
    // never aborts on reset failure — advisory hint alone is still
    // useful, and the alternative (abort) loses the opportunity for
    // the agent to act on stale worktree state.
    if (rerunFrom) {
      try {
        await tryResetWorktreeToBeforeSha(db, taskId, rerunFrom);
      } catch {
        // Any throw is swallowed here; tryResetWorktreeToBeforeSha
        // already logs and returns on known failure modes.
      }
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

/**
 * B9 (partial): capture the most recent superseded attempt on
 * `stageName` (the rerunFrom stage) and stage its worktree diff as a
 * migration_hint the successor attempt can pick up. No-op when there
 * is no superseded attempt, no checkpoint, or no captured diff.
 */
function writeB9MigrationHint(
  db: DatabaseSync,
  args: {
    taskId: string;
    stageName: string;
    fromVersion: string;
    toVersion: string;
  },
): void {
  const attempt = db.prepare(
    `SELECT attempt_id FROM stage_attempts
     WHERE task_id = ? AND stage_name = ? AND status = 'superseded'
     ORDER BY attempt_idx DESC
     LIMIT 1`,
  ).get(args.taskId, args.stageName) as { attempt_id: string } | undefined;

  if (!attempt) {
    // The rerunFrom stage had no running/success attempts to supersede
    // (fresh migration, resume_from pointing at a stage not yet run).
    // Nothing to hint about.
    return;
  }

  const checkpoint = db.prepare(
    `SELECT diff_text, diff_bytes, status AS cp_status FROM stage_checkpoints
     WHERE attempt_id = ?`,
  ).get(attempt.attempt_id) as
    | { diff_text: string | null; diff_bytes: number | null; cp_status: string }
    | undefined;

  let note: string | null = null;
  let diffText: string | null = null;
  let diffBytes: number | null = null;

  if (!checkpoint) {
    note = "previous attempt ran without checkpoint capture";
  } else if (checkpoint.diff_text === null && checkpoint.cp_status === "diff_too_large") {
    note = `previous attempt's diff exceeded cap (${checkpoint.diff_bytes} bytes); not inlined`;
    diffBytes = checkpoint.diff_bytes;
  } else if (checkpoint.diff_text === null) {
    note = `previous attempt checkpoint status=${checkpoint.cp_status}; diff unavailable`;
  } else {
    diffText = checkpoint.diff_text;
    diffBytes = checkpoint.diff_bytes;
    note = `diff from superseded attempt ${attempt.attempt_id}`;
  }

  writeMigrationHint(db, {
    taskId: args.taskId,
    stageName: args.stageName,
    fromVersion: args.fromVersion,
    toVersion: args.toVersion,
    previousAttemptId: attempt.attempt_id,
    previousDiffText: diffText,
    previousDiffBytes: diffBytes,
    note,
  });
}

const B9_RESET_TIMEOUT_MS = 10_000;

/**
 * B9 full — reset the task's owned workdir to the before_sha captured
 * by the most recently superseded rerunFrom attempt's stage_checkpoint.
 *
 * Graceful skip (never throws, never aborts migration) when any of:
 *   - task has no task_worktrees row (worktree ownership not opted in)
 *   - task_worktrees.status != 'active' (allocation unavailable / pruned)
 *   - rerunFrom's latest superseded attempt has no stage_checkpoints row
 *   - checkpoint.before_sha is NULL (captureBefore failed / disabled)
 *   - git reset itself fails (e.g. unknown SHA after GC)
 *
 * Design rationale: file state (reset) + advisory context (hint) are
 * two independent signals. Either one can fail without invalidating
 * the other; migration succeeds as long as the supersede TX landed.
 */
async function tryResetWorktreeToBeforeSha(
  db: DatabaseSync,
  taskId: string,
  rerunFromStage: string,
): Promise<void> {
  const ownership = resolveWorktree(db, taskId);
  if (!ownership || ownership.status !== "active") return;

  const attempt = db.prepare(
    `SELECT attempt_id FROM stage_attempts
     WHERE task_id = ? AND stage_name = ? AND status = 'superseded'
     ORDER BY attempt_idx DESC LIMIT 1`,
  ).get(taskId, rerunFromStage) as { attempt_id: string } | undefined;
  if (!attempt) return;

  const cp = db.prepare(
    `SELECT before_sha FROM stage_checkpoints WHERE attempt_id = ?`,
  ).get(attempt.attempt_id) as { before_sha: string | null } | undefined;
  if (!cp || !cp.before_sha) return;

  const r = await gitResetHard(
    ownership.workdir, cp.before_sha, B9_RESET_TIMEOUT_MS,
  );
  if (!r.ok) {
    logger.warn(
      { taskId, stage: rerunFromStage, workdir: ownership.workdir,
        beforeSha: cp.before_sha, stderr: r.stderr },
      "[migration-orchestrator] B9 reset --hard failed; continuing without reset",
    );
  }
}
