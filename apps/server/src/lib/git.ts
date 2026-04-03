import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { logger } from "./logger.js";
import { loadSystemSettings } from "./config-loader.js";
import { spawnWithTimeout } from "./spawn-utils.js";

const exec = promisify(execFile);

const EXTRA_PATH = process.env.EXTRA_PATH || "/opt/homebrew/bin:/usr/local/bin";
const GIT_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;

export async function createWorktree(
  repoPath: string,
  branch: string,
  worktreesBase: string,
): Promise<string> {
  await mkdir(worktreesBase, { recursive: true });
  const worktreePath = join(worktreesBase, branch.replace(/\//g, "-"));

  await exec("git", ["worktree", "add", "-b", branch, worktreePath], {
    cwd: repoPath,
    env: { ...process.env, PATH: `${process.env.PATH}:${EXTRA_PATH}` },
    timeout: GIT_TIMEOUT_MS,
  });

  return worktreePath;
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
): Promise<void> {
  await exec("git", ["worktree", "remove", worktreePath, "--force"], {
    cwd: repoPath,
    env: { ...process.env, PATH: `${process.env.PATH}:${EXTRA_PATH}` },
    timeout: GIT_TIMEOUT_MS,
  });
}

export async function installDepsInWorktree(worktreePath: string): Promise<void> {
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");

  // Detect package manager by lockfile
  let cmd = "npm";
  let args = ["install"];
  if (existsSync(join(worktreePath, "pnpm-lock.yaml"))) {
    cmd = "pnpm";
    args = ["install", "--frozen-lockfile"];
  } else if (existsSync(join(worktreePath, "bun.lockb")) || existsSync(join(worktreePath, "bun.lock"))) {
    cmd = "bun";
    args = ["install", "--frozen-lockfile"];
  } else if (existsSync(join(worktreePath, "yarn.lock"))) {
    cmd = "yarn";
    args = ["install", "--frozen-lockfile"];
  }

  const result = await spawnWithTimeout(cmd, args, {
    cwd: worktreePath,
    env: { ...process.env, PATH: `${process.env.PATH}:${EXTRA_PATH}` },
    timeoutMs: INSTALL_TIMEOUT_MS,
    maxOutputBytes: 50 * 1024 * 1024,
  });

  if (result.timedOut) {
    throw new Error(`Dependency installation timed out after ${INSTALL_TIMEOUT_MS / 1000}s`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`Dependency installation failed (exit ${result.exitCode}):\n${result.combined.slice(-2000)}`);
  }
}

export function buildBranchName(pageId: string, slug: string): string {
  const shortId = pageId.replace(/-/g, "").slice(0, 8);
  const safeSlug = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `feature/${shortId}-${safeSlug}`;
}

export function resolveRepoPath(repoName: string): string {
  const settings = loadSystemSettings();
  const reposBase = settings.paths?.repos_base || "";
  if (!reposBase || !repoName) return "";
  const exact = join(reposBase, repoName);
  try { if (statSync(exact).isDirectory()) return exact; } catch { /* */ }
  try {
    const entries = readdirSync(reposBase);
    const ci = entries.find((e) => e.toLowerCase() === repoName.toLowerCase());
    if (ci) { const p = join(reposBase, ci); if (statSync(p).isDirectory()) return p; }
    const partial = entries.find((e) => e.toLowerCase().endsWith(repoName.toLowerCase()));
    if (partial) { const p = join(reposBase, partial); if (statSync(p).isDirectory()) return p; }
  } catch { /* */ }
  logger.info({ repoName, reposBase }, "resolveRepoPath: no match found");
  return "";
}

export async function initRepo(repoName: string): Promise<string> {
  const settings = loadSystemSettings();
  const reposBase = settings.paths?.repos_base || "";
  if (!reposBase) throw new Error("paths.repos_base is not configured");
  const repoPath = join(reposBase, repoName);
  await mkdir(repoPath, { recursive: true });
  await exec("git", ["init"], {
    cwd: repoPath,
    env: { ...process.env, PATH: `${process.env.PATH}:${EXTRA_PATH}` },
    timeout: GIT_TIMEOUT_MS,
  });
  // Create an initial commit so worktree branching works
  await exec("git", ["commit", "--allow-empty", "-m", "Initial commit"], {
    cwd: repoPath,
    env: { ...process.env, PATH: `${process.env.PATH}:${EXTRA_PATH}` },
    timeout: GIT_TIMEOUT_MS,
  });
  logger.info({ repoPath }, "initRepo: new repository initialized");
  return repoPath;
}

// --- Foreach worktree isolation helpers ---

function getGitEnv() {
  return { ...process.env, PATH: `${process.env.PATH}:${EXTRA_PATH}` };
}

export async function createWorktreeFromExisting(
  parentWorktreePath: string,
  branchSuffix: string,
  worktreesBase?: string,
): Promise<{ worktreePath: string; branchName: string; repoRoot: string }> {
  const env = getGitEnv();
  const { stdout: repoRoot } = await exec(
    "git", ["rev-parse", "--show-toplevel"],
    { cwd: parentWorktreePath, env, timeout: GIT_TIMEOUT_MS },
  );

  const { stdout: parentBranch } = await exec(
    "git", ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd: parentWorktreePath, env, timeout: GIT_TIMEOUT_MS },
  );

  const branchName = `${parentBranch.trim()}-${branchSuffix}`;

  const base = worktreesBase ?? join(repoRoot.trim(), "..", "wfc-foreach-worktrees");
  await mkdir(base, { recursive: true });
  const worktreePath = join(base, branchName.replace(/\//g, "-"));

  await exec(
    "git", ["worktree", "add", "-b", branchName, worktreePath, parentBranch.trim()],
    { cwd: parentWorktreePath, env, timeout: GIT_TIMEOUT_MS },
  );

  return { worktreePath, branchName, repoRoot: repoRoot.trim() };
}

export async function commitAll(
  worktreePath: string,
  message: string,
): Promise<boolean> {
  const env = getGitEnv();
  await exec("git", ["add", "-A"], {
    cwd: worktreePath, env, timeout: GIT_TIMEOUT_MS,
  });

  try {
    await exec("git", ["diff", "--cached", "--quiet"], {
      cwd: worktreePath, env, timeout: GIT_TIMEOUT_MS,
    });
    // Exit 0 means no staged changes
    return false;
  } catch {
    // Exit non-zero means there are staged changes — commit them
    await exec("git", ["commit", "-m", message], {
      cwd: worktreePath, env, timeout: GIT_TIMEOUT_MS,
    });
    return true;
  }
}

export async function getDiffStat(
  worktreePath: string,
  baseBranch: string,
): Promise<{ filesChanged: string[]; diffStat: string }> {
  const env = getGitEnv();
  const { stdout: fileList } = await exec(
    "git", ["diff", "--name-only", `${baseBranch}...HEAD`],
    { cwd: worktreePath, env, timeout: GIT_TIMEOUT_MS },
  );
  const filesChanged = fileList.trim().split("\n").filter(Boolean);
  const { stdout: diffStat } = await exec(
    "git", ["diff", "--stat", `${baseBranch}...HEAD`],
    { cwd: worktreePath, env, timeout: GIT_TIMEOUT_MS },
  );
  return { filesChanged, diffStat: diffStat.trim() };
}

export async function cleanupWorktreeOnly(
  repoPath: string,
  worktreePath: string,
): Promise<void> {
  const env = getGitEnv();
  await exec("git", ["worktree", "remove", "--force", worktreePath], {
    cwd: repoPath, env, timeout: GIT_TIMEOUT_MS,
  });
}

