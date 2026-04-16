import { query } from "@anthropic-ai/claude-agent-sdk";
import type { HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { buildMcpServers } from "../lib/mcp-config.js";
import { createStoreReaderMcp } from "../lib/store-reader-mcp.js";
import type { SSEMessage } from "../types/index.js";
import { sseManager } from "../sse/manager.js";
import { taskLogger } from "../lib/logger.js";
import { loadSystemSettings, type AgentRuntimeConfig, type SubAgentDefinition, flattenStages } from "../lib/config-loader.js";
import type { WorkflowContext } from "../machine/types.js";
import { loadMcpRegistry, buildMcpFromRegistry } from "../lib/config/mcp.js";
import { queryGemini } from "./gemini-executor.js";
import { queryCodex } from "./codex-executor.js";
import { type AgentResult, type AgentQuery } from "./query-tracker.js";
import { buildSystemAppendPrompt, buildEffectivePrompt, buildStaticPromptPrefix } from "./prompt-builder.js";
import { buildQueryOptions } from "./query-options-builder.js";
import { processAgentStream } from "./stream-processor.js";
import { outputSchemaToJsonSchema } from "./output-schema.js";
import { createAskUserQuestionInterceptor, createSpecAuditHook, createPathRestrictionHook } from "./executor-hooks.js";

const appendPromptCache = new Map<string, { prompt: string; fragmentIds: string[] }>();

export function clearAppendPromptCache(taskId: string): void {
  for (const key of appendPromptCache.keys()) {
    if (key.startsWith(`${taskId}:`)) appendPromptCache.delete(key);
  }
}

function resolveModelForEngine(engine: string, privateAgent?: Record<string, any>, settingsAgent?: Record<string, any>): string | undefined {
  const key = `${engine}_model`;
  return (privateAgent as any)?.[key] ?? (settingsAgent as any)?.[key] ?? settingsAgent?.default_model;
}

function createSSEMessage(taskId: string, type: SSEMessage["type"], data: unknown): SSEMessage {
  return { type, taskId, timestamp: new Date().toISOString(), data };
}

export interface StageOpts {
  cwd?: string;
  interactive?: boolean;
  specFiles?: string[];
  enabledSteps?: string[];
  resumeSessionId?: string;
  resumePrompt?: string;
  resumeSync?: boolean;
  runtime?: AgentRuntimeConfig;
  injectedContext?: WorkflowContext;
  _resumeDepth?: number;
}

export async function executeStage(
  taskId: string, stageName: string, prompt: string, stagePrompt: string,
  stageOpts?: StageOpts,
): Promise<AgentResult> {
  const { cwd, interactive, specFiles, enabledSteps, resumeSessionId, resumePrompt, resumeSync, runtime, injectedContext, _resumeDepth = 0 } = stageOpts ?? {};
  const settings = loadSystemSettings();
  const claudePath = settings.paths?.claude_executable || "claude";
  const geminiPath = settings.paths?.gemini_executable || "gemini";
  const isResume = !!resumeSessionId;

  let context: WorkflowContext | undefined = injectedContext;
  if (!context) {
    const { getWorkflow } = await import("../machine/actor-registry.js");
    const actor = getWorkflow(taskId);
    context = (actor?.getSnapshot() as { context?: WorkflowContext } | undefined)?.context;
  }
  if (!context) {
    throw new Error(`No workflow context available for task ${taskId}`);
  }
  const privateConfig = context.config;

  const privateStage = privateConfig?.pipeline?.stages
    ? flattenStages(privateConfig.pipeline.stages).find((s) => s.name === stageName)
    : undefined;

  const engine = privateStage?.engine ?? privateConfig?.pipeline?.engine ?? privateConfig?.agent?.default_engine ?? settings.agent?.default_engine ?? "claude";

  const stageConfig = {
    engine,
    model: privateStage?.model || resolveModelForEngine(engine, privateConfig?.agent, settings.agent),
    thinking: privateStage?.thinking
      ? { type: privateStage.thinking.type as "enabled" | "disabled" | "adaptive" }
      : { type: "disabled" as const },
    effort: privateStage?.effort,
    permissionMode: (privateStage?.permission_mode ?? "bypassPermissions") as "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk",
    debug: privateStage?.debug ?? false,
    maxTurns: privateStage?.max_turns ?? 30,
    maxBudgetUsd: privateStage?.max_budget_usd ?? 2,
    mcpServices: mergeDynamicMcps(
      (privateStage?.mcps ?? []) as string[],
      stageName,
      context,
    ),
  };

  // Auto-inject PulseMCP for analyzing stage so it can discover external capabilities
  if (stageName === "analyzing" && !stageConfig.mcpServices.includes("pulsemcp")) {
    stageConfig.mcpServices = [...stageConfig.mcpServices, "pulsemcp"];
  }

  const sandboxEnabled = !!(privateConfig?.sandbox ?? settings.sandbox)?.enabled;
  taskLogger(taskId, stageName).info({ engine: stageConfig.engine, model: stageConfig.model ?? "default", interactive: !!interactive, resume: isResume, sandbox: sandboxEnabled, hasPrivateConfig: !!privateConfig }, "stage START");
  if (!isResume) {
    sseManager.pushMessage(taskId, createSSEMessage(taskId, "stage_change", { stage: stageName }));
  }

  // prompt (3rd arg) already contains runtime-aware tier1Context from state-builders
  const effectiveTier1 = prompt;

  let absoluteTimer: ReturnType<typeof setTimeout> | undefined;
  let warningTimer: ReturnType<typeof setTimeout> | undefined;

  // Check for previous checkpoint from interrupted execution
  const checkpoint = context.stageCheckpoints?.[stageName];
  const MAX_CHECKPOINT_CHARS = 4000;
  const checkpointRaw = checkpoint
    ? (typeof checkpoint === "string" ? checkpoint : JSON.stringify(checkpoint, null, 2))
    : "";
  const checkpointContext = checkpointRaw
    ? `\n\n## Previous Progress (from interrupted execution)\nYou were previously working on this stage but were interrupted. Here is your partial progress:\n${checkpointRaw.length > MAX_CHECKPOINT_CHARS ? checkpointRaw.slice(0, MAX_CHECKPOINT_CHARS) + "\n... [truncated]" : checkpointRaw}\n\nContinue from where you left off. Do not redo completed work.`
    : "";

  const mcpServices = stageConfig.mcpServices as string[];
  if (mcpServices.length > 0) {
    sseManager.pushMessage(taskId, createSSEMessage(taskId, "agent_progress", {
      phase: "mcp_init", services: mcpServices
    }));
  }
  const localMcp: Record<string, unknown> = buildMcpServers(mcpServices, stageConfig.engine as "claude" | "gemini");
  if (context.store && Object.keys(context.store).length > 0) {
    localMcp["__store__"] = createStoreReaderMcp(
      context.store,
      context.scratchPad ?? [],
      stageName,
    );
  } else if (context.scratchPad && context.scratchPad.length > 0) {
    localMcp["__store__"] = createStoreReaderMcp({}, context.scratchPad, stageName);
  }
  const appendCacheKey = `${taskId}:${stageName}`;
  let appendPrompt: string;
  let resolvedFragmentIds: string[];
  if (isResume && appendPromptCache.has(appendCacheKey)) {
    const cached = appendPromptCache.get(appendCacheKey)!;
    appendPrompt = cached.prompt;
    resolvedFragmentIds = cached.fragmentIds;
  } else {
    const result = await buildSystemAppendPrompt({
      taskId, stageName, enabledSteps, runtime, privateConfig,
      stageConfig: { ...stageConfig, mcpServices }, cwd,
    });
    appendPrompt = result.prompt;
    resolvedFragmentIds = result.fragmentIds;
    appendPromptCache.set(appendCacheKey, result);
  }
  const staticPrefix = buildStaticPromptPrefix(privateConfig, stageConfig.engine, resolvedFragmentIds);
  const fullAppendPrompt = staticPrefix ? `${staticPrefix}\n\n${appendPrompt}` : appendPrompt;

  const canResume = !!resumeSessionId;
  const effectivePrompt = buildEffectivePrompt({
    isResume, resumeSync, resumePrompt, tier1Context: effectiveTier1 + checkpointContext, prompt, canResume,
  });

  let agentQuery: AgentQuery;

  if (stageConfig.engine === "gemini") {
    const approvalMap: Record<string, "yolo" | "plan" | "auto_edit" | "default"> = {
      bypassPermissions: "yolo",
      plan: "plan",
      acceptEdits: "auto_edit",
      default: "default",
      dontAsk: "default",
    };
    const geminiApprovalMode = approvalMap[stageConfig.permissionMode] ?? "yolo";

    const fullPrompt = `${fullAppendPrompt}\n\n---\n\n${effectivePrompt}`;
    const geminiResume = resumeSessionId ?? undefined;
    const geminiQuery = queryGemini({
      prompt: fullPrompt,
      options: {
        geminiPath,
        model: stageConfig.model,
        approvalMode: geminiApprovalMode,
        cwd,
        resume: geminiResume,
        env: { CI: "true" },
        mcpServers: localMcp,
      }
    });
    agentQuery = geminiQuery;
    // Emit effective cwd so frontend can build correct resume command
    if (geminiQuery.effectiveCwd) {
      sseManager.pushMessage(taskId, createSSEMessage(taskId, "stage_cwd", { stage: stageName, cwd: geminiQuery.effectiveCwd }));
    }
  } else if (stageConfig.engine === "codex") {
    const sandboxMap: Record<string, "read-only" | "workspace-write" | "danger-full-access"> = {
      bypassPermissions: "danger-full-access",
      plan: "read-only",
      acceptEdits: "workspace-write",
      default: "workspace-write",
      dontAsk: "workspace-write",
    };
    const codexSandbox = sandboxMap[stageConfig.permissionMode] ?? "workspace-write";

    const codexPath = settings.paths?.codex_executable || "codex";
    const fullPrompt = `${fullAppendPrompt}\n\n---\n\n${effectivePrompt}`;
    const codexQuery = queryCodex({
      prompt: fullPrompt,
      options: {
        codexPath,
        model: stageConfig.model,
        sandbox: codexSandbox,
        cwd,
        env: { CI: "true" },
        mcpServers: localMcp,
      },
    });
    agentQuery = codexQuery;
  } else {
    const hooks: Record<string, Array<{ hooks: Array<(input: HookInput, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<HookJSONOutput>> }>> = {};
    if (specFiles?.length) {
      hooks.PreToolUse = [{ hooks: [createSpecAuditHook(taskId, specFiles)] }];
    }

    // Path restriction hooks (safety paths + pipeline sandbox config)
    const sandboxFs = (privateConfig?.sandbox ?? settings.sandbox)?.filesystem;
    const pathHook = createPathRestrictionHook(
      sandboxFs?.allow_write,
      sandboxFs?.deny_write,
    );
    if (!hooks.PreToolUse) hooks.PreToolUse = [];
    hooks.PreToolUse.push({ hooks: [pathHook] });

    const pipelineStage = privateConfig?.pipeline?.stages
      ? flattenStages(privateConfig.pipeline.stages).find((s) => s.name === stageName)
      : undefined;
    const outputFormat = pipelineStage?.outputs
      ? { type: "json_schema" as const, schema: outputSchemaToJsonSchema(pipelineStage.outputs) }
      : undefined;

    const agentDefs = runtime?.agents as Record<string, SubAgentDefinition> | undefined;
    const sandboxConfig = privateConfig?.sandbox ?? settings.sandbox;

    // Absolute execution timeout for web mode (Claude path only)
    const stageTimeoutSec = privateStage?.stage_timeout_sec ?? 1800;
    const abortController = new AbortController();
    absoluteTimer = setTimeout(() => {
      taskLogger(taskId, stageName).error({ timeoutSec: stageTimeoutSec }, "Stage absolute execution timeout reached");
      abortController.abort(new Error(`Stage execution timeout after ${stageTimeoutSec}s`));
    }, stageTimeoutSec * 1000);
    warningTimer = setTimeout(() => {
      const remainingSec = Math.floor(stageTimeoutSec * 0.2);
      sseManager.pushMessage(taskId, createSSEMessage(taskId, "agent_progress", {
        phase: "timeout_approaching",
        remainingSeconds: remainingSec,
        message: `Stage will timeout in ${remainingSec}s`,
      }));
    }, stageTimeoutSec * 0.8 * 1000);

    const options = buildQueryOptions({
      taskId, stageName, appendPrompt: fullAppendPrompt, stageConfig, sandboxConfig,
      hooks, localMcp, claudePath, cwd, resumeSessionId, interactive,
      canUseTool: interactive ? createAskUserQuestionInterceptor(taskId) : undefined,
      outputFormat,
      agents: agentDefs,
      runtime,
      abortController,
    });

    agentQuery = query({ prompt: effectivePrompt, options }) as AgentQuery;
  }

  // Track effective cwd for resume commands (gemini uses temp dirs)
  const effectiveCwd = stageConfig.engine === "gemini" && "effectiveCwd" in agentQuery
    ? (agentQuery as any).effectiveCwd as string | undefined
    : cwd;

  let result: AgentResult;
  try {
    result = await processAgentStream({
      taskId,
      stageName,
      agentQuery,
      resumeDepth: _resumeDepth,
      onResume: ({ sessionId, resumePrompt: rp }) =>
        executeStage(taskId, stageName, prompt, stagePrompt, {
          ...stageOpts, resumeSessionId: sessionId, resumePrompt: rp, _resumeDepth: _resumeDepth + 1,
        }),
    });
  } finally {
    if (absoluteTimer) clearTimeout(absoluteTimer);
    if (warningTimer) clearTimeout(warningTimer);
  }

  return { ...result, cwd: effectiveCwd || cwd };
}

function mergeDynamicMcps(
  staticMcps: string[],
  stageName: string,
  context: WorkflowContext,
): string[] {
  // analyzing is the producer — it should not consume dynamic MCPs
  if (stageName === "analyzing") return staticMcps;

  try {
    // Search all store values for recommendedMcps (not just "analysis" key)
    const store = context.store as Record<string, any> | undefined;
    let recommended: unknown;
    if (store) {
      for (const val of Object.values(store)) {
        if (val && typeof val === "object" && Array.isArray(val.recommendedMcps)) {
          recommended = val.recommendedMcps;
          break;
        }
      }
    }
    if (!Array.isArray(recommended)) return staticMcps;

    const registry = loadMcpRegistry();
    if (!registry) return staticMcps;

    const seen = new Set(staticMcps);
    const validDynamic: string[] = [];
    for (const name of recommended) {
      if (
        typeof name === "string" &&
        name.length > 0 &&
        !seen.has(name) &&
        registry[name] != null &&
        buildMcpFromRegistry(name, registry[name]) !== null
      ) {
        seen.add(name);
        validDynamic.push(name);
      }
    }

    if (validDynamic.length > 0) {
      taskLogger(context.taskId, stageName).info(
        { dynamic: validDynamic },
        "Injecting dynamic MCPs from analysis",
      );
    }
    return [...staticMcps, ...validDynamic];
  } catch {
    return staticMcps;
  }
}
