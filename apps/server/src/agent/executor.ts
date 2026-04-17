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
import { getOrCreateSessionManager } from "./session-manager-registry.js";
import { flattenStages } from "../lib/config/types.js";

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

    const writes = (input.runtime.writes ?? []).map(w => typeof w === "string" ? w : w.key);
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

export async function runAgentSingleSession(
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
    parallelGroup?: { name: string; stages: any[] };
  }
): Promise<AgentResult> {
  // Mock executor path (same pattern as runAgent)
  if (process.env.MOCK_EXECUTOR === "true") {
    const delayMs = Number(process.env.MOCK_EXECUTOR_DELAY_MS ?? 300);
    await new Promise(r => setTimeout(r, delayMs));
    const writes = (input.runtime.writes ?? []).map(w => typeof w === "string" ? w : w.key);
    const mockData = _buildMockWrites(writes);
    return {
      resultText: JSON.stringify(mockData),
      costUsd: 0.001,
      durationMs: delayMs,
      sessionId: `mock-single-${taskId}-${input.stageName}-${Date.now()}`,
      tokenUsage: undefined,
    };
  }

  const { stageName, worktreePath, tier1Context, resumeInfo, interactive, runtime, context: inputContext } = input;
  if (!inputContext) throw new Error(`No workflow context for task ${taskId}`);

  const settings = loadSystemSettings();
  const claudePath = settings.paths?.claude_executable || "claude";
  const pipeline = inputContext.config?.pipeline;
  const idleTimeoutMs = (pipeline?.session_idle_timeout_sec ?? 7200) * 1000;

  const mgr = getOrCreateSessionManager(taskId, {
    taskId,
    claudePath,
    idleTimeoutMs,
    cwd: worktreePath,
  });

  const privateStage = pipeline?.stages
    ? flattenStages(pipeline.stages).find((s) => s.name === stageName)
    : undefined;

  // When the "stage" is actually a parallel-group name, flattenStages won't
  // find it (groups aren't in the flat list). In single-session parallel mode
  // the whole group runs as one agent invocation, so we need to size its
  // budget from the children — otherwise maxTurns/maxBudgetUsd fall back to
  // the hard-coded defaults (30 turns / $2) regardless of what the pipeline
  // author configured on individual children.
  let groupChildren: any[] | undefined;
  if (!privateStage && input.parallelGroup?.stages?.length) {
    groupChildren = input.parallelGroup.stages;
  }
  const mergedMaxTurns = groupChildren
    ? groupChildren.reduce((sum, s) => sum + (s.max_turns ?? 30), 0)
    : (privateStage?.max_turns ?? 30);
  const mergedMaxBudgetUsd = groupChildren
    ? groupChildren.reduce((sum, s) => sum + (s.max_budget_usd ?? 2), 0)
    : (privateStage?.max_budget_usd ?? 2);
  const mergedMcpServices = groupChildren
    ? Array.from(new Set(groupChildren.flatMap((s) => s.mcps ?? []))) as string[]
    : ((privateStage?.mcps ?? []) as string[]);
  // Pick the strongest child config for ambiguous fields (effort/permissionMode/thinking):
  // - effort: "max" > "high" > "medium" > "low"
  // - permissionMode: use the least restrictive ("bypassPermissions" > "acceptEdits" > others)
  //   since the single session needs to do whatever any child needs.
  const effortRank: Record<string, number> = { low: 1, medium: 2, high: 3, max: 4 };
  const pickMaxEffort = (stages: any[]): "low" | "medium" | "high" | "max" | undefined => {
    let best: string | undefined;
    for (const s of stages) {
      const e = s.effort as string | undefined;
      if (!e) continue;
      if (!best || (effortRank[e] ?? 0) > (effortRank[best] ?? 0)) best = e;
    }
    return best as any;
  };
  const mergedEffort = groupChildren ? pickMaxEffort(groupChildren) : privateStage?.effort;
  const permRank: Record<string, number> = {
    plan: 1,
    default: 2,
    dontAsk: 3,
    acceptEdits: 4,
    bypassPermissions: 5,
  };
  const pickMaxPerm = (stages: any[]): string => {
    let best = "bypassPermissions";
    let bestRank = 0;
    for (const s of stages) {
      const p = s.permission_mode as string | undefined;
      if (!p) continue;
      const r = permRank[p] ?? 0;
      if (r > bestRank) { best = p; bestRank = r; }
    }
    return bestRank > 0 ? best : "bypassPermissions";
  };
  const mergedPermissionMode = groupChildren
    ? pickMaxPerm(groupChildren)
    : (privateStage?.permission_mode ?? "bypassPermissions");
  const mergedThinking = groupChildren
    ? (groupChildren.some((s) => s.thinking?.type === "enabled") ? { type: "enabled" as const } : { type: "disabled" as const })
    : (privateStage?.thinking
      ? { type: privateStage.thinking.type as "enabled" | "disabled" | "adaptive" }
      : { type: "disabled" as const });
  // stageTimeoutSec: take the max so the group gets enough time for the slowest child.
  const mergedStageTimeoutSec = groupChildren
    ? Math.max(...groupChildren.map((s) => s.stage_timeout_sec ?? 0))
    : privateStage?.stage_timeout_sec;

  // Surface per-stage permission/thinking settings that had to be escalated to
  // fit the single-session group. In multi-session mode each child runs in its
  // own SDK query with its own permissionMode; in single-session they share one
  // session, so we pick the least-restrictive across children. Pipeline authors
  // who relied on per-stage isolation need to know their stricter per-stage
  // settings are being ignored.
  if (groupChildren && groupChildren.length > 1) {
    const distinctPerms = Array.from(
      new Set(groupChildren.map((s) => (s.permission_mode as string | undefined) ?? "(default)")),
    );
    const distinctThinkings = Array.from(
      new Set(groupChildren.map((s) => ((s.thinking?.type as string | undefined) ?? "(none)"))),
    );
    if (distinctPerms.length > 1) {
      taskLogger(taskId, stageName).warn(
        { children: groupChildren.map((s) => s.name), childPerms: distinctPerms, effectivePerm: mergedPermissionMode },
        "single-session group escalated permission_mode to the least-restrictive across children; per-stage isolation is NOT preserved in this mode",
      );
    }
    if (distinctThinkings.length > 1) {
      taskLogger(taskId, stageName).warn(
        { children: groupChildren.map((s) => s.name), childThinking: distinctThinkings, effectiveThinking: mergedThinking.type },
        "single-session group runs with enabled-if-any thinking; per-stage thinking config diverges",
      );
    }
  }

  const stageConfig = {
    model: privateStage?.model || settings.agent?.claude_model,
    effort: mergedEffort,
    mcpServices: mergedMcpServices,
    permissionMode: mergedPermissionMode,
    maxTurns: mergedMaxTurns,
    maxBudgetUsd: mergedMaxBudgetUsd,
    thinking: mergedThinking,
    stageTimeoutSec: mergedStageTimeoutSec && mergedStageTimeoutSec > 0 ? mergedStageTimeoutSec : undefined,
  };

  const result = await mgr.executeStage({
    taskId,
    stageName,
    tier1Context,
    stagePrompt: runtime.system_prompt,
    stageConfig,
    resumeInfo: resumeInfo?.feedback ? { feedback: resumeInfo.feedback } : undefined,
    worktreePath,
    interactive: interactive ?? false,
    runtime,
    context: inputContext,
    parallelGroup: input.parallelGroup,
  });

  // Run verify commands if configured (same pattern as runAgent)
  const stageConf = findStageConfig(inputContext.config?.pipeline?.stages, stageName);
  const verifyCommands = stageConf?.verify_commands as string[] | undefined;
  const verifyPolicy = (stageConf?.verify_policy ?? "must_pass") as string;

  if (verifyCommands?.length && verifyPolicy !== "skip") {
    const { allPassed, results: verifyResults } = await runVerifyCommands(taskId, stageName, verifyCommands, worktreePath);
    if (!allPassed) {
      if (verifyPolicy === "must_pass") {
        return { ...result, verifyFailed: true, verifyResults };
      }
      taskLogger(taskId, stageName).warn({ failures: formatVerifyFailures(verifyResults).slice(0, 1000) }, "Verify commands failed (warn policy, continuing)");
    }
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
    for (const w of input.runtime.writes ?? []) {
      const field = typeof w === "string" ? w : w.key;
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
