import { execSync } from "node:child_process";

export function getGitHead(worktreePath: string | undefined): string | undefined {
  if (!worktreePath) return undefined;
  try {
    return execSync("git rev-parse HEAD", { cwd: worktreePath, stdio: "pipe" }).toString().trim();
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
  try {
    if (strategy === "git_reset") {
      execSync(`git reset --hard ${gitHead}`, { cwd: worktreePath, stdio: "pipe" });
    } else if (strategy === "git_stash") {
      execSync("git stash", { cwd: worktreePath, stdio: "pipe" });
    } else {
      return { success: false, error: `unknown strategy: ${strategy}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
