import { spawn } from "node:child_process";

export interface SpawnResult {
  stdout: string;
  stderr: string;
  combined: string;
  exitCode: number;
  timedOut: boolean;
}

// Grace period after kill signals before force-resolving the promise.
// Handles the case where the process ignores signals or exit event never fires.
const KILL_GRACE_MS = 3_000;

/**
 * Spawn a child process with reliable timeout and process-tree kill.
 *
 * Kill strategy (layered):
 * 1. SIGKILL to the process group (-pid) — kills all descendants in the same group
 * 2. SIGKILL directly to the child — fallback if child changed its own PGID
 * 3. Force-resolve after KILL_GRACE_MS — fallback if exit event never fires
 *    (e.g. child is zombie or inherited pipe FDs are still open)
 */
export async function spawnWithTimeout(
  cmd: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    maxOutputBytes?: number;
  },
): Promise<SpawnResult> {
  const maxBytes = options.maxOutputBytes ?? 5 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    let timedOut = false;
    let settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer !== null) clearTimeout(forceTimer);
      resolve({
        stdout: stdoutBuf,
        stderr: stderrBuf,
        combined: (stdoutBuf + stderrBuf).trim(),
        exitCode,
        timedOut,
      });
    };

    const killAll = () => {
      // Layer 1: kill entire process group
      if (child.pid != null) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* PGID may have changed */ }
      }
      // Layer 2: kill direct child (fallback if it moved to a different PGID)
      try { child.kill("SIGKILL"); } catch { /* already dead */ }

      // Layer 3: force-resolve after grace period — handles zombie/stuck exit events
      forceTimer = setTimeout(() => settle(1), KILL_GRACE_MS);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killAll();
    }, options.timeoutMs);

    child.stdout!.on("data", (chunk: Buffer) => {
      if (stdoutBuf.length < maxBytes) {
        const str = chunk.toString();
        const remaining = maxBytes - stdoutBuf.length;
        stdoutBuf += remaining >= str.length ? str : str.slice(0, remaining);
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderrBuf.length < maxBytes) {
        const str = chunk.toString();
        const remaining = maxBytes - stderrBuf.length;
        stderrBuf += remaining >= str.length ? str : str.slice(0, remaining);
      }
    });

    child.on("exit", () => settle(child.exitCode ?? 1));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer !== null) clearTimeout(forceTimer);
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      reject(err);
    });
  });
}
