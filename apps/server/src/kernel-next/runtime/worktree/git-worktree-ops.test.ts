// W2 — thin wrappers around `git worktree add/list/remove`.
//
// Integration tests hit real git against a tmp repo; no mocks. Mirrors
// the style of checkpoint/git-commands.test.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  addWorktree,
  listWorktrees,
  removeWorktree,
  gitResetHard,
} from "./git-worktree-ops.js";

const exec = promisify(execFile);

async function initRepo(dir: string): Promise<void> {
  await exec("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@t.t"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "initial\n");
  await exec("git", ["add", "."], { cwd: dir });
  await exec("git", ["commit", "-qm", "init"], { cwd: dir });
}

describe("git-worktree-ops (W2)", () => {
  let repo: string;
  let wtRoot: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "wt-src-"));
    wtRoot = await mkdtemp(join(tmpdir(), "wt-root-"));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  });

  it("addWorktree — creates a new worktree + branch from HEAD", async () => {
    await initRepo(repo);
    const target = join(wtRoot, "task-1");
    const r = await addWorktree(
      { repo, targetDir: target, branchName: "wfc/task/t1" },
      5_000,
    );
    expect(r.ok).toBe(true);
    // Directory exists
    const s = await stat(target);
    expect(s.isDirectory()).toBe(true);
    // README from base branch shows up in the new worktree
    const readmeStat = await stat(join(target, "README.md"));
    expect(readmeStat.isFile()).toBe(true);
    // Branch exists in the source repo
    const b = await exec("git", ["branch", "--list", "wfc/task/t1"], { cwd: repo });
    expect(b.stdout).toContain("wfc/task/t1");
  });

  it("addWorktree — baseBranch override picks a different starting point", async () => {
    await initRepo(repo);
    // Create a feature branch with a distinct commit
    await writeFile(join(repo, "feature.txt"), "feature\n");
    await exec("git", ["checkout", "-qb", "feature"], { cwd: repo });
    await exec("git", ["add", "."], { cwd: repo });
    await exec("git", ["commit", "-qm", "add feature"], { cwd: repo });
    await exec("git", ["checkout", "-q", "main"], { cwd: repo });

    const target = join(wtRoot, "task-2");
    const r = await addWorktree(
      { repo, targetDir: target, branchName: "wfc/task/t2", baseBranch: "feature" },
      5_000,
    );
    expect(r.ok).toBe(true);
    const featureStat = await stat(join(target, "feature.txt"));
    expect(featureStat.isFile()).toBe(true);
  });

  it("addWorktree — non-git repo returns ok=false with diagnostic", async () => {
    const target = join(wtRoot, "task-x");
    const r = await addWorktree(
      { repo, targetDir: target, branchName: "wfc/task/x" },
      5_000,
    );
    expect(r.ok).toBe(false);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  it("addWorktree — existing non-empty targetDir returns ok=false (git refuses to overwrite)", async () => {
    await initRepo(repo);
    const target = join(wtRoot, "task-3");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "stray.txt"), "stray\n");

    const r = await addWorktree(
      { repo, targetDir: target, branchName: "wfc/task/t3" },
      5_000,
    );
    expect(r.ok).toBe(false);
  });

  it("listWorktrees — reports the source repo + every added worktree", async () => {
    await initRepo(repo);
    const a = join(wtRoot, "ta");
    const b = join(wtRoot, "tb");
    await addWorktree({ repo, targetDir: a, branchName: "wfc/task/a" }, 5_000);
    await addWorktree({ repo, targetDir: b, branchName: "wfc/task/b" }, 5_000);

    const list = await listWorktrees(repo, 5_000);
    expect(list.ok).toBe(true);
    // listWorktrees returns absolute paths; both of our targets must appear
    // alongside the source repo itself.
    const paths = list.entries.map((e) => e.path);
    // macOS mkdtemp may prefix /private — normalise via endsWith
    expect(paths.some((p) => p.endsWith("/ta"))).toBe(true);
    expect(paths.some((p) => p.endsWith("/tb"))).toBe(true);
  });

  it("removeWorktree — git forgets the worktree + filesystem cleaned", async () => {
    await initRepo(repo);
    const target = join(wtRoot, "ta");
    await addWorktree({ repo, targetDir: target, branchName: "wfc/task/a" }, 5_000);
    const r = await removeWorktree({ repo, targetDir: target, force: true }, 5_000);
    expect(r.ok).toBe(true);
    // Directory gone
    await expect(stat(target)).rejects.toThrow();
    // Branch still exists (removeWorktree doesn't touch branches)
    const b = await exec("git", ["branch", "--list", "wfc/task/a"], { cwd: repo });
    expect(b.stdout).toContain("wfc/task/a");
  });

  it("removeWorktree — non-existent target returns ok=false (idempotence left to caller)", async () => {
    await initRepo(repo);
    const r = await removeWorktree(
      { repo, targetDir: join(wtRoot, "ghost"), force: true },
      5_000,
    );
    expect(r.ok).toBe(false);
  });

  it("gitResetHard — rewinds HEAD + wipes tracked modifications inside the worktree", async () => {
    await initRepo(repo);
    const target = join(wtRoot, "reset-task");
    const r1 = await addWorktree(
      { repo, targetDir: target, branchName: "wfc/task/reset" },
      5_000,
    );
    expect(r1.ok).toBe(true);

    // Capture initial SHA inside the worktree.
    const before = await exec("git", ["rev-parse", "HEAD"], { cwd: target });
    const beforeSha = before.stdout.trim();

    // Simulate the agent making changes + a new commit on the worktree branch.
    await writeFile(join(target, "README.md"), "mutated by agent\n");
    await exec("git", ["add", "."], { cwd: target });
    await exec("git", ["commit", "-qm", "agent work"], { cwd: target });

    const mid = await exec("git", ["rev-parse", "HEAD"], { cwd: target });
    expect(mid.stdout.trim()).not.toBe(beforeSha);

    // Reset back to the captured SHA.
    const r2 = await gitResetHard(target, beforeSha, 5_000);
    expect(r2.ok).toBe(true);
    const after = await exec("git", ["rev-parse", "HEAD"], { cwd: target });
    expect(after.stdout.trim()).toBe(beforeSha);
    // README contents restored
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(join(target, "README.md"), "utf-8");
    expect(content).toBe("initial\n");
  });

  it("gitResetHard — unknown SHA returns ok=false (caller logs + skips reset)", async () => {
    await initRepo(repo);
    const target = join(wtRoot, "reset-bad");
    await addWorktree(
      { repo, targetDir: target, branchName: "wfc/task/reset-bad" },
      5_000,
    );
    const r = await gitResetHard(target, "deadbeefdeadbeef", 5_000);
    expect(r.ok).toBe(false);
  });
});
