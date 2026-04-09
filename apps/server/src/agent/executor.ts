// Multi-session executor: each stage creates an independent query() call.
// Per-stage allowedTools / maxTurns / maxBudgetUsd / cwd / thinking / outputFormat from stage-config.
// SessionIds are persisted so users can resume any stage via: claude --resume <sessionId>

import { createWorktree, installDepsInWorktree, resolveRepoPath, initRepo } from "../lib/git.js";
import { join } from "node:path";
import { taskLogger } from "../lib/logger.js";
import { injectWorktreeConfig } from "../lib/worktree-injector.js";
import { loadSystemSettings, getNestedValue, type AgentRuntimeConfig, type ScriptRuntimeConfig } from "../lib/config-loader.js";
import { findStageConfig } from "../lib/config/stage-lookup.js";
import type { WorkflowContext } from "../machine/types.js";
import { buildTier1Context } from "./context-builder.js";
import { type AgentResult } from "./query-tracker.js";
import { scriptRegistry } from "../scripts/index.js";
import { executeStage } from "./stage-executor.js";
import { runVerifyCommands, formatVerifyFailures } from "./verify-commands.js";

// ── Mock executor (MOCK_EXECUTOR=true only, never runs in production) ──
const _mockCallCounts = new Map<string, number>(); // key: taskId:stageName

/** Reset mock call counters — for use in tests only. */
export function _resetMockState(): void {
  _mockCallCounts.clear();
}

function _getMockScenario(context?: WorkflowContext): string {
  const taskText = context?.taskText ?? "";
  const m = taskText.match(/\[SCENARIO:([^\]]+)\]/);
  return m?.[1] ?? "happy_path";
}

function _buildMockWrites(writes: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of writes) {
    out[field] = { _mock: true, title: "Mock Task", repoName: "mock-repo", passed: true, blockers: [] };
  }
  return out;
}

// --- Re-exports for backward compatibility ---
export { buildTier1Context };
export {
  cancelTask,
  queueInterruptMessage,
  interruptActiveQuery,
  getActiveQueryInfo,
  type AgentResult,
} from "./query-tracker.js";
export { generateSchemaPrompt } from "./prompt-builder.js";

// --- Unified Runner functions ---

export async function runAgent(
  taskId: string,
  input: {
    stageName: string;
    worktreePath: string;
    tier1Context: string;
    enabledSteps?: string[];
    attempt: number;
    resumeInfo?: { sessionId: string; feedback?: string; sync?: boolean };
    interactive?: boolean;
    runtime: AgentRuntimeConfig;
    context?: WorkflowContext;
  }
): Promise<AgentResult> {
  if (process.env.MOCK_EXECUTOR === "true") {
    const scenario = _getMockScenario(input.context);
    const callKey = `${taskId}:${input.stageName}`;
    const count = (_mockCallCounts.get(callKey) ?? 0) + 1;
    _mockCallCounts.set(callKey, count);

    const delayMs = Number(process.env.MOCK_EXECUTOR_DELAY_MS ?? 300);
    await new Promise(r => setTimeout(r, delayMs));

    if (scenario === "blocked") {
      throw new Error("Mock executor: forced failure for blocked scenario");
    }
    if (scenario === "missing_output" && count <= 3) {
      return { resultText: "{}", costUsd: 0.001, durationMs: delayMs, sessionId: `mock-${Date.now()}`, tokenUsage: undefined };
    }
    if (scenario === "slow") {
      await new Promise(r => setTimeout(r, 2000));
    }

    const writes = input.runtime.writes ?? [];
    const mockData = _buildMockWrites(writes);
    return {
      resultText: JSON.stringify(mockData),
      costUsd: 0.001,
      durationMs: delayMs,
      sessionId: `mock-${taskId}-${input.stageName}-${Date.now()}`,
      tokenUsage: undefined,
    };
  }

  const { stageName, worktreePath, tier1Context, enabledSteps, resumeInfo, interactive, runtime, context: inputContext } = input;

  const result = await executeStage(taskId, stageName, tier1Context, runtime.system_prompt, {
    cwd: worktreePath,
    interactive,
    enabledSteps,
    resumeSessionId: resumeInfo?.sessionId,
    resumePrompt: resumeInfo?.feedback,
    resumeSync: resumeInfo?.sync,
    runtime,
    injectedContext: inputContext,
  });

  // Run verify commands if configured
  const stageConf = findStageConfig(inputContext?.config?.pipeline?.stages, stageName);
  const verifyCommands = stageConf?.verify_commands as string[] | undefined;
  const verifyPolicy = (stageConf?.verify_policy ?? "must_pass") as string;

  if (verifyCommands?.length && verifyPolicy !== "skip") {
    const { allPassed, results: verifyResults } = await runVerifyCommands(taskId, stageName, verifyCommands, worktreePath);
    if (!allPassed) {
      const failures = formatVerifyFailures(verifyResults);
      if (verifyPolicy === "must_pass") {
        return {
          ...result,
          verifyFailed: true,
          verifyResults,
        };
      }
      // warn policy: log failures but don't block
      taskLogger(taskId, stageName).warn({ failures: failures.slice(0, 1000) }, "Verify commands failed (warn policy, continuing)");
    }
    // Attach verify results to output regardless of policy
    return { ...result, verifyResults };
  }

  return result;
}

export async function runScript(
  taskId: string,
  input: {
    stageName: string;
    context: WorkflowContext;
    runtime: ScriptRuntimeConfig;
  }
): Promise<Record<string, unknown>> {
  if (process.env.MOCK_EXECUTOR === "true") {
    const delayMs = Number(process.env.MOCK_EXECUTOR_DELAY_MS ?? 200);
    await new Promise(r => setTimeout(r, delayMs));
    const out: Record<string, unknown> = {};
    for (const field of input.runtime.writes ?? []) {
      if (field === "worktreePath") out[field] = process.cwd();
      else if (field === "branch") out[field] = "mock-branch";
      else out[field] = { _mock: true };
    }
    return out;
  }

  const { stageName, context, runtime } = input;
  const log = taskLogger(taskId, stageName);
  const settings = loadSystemSettings();

  log.info({ script_id: runtime.script_id }, "Executing script via Registry");

  const script = await scriptRegistry.getOrLoadDynamic(runtime.script_id);
  if (!script) {
    throw new Error(`Unknown script_id: ${runtime.script_id}. Ensure it is registered in src/scripts/index.ts or installed via config/scripts/`);
  }

  if (script.metadata.requiredSettings) {
    for (const path of script.metadata.requiredSettings) {
      if (!getNestedValue(settings, path)) {
        throw new Error(`Script "${runtime.script_id}" requires system setting path "${path}", which is missing or empty.`);
      }
    }
  }

  const inputs: Record<string, unknown> = {};
  if (runtime.reads) {
    for (const [inputKey, storePath] of Object.entries(runtime.reads)) {
      inputs[inputKey] = getNestedValue(context.store, storePath as string);
    }
  }

  return script.handler({
    taskId,
    context,
    settings,
    args: runtime.args,
    inputs,
  });
}

// --- Kept for backward compatibility (used by scripts/git-worktree.ts) ---

export async function createWorktreeForTask(taskId: string, repoName: string, branch: string): Promise<string> {
  let repoPath = resolveRepoPath(repoName);
  if (!repoPath) {
    taskLogger(taskId).info({ repoName }, "Repository not found, initializing new repo");
    repoPath = await initRepo(repoName);
  }
  const settings = loadSystemSettings();
  const worktreesBase = settings.paths?.worktrees_base || join(process.env.HOME ?? "/tmp", "wfc-worktrees");
  const worktreePath = await createWorktree(repoPath, branch, worktreesBase);
  taskLogger(taskId).info({ worktreePath }, "Worktree created");
  await installDepsInWorktree(worktreePath);
  taskLogger(taskId).info("Dependencies installed");
  injectWorktreeConfig(worktreePath);
  taskLogger(taskId).info("Worktree config injected (skills/hooks/CLAUDE.md)");
  return worktreePath;
}
