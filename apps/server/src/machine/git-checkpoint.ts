import { execFileSync } from "node:child_process";

export function getGitHead(worktreePath: string | undefined): string | undefined {
  if (!worktreePath) return undefined;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, stdio: "pipe", timeout: 5000 }).toString().trim();
  } catch {
    return undefined;
  }
}

export function runCompensation(
  strategy: string,
  gitHead: string | undefined,
  worktreePath: string | undefined,
): { success: boolean; error?: string } {
  if (!worktreePath || !gitHead) return { success: false, error: "missing worktreePath or gitHead" };
  // Validate gitHead is a valid hex SHA to prevent injection
  if (!/^[0-9a-f]{40}$/i.test(gitHead)) {
    return { success: false, error: `invalid git SHA format: ${gitHead.slice(0, 20)}` };
  }
  try {
    if (strategy === "git_reset") {
      execFileSync("git", ["reset", "--hard", gitHead], { cwd: worktreePath, stdio: "pipe", timeout: 5000 });
    } else if (strategy === "git_stash") {
      execFileSync("git", ["stash"], { cwd: worktreePath, stdio: "pipe", timeout: 5000 });
    } else {
      return { success: false, error: `unknown strategy: ${strategy}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
