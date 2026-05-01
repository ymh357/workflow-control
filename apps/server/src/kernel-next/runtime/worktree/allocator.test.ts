// W3 — allocateWorktree + resolveWorktree.
//
// allocateWorktree:
//   - Creates a task_worktrees row (PK=taskId) and tries to make a
//     git worktree. On git success: status='active'.
//     On git failure or non-git repo: status='unavailable' + diagnostic.
//   - Second call for the same taskId is idempotent: returns the
//     existing row, bumps last_used_at, does NOT touch git.
//
// resolveWorktree:
//   - Returns { workdir, status, branchName } or null when no row.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initKernelNextSchema } from "../../ir/sql.js";
import { allocateWorktree, resolveWorktree } from "./allocator.js";

const exec = promisify(execFile);

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

async function initRepo(dir: string): Promise<void> {
  await exec("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@t.t"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "initial\n");
  await exec("git", ["add", "."], { cwd: dir });
  await exec("git", ["commit", "-qm", "init"], { cwd: dir });
}

describe("allocator + resolver (W3)", () => {
  let repo: string;
  let wtRoot: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "alloc-src-"));
    wtRoot = await mkdtemp(join(tmpdir(), "alloc-root-"));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  });

  it("happy path — creates active row + real worktree directory", async () => {
    const db = makeDb();
    try {
      await initRepo(repo);
      const r = await allocateWorktree(db, "t1", {
        repo, worktreeRoot: wtRoot,
      });
      expect(r.status).toBe("active");
      expect(r.workdir).toBe(join(wtRoot, "t1"));
      expect(r.branchName).toBe("wfc/task/t1");
      if (r.workdir === null) throw new Error("unreachable: active but null workdir");
      // On-disk dir exists
      const s = await stat(r.workdir);
      expect(s.isDirectory()).toBe(true);
      // DB row
      const row = db.prepare(
        `SELECT task_id, status, workdir, branch_name FROM task_worktrees WHERE task_id = ?`,
      ).get("t1") as { task_id: string; status: string; workdir: string; branch_name: string };
      expect(row.status).toBe("active");
      expect(row.workdir).toBe(join(wtRoot, "t1"));
      expect(row.branch_name).toBe("wfc/task/t1");
    } finally {
      db.close();
    }
  });

  it("non-git repo → unavailable row + null workdir, does NOT throw", async () => {
    const db = makeDb();
    try {
      const r = await allocateWorktree(db, "t-bad", {
        repo, worktreeRoot: wtRoot,   // repo is just a tmpdir, no git init
      });
      expect(r.status).toBe("unavailable");
      expect(r.workdir).toBeNull();
      const row = db.prepare(
        `SELECT status, diagnostic FROM task_worktrees WHERE task_id = ?`,
      ).get("t-bad") as { status: string; diagnostic: string | null };
      expect(row.status).toBe("unavailable");
      expect(row.diagnostic).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it("second allocate for same taskId is idempotent (no new worktree)", async () => {
    const db = makeDb();
    try {
      await initRepo(repo);
      const first = await allocateWorktree(db, "t2", {
        repo, worktreeRoot: wtRoot,
      });
      expect(first.status).toBe("active");
      const firstLastUsed = db.prepare(
        `SELECT last_used_at FROM task_worktrees WHERE task_id = ?`,
      ).get("t2") as { last_used_at: number };

      // Small sleep so last_used_at bumps are observable.
      await new Promise((res) => setTimeout(res, 10));

      const second = await allocateWorktree(db, "t2", {
        repo, worktreeRoot: wtRoot,
      });
      expect(second.status).toBe("active");
      expect(second.workdir).toBe(first.workdir);
      // last_used_at bumped
      const secondLastUsed = db.prepare(
        `SELECT last_used_at FROM task_worktrees WHERE task_id = ?`,
      ).get("t2") as { last_used_at: number };
      expect(secondLastUsed.last_used_at).toBeGreaterThanOrEqual(firstLastUsed.last_used_at);
      // Still only one DB row
      const count = db.prepare(
        `SELECT COUNT(*) AS n FROM task_worktrees WHERE task_id = ?`,
      ).get("t2") as { n: number };
      expect(count.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("baseBranch option is passed through to git worktree add", async () => {
    const db = makeDb();
    try {
      await initRepo(repo);
      await writeFile(join(repo, "feature.txt"), "feature\n");
      await exec("git", ["checkout", "-qb", "feature"], { cwd: repo });
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-qm", "feature"], { cwd: repo });
      await exec("git", ["checkout", "-q", "main"], { cwd: repo });

      const r = await allocateWorktree(db, "t-feat", {
        repo, worktreeRoot: wtRoot, baseBranch: "feature",
      });
      expect(r.status).toBe("active");
      // feature.txt visible in the new worktree
      const featureStat = await stat(join(r.workdir!, "feature.txt"));
      expect(featureStat.isFile()).toBe(true);
      const row = db.prepare(
        `SELECT base_branch FROM task_worktrees WHERE task_id = ?`,
      ).get("t-feat") as { base_branch: string | null };
      expect(row.base_branch).toBe("feature");
    } finally {
      db.close();
    }
  });

  it("resolveWorktree — returns stored row, null when missing", async () => {
    const db = makeDb();
    try {
      await initRepo(repo);
      await allocateWorktree(db, "t3", { repo, worktreeRoot: wtRoot });
      const r = resolveWorktree(db, "t3");
      expect(r).not.toBeNull();
      expect(r!.status).toBe("active");
      expect(r!.workdir).toBe(join(wtRoot, "t3"));
      expect(r!.branchName).toBe("wfc/task/t3");

      const ghost = resolveWorktree(db, "ghost");
      expect(ghost).toBeNull();
    } finally {
      db.close();
    }
  });

  // Bug 59 (c12+ review Wave 2 T3): when a kernel crashed between
  // `git worktree add` succeeding and the task_worktrees INSERT, the
  // disk worktree existed and git knew about it, but the DB row was
  // missing. Pre-fix the next allocateWorktree call hit
  // `fatal: '...' already exists` and recorded status='unavailable'.
  // Post-fix the allocator probes `git worktree list` first and
  // adopts a pre-existing worktree at the expected path.
  it("Bug 59: adopts a pre-existing on-disk worktree when DB row was lost", async () => {
    const db = makeDb();
    try {
      await initRepo(repo);
      // First allocation creates worktree + DB row.
      const r1 = await allocateWorktree(db, "t-resurrect", {
        repo, worktreeRoot: wtRoot,
      });
      expect(r1.status).toBe("active");

      // Simulate the kernel-crashed-after-git-success scenario: drop
      // the DB row but leave the on-disk worktree intact.
      db.prepare(`DELETE FROM task_worktrees WHERE task_id = ?`).run("t-resurrect");

      const r2 = await allocateWorktree(db, "t-resurrect", {
        repo, worktreeRoot: wtRoot,
      });
      // Post-fix: adoption succeeds — status active, DB row reinstated.
      expect(r2.status).toBe("active");
      expect(r2.workdir).toBe(join(wtRoot, "t-resurrect"));
      const row = db.prepare(
        `SELECT status FROM task_worktrees WHERE task_id = ?`,
      ).get("t-resurrect") as { status: string } | undefined;
      expect(row?.status).toBe("active");
    } finally {
      db.close();
    }
  });
});
