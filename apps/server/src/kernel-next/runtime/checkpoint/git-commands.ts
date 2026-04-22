// Minimal, structured wrappers around git subcommands used by the
// checkpoint module. None throw — failure always surfaces as ok=false
// on GitResult. All respect per-call timeouts via spawnWithTimeout.
//
// snapshotWorkTree uses a scratch GIT_INDEX_FILE to build a dangling
// commit that includes the full working tree (tracked modifications
// + untracked files, minus .gitignore'd paths) without mutating the
// caller's index, refs, or working tree.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnWithTimeout } from "../../../lib/spawn-utils.js";
import type { GitResult } from "./types.js";

const EXTRA_PATH = "/opt/homebrew/bin:/usr/local/bin";

function buildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${process.env.PATH ?? ""}:${EXTRA_PATH}`,
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    ...extra,
  };
}

async function run(
  args: string[],
  cwd: string,
  timeoutMs: number,
  envExtra: Record<string, string> = {},
): Promise<GitResult> {
  try {
    const r = await spawnWithTimeout("git", args, {
      cwd,
      timeoutMs,
      env: buildEnv(envExtra),
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

export async function isGitRepo(cwd: string, timeoutMs: number): Promise<boolean> {
  const r = await run(["rev-parse", "--is-inside-work-tree"], cwd, timeoutMs);
  return r.ok && r.stdout.trim() === "true";
}

export async function gitRevParseHead(
  cwd: string,
  timeoutMs: number,
): Promise<GitResult> {
  return run(["rev-parse", "HEAD"], cwd, timeoutMs);
}

/**
 * Capture working-tree state (tracked + untracked, honouring
 * .gitignore) as a dangling commit SHA on stdout. Does not mutate
 * .git/index, any ref, or the working tree.
 *
 * Uses a temporary GIT_INDEX_FILE so the 4 sub-steps do not touch
 * the runtime's .git/index. Cleans up the scratch index even on
 * partial failure.
 *
 * Returns ok=false if HEAD is unavailable (repo with zero commits),
 * if any sub-step fails, or if the overall timeout is hit.
 */
export async function snapshotWorkTree(
  cwd: string,
  timeoutMs: number,
): Promise<GitResult> {
  const deadline = Date.now() + timeoutMs;
  const remaining = (): number => Math.max(0, deadline - Date.now());

  let scratchDir: string | null = null;
  try {
    scratchDir = await mkdtemp(join(tmpdir(), "wfc-cp-idx-"));
    const indexFile = join(scratchDir, "index");
    const env = { GIT_INDEX_FILE: indexFile };

    const readTree = await run(["read-tree", "HEAD"], cwd, remaining(), env);
    if (!readTree.ok) return readTree;

    const addAll = await run(["add", "-A"], cwd, remaining(), env);
    if (!addAll.ok) return addAll;

    const writeTree = await run(["write-tree"], cwd, remaining(), env);
    if (!writeTree.ok) return writeTree;
    const treeSha = writeTree.stdout.trim();
    if (!/^[a-f0-9]{40}$/.test(treeSha)) {
      return {
        ok: false,
        stdout: "",
        stderr: `write-tree returned unexpected output: ${treeSha}`,
        exitCode: -1,
        timedOut: false,
      };
    }

    // Clean-tree short-circuit: if the scratch tree equals HEAD^{tree}
    // the working tree has no tracked modifications AND no new
    // untracked-non-ignored files. Returning a fresh commit-tree here
    // would produce a new SHA every call (author/committer timestamps
    // change), causing non-determinism downstream. Signal "no change"
    // to the caller by returning ok=true with empty stdout — callers
    // (resolveSha) already fall back to `rev-parse HEAD` in that case.
    const headTree = await run(["rev-parse", "HEAD^{tree}"], cwd, remaining());
    if (headTree.ok && headTree.stdout.trim() === treeSha) {
      return {
        ok: true,
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    }

    // commit-tree does not need the scratch index; use default env.
    return run(
      ["commit-tree", treeSha, "-p", "HEAD", "-m", "wfc-checkpoint"],
      cwd,
      remaining(),
    );
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: -1,
      timedOut: false,
    };
  } finally {
    if (scratchDir) {
      await rm(scratchDir, { recursive: true, force: true }).catch(() => {
        // scratch cleanup failure is not the caller's problem
      });
    }
  }
}

export async function gitDiff(
  cwd: string,
  from: string,
  to: string,
  timeoutMs: number,
): Promise<GitResult> {
  return run(["diff", "--no-color", from, to], cwd, timeoutMs);
}
