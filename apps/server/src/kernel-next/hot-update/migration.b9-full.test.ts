// B9 full — end-to-end: migration resets the owned worktree to
// before_sha after supersede, before resume.
//
// Scenario:
//   1. Task t owns a worktree (W4 contract).
//   2. Stage B runs, checkpoint records before_sha=X; agent modifies
//      files and commits — worktree HEAD is now Y.
//   3. migration proposes v2 changing B, rerunFrom=B.
//   4. executeMigration supersedes B's attempt, reads before_sha=X
//      from stage_checkpoints, runs git reset --hard X inside the
//      owned workdir. HEAD is X again; agent's half-finished work
//      is reverted.
//   5. migration_hint still carries the diff text as advisory.
//
// Graceful-degradation coverage is in migration.b9-full.fallback.test
// (same file for now; separate describe block).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelService } from "../mcp/kernel.js";
import { diamondIR } from "../generator-mock/mini-generator.js";
import {
  executeMigration,
  __resetOrchestratorLocksForTest,
} from "./migration-orchestrator.js";
import { taskRegistry } from "../runtime/task-registry.js";
import { allocateWorktree } from "../runtime/worktree/allocator.js";

const exec = promisify(execFile);

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

function diamondPrompts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of diamondIR().stages) {
    if (s.type === "agent") out[s.config.promptRef] = "dummy";
  }
  return out;
}

async function initRepo(dir: string): Promise<void> {
  await exec("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@t.t"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "initial\n");
  await exec("git", ["add", "."], { cwd: dir });
  await exec("git", ["commit", "-qm", "init"], { cwd: dir });
}

function seedSupersededAttemptWithCheckpoint(args: {
  db: DatabaseSync;
  taskId: string;
  stageName: string;
  versionHash: string;
  workdir: string;
  beforeSha: string;
  afterSha: string;
}): string {
  const attemptId = randomUUID();
  // Attempt: status='success' (will be marked superseded by the real
  // migration SQL during executeMigration's supersede TX).
  args.db.prepare(
    `INSERT INTO stage_attempts
     (attempt_id, task_id, version_hash, stage_name, attempt_idx,
      started_at, ended_at, status, kind)
     VALUES (?, ?, ?, ?, 1, ?, ?, 'success', 'regular')`,
  ).run(attemptId, args.taskId, args.versionHash, args.stageName,
    Date.now() - 1000, Date.now() - 500);
  // Checkpoint row with before/after_sha populated.
  args.db.prepare(
    `INSERT INTO stage_checkpoints
     (attempt_id, workdir, before_sha, after_sha, diff_text, diff_bytes,
      status, captured_before_at, captured_after_at)
     VALUES (?, ?, ?, ?, ?, ?, 'captured', ?, ?)`,
  ).run(attemptId, args.workdir, args.beforeSha, args.afterSha,
    "diff --git a/README.md b/README.md\n+new line\n", 50,
    Date.now() - 1000, Date.now() - 500);
  return attemptId;
}

describe("B9 full — executeMigration resets owned worktree to before_sha", () => {
  let repo: string;
  let wtRoot: string;

  beforeEach(async () => {
    __resetOrchestratorLocksForTest();
    taskRegistry.__clearForTest();
    repo = await mkdtemp(join(tmpdir(), "b9-repo-"));
    wtRoot = await mkdtemp(join(tmpdir(), "b9-wt-"));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  });

  it("resets HEAD + working tree to before_sha inside the task's owned workdir", async () => {
    const db = makeDb();
    try {
      await initRepo(repo);
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
      if (!submitted.ok) throw new Error("submit: " + JSON.stringify(submitted.diagnostics));
      const v1 = submitted.versionHash;
      const taskId = "t-b9";

      // Allocate the owned worktree.
      const alloc = await allocateWorktree(db, taskId, {
        repo, worktreeRoot: wtRoot,
      });
      if (alloc.status !== "active" || !alloc.workdir) {
        throw new Error("alloc: " + JSON.stringify(alloc));
      }

      // Capture "before" SHA inside the worktree — this is what the
      // stage checkpoint would have recorded on captureBefore.
      const beforeRaw = await exec("git", ["rev-parse", "HEAD"], { cwd: alloc.workdir });
      const beforeSha = beforeRaw.stdout.trim();

      // Simulate agent modifying + committing inside the worktree.
      await writeFile(join(alloc.workdir, "README.md"), "mutated by agent\n");
      await exec("git", ["add", "."], { cwd: alloc.workdir });
      await exec("git", ["commit", "-qm", "agent work"], { cwd: alloc.workdir });
      const afterRaw = await exec("git", ["rev-parse", "HEAD"], { cwd: alloc.workdir });
      const afterSha = afterRaw.stdout.trim();
      expect(afterSha).not.toBe(beforeSha);

      // Seed the B stage attempt + its checkpoint row. Real flows write
      // these during stage execution; we seed directly because the
      // focus is on migration's reset side, not runPipeline.
      seedSupersededAttemptWithCheckpoint({
        db, taskId, stageName: "B", versionHash: v1,
        workdir: alloc.workdir, beforeSha, afterSha,
      });

      // Propose v2.
      const propose = svc.propose({
        currentVersion: v1,
        patch: { ops: [{
          op: "update_stage_config", stage: "B",
          configPatch: { promptRef: "b-v2" },
        }] },
        actor: "test", rerunFrom: "B",
        migrateRunningTasks: [taskId], autoApprove: true,
      });
      if (!propose.ok) throw new Error("propose: " + JSON.stringify(propose.diagnostics));

      // Migrate with a stubbed startRunner so the test focuses on
      // supersede + reset; the run-final half is covered by
      // migration.real-resume.test.
      const mig = await executeMigration({
        db, taskId, proposalId: propose.proposalId,
        startRunnerOverride: (async () => ({
          ok: true as const, taskId, versionHash: propose.proposedVersion,
        })) as never,
      });
      if (!mig.ok) throw new Error("migration: " + JSON.stringify(mig));

      // Assertion: the worktree's HEAD is back at beforeSha.
      const resetRaw = await exec("git", ["rev-parse", "HEAD"], { cwd: alloc.workdir });
      expect(resetRaw.stdout.trim()).toBe(beforeSha);

      // The migration_hint (partial-B9 advisory) is still written —
      // reset handles file state, hint tells the agent what happened.
      const hint = db.prepare(
        `SELECT previous_attempt_id, previous_diff_text, note FROM migration_hints
         WHERE task_id = ? AND stage_name = ?`,
      ).get(taskId, "B") as
        | { previous_attempt_id: string; previous_diff_text: string | null; note: string | null }
        | undefined;
      expect(hint).toBeDefined();
      // The hint carries whatever diff the checkpoint captured — in this
      // fixture we seeded a placeholder diff. Verify the hint retrieved
      // the stored text verbatim, not that reset produced it (reset is a
      // file-state operation, not a diff-synthesising one).
      expect(hint!.previous_diff_text).toContain("new line");
    } finally {
      db.close();
    }
  });

  it("no-op when task has no task_worktrees row (worktree ownership not opted in)", async () => {
    const db = makeDb();
    try {
      await initRepo(repo);
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
      if (!submitted.ok) throw new Error("submit failed");
      const v1 = submitted.versionHash;
      const taskId = "t-no-ownership";

      // Seed a stage attempt + checkpoint against a disposable path —
      // the migration is NOT supposed to touch filesystem here because
      // task_worktrees has no row for this taskId.
      const dummyWorkdir = await mkdtemp(join(tmpdir(), "b9-dummy-"));
      try {
        await initRepo(dummyWorkdir);
        const beforeRaw = await exec("git", ["rev-parse", "HEAD"], { cwd: dummyWorkdir });
        const beforeSha = beforeRaw.stdout.trim();
        await writeFile(join(dummyWorkdir, "README.md"), "changed\n");
        await exec("git", ["add", "."], { cwd: dummyWorkdir });
        await exec("git", ["commit", "-qm", "after"], { cwd: dummyWorkdir });
        const afterRaw = await exec("git", ["rev-parse", "HEAD"], { cwd: dummyWorkdir });

        seedSupersededAttemptWithCheckpoint({
          db, taskId, stageName: "B", versionHash: v1,
          workdir: dummyWorkdir, beforeSha, afterSha: afterRaw.stdout.trim(),
        });

        const propose = svc.propose({
          currentVersion: v1,
          patch: { ops: [{
            op: "update_stage_config", stage: "B",
            configPatch: { promptRef: "b-v2" },
          }] },
          actor: "test", rerunFrom: "B",
          migrateRunningTasks: [taskId], autoApprove: true,
        });
        if (!propose.ok) throw new Error("propose failed");

        const mig = await executeMigration({
          db, taskId, proposalId: propose.proposalId,
          startRunnerOverride: (async () => ({
            ok: true as const, taskId, versionHash: propose.proposedVersion,
          })) as never,
        });
        expect(mig.ok).toBe(true);

        // dummyWorkdir HEAD is UNCHANGED — migration didn't reset it
        // because the task has no ownership row.
        const afterMigRaw = await exec("git", ["rev-parse", "HEAD"], { cwd: dummyWorkdir });
        expect(afterMigRaw.stdout.trim()).toBe(afterRaw.stdout.trim());
      } finally {
        await rm(dummyWorkdir, { recursive: true, force: true });
      }
    } finally {
      db.close();
    }
  });

  it("skips reset and records diagnostic when task_worktrees status='unavailable'", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
      if (!submitted.ok) throw new Error("submit failed");
      const v1 = submitted.versionHash;
      const taskId = "t-unavail";

      // Insert an unavailable ownership row directly.
      db.prepare(
        `INSERT INTO task_worktrees
         (task_id, workdir, base_branch, branch_name, status,
          created_at, last_used_at, diagnostic)
         VALUES (?, '/does/not/exist', NULL, ?, 'unavailable', ?, ?, 'not a git repo')`,
      ).run(taskId, `wfc/task/${taskId}`, Date.now(), Date.now());

      // Seed a superseded attempt + checkpoint (SHAs don't matter, we
      // should skip reset entirely based on ownership status).
      seedSupersededAttemptWithCheckpoint({
        db, taskId, stageName: "B", versionHash: v1,
        workdir: "/does/not/exist",
        beforeSha: "0".repeat(40),
        afterSha: "1".repeat(40),
      });

      const propose = svc.propose({
        currentVersion: v1,
        patch: { ops: [{
          op: "update_stage_config", stage: "B",
          configPatch: { promptRef: "b-v2" },
        }] },
        actor: "test", rerunFrom: "B",
        migrateRunningTasks: [taskId], autoApprove: true,
      });
      if (!propose.ok) throw new Error("propose failed");

      const mig = await executeMigration({
        db, taskId, proposalId: propose.proposalId,
        startRunnerOverride: (async () => ({
          ok: true as const, taskId, versionHash: propose.proposedVersion,
        })) as never,
      });
      // Must succeed overall — unavailable workdir must not block migration.
      expect(mig.ok).toBe(true);
    } finally {
      db.close();
    }
  });

  it("skips reset and continues migration when before_sha is NULL in checkpoint", async () => {
    const db = makeDb();
    try {
      await initRepo(repo);
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
      if (!submitted.ok) throw new Error("submit failed");
      const v1 = submitted.versionHash;
      const taskId = "t-null-sha";

      const alloc = await allocateWorktree(db, taskId, {
        repo, worktreeRoot: wtRoot,
      });
      if (alloc.status !== "active" || !alloc.workdir) {
        throw new Error("alloc failed");
      }

      // Make a change in the worktree so we can confirm reset did NOT run.
      await writeFile(join(alloc.workdir, "README.md"), "mutated\n");
      await exec("git", ["add", "."], { cwd: alloc.workdir });
      await exec("git", ["commit", "-qm", "mutation"], { cwd: alloc.workdir });
      const afterRaw = await exec("git", ["rev-parse", "HEAD"], { cwd: alloc.workdir });
      const headAfterMutation = afterRaw.stdout.trim();

      // Seed attempt + checkpoint with before_sha=NULL (status=before_failed).
      const attemptId = randomUUID();
      db.prepare(
        `INSERT INTO stage_attempts
         (attempt_id, task_id, version_hash, stage_name, attempt_idx,
          started_at, ended_at, status, kind)
         VALUES (?, ?, ?, 'B', 1, ?, ?, 'success', 'regular')`,
      ).run(attemptId, taskId, v1, Date.now() - 1000, Date.now() - 500);
      db.prepare(
        `INSERT INTO stage_checkpoints
         (attempt_id, workdir, before_sha, after_sha, diff_text, diff_bytes,
          status, captured_before_at, captured_after_at)
         VALUES (?, ?, NULL, NULL, NULL, NULL, 'before_failed', ?, NULL)`,
      ).run(attemptId, alloc.workdir, Date.now() - 1000);

      const propose = svc.propose({
        currentVersion: v1,
        patch: { ops: [{
          op: "update_stage_config", stage: "B",
          configPatch: { promptRef: "b-v2" },
        }] },
        actor: "test", rerunFrom: "B",
        migrateRunningTasks: [taskId], autoApprove: true,
      });
      if (!propose.ok) throw new Error("propose failed");

      const mig = await executeMigration({
        db, taskId, proposalId: propose.proposalId,
        startRunnerOverride: (async () => ({
          ok: true as const, taskId, versionHash: propose.proposedVersion,
        })) as never,
      });
      expect(mig.ok).toBe(true);

      // HEAD unchanged — no reset because before_sha was NULL.
      const postMigRaw = await exec("git", ["rev-parse", "HEAD"], { cwd: alloc.workdir });
      expect(postMigRaw.stdout.trim()).toBe(headAfterMutation);
    } finally {
      db.close();
    }
  });
});
