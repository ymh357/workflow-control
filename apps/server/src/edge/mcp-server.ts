import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAllSlots, hasSlot, getSlotNonce, resolveSlot, setPendingRecovery, renewSlot, type ResolveSlotResult } from "./registry.js";
import { buildTier1Context } from "../agent/context-builder.js";
import { buildSystemAppendPrompt, buildStaticPromptPrefix } from "../agent/prompt-builder.js";
import { extractJSON } from "../lib/json-extractor.js";
import { sseManager } from "../sse/manager.js";
import { getNestedValue, listAvailablePipelines, flattenStages, isParallelGroup } from "../lib/config-loader.js";
import { TERMINAL_STATES } from "../machine/types.js";
import type { WorkflowContext } from "../machine/types.js";
import type { AgentRuntimeConfig, PipelineStageConfig, PipelineConfig, PipelineStageEntry, ForeachRuntimeConfig } from "../lib/config-loader.js";
import type { ConditionRuntimeConfig } from "../lib/config/types.js";
import type { SSEMessage } from "../types/index.js";
import { taskLogger } from "../lib/logger.js";
import {
  getTaskContext,
  confirmGate,
  rejectGate,
  retryTask,
  cancelTask_,
  resumeTask,
  interruptTask,
  createTask,
  launch,
} from "../actions/task-actions.js";
import type { ActionResult } from "../actions/task-actions.js";

// Task-scoped authentication tokens — generated on trigger_task, required for all operations
const taskTokens = new Map<string, string>();

function validateTaskToken(taskId: string, token?: string): string | null {
  let expected = taskTokens.get(taskId);
  // Fallback: read from persisted WorkflowContext after server restart
  if (!expected) {
    const ctx = getTaskContext(taskId);
    if (ctx?.taskToken) {
      expected = ctx.taskToken;
      taskTokens.set(taskId, expected); // Re-cache
    }
  }
  if (!expected) return null; // No token anywhere (legacy task), allow
  if (!token) return "taskToken is required for this task";
  if (token !== expected) return "Invalid taskToken";
  return null;
}

function textResult(text: string, isError?: boolean) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function actionToTextResult(result: ActionResult<unknown>) {
  if (result.ok) return textResult(JSON.stringify({ ok: true, ...result.data as Record<string, unknown> }, null, 2));
  return textResult(JSON.stringify({ error: result.message }, null, 2), true);
}

function findStageConfig(context: WorkflowContext, stageName: string): PipelineStageConfig | undefined {
  if (!context.config?.pipeline?.stages) return undefined;
  return flattenStages(context.config.pipeline.stages).find((s) => s.name === stageName);
}

async function buildStageContext(taskId: string, stageName: string, compact = false): Promise<Record<string, unknown> | null> {
  const context = getTaskContext(taskId);
  if (!context) return null;

  const stageConfig = findStageConfig(context, stageName);
  if (!stageConfig) return null;

  const runtime = stageConfig.runtime as AgentRuntimeConfig | undefined;
  if (!runtime || runtime.engine !== "llm") return null;

  const tier1Context = buildTier1Context(context, runtime);
  const stageEngine = stageConfig.engine ?? context.config?.pipeline?.engine ?? "claude";
  const systemPrompt = await buildSystemAppendPrompt({
    taskId,
    stageName,
    runtime,
    privateConfig: context.config,
    stageConfig: { engine: stageEngine, mcpServices: stageConfig.mcps ?? [] },
    cwd: context.worktreePath,
  });

  const staticPrefix = compact ? undefined : buildStaticPromptPrefix(context.config, stageEngine);

  const storeReads: Record<string, unknown> = {};
  if (runtime.reads) {
    for (const [label, storePath] of Object.entries(runtime.reads)) {
      storeReads[label] = getNestedValue(context.store, storePath);
    }
  }

  const mcpList = stageConfig.mcps ?? [];

  // Detect foreach sub-task and expose foreachItem (Issue #1)
  let foreachItem: unknown = undefined;
  let foreachItemVar: string | undefined = undefined;
  if (context.foreachMeta) {
    foreachItemVar = context.foreachMeta.itemVar;
    foreachItem = context.store[context.foreachMeta.itemVar];
  }

  return {
    taskId,
    stageName,
    tier1Context,
    systemPrompt,
    ...(staticPrefix !== undefined ? { staticPromptPrefix: staticPrefix } : {}),
    outputSchema: stageConfig.outputs ?? null,
    storeReads,
    mcps: mcpList,
    worktreePath: context.worktreePath ?? "",
    branch: context.branch ?? "",
    writes: (runtime.writes ?? []).map((w: string | { key: string; strategy?: string }) => typeof w === "string" ? w : w.key),
    resumeInfo: context.resumeInfo ?? null,
    ...(foreachItem !== undefined ? { foreachItem, foreachItemVar } : {}),
    contextUsageHint: {
      tier1Context: "Task description and store value summaries for prompt injection (token-budgeted, may be lossy for large values).",
      systemPrompt: "Stage-specific instructions, constraints, and output format requirements.",
      ...(staticPrefix !== undefined ? { staticPromptPrefix: "Cross-stage shared prompt prefix (constraints + fragments). Omit in compact mode to save tokens." } : {}),
      storeReads: "Full structured JSON data from declared stage reads. Use these as the authoritative data inputs.",
      outputSchema: "Required output format — your response must contain JSON with these fields.",
      worktreePath: "Absolute path to the git worktree for this task. Use as the root directory for all file reads and writes.",
      branch: "Git branch name for this task's worktree. Use when committing or referencing version control.",
    },
  };
}

// Pre-validate output against runtime.writes (same logic as state-builders.ts onDone guard).
// All declared write fields must be present — matches the guard in state-builders.ts
// which retries when any field is missing (!runtime.writes.every(field => parsed[field] !== undefined)).
function validateStageOutput(
  stageConfig: PipelineStageConfig,
  resultText: string,
  pipelineConfig?: PipelineConfig,
): { valid: true } | { valid: false; missing?: string[]; reason: string } {
  const runtime = stageConfig.runtime as AgentRuntimeConfig | undefined;
  const rawWrites = runtime?.writes ?? [];
  const writes = rawWrites.map((w) => typeof w === "string" ? w : w.key);

  if (writes.length === 0) return { valid: true };
  if (!resultText) return { valid: false, reason: "resultText is empty" };

  let parsed: Record<string, unknown>;
  try {
    parsed = extractJSON(resultText);
  } catch {
    return { valid: false, reason: "Could not parse JSON from resultText" };
  }

  // All declared write fields must be present — matches the guard in state-builders.ts
  const missing = writes.filter((field) => parsed[field] === undefined);
  if (missing.length > 0) {
    return { valid: false, missing, reason: `Missing required output fields: ${missing.join(", ")}` };
  }

  // Check downstream foreach dependencies (skip condition-gated stages)
  if (pipelineConfig?.stages) {
    const allStages = flattenStages(pipelineConfig.stages);

    // Build set of stages behind non-default condition branches (may be skipped)
    const conditionGated = new Set<string>();
    for (const s of allStages) {
      if (s.type === "condition" && s.runtime) {
        const condRuntime = s.runtime as ConditionRuntimeConfig;
        for (const branch of condRuntime.branches) {
          if (!branch.default) {
            conditionGated.add(branch.to);
          }
        }
      }
    }

    const currentIdx = allStages.findIndex((s) => s.name === stageConfig.name);
    for (let i = currentIdx + 1; i < allStages.length; i++) {
      const downstream = allStages[i];
      // Skip foreach stages that are behind condition gates (may not execute)
      if (conditionGated.has(downstream.name)) continue;
      if (downstream.type === "foreach" && downstream.runtime) {
        const foreachRuntime = downstream.runtime as ForeachRuntimeConfig;
        const itemsPath = foreachRuntime.items.startsWith("store.") ? foreachRuntime.items.slice(6) : foreachRuntime.items;
        const rootKey = itemsPath.split(".")[0];
        if (writes.includes(rootKey)) {
          const value = getNestedValue(parsed, itemsPath);
          if (!Array.isArray(value)) {
            return {
              valid: false,
              reason: `Downstream foreach stage "${downstream.name}" expects "${foreachRuntime.items}" to be an array, but got ${typeof value}. Fix the output to include this field as an array.`,
            };
          }
        }
      }
    }
  }

  return { valid: true };
}

export function createEdgeMcpServer(): McpServer {
  const server = new McpServer(
    { name: "workflow-control-edge", version: "1.0.0" },
    { capabilities: { resources: { listChanged: true } } },
  );

  // --- list_available_stages ---
  server.tool(
    "list_available_stages",
    "List all pipeline stages currently waiting for an edge agent to execute them",
    {},
    async () => {
      const slots = getAllSlots();
      const enriched = slots.map((slot) => {
        const context = getTaskContext(slot.taskId);
        // Check if this stage is part of a parallel group
        let parallelGroup: string | undefined;
        if (context?.config?.pipeline?.stages) {
          for (const entry of context.config.pipeline.stages as any[]) {
            if (entry?.parallel?.stages?.some((s: any) => s.name === slot.stageName)) {
              parallelGroup = entry.parallel.name;
              break;
            }
          }
        }
        // Detect foreach item for sub-tasks (Issue #1)
        const fMeta = context?.foreachMeta;
        const foreachItem = fMeta ? context?.store?.[fMeta.itemVar] : undefined;
        const skippedStages = context?.skippedStages ?? [];

        return {
          taskId: slot.taskId,
          stageName: slot.stageName,
          nonce: slot.nonce,
          taskText: context?.taskText ?? "",
          createdAt: new Date(slot.createdAt).toISOString(),
          waitingSeconds: Math.round((Date.now() - slot.createdAt) / 1000),
          ...(parallelGroup ? { parallelGroup } : {}),
          ...(foreachItem !== undefined ? { foreachItem, foreachItemVar: fMeta!.itemVar } : {}),
          ...(skippedStages.length > 0 ? { skippedStages } : {}),
        };
      });
      return textResult(JSON.stringify(enriched, null, 2));
    },
  );

  // --- get_stage_context ---
  server.tool(
    "get_stage_context",
    "Get full execution context for a stage: system prompt, tier1 context, output schema, store values, and worktree info",
    {
      taskId: z.string().describe("The task ID"),
      stageName: z.string().describe("The stage name to get context for"),
      taskToken: z.string().optional().describe("Task authentication token from trigger_task"),
      compact: z.boolean().optional().default(false).describe("When true, omit staticPromptPrefix to reduce response size for edge agents with limited context windows"),
    },
    async ({ taskId, stageName, taskToken, compact }) => {
      const authErr = validateTaskToken(taskId, taskToken);
      if (authErr) return textResult(JSON.stringify({ error: authErr }), true);
      if (!hasSlot(taskId, stageName)) {
        return textResult(JSON.stringify({ error: `No pending edge slot for ${taskId}::${stageName}` }), true);
      }
      const ctx = await buildStageContext(taskId, stageName, compact);
      if (!ctx) {
        return textResult(JSON.stringify({ error: `Could not build context for ${taskId}::${stageName}` }), true);
      }
      const nonce = getSlotNonce(taskId, stageName);
      if (nonce) ctx.nonce = nonce;
      return textResult(JSON.stringify(ctx, null, 2));
    },
  );

  // --- get_stage_schema ---
  server.tool(
    "get_stage_schema",
    "Get lightweight schema for a stage — only outputSchema, writes, reads keys, and nonce. Use this instead of get_stage_context when you only need to know the output format.",
    {
      taskId: z.string(),
      stageName: z.string(),
      taskToken: z.string().optional(),
    },
    async ({ taskId, stageName, taskToken }) => {
      const authErr = validateTaskToken(taskId, taskToken);
      if (authErr) return textResult(JSON.stringify({ error: authErr }), true);

      const context = getTaskContext(taskId);
      if (!context) {
        return textResult(JSON.stringify({ error: "Task not found" }), true);
      }

      const stageConf = findStageConfig(context, stageName);
      if (!stageConf) {
        return textResult(JSON.stringify({ error: `Stage "${stageName}" not found in pipeline` }), true);
      }

      const runtime = stageConf.runtime;
      const nonce = getSlotNonce(taskId, stageName);

      const isAgent = runtime && "engine" in runtime && (runtime as AgentRuntimeConfig).engine === "llm";
      const agentRuntime = isAgent ? runtime as AgentRuntimeConfig : undefined;

      const schema = {
        stageName,
        writes: agentRuntime?.writes ?? [],
        reads: agentRuntime?.reads ? Object.keys(agentRuntime.reads) : [],
        outputSchema: stageConf.outputs ?? null,
        nonce: nonce ?? null,
      };

      return textResult(JSON.stringify(schema), false);
    },
  );

  // --- submit_stage_result ---
  server.tool(
    "submit_stage_result",
    "Submit the result of an edge-executed stage. Pre-validates output fields before accepting. Returns immediately after submission — the runner will handle stage transitions.",
    {
      taskId: z.string().describe("The task ID"),
      stageName: z.string().describe("The stage name being completed"),
      resultText: z.string().describe("The result text (JSON string with the stage output fields)"),
      nonce: z.string().optional().describe("Slot nonce from get_stage_context — prevents stale submissions after retry"),
      sessionId: z.string().optional().describe("Optional session ID for resume capability"),
      costUsd: z.number().optional().describe("Optional cost in USD"),
      durationMs: z.number().optional().describe("Optional duration in milliseconds"),
      taskToken: z.string().optional().describe("Task authentication token from trigger_task"),
    },
    async ({ taskId, stageName, resultText, nonce, sessionId, costUsd, durationMs, taskToken }) => {
      const authErr = validateTaskToken(taskId, taskToken);
      if (authErr) return textResult(JSON.stringify({ error: authErr }), true);
      // Pre-validate: check output fields BEFORE resolving the slot
      const context = getTaskContext(taskId);
      if (context) {
        const stageConfig = findStageConfig(context, stageName);
        if (stageConfig) {
          const runtime = stageConfig.runtime as AgentRuntimeConfig | undefined;
          const writes = runtime?.writes ?? [];
          const validation = validateStageOutput(stageConfig, resultText, context.config?.pipeline);
          if (!validation.valid) {
            return textResult(JSON.stringify({
              error: "Output validation failed",
              reason: validation.reason,
              missingFields: validation.missing,
              expectedFields: writes,
            }, null, 2), true);
          }
        }
      }

      const agentResult = {
        resultText,
        sessionId,
        costUsd: costUsd ?? 0,
        durationMs: durationMs ?? 0,
      };
      const resolved = resolveSlot(taskId, stageName, agentResult, nonce);

      if (resolved === "not_found" || resolved === "nonce_mismatch" || resolved === "expired") {
        const errorMessages: Record<string, string> = {
          not_found: `No pending edge slot for ${taskId}::${stageName}. It may have timed out or already been resolved.`,
          nonce_mismatch: `Nonce mismatch for ${taskId}::${stageName}. Your submission is stale — a newer slot exists. Call get_stage_context to get the current nonce and retry.`,
          expired: `Edge slot for ${taskId}::${stageName} has expired. Trigger a retry_task to re-create the slot.`,
        };
        return textResult(JSON.stringify({ error: errorMessages[resolved], reason: resolved }), true);
      }

      // Handle persisted slot recovery (server restarted since slot was created).
      // The task is in "blocked" state — store the result for auto-resolution,
      // then trigger a RETRY so the stage re-runs and createSlot picks up the pending result.
      if (resolved === "persisted") {
        setPendingRecovery(taskId, stageName, agentResult);
        taskLogger(taskId).info({ stageName }, "Edge agent submitted result for persisted slot — triggering recovery retry");
        try {
          const { sendEvent } = await import("../machine/actor-registry.js");
          sendEvent(taskId, { type: "RETRY" });
        } catch (err) {
          taskLogger(taskId).error({ err, stageName }, "Failed to trigger recovery retry for persisted slot");
          return textResult(JSON.stringify({ error: "Slot was persisted but failed to trigger recovery retry" }), true);
        }
        return textResult(JSON.stringify({
          ok: true,
          recovered: true,
          completed: stageName,
          nextAction: "CONTINUE_PIPELINE",
          instruction: "Result accepted via server-restart recovery. The stage is being re-executed with cached result. Call list_available_stages to continue.",
        }, null, 2));
      }

      taskLogger(taskId).info({ stageName }, "Edge agent submitted stage result via MCP");

      // Build enriched response with pipeline progress and next-action directive.
      // This is the primary mechanism to keep the MCP client looping — tool results
      // are more strongly followed than system prompts from thousands of tokens ago.
      const postCtx = getTaskContext(taskId);
      const allStages = postCtx?.config?.pipeline?.stages ? flattenStages(postCtx.config.pipeline.stages) : [];
      const completedCount = postCtx?.completedStages ? new Set(postCtx.completedStages).size : Object.keys(postCtx?.stageTokenUsages ?? {}).length;
      const progress = `${completedCount}/${allStages.length}`;
      const skippedStages = postCtx?.skippedStages ?? [];
      const isTerminal = postCtx ? TERMINAL_STATES.has(postCtx.status) : false;

      let nextAction: string;
      let instruction: string;
      if (isTerminal && postCtx?.status === "completed") {
        nextAction = "PIPELINE_COMPLETE";
        instruction = "All stages completed. Call get_task_status to get final results and report to the user.";
      } else if (isTerminal) {
        nextAction = "PIPELINE_TERMINATED";
        instruction = `Pipeline reached terminal state: ${postCtx?.status}. Call get_task_status for details.`;
      } else {
        nextAction = "CONTINUE_PIPELINE";
        instruction = "Stage submitted. Call list_available_stages RIGHT NOW to pick up the next stage. The pipeline is NOT finished — do NOT stop.";
      }

      return textResult(JSON.stringify({
        ok: true,
        completed: stageName,
        nextAction,
        instruction,
        pipelineProgress: progress,
        taskStatus: postCtx?.status ?? "unknown",
        ...(skippedStages.length > 0 ? { skippedStages } : {}),
      }, null, 2));
    },
  );

  // --- report_progress ---
  server.tool(
    "report_progress",
    "Report progress for a stage being executed by an edge agent. Shows up on the dashboard.",
    {
      taskId: z.string().describe("The task ID"),
      stageName: z.string().describe("The stage name"),
      type: z.enum(["text", "tool_use", "thinking"]).describe("The type of progress update"),
      data: z.record(z.string(), z.unknown()).describe("Progress data: { text } for text/thinking, { toolName, input } for tool_use"),
      taskToken: z.string().optional().describe("Task authentication token from trigger_task"),
    },
    async ({ taskId, stageName, type, data, taskToken }) => {
      const authErr = validateTaskToken(taskId, taskToken);
      if (authErr) return textResult(JSON.stringify({ error: authErr }), true);
      if (!hasSlot(taskId, stageName)) {
        return textResult(JSON.stringify({ error: `No pending edge slot for ${taskId}::${stageName}` }), true);
      }

      if ((type === "text" || type === "thinking") && typeof data.text !== "string") {
        return textResult(JSON.stringify({ error: `data.text (string) is required for type "${type}"` }), true);
      }
      if (type === "tool_use" && typeof data.toolName !== "string") {
        return textResult(JSON.stringify({ error: `data.toolName (string) is required for type "tool_use"` }), true);
      }

      const sseType = type === "text" ? "agent_text"
        : type === "tool_use" ? "agent_tool_use"
        : "agent_thinking";
      sseManager.pushMessage(taskId, {
        type: sseType as SSEMessage["type"],
        taskId,
        timestamp: new Date().toISOString(),
        data: data as SSEMessage["data"],
      });
      // Renew slot timeout on every progress report
      renewSlot(taskId, stageName);
      return textResult(JSON.stringify({ ok: true }));
    },
  );

  // --- get_store_value ---
  server.tool(
    "get_store_value",
    "Read a value from the workflow store using dot notation (e.g., 'analysis.plan')",
    {
      taskId: z.string().describe("The task ID"),
      path: z.string().describe("Dot-notation path into the store (e.g., 'analysis.plan')"),
      taskToken: z.string().optional().describe("Task authentication token from trigger_task"),
    },
    async ({ taskId, path, taskToken }) => {
      const authErr = validateTaskToken(taskId, taskToken);
      if (authErr) return textResult(JSON.stringify({ error: authErr }), true);
      const context = getTaskContext(taskId);
      if (!context) {
        return textResult(JSON.stringify({ error: `Task ${taskId} not found` }), true);
      }
      const value = getNestedValue(context.store, path);
      return textResult(JSON.stringify({ value }, null, 2));
    },
  );

  // --- check_interrupts ---
  server.tool(
    "check_interrupts",
    "Check if the task has been cancelled or interrupted",
    {
      taskId: z.string().describe("The task ID"),
      taskToken: z.string().optional().describe("Task authentication token from trigger_task"),
    },
    async ({ taskId, taskToken }) => {
      const authErr = validateTaskToken(taskId, taskToken);
      if (authErr) return textResult(JSON.stringify({ error: authErr }), true);
      const context = getTaskContext(taskId);
      if (!context) {
        return textResult(JSON.stringify({ interrupted: true, reason: "Task not found" }));
      }
      const interrupted = context.status === "cancelled" || context.status === "blocked";
      // Clean up token for terminal tasks to prevent memory leak
      if (TERMINAL_STATES.has(context.status as any)) {
        taskTokens.delete(taskId);
      }
      return textResult(JSON.stringify({
        interrupted,
        reason: interrupted ? context.error ?? context.status : undefined,
      }));
    },
  );

  // --- trigger_task ---
  server.tool(
    "trigger_task",
    "Create and launch a workflow task. Returns immediately with taskId and edge stage list — the runner handles stage execution.",
    {
      taskText: z.string().describe("The task description"),
      pipeline: z.string().describe(`Exact pipeline ID. Available: ${listAvailablePipelines().map((p) => p.id).join(", ")}`),
      edge: z.boolean().default(true).describe("When true, all agent stages are executed by you via MCP. Default: true."),
      repoName: z.string().optional().describe("Target repository name (optional)"),
    },
    async ({ taskText, pipeline, edge, repoName }) => {
      const available = listAvailablePipelines().map((p) => p.id);
      if (!available.includes(pipeline)) {
        return textResult(JSON.stringify({ error: `Unknown pipeline "${pipeline}". Available: ${available.join(", ")}` }), true);
      }

      const created = createTask({ taskText, repoName, pipelineName: pipeline, edge });
      if (!created.ok) return actionToTextResult(created);
      const taskId = created.data.taskId;
      const taskToken = randomUUID();
      taskTokens.set(taskId, taskToken);
      // Persist token to WorkflowContext for restart recovery
      const ctxForToken = getTaskContext(taskId);
      if (ctxForToken) ctxForToken.taskToken = taskToken;

      const launched = launch(taskId);
      if (!launched.ok) return actionToTextResult(launched);

      const context = getTaskContext(taskId);
      const pipelineConfig = context?.config?.pipeline;
      const stages = pipelineConfig?.stages ? flattenStages(pipelineConfig.stages) : [];
      const defaultMode = pipelineConfig?.default_execution_mode;
      const edgeStages = stages
        .filter((s) => {
          const mode = s.execution_mode ?? (s.type === "agent" ? defaultMode : undefined);
          return mode === "edge" || mode === "any";
        })
        .map((s) => s.name);

      // Identify condition-gated stages for transparency
      const conditionGated = new Set<string>();
      for (const s of stages) {
        if (s.type === "condition" && s.runtime) {
          const condRuntime = s.runtime as ConditionRuntimeConfig;
          for (const branch of condRuntime.branches) {
            if (!branch.default) {
              conditionGated.add(branch.to);
            }
          }
        }
      }
      // Also mark stages inside condition-gated parallel groups
      if (pipelineConfig?.stages) {
        for (const entry of pipelineConfig.stages) {
          if (isParallelGroup(entry) && conditionGated.has(entry.parallel.name)) {
            for (const childStage of entry.parallel.stages) {
              conditionGated.add(childStage.name);
            }
          }
        }
      }

      const edgeStageDetails = edgeStages.map((name: string) => ({
        name,
        conditionGated: conditionGated.has(name),
      }));

      return textResult(JSON.stringify({
        taskId,
        taskToken,
        pipeline,
        edgeStages,
        edgeStageDetails,
      }, null, 2));
    },
  );

  // --- get_task_status ---
  server.tool(
    "get_task_status",
    "Get the current status of a workflow task",
    {
      taskId: z.string().describe("The task ID"),
      taskToken: z.string().optional().describe("Task authentication token from trigger_task"),
    },
    async ({ taskId, taskToken }) => {
      const authErr = validateTaskToken(taskId, taskToken);
      if (authErr) return textResult(JSON.stringify({ error: authErr }), true);
      const context = getTaskContext(taskId);
      if (!context) {
        return textResult(JSON.stringify({ error: `Task ${taskId} not found` }), true);
      }
      // Clean up token for terminal tasks to prevent memory leak
      if (TERMINAL_STATES.has(context.status as any)) {
        taskTokens.delete(taskId);
      }
      return textResult(JSON.stringify({
        taskId: context.taskId,
        status: context.status,
        lastStage: context.lastStage,
        error: context.error,
        branch: context.branch,
        worktreePath: context.worktreePath,
        totalCostUsd: context.totalCostUsd ?? 0,
        storeKeys: Object.keys(context.store),
        completedStages: context.completedStages ?? [],
        skippedStages: context.skippedStages ?? [],
        executionHistory: context.executionHistory ?? [],
      }, null, 2));
    },
  );

  // --- retry_task ---
  server.tool(
    "retry_task",
    "Retry a blocked/cancelled/running task from its last stage. Returns immediately — the runner handles stage transitions.",
    {
      taskId: z.string().describe("The task ID"),
      taskToken: z.string().optional().describe("Task authentication token from trigger_task"),
      sync: z.boolean().optional().describe("Use sync retry mode (resumes same session) when available"),
      fromStage: z.string().optional().describe("Stage name to retry from. If omitted, retries from the last failed stage."),
    },
    async ({ taskId, taskToken, sync, fromStage }) => {
      const authErr = validateTaskToken(taskId, taskToken);
      if (authErr) return textResult(JSON.stringify({ error: authErr }), true);
      const result = retryTask(taskId, { sync, fromStage });
      if (!result.ok) return actionToTextResult(result);

      const { lastStage, statusAfter } = result.data;
      taskLogger(taskId).info({ lastStage, statusAfter }, "Task retried via edge MCP");

      return textResult(JSON.stringify({
        ok: true,
        retried: true,
        retriedFrom: lastStage,
        statusAfter,
      }, null, 2));
    },
  );

  // --- confirm_gate ---
  server.tool(
    "confirm_gate",
    "Confirm or reject a human confirmation gate. Returns immediately after submission.",
    {
      taskId: z.string().describe("The task ID"),
      taskToken: z.string().optional().describe("Task authentication token from trigger_task"),
      decision: z.enum(["approve", "reject", "feedback"]).describe("User's decision"),
      reason: z.string().optional().describe("Reason for rejection (when decision is 'reject')"),
      feedback: z.string().optional().describe("User feedback to send back to the previous agent stage (when decision is 'feedback')"),
      repoName: z.string().optional().describe("Repository name override (when decision is 'approve')"),
    },
    async ({ taskId, taskToken, decision, reason, feedback, repoName }) => {
      const authErr = validateTaskToken(taskId, taskToken);
      if (authErr) return textResult(JSON.stringify({ error: authErr }), true);
      const contextBefore = getTaskContext(taskId);
      if (!contextBefore) {
        return textResult(JSON.stringify({ error: `Task ${taskId} not found` }), true);
      }
      const gateStageName = contextBefore.status;

      if (decision === "approve") {
        const result = confirmGate(taskId, { repoName });
        if (!result.ok) return actionToTextResult(result);
      } else {
        const result = rejectGate(taskId, { reason, feedback: decision === "feedback" ? feedback : undefined });
        if (!result.ok) return actionToTextResult(result);
      }

      taskLogger(taskId).info({ decision, gateStageName, reason, feedback }, "Gate decision submitted via edge MCP");

      const gateNextAction = decision === "approve" ? "CONTINUE_PIPELINE" : "WAIT_FOR_RETRY";
      const gateInstruction = decision === "approve"
        ? "Gate approved. Call list_available_stages RIGHT NOW to pick up the next stage. Do NOT stop."
        : "Gate rejected — the pipeline is re-running a previous stage. Call get_task_status in a few seconds to check progress, then call list_available_stages when a new stage is ready. Do NOT stop.";

      return textResult(JSON.stringify({
        ok: true,
        decision,
        gate: gateStageName,
        nextAction: gateNextAction,
        instruction: gateInstruction,
      }, null, 2));
    },
  );

  // --- cancel_task ---
  server.tool(
    "cancel_task",
    "Cancel a running or blocked task. Stops agent execution and transitions to cancelled state.",
    {
      taskId: z.string().describe("The task ID"),
      taskToken: z.string().optional().describe("Task authentication token from trigger_task"),
    },
    async ({ taskId, taskToken }) => {
      const authErr = validateTaskToken(taskId, taskToken);
      if (authErr) return textResult(JSON.stringify({ error: authErr }), true);
      const result = await cancelTask_(taskId);
      taskTokens.delete(taskId);
      return actionToTextResult(result);
    },
  );

  // --- interrupt_task ---
  server.tool(
    "interrupt_task",
    "Force-interrupt a running task. Transitions to blocked state and aborts the active agent. Use retry_task to resume after fixing issues.",
    {
      taskId: z.string().describe("The task ID"),
      taskToken: z.string().optional().describe("Task authentication token from trigger_task"),
      message: z.string().optional().describe("Reason for interruption"),
    },
    async ({ taskId, taskToken, message }) => {
      const authErr = validateTaskToken(taskId, taskToken);
      if (authErr) return textResult(JSON.stringify({ error: authErr }), true);
      const result = await interruptTask(taskId, message);
      return actionToTextResult(result);
    },
  );

  // --- resume_task ---
  server.tool(
    "resume_task",
    "Resume a cancelled or blocked task from its last stage. Returns immediately — the runner handles stage transitions.",
    {
      taskId: z.string().describe("The task ID"),
      taskToken: z.string().optional().describe("Task authentication token from trigger_task"),
    },
    async ({ taskId, taskToken }) => {
      const authErr = validateTaskToken(taskId, taskToken);
      if (authErr) return textResult(JSON.stringify({ error: authErr }), true);
      const result = resumeTask(taskId);
      if (!result.ok) return actionToTextResult(result);

      return textResult(JSON.stringify({
        ok: true,
        resumed: true,
        statusAfter: result.data.statusAfter,
      }, null, 2));
    },
  );

  return server;
}
