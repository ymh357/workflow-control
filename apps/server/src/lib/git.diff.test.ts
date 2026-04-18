// Phase 1 / Step 1.4 — real-git integration tests for resolveHeadRef() and
// captureStageDiff(). Uses temp repos with `execSync("git init")` rather
// than mocks because we're validating the diff composition and truncation
// logic end-to-end.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  resolveHeadRef,
  captureStageDiff,
  WORKTREE_DIFF_MAX_BYTES,
} from "./git.js";

function makeTempRepo(): string {
  const dir = join(
    tmpdir(),
    `exec-record-diff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  execSync(
    "git init -q && git config user.email t@t && git config user.name t && git commit --allow-empty -m init -q",
    { cwd: dir, stdio: "pipe" },
  );
  return dir;
}

describe("resolveHeadRef", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = makeTempRepo();
  });

  afterEach(() => {
    try {
      rmSync(repoDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("returns the current 40-char SHA", async () => {
    const head = await resolveHeadRef(repoDir);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns null for a non-existent worktree", async () => {
    const head = await resolveHeadRef(`/tmp/does-not-exist-${Date.now()}`);
    expect(head).toBeNull();
  });

  it("returns null for a directory that is not a git repo", async () => {
    const nonGit = join(tmpdir(), `non-git-${Date.now()}`);
    mkdirSync(nonGit, { recursive: true });
    try {
      const head = await resolveHeadRef(nonGit);
      expect(head).toBeNull();
    } finally {
      try {
        rmSync(nonGit, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });
});

describe("captureStageDiff", () => {
  let repoDir: string;
  let baseRef: string;

  beforeEach(() => {
    repoDir = makeTempRepo();
    baseRef = execSync("git rev-parse HEAD", {
      cwd: repoDir,
      stdio: "pipe",
    })
      .toString()
      .trim();
  });

  afterEach(() => {
    try {
      rmSync(repoDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("returns null when baseRef is null", async () => {
    const result = await captureStageDiff(repoDir, null);
    expect(result).toBeNull();
  });

  it("returns empty non-truncated text when nothing changed", async () => {
    const result = await captureStageDiff(repoDir, baseRef);
    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(false);
    expect(result!.text).toBe("");
  });

  it("captures committed changes between baseRef and HEAD", async () => {
    writeFileSync(join(repoDir, "a.txt"), "hello\n");
    execSync('git add . && git commit -m "add a" -q', {
      cwd: repoDir,
      stdio: "pipe",
    });
    const result = await captureStageDiff(repoDir, baseRef);
    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(false);
    expect(result!.text).toContain("a.txt");
    expect(result!.text).toContain("+hello");
  });

  it("captures uncommitted changes that were never committed", async () => {
    writeFileSync(join(repoDir, "pending.txt"), "draft\n");
    execSync("git add pending.txt", { cwd: repoDir, stdio: "pipe" });
    // Staged but not committed -> working-tree diff against HEAD picks it up
    const result = await captureStageDiff(repoDir, baseRef);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("pending.txt");
    expect(result!.text).toContain("+draft");
  });

  it("captures both committed + uncommitted in one blob", async () => {
    writeFileSync(join(repoDir, "committed.txt"), "c\n");
    execSync('git add . && git commit -m "c" -q', {
      cwd: repoDir,
      stdio: "pipe",
    });
    writeFileSync(join(repoDir, "dirty.txt"), "d\n");
    execSync("git add dirty.txt", { cwd: repoDir, stdio: "pipe" });

    const result = await captureStageDiff(repoDir, baseRef);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("committed.txt");
    expect(result!.text).toContain("dirty.txt");
  });

  it("truncates to maxBytes and sets the flag", async () => {
    // Write a large file whose diff will exceed a 200-byte cap.
    writeFileSync(join(repoDir, "big.txt"), "x".repeat(2000));
    execSync('git add . && git commit -m "big" -q', {
      cwd: repoDir,
      stdio: "pipe",
    });
    const result = await captureStageDiff(repoDir, baseRef, { maxBytes: 200 });
    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(true);
    expect(result!.text.endsWith("\n[truncated]\n")).toBe(true);
    expect(result!.text.length).toBeLessThanOrEqual(200);
  });

  it("returns null for a non-git directory (git invocation fails)", async () => {
    const nonGit = join(tmpdir(), `non-git-diff-${Date.now()}`);
    mkdirSync(nonGit, { recursive: true });
    try {
      const result = await captureStageDiff(nonGit, baseRef);
      expect(result).toBeNull();
    } finally {
      try {
        rmSync(nonGit, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  it("WORKTREE_DIFF_MAX_BYTES is 1 MiB per design §3", () => {
    expect(WORKTREE_DIFF_MAX_BYTES).toBe(1 * 1024 * 1024);
  });
});
