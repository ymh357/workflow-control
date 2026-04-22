// W4 — startPipelineRun integrates the worktree ownership contract.
//
// New input shape:
//   worktreeSourceRepo? : string   -- when set, allocate a worktree for the task
//   worktreeRoot?       : string   -- defaults to {data_dir}/worktrees
//   baseBranch?         : string   -- passed to allocateWorktree
//
// When worktreeSourceRepo is omitted: behaviour unchanged. Existing
// tests / callers don't need to opt in.
//
// When set and allocation succeeds → checkpointConfig.workdir is the
// allocated dir (unless caller passed an explicit checkpointConfig
// that should win).
//
// When set but allocation is unavailable → checkpointConfig.enabled
// gets forced to false so checkpoint captures don't fire against the
// wrong cwd.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { startPipelineRun } from "./start-pipeline-run.js";
import { taskRegistry } from "./task-registry.js";
import { resolveWorktree } from "./worktree/allocator.js";

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

async function waitUntilTaskDone(
  db: DatabaseSync, taskId: string, timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const running = db.prepare(
      `SELECT 1 FROM stage_attempts WHERE task_id = ? AND status = 'running' LIMIT 1`,
    ).get(taskId);
    const reg = taskRegistry.get(taskId);
    if (!running && !reg) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout: task ${taskId} never settled`);
}

describe("startPipelineRun + worktree (W4)", () => {
  let repo: string;
  let wtRoot: string;
  beforeEach(async () => {
    taskRegistry.__clearForTest();
    repo = await mkdtemp(join(tmpdir(), "sr-src-"));
    wtRoot = await mkdtemp(join(tmpdir(), "sr-root-"));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  });

  it("allocates an active worktree and records it in task_worktrees", async () => {
    const db = makeDb();
    try {
      await initRepo(repo);
      const r = await startPipelineRun({
        db, broadcaster: { publish: () => {} } as never,
        name: "diamond",
        taskId: "t-wt-1",
        worktreeSourceRepo: repo,
        worktreeRoot: wtRoot,
      });
      if (!r.ok) throw new Error("start: " + JSON.stringify(r));
      await waitUntilTaskDone(db, "t-wt-1", 3000);
      const row = resolveWorktree(db, "t-wt-1");
      expect(row).not.toBeNull();
      expect(row!.status).toBe("active");
      expect(row!.workdir).toBe(join(wtRoot, "t-wt-1"));
    } finally {
      db.close();
    }
  });

  it("falls back to unavailable when worktreeSourceRepo is not a git repo", async () => {
    const db = makeDb();
    try {
      // repo is a plain tmpdir — no git init.
      const r = await startPipelineRun({
        db, broadcaster: { publish: () => {} } as never,
        name: "diamond",
        taskId: "t-wt-bad",
        worktreeSourceRepo: repo,
        worktreeRoot: wtRoot,
      });
      if (!r.ok) throw new Error("start: " + JSON.stringify(r));
      await waitUntilTaskDone(db, "t-wt-bad", 3000);
      const row = resolveWorktree(db, "t-wt-bad");
      expect(row).not.toBeNull();
      expect(row!.status).toBe("unavailable");
      expect(row!.diagnostic).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it("does not allocate when worktreeSourceRepo is omitted (opt-in)", async () => {
    const db = makeDb();
    try {
      const r = await startPipelineRun({
        db, broadcaster: { publish: () => {} } as never,
        name: "diamond",
        taskId: "t-wt-off",
      });
      if (!r.ok) throw new Error("start: " + JSON.stringify(r));
      await waitUntilTaskDone(db, "t-wt-off", 3000);
      const row = resolveWorktree(db, "t-wt-off");
      expect(row).toBeNull();
    } finally {
      db.close();
    }
  });

  it("resume run for same taskId reuses the existing task_worktrees row (idempotent)", async () => {
    const db = makeDb();
    try {
      await initRepo(repo);

      // First run allocates.
      const first = await startPipelineRun({
        db, broadcaster: { publish: () => {} } as never,
        name: "diamond", taskId: "t-wt-resume",
        worktreeSourceRepo: repo, worktreeRoot: wtRoot,
      });
      if (!first.ok) throw new Error("first: " + JSON.stringify(first));
      await waitUntilTaskDone(db, "t-wt-resume", 3000);
      const before = resolveWorktree(db, "t-wt-resume");
      expect(before).not.toBeNull();

      // Second run on the same taskId — simulates migration-driven
      // resume. Should NOT create a second worktree dir; DB row count stays 1.
      const second = await startPipelineRun({
        db, broadcaster: { publish: () => {} } as never,
        name: "diamond", taskId: "t-wt-resume",
        worktreeSourceRepo: repo, worktreeRoot: wtRoot,
        resumeFrom: "B",
      });
      if (!second.ok) throw new Error("second: " + JSON.stringify(second));
      await waitUntilTaskDone(db, "t-wt-resume", 3000);

      const after = resolveWorktree(db, "t-wt-resume");
      expect(after!.workdir).toBe(before!.workdir);

      const count = db.prepare(
        `SELECT COUNT(*) AS n FROM task_worktrees WHERE task_id = ?`,
      ).get("t-wt-resume") as { n: number };
      expect(count.n).toBe(1);
    } finally {
      db.close();
    }
  });
});
