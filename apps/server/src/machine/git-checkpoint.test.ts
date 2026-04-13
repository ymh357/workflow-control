import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { getGitHead, runCompensation } from "./git-checkpoint.js";

describe("getGitHead", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `git-cp-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(testDir, { recursive: true });
    execSync("git init && git commit --allow-empty -m init", { cwd: testDir, stdio: "pipe" });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("returns 40-char git SHA for valid repo", () => {
    const head = getGitHead(testDir);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns undefined for non-existent path", () => {
    expect(getGitHead("/tmp/does-not-exist-" + Date.now())).toBeUndefined();
  });

  it("returns undefined for non-git directory", () => {
    const nonGit = join(tmpdir(), `non-git-${Date.now()}`);
    mkdirSync(nonGit, { recursive: true });
    expect(getGitHead(nonGit)).toBeUndefined();
    try { rmSync(nonGit, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("returns undefined when path is undefined", () => {
    expect(getGitHead(undefined)).toBeUndefined();
  });
});

describe("runCompensation", () => {
  let testDir: string;
  let initialHead: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `git-comp-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(testDir, { recursive: true });
    execSync("git init && git commit --allow-empty -m init", { cwd: testDir, stdio: "pipe" });
    initialHead = execSync("git rev-parse HEAD", { cwd: testDir, stdio: "pipe" }).toString().trim();
    execSync("git commit --allow-empty -m second", { cwd: testDir, stdio: "pipe" });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("git_reset restores to specified commit", () => {
    const result = runCompensation("git_reset", initialHead, testDir);
    expect(result.success).toBe(true);
    const currentHead = execSync("git rev-parse HEAD", { cwd: testDir, stdio: "pipe" }).toString().trim();
    expect(currentHead).toBe(initialHead);
  });

  it("git_stash succeeds without error", () => {
    const result = runCompensation("git_stash", initialHead, testDir);
    expect(result.success).toBe(true);
  });

  it("returns error for missing worktreePath", () => {
    const result = runCompensation("git_reset", initialHead, undefined);
    expect(result.success).toBe(false);
  });

  it("returns error for missing gitHead", () => {
    const result = runCompensation("git_reset", undefined, testDir);
    expect(result.success).toBe(false);
  });

  it("returns error for unknown strategy", () => {
    const result = runCompensation("unknown", initialHead, testDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain("unknown strategy");
  });
});
