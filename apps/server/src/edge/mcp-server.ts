import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAllSlots, hasSlot, getSlotNonce, resolveSlot } from "./registry.js";
import { buildTier1Context } from "../agent/context-builder.js";
import { buildSystemAppendPrompt } from "../agent/prompt-builder.js";
import { extractJSON } from "../lib/json-extractor.js";
import { sseManager } from "../sse/manager.js";
import { getNestedValue, listAvailablePipelines, flattenStages } from "../lib/config-loader.js";
import type { WorkflowContext } from "../machine/types.js";
import type { AgentRuntimeConfig, PipelineStageConfig } from "../lib/config-loader.js";
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

async function buildStageContext(taskId: string, stageName: string): Promise<Record<string, unknown> | null> {
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

  const storeReads: Record<string, unknown> = {};
  if (runtime.reads) {
    for (const [label, storePath] of Object.entries(runtime.reads)) {
      storeReads[label] = getNestedValue(context.store, storePath);
    }
  }

  return {
    taskId,
    stageName,
    tier1Context,
    systemPrompt,
    outputSchema: stageConfig.outputs ?? null,
    storeReads,
    worktreePath: context.worktreePath ?? "",
    branch: context.branch ?? "",
    writes: runtime.writes ?? [],
    resumeInfo: context.resumeInfo ?? null,
  };
}

// Pre-validate output against runtime.writes (same logic as state-builders.ts onDone guard).
// Validation uses "at least one field present" semantics:
// This matches the guard in state-builders.ts — partial output is acceptable
// because agents may legitimately produce a subset of declared fields.
function validateStageOutput(resultText: string, writes: string[]): { valid: boolean; missing?: string[]; reason?: string } {
  if (writes.length === 0) return { valid: true };
  if (!resultText) return { valid: false, reason: "resultText is empty" };

  let parsed: Record<string, unknown>;
  try {
    parsed = extractJSON(resultText);
  } catch {
    return { valid: false, reason: "Could not parse JSON from resultText" };
  }

  // "At least one field present" semantics — matches the guard in state-builders.ts
  const missing = writes.filter((field) => parsed[field] === undefined);
  if (missing.length === writes.length) {
    return { valid: false, missing, reason: `None of the required fields found: ${writes.join(", ")}` };
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
        return {
          taskId: slot.taskId,
          stageName: slot.stageName,
          nonce: slot.nonce,
          taskText: context?.taskText ?? "",
          createdAt: new Date(slot.createdAt).toISOString(),
          waitingSeconds: Math.round((Date.now() - slot.createdAt) / 1000),
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
    },
    async ({ taskId, stageName }) => {
      if (!hasSlot(taskId, stageName)) {
        return textResult(JSON.stringify({ error: `No pending edge slot for ${taskId}::${stageName}` }), true);
      }
      const ctx = await buildStageContext(taskId, stageName);
      if (!ctx) {
        return textResult(JSON.stringify({ error: `Could not build context for ${taskId}::${stageName}` }), true);
      }
      const nonce = getSlotNonce(taskId, stageName);
      if (nonce) ctx.nonce = nonce;
      return textResult(JSON.stringify(ctx, null, 2));
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
    },
    async ({ taskId, stageName, resultText, nonce, sessionId, costUsd, durationMs }) => {
      // Pre-validate: check output fields BEFORE resolving the slot
      const context = getTaskContext(taskId);
      if (context) {
        const stageConfig = findStageConfig(context, stageName);
        const runtime = stageConfig?.runtime as AgentRuntimeConfig | undefined;
        const writes = runtime?.writes ?? [];
        const validation = validateStageOutput(resultText, writes);
        if (!validation.valid) {
          return textResult(JSON.stringify({
            error: "Output validation failed",
            reason: validation.reason,
            missingFields: validation.missing,
            expectedFields: writes,
          }, null, 2), true);
        }
      }

      const resolved = resolveSlot(taskId, stageName, {
        resultText,
        sessionId,
        costUsd: costUsd ?? 0,
        durationMs: durationMs ?? 0,
      }, nonce);

      if (!resolved) {
        return textResult(JSON.stringify({ error: `No pending edge slot for ${taskId}::${stageName}. It may have timed out or already been resolved.` }), true);
      }

      taskLogger(taskId).info({ stageName }, "Edge agent submitted stage result via MCP");

      return textResult(JSON.stringify({ ok: true, completed: stageName }, null, 2));
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
    },
    async ({ taskId, stageName, type, data }) => {
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
    },
    async ({ taskId, path }) => {
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
    },
    async ({ taskId }) => {
      const context = getTaskContext(taskId);
      if (!context) {
        return textResult(JSON.stringify({ interrupted: true, reason: "Task not found" }));
      }
      const interrupted = context.status === "cancelled" || context.status === "blocked";
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

      return textResult(JSON.stringify({
        taskId,
        pipeline,
        edgeStages,
      }, null, 2));
    },
  );

  // --- get_task_status ---
  server.tool(
    "get_task_status",
    "Get the current status of a workflow task",
    {
      taskId: z.string().describe("The task ID"),
    },
    async ({ taskId }) => {
      const context = getTaskContext(taskId);
      if (!context) {
        return textResult(JSON.stringify({ error: `Task ${taskId} not found` }), true);
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
      }, null, 2));
    },
  );

  // --- retry_task ---
  server.tool(
    "retry_task",
    "Retry a blocked/cancelled/running task from its last stage. Returns immediately — the runner handles stage transitions.",
    {
      taskId: z.string().describe("The task ID"),
      sync: z.boolean().optional().describe("Use sync retry mode (resumes same session) when available"),
    },
    async ({ taskId, sync }) => {
      const result = retryTask(taskId, { sync });
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
      decision: z.enum(["approve", "reject", "feedback"]).describe("User's decision"),
      reason: z.string().optional().describe("Reason for rejection (when decision is 'reject')"),
      feedback: z.string().optional().describe("User feedback to send back to the previous agent stage (when decision is 'feedback')"),
      repoName: z.string().optional().describe("Repository name override (when decision is 'approve')"),
    },
    async ({ taskId, decision, reason, feedback, repoName }) => {
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

      return textResult(JSON.stringify({ ok: true, decision, gate: gateStageName }, null, 2));
    },
  );

  // --- cancel_task ---
  server.tool(
    "cancel_task",
    "Cancel a running or blocked task. Stops agent execution and transitions to cancelled state.",
    {
      taskId: z.string().describe("The task ID"),
    },
    async ({ taskId }) => {
      const result = await cancelTask_(taskId);
      return actionToTextResult(result);
    },
  );

  // --- interrupt_task ---
  server.tool(
    "interrupt_task",
    "Force-interrupt a running task. Transitions to blocked state and aborts the active agent. Use retry_task to resume after fixing issues.",
    {
      taskId: z.string().describe("The task ID"),
      message: z.string().optional().describe("Reason for interruption"),
    },
    async ({ taskId, message }) => {
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
    },
    async ({ taskId }) => {
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
