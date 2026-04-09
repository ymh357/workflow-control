import { exec } from "node:child_process";
import { promisify } from "node:util";
import { taskLogger } from "../lib/logger.js";
import { sseManager } from "../sse/manager.js";
import type { SSEMessage } from "../types/index.js";

const execAsync = promisify(exec);
const VERIFY_TIMEOUT_MS = 60_000;

const SENSITIVE_ENV_PATTERNS = [/_TOKEN$/, /_SECRET$/, /_KEY$/, /_PASSWORD$/, /^ANTHROPIC_/, /^OPENAI_/];

function filterSensitiveEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const filtered: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!SENSITIVE_ENV_PATTERNS.some(p => p.test(key))) {
      filtered[key] = value;
    }
  }
  return filtered;
}

export interface VerifyResult {
  command: string;
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

function createSSEMessage(taskId: string, type: SSEMessage["type"], data: unknown): SSEMessage {
  return { type, taskId, timestamp: new Date().toISOString(), data };
}

export async function runVerifyCommands(
  taskId: string,
  stageName: string,
  commands: string[],
  cwd?: string,
): Promise<{ allPassed: boolean; results: VerifyResult[] }> {
  const log = taskLogger(taskId, stageName);
  const results: VerifyResult[] = [];

  log.info({ commands, cwd }, "Running verify commands");
  sseManager.pushMessage(taskId, createSSEMessage(taskId, "agent_progress", {
    phase: "verification", commands,
  }));

  for (const command of commands) {
    const start = Date.now();
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout: VERIFY_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: { ...filterSensitiveEnv(process.env), CI: "true", FORCE_COLOR: "0" },
      });
      const durationMs = Date.now() - start;
      results.push({ command, passed: true, exitCode: 0, stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 2000), durationMs });
      log.info({ command, durationMs }, "Verify command passed");
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const timedOut = !!err.killed;
      const exitCode = timedOut ? 124 : (err.code ?? 1);
      const stderr = (err.stderr ?? "").slice(0, 2000);
      results.push({ command, passed: false, exitCode, stdout: (err.stdout ?? "").slice(0, 4000), stderr, durationMs });
      log.warn({ command, exitCode, timedOut, stderr: stderr.slice(0, 500) }, timedOut ? "Verify command timed out" : "Verify command failed");
    }
  }

  const allPassed = results.every((r) => r.passed);
  sseManager.pushMessage(taskId, createSSEMessage(taskId, "agent_progress", {
    phase: "verification_complete", allPassed,
    results: results.map(r => ({ command: r.command, passed: r.passed, exitCode: r.exitCode })),
  }));

  return { allPassed, results };
}

export function formatVerifyFailures(results: VerifyResult[]): string {
  const failed = results.filter((r) => !r.passed);
  if (failed.length === 0) return "";
  return failed.map((r) =>
    `Command: ${r.command}\nExit code: ${r.exitCode}\nstderr: ${r.stderr}\nstdout (tail): ${r.stdout.slice(-1000)}`
  ).join("\n---\n");
}
