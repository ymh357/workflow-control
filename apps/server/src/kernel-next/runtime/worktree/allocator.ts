// W3 — worktree allocation + resolution.
//
// allocateWorktree upserts a task_worktrees row keyed by taskId and
// tries to create a git worktree via runtime/worktree/git-worktree-ops.
// Second call for the same taskId is idempotent: returns the existing
// row and bumps last_used_at, without touching git.
//
// resolveWorktree is a cheap read-only lookup used by the migration
// orchestrator's resume path and by future B9 full (git reset to
// before_sha operates inside the owned workdir).

import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { addWorktree } from "./git-worktree-ops.js";

export interface AllocateOptions {
  /** Source git repository path. */
  repo: string;
  /** Root directory under which `<worktreeRoot>/<taskId>` is created. */
  worktreeRoot: string;
  /** Optional git ref for the new branch starting point. Defaults to HEAD. */
  baseBranch?: string;
  /** Timeout for the underlying git operation (ms). Default 10_000. */
  timeoutMs?: number;
}

export interface AllocationResult {
  status: "active" | "unavailable";
  /** Absolute workdir path when status='active'; null on unavailable. */
  workdir: string | null;
  /** Logical branch name (created in the source repo when active). */
  branchName: string;
}

export interface WorktreeRow {
  taskId: string;
  workdir: string;
  baseBranch: string | null;
  branchName: string;
  status: "active" | "unavailable" | "pruned";
  createdAt: number;
  lastUsedAt: number;
  diagnostic: string | null;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function branchNameFor(taskId: string): string {
  return `wfc/task/${taskId}`;
}

/**
 * Idempotent worktree allocation for a task.
 *
 * - First call: inserts a new task_worktrees row, attempts git worktree
 *   add, returns active or unavailable based on git result.
 * - Subsequent calls for the same taskId: returns the existing row with
 *   last_used_at bumped; does not touch git. Status is whatever was
 *   recorded on the first call.
 */
export async function allocateWorktree(
  db: DatabaseSync,
  taskId: string,
  opts: AllocateOptions,
): Promise<AllocationResult> {
  const existing = db.prepare(
    `SELECT status, workdir, branch_name FROM task_worktrees WHERE task_id = ?`,
  ).get(taskId) as
    | { status: "active" | "unavailable" | "pruned"; workdir: string; branch_name: string }
    | undefined;

  if (existing) {
    db.prepare(
      `UPDATE task_worktrees SET last_used_at = ? WHERE task_id = ?`,
    ).run(Date.now(), taskId);
    return {
      status: existing.status === "active" ? "active" : "unavailable",
      workdir: existing.status === "active" ? existing.workdir : null,
      branchName: existing.branch_name,
    };
  }

  const branchName = branchNameFor(taskId);
  const workdir = join(opts.worktreeRoot, taskId);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const git = await addWorktree(
    {
      repo: opts.repo,
      targetDir: workdir,
      branchName,
      baseBranch: opts.baseBranch,
    },
    timeoutMs,
  );

  const now = Date.now();
  if (git.ok) {
    db.prepare(
      `INSERT INTO task_worktrees
       (task_id, workdir, base_branch, branch_name, status,
        created_at, last_used_at, diagnostic)
       VALUES (?, ?, ?, ?, 'active', ?, ?, NULL)`,
    ).run(taskId, workdir, opts.baseBranch ?? null, branchName, now, now);
    return { status: "active", workdir, branchName };
  }

  // Unavailable — record diagnostic so callers / users can investigate.
  const diagnostic = git.stderr.slice(0, 1000) ||
    `git worktree add exit=${git.exitCode} timedOut=${git.timedOut}`;
  db.prepare(
    `INSERT INTO task_worktrees
     (task_id, workdir, base_branch, branch_name, status,
      created_at, last_used_at, diagnostic)
     VALUES (?, ?, ?, ?, 'unavailable', ?, ?, ?)`,
  ).run(taskId, workdir, opts.baseBranch ?? null, branchName, now, now, diagnostic);
  return { status: "unavailable", workdir: null, branchName };
}

/**
 * Read-only lookup. Returns the full row, or null when no row exists
 * for the given taskId. Callers that just need workdir can use
 * `resolveWorktree(db, tid)?.workdir`.
 */
export function resolveWorktree(
  db: DatabaseSync,
  taskId: string,
): WorktreeRow | null {
  const row = db.prepare(
    `SELECT task_id, workdir, base_branch, branch_name, status,
            created_at, last_used_at, diagnostic
       FROM task_worktrees WHERE task_id = ?`,
  ).get(taskId) as
    | {
        task_id: string;
        workdir: string;
        base_branch: string | null;
        branch_name: string;
        status: "active" | "unavailable" | "pruned";
        created_at: number;
        last_used_at: number;
        diagnostic: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    taskId: row.task_id,
    workdir: row.workdir,
    baseBranch: row.base_branch,
    branchName: row.branch_name,
    status: row.status,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    diagnostic: row.diagnostic,
  };
}
