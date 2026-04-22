// W2 — minimal, structured wrappers around `git worktree`.
//
// Mirrors the runtime/checkpoint/git-commands.ts style: never throws,
// failure surfaces as ok=false with stderr populated, per-call timeout
// via spawnWithTimeout.

import { spawnWithTimeout } from "../../../lib/spawn-utils.js";

const EXTRA_PATH = "/opt/homebrew/bin:/usr/local/bin";

function buildEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${process.env.PATH ?? ""}:${EXTRA_PATH}`,
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

export interface GitOpResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

async function run(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<GitOpResult> {
  try {
    const r = await spawnWithTimeout("git", args, {
      cwd, timeoutMs, env: buildEnv(),
    });
    return {
      ok: !r.timedOut && r.exitCode === 0,
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
    };
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: -1,
      timedOut: false,
    };
  }
}

export interface AddWorktreeArgs {
  /** Source git repository. `git worktree add` is run with cwd=repo. */
  repo: string;
  /** Absolute path for the new worktree directory. */
  targetDir: string;
  /** New branch name to create in the source repo. */
  branchName: string;
  /**
   * Starting commit / ref for the new branch. When absent, git uses
   * the current HEAD of the source repo.
   */
  baseBranch?: string;
}

export async function addWorktree(
  args: AddWorktreeArgs,
  timeoutMs: number,
): Promise<GitOpResult> {
  const argv = ["worktree", "add", "-b", args.branchName, args.targetDir];
  if (args.baseBranch) argv.push(args.baseBranch);
  return run(argv, args.repo, timeoutMs);
}

export interface WorktreeEntry {
  path: string;
  head: string | null;  // commit SHA, null when detached & uninitialised
  branch: string | null;
}

export interface ListWorktreesResult extends GitOpResult {
  entries: WorktreeEntry[];
}

/**
 * Parses `git worktree list --porcelain`. Each entry is newline-separated
 * key/value lines terminated by a blank line:
 *
 *   worktree /abs/path
 *   HEAD <sha>
 *   branch refs/heads/<name>
 *
 *   worktree /abs/path2
 *   ...
 */
export async function listWorktrees(
  repo: string,
  timeoutMs: number,
): Promise<ListWorktreesResult> {
  const r = await run(["worktree", "list", "--porcelain"], repo, timeoutMs);
  if (!r.ok) {
    return { ...r, entries: [] };
  }
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> | null = null;
  for (const line of r.stdout.split("\n")) {
    if (line === "") {
      if (current?.path) {
        entries.push({
          path: current.path,
          head: current.head ?? null,
          branch: current.branch ?? null,
        });
      }
      current = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length) };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch ")) {
      // branch refs/heads/<name> → strip prefix
      current.branch = line.slice("branch refs/heads/".length);
    }
  }
  // Trailing entry without final blank line
  if (current?.path) {
    entries.push({
      path: current.path,
      head: current.head ?? null,
      branch: current.branch ?? null,
    });
  }
  return { ...r, entries };
}

export interface RemoveWorktreeArgs {
  repo: string;
  targetDir: string;
  /** When true, passes --force so git removes even with uncommitted changes. */
  force?: boolean;
}

export async function removeWorktree(
  args: RemoveWorktreeArgs,
  timeoutMs: number,
): Promise<GitOpResult> {
  const argv = ["worktree", "remove"];
  if (args.force) argv.push("--force");
  argv.push(args.targetDir);
  return run(argv, args.repo, timeoutMs);
}
