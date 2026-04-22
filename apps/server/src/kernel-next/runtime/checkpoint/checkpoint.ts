// Checkpoint capture — pure coordination layer between git-commands,
// sqlite, and the runner's PortRuntime hooks.
//
// Two write phases:
//   captureBefore: fires on attempt start, INSERTs a row. Terminal
//                  statuses (not_a_repo, disabled, before_failed) end
//                  the checkpoint here; 'capturing' means captureAfter
//                  may still fire.
//   captureAfter : UPDATEs the row with after_sha / diff_text / final
//                  status. No-op when row doesn't exist, or when the
//                  row has already left the 'capturing' state.
//
// Invariant: these functions never throw. Every DB / git failure is
// captured in the row's diagnostic column or swallowed via logger.warn.

import type { DatabaseSync } from "node:sqlite";
import { logger } from "../../../lib/logger.js";
import type {
  CheckpointConfig,
  CheckpointTimeouts,
  GitResult,
  ResolvedCheckpointConfig,
} from "./types.js";
import {
  DEFAULT_CHECKPOINT_TIMEOUTS,
  DEFAULT_MAX_DIFF_BYTES,
} from "./types.js";

export type { CheckpointConfig, GitResult, ResolvedCheckpointConfig } from "./types.js";

export interface CheckpointDeps {
  isGitRepo: (cwd: string, timeoutMs: number) => Promise<boolean>;
  gitRevParseHead: (cwd: string, timeoutMs: number) => Promise<GitResult>;
  snapshotWorkTree: (cwd: string, timeoutMs: number) => Promise<GitResult>;
  gitDiff: (cwd: string, from: string, to: string, timeoutMs: number) => Promise<GitResult>;
  pathExists: (p: string) => Promise<boolean>;
  now: () => number;
}

export function resolveCheckpointConfig(
  config: CheckpointConfig | undefined,
): ResolvedCheckpointConfig {
  // Default enabled requires an EXPLICIT workdir. The server's
  // process.cwd() is almost never the agent's subject repo, so
  // capturing it silently would describe "what changed in the server
  // repo" rather than "what the agent changed" — the opposite of
  // useful. Callers that want checkpointing must tell us where to
  // capture from; otherwise checkpointing is off.
  const hasExplicitWorkdir = typeof config?.workdir === "string" && config.workdir.length > 0;
  const enabled = config?.enabled ?? hasExplicitWorkdir;
  return {
    enabled,
    workdir: config?.workdir ?? process.cwd(),
    maxDiffBytes: config?.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES,
    timeouts: {
      revParseMs: config?.timeouts?.revParseMs ?? DEFAULT_CHECKPOINT_TIMEOUTS.revParseMs,
      snapshotMs: config?.timeouts?.snapshotMs ?? DEFAULT_CHECKPOINT_TIMEOUTS.snapshotMs,
      diffMs: config?.timeouts?.diffMs ?? DEFAULT_CHECKPOINT_TIMEOUTS.diffMs,
    },
  };
}

/**
 * Phase 1: INSERT a stage_checkpoints row describing the pre-attempt
 * state. Terminal statuses short-circuit Phase 2; otherwise row sits
 * at status='capturing' awaiting captureAfter.
 */
export async function captureBefore(
  db: DatabaseSync,
  deps: CheckpointDeps,
  args: {
    attemptId: string;
    workdir: string;
    timeouts: CheckpointTimeouts;
  },
): Promise<void> {
  const { attemptId, workdir, timeouts } = args;
  try {
    const exists = await deps.pathExists(workdir);
    if (!exists) {
      insertRow(db, {
        attempt_id: attemptId,
        workdir,
        status: "disabled",
        diagnostic: `workdir not found: ${workdir}`,
        before_sha: null,
        captured_before_at: deps.now(),
      });
      return;
    }

    const isRepo = await deps.isGitRepo(workdir, timeouts.revParseMs);
    if (!isRepo) {
      insertRow(db, {
        attempt_id: attemptId,
        workdir,
        status: "not_a_repo",
        diagnostic: null,
        before_sha: null,
        captured_before_at: deps.now(),
      });
      return;
    }

    const beforeSha = await resolveSha(deps, workdir, timeouts);
    if (beforeSha.kind === "error") {
      insertRow(db, {
        attempt_id: attemptId,
        workdir,
        status: "before_failed",
        diagnostic: beforeSha.diagnostic,
        before_sha: null,
        captured_before_at: deps.now(),
      });
      return;
    }

    insertRow(db, {
      attempt_id: attemptId,
      workdir,
      status: "capturing",
      diagnostic: null,
      before_sha: beforeSha.sha,
      captured_before_at: deps.now(),
    });
  } catch (err) {
    logger.warn(
      { attemptId, err: err instanceof Error ? err.message : String(err) },
      "[checkpoint] captureBefore swallowed error",
    );
  }
}

/**
 * Phase 2: UPDATE the row with after_sha, diff_text, and final status.
 * No-op if row missing or row has already progressed past 'capturing'.
 */
export async function captureAfter(
  db: DatabaseSync,
  deps: CheckpointDeps,
  args: {
    attemptId: string;
    maxDiffBytes: number;
    timeouts: CheckpointTimeouts;
  },
): Promise<void> {
  const { attemptId, maxDiffBytes, timeouts } = args;
  try {
    const row = db
      .prepare(
        `SELECT workdir, before_sha, status FROM stage_checkpoints WHERE attempt_id = ?`,
      )
      .get(attemptId) as
      | { workdir: string; before_sha: string | null; status: string }
      | undefined;
    if (!row) return;
    if (row.status !== "capturing") return;
    if (row.before_sha == null) return;

    const afterSha = await resolveSha(deps, row.workdir, timeouts);
    if (afterSha.kind === "error") {
      db.prepare(
        `UPDATE stage_checkpoints
         SET status = 'after_failed',
             after_sha = NULL,
             diff_text = NULL,
             diagnostic = ?,
             captured_after_at = ?
         WHERE attempt_id = ?`,
      ).run(afterSha.diagnostic, deps.now(), attemptId);
      return;
    }

    const diffRes = await deps.gitDiff(
      row.workdir, row.before_sha, afterSha.sha, timeouts.diffMs,
    );
    if (!diffRes.ok) {
      db.prepare(
        `UPDATE stage_checkpoints
         SET status = 'after_failed',
             after_sha = ?,
             diff_text = NULL,
             diagnostic = ?,
             captured_after_at = ?
         WHERE attempt_id = ?`,
      ).run(
        afterSha.sha,
        `git diff failed: ${diffRes.stderr || `exit ${diffRes.exitCode}`}`,
        deps.now(),
        attemptId,
      );
      return;
    }

    const diffText = diffRes.stdout;
    const diffBytes = Buffer.byteLength(diffText);
    if (diffBytes > maxDiffBytes) {
      db.prepare(
        `UPDATE stage_checkpoints
         SET status = 'diff_too_large',
             after_sha = ?,
             diff_text = NULL,
             diff_bytes = ?,
             diagnostic = ?,
             captured_after_at = ?
         WHERE attempt_id = ?`,
      ).run(
        afterSha.sha,
        diffBytes,
        `diff exceeded maxDiffBytes (${diffBytes} > ${maxDiffBytes})`,
        deps.now(),
        attemptId,
      );
      return;
    }

    db.prepare(
      `UPDATE stage_checkpoints
       SET status = 'captured',
           after_sha = ?,
           diff_text = ?,
           diff_bytes = ?,
           captured_after_at = ?
       WHERE attempt_id = ?`,
    ).run(afterSha.sha, diffText, diffBytes, deps.now(), attemptId);
  } catch (err) {
    logger.warn(
      { attemptId, err: err instanceof Error ? err.message : String(err) },
      "[checkpoint] captureAfter swallowed error",
    );
  }
}

// ---- Helpers -------------------------------------------------------

type ShaResult =
  | { kind: "ok"; sha: string }
  | { kind: "error"; diagnostic: string };

async function resolveSha(
  deps: CheckpointDeps,
  workdir: string,
  timeouts: CheckpointTimeouts,
): Promise<ShaResult> {
  const snap = await deps.snapshotWorkTree(workdir, timeouts.snapshotMs);
  if (snap.ok && snap.stdout.trim() !== "") {
    return { kind: "ok", sha: snap.stdout.trim() };
  }
  const head = await deps.gitRevParseHead(workdir, timeouts.revParseMs);
  if (head.ok && head.stdout.trim() !== "") {
    return { kind: "ok", sha: head.stdout.trim() };
  }
  const diag =
    !snap.ok && !head.ok
      ? `snapshotWorkTree failed: ${snap.stderr || `exit ${snap.exitCode}`}; rev-parse HEAD failed: ${head.stderr || `exit ${head.exitCode}`}`
      : !head.ok
        ? `rev-parse HEAD failed: ${head.stderr || `exit ${head.exitCode}`}`
        : `snapshotWorkTree returned empty, rev-parse HEAD returned empty`;
  return { kind: "error", diagnostic: diag };
}

function insertRow(
  db: DatabaseSync,
  row: {
    attempt_id: string;
    workdir: string;
    status: string;
    diagnostic: string | null;
    before_sha: string | null;
    captured_before_at: number;
  },
): void {
  try {
    db.prepare(
      `INSERT INTO stage_checkpoints
       (attempt_id, workdir, before_sha, status, diagnostic, captured_before_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      row.attempt_id,
      row.workdir,
      row.before_sha,
      row.status,
      row.diagnostic,
      row.captured_before_at,
    );
  } catch (err) {
    // PK collision on duplicate captureBefore is expected; any other
    // failure is swallowed here and surfaces via logger above.
    logger.warn(
      { attemptId: row.attempt_id, err: err instanceof Error ? err.message : String(err) },
      "[checkpoint] INSERT stage_checkpoints failed",
    );
  }
}
