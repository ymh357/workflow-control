import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  isGitRepo,
  gitRevParseHead,
  snapshotWorkTree,
  gitDiff,
} from "./git-commands.js";

const exec = promisify(execFile);

async function initRepo(dir: string) {
  await exec("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@t.t"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "initial\n");
  await exec("git", ["add", "."], { cwd: dir });
  await exec("git", ["commit", "-qm", "init"], { cwd: dir });
}

describe("git-commands", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "checkpoint-git-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("isGitRepo — returns true for initialised repo", async () => {
    await initRepo(dir);
    expect(await isGitRepo(dir, 5_000)).toBe(true);
  });

  it("isGitRepo — returns false for plain tmpdir", async () => {
    expect(await isGitRepo(dir, 5_000)).toBe(false);
  });

  it("isGitRepo — returns false for non-existent path", async () => {
    expect(await isGitRepo(join(dir, "nope"), 5_000)).toBe(false);
  });

  it("gitRevParseHead — returns SHA on HEAD", async () => {
    await initRepo(dir);
    const r = await gitRevParseHead(dir, 5_000);
    expect(r.ok).toBe(true);
    expect(r.stdout.trim()).toMatch(/^[a-f0-9]{40}$/);
  });

  it("gitRevParseHead — ok=false on bare dir (no HEAD)", async () => {
    const r = await gitRevParseHead(dir, 5_000);
    expect(r.ok).toBe(false);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  it("snapshotWorkTree — clean tree produces commit whose tree equals HEAD^{tree}", async () => {
    await initRepo(dir);
    const r = await snapshotWorkTree(dir, 10_000);
    expect(r.ok).toBe(true);
    const commitSha = r.stdout.trim();
    expect(commitSha).toMatch(/^[a-f0-9]{40}$/);
    const snapTree = (await exec("git", ["rev-parse", `${commitSha}^{tree}`], { cwd: dir })).stdout.trim();
    const headTree = (await exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: dir })).stdout.trim();
    expect(snapTree).toBe(headTree);
  });

  it("snapshotWorkTree — SHA on dirty tracked file", async () => {
    await initRepo(dir);
    await writeFile(join(dir, "README.md"), "modified\n");
    const r = await snapshotWorkTree(dir, 10_000);
    expect(r.ok).toBe(true);
    const sha = r.stdout.trim();
    expect(sha).toMatch(/^[a-f0-9]{40}$/);
    const show = await exec("git", ["show", "--stat", sha], { cwd: dir });
    expect(show.stdout).toContain("README.md");
  });

  it("snapshotWorkTree — captures untracked files (.gitignore honoured)", async () => {
    await initRepo(dir);
    await writeFile(join(dir, ".gitignore"), "ignored.txt\n");
    await exec("git", ["add", ".gitignore"], { cwd: dir });
    await exec("git", ["commit", "-qm", "ignore"], { cwd: dir });
    await writeFile(join(dir, "new.txt"), "new\n");
    await writeFile(join(dir, "ignored.txt"), "should not appear\n");
    const r = await snapshotWorkTree(dir, 10_000);
    expect(r.ok).toBe(true);
    const sha = r.stdout.trim();
    const show = await exec("git", ["show", "--stat", sha], { cwd: dir });
    expect(show.stdout).toContain("new.txt");
    expect(show.stdout).not.toContain("ignored.txt");
  });

  it("snapshotWorkTree — does not mutate .git/index", async () => {
    await initRepo(dir);
    await writeFile(join(dir, "staged.txt"), "staged\n");
    await exec("git", ["add", "staged.txt"], { cwd: dir });
    await writeFile(join(dir, "unstaged.txt"), "unstaged\n");
    const statusBefore = (await exec("git", ["status", "--porcelain"], { cwd: dir })).stdout;
    await snapshotWorkTree(dir, 10_000);
    const statusAfter = (await exec("git", ["status", "--porcelain"], { cwd: dir })).stdout;
    expect(statusAfter).toBe(statusBefore);
  });

  it("snapshotWorkTree — ok=false on repo with no HEAD (fresh git init)", async () => {
    await exec("git", ["init", "-q", "-b", "main"], { cwd: dir });
    const r = await snapshotWorkTree(dir, 10_000);
    expect(r.ok).toBe(false);
  });

  it("gitDiff — returns unified diff between two SHAs", async () => {
    await initRepo(dir);
    const before = (await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
    await writeFile(join(dir, "b.txt"), "line\n");
    const afterSnap = await snapshotWorkTree(dir, 10_000);
    const after = afterSnap.stdout.trim();
    const r = await gitDiff(dir, before, after, 10_000);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("b.txt");
    expect(r.stdout).toContain("+line");
  });

  it("gitDiff — ok=false on invalid SHA", async () => {
    await initRepo(dir);
    const r = await gitDiff(dir, "deadbeef", "cafef00d", 10_000);
    expect(r.ok).toBe(false);
  });
});
