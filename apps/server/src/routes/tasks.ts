import { Hono } from "hono";
import { getAllWorkflows, getWorkflow, restoreWorkflow, loadAllPersistedTaskIds, getLatestSessionId, sendEvent } from "../machine/workflow.js";
import { questionManager } from "../lib/question-manager.js";
import { sseManager } from "../sse/manager.js";
import { taskLogger } from "../lib/logger.js";
import { getNestedValue } from "../lib/config-loader.js";
import { validateBody, getValidatedBody, interruptSchema, taskConfigUpdateSchema } from "../middleware/validate.js";
import { z } from "zod";
import { errorResponse, ErrorCode } from "../lib/error-response.js";
import { sendMessage, interruptTask } from "../actions/task-actions.js";
import { actionToResponse } from "./action-helpers.js";
import { deriveCurrentStage, deriveUpdatedAt, isConfigEditable } from "../lib/task-view-helpers.js";
import { loadEvents } from "../machine/workflow-events.js";

export const tasksRoute = new Hono();

// --- Routes ---

// 1. List all tasks (With Heavy Guardrails)
tasksRoute.get("/tasks", (c) => {
  const log = taskLogger("system", "route:tasks");
  try {
    const failedRestores: { id: string; reason: string }[] = [];
    for (const id of loadAllPersistedTaskIds(50)) {
      try {
        if (!getWorkflow(id)) {
          const restored = restoreWorkflow(id);
          if (!restored) {
            failedRestores.push({ id, reason: "Task snapshot could not be restored" });
          }
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log.error({ taskId: id, err }, `Failed to restore task ${id}`);
        failedRestores.push({ id, reason });
      }
    }

    const workflows = getAllWorkflows();
    const tasks = [];

    for (const [id, actor] of workflows.entries()) {
      try {
        const snap = actor.getSnapshot();
        if (!snap || !snap.context) continue;

        const ctx = snap.context;
        const pipeline = ctx.config?.pipeline;
        const titlePath = pipeline?.display?.title_path;
        const pendingQuestion = questionManager.getPersistedPending(id);
        tasks.push({
          id,
          taskText: ctx.taskText,
          status: ctx.status || "unknown",
          currentStage: deriveCurrentStage(ctx),
          sessionId: getLatestSessionId(ctx),
          branch: ctx.branch,
          error: ctx.error,
          totalCostUsd: ctx.totalCostUsd ?? 0,
          store: ctx.store ?? {},
          displayTitle: titlePath ? getNestedValue(ctx.store, titlePath) ?? id : id,
          updatedAt: deriveUpdatedAt(ctx, pendingQuestion),
          pendingQuestion: !!pendingQuestion,
        });
      } catch (err) {
        log.error({ taskId: id, err }, `Error processing snapshot for task ${id}`);
      }
    }

    return c.json({ tasks, failedRestores });
  } catch (globalErr) {
    log.error({ err: globalErr }, "Global error in GET /tasks");
    return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, "Internal server error");
  }
});

const messageSchema = z.object({
  message: z.string().trim().min(1, { message: "message is required" }),
});

// 2a. Send message to running agent (interrupt + resume with user message)
tasksRoute.post("/tasks/:taskId/message", validateBody(messageSchema, "message is required"), async (c) => {
  const taskId = c.req.param("taskId");
  const { message } = getValidatedBody(c) as { message: string };
  return actionToResponse(c, await sendMessage(taskId, message));
});

// 2b. Force interrupt — transitions to blocked state
tasksRoute.post("/tasks/:taskId/interrupt", validateBody(interruptSchema), async (c) => {
  const taskId = c.req.param("taskId");
  const body = getValidatedBody(c) as { message?: string };
  const message = body.message?.trim() || "User interrupted to edit configuration.";
  return actionToResponse(c, await interruptTask(taskId, message));
});

// 3. Get task config snapshot
tasksRoute.get("/tasks/:taskId/config", (c) => {
  const taskId = c.req.param("taskId");
  const actor = getWorkflow(taskId) ?? restoreWorkflow(taskId);
  if (!actor) return errorResponse(c, 404, ErrorCode.TASK_NOT_FOUND, "Task not found");
  const context = (actor.getSnapshot()).context;
  return c.json({ config: context.config });
});

// 4. Update task config snapshot
tasksRoute.put("/tasks/:taskId/config", validateBody(taskConfigUpdateSchema), async (c) => {
  const taskId = c.req.param("taskId");
  const actor = getWorkflow(taskId) ?? restoreWorkflow(taskId);
  if (!actor) return errorResponse(c, 404, ErrorCode.TASK_NOT_FOUND, "Task not found");
  if (!isConfigEditable(actor.getSnapshot().context.status)) {
    return errorResponse(c, 409, ErrorCode.INVALID_STATE, "Task config can only be edited when the task is idle, blocked, cancelled, completed, or errored");
  }

  const body = getValidatedBody(c) as { config: Record<string, unknown> };

  sendEvent(taskId, { type: "UPDATE_CONFIG", config: body.config as any });

  // Return updated config so frontend can sync without a second fetch
  const snap = actor.getSnapshot();
  return c.json({ ok: true, config: snap.context.config });
});

// 5. Get task detail
tasksRoute.get("/tasks/:taskId", async (c) => {
  const taskId = c.req.param("taskId");
  const actor = getWorkflow(taskId) ?? restoreWorkflow(taskId);
  if (!actor) return errorResponse(c, 404, ErrorCode.TASK_NOT_FOUND, "Task not found");

  const snap = actor.getSnapshot();
  const ctx = snap.context;
  const pipeline = ctx.config?.pipeline;
  const titlePath = pipeline?.display?.title_path;
  const summaryPath = pipeline?.display?.completion_summary_path;
  const pendingQuestion = questionManager.getPersistedPending(taskId);

  return c.json({
    id: taskId,
    taskText: ctx.taskText,
    status: ctx.status,
    currentStage: deriveCurrentStage(ctx),
    sessionId: getLatestSessionId(ctx),
    branch: ctx.branch,
    worktreePath: ctx.worktreePath,
    error: ctx.error,
    retryCount: ctx.retryCount,
    stageSessionIds: ctx.stageSessionIds,
    stageCwds: ctx.stageCwds,
    pendingQuestion,
    totalCostUsd: ctx.totalCostUsd ?? 0,
    totalTokenUsage: ctx.totalTokenUsage,
    stageTokenUsages: ctx.stageTokenUsages,
    config: ctx.config,
    store: ctx.store ?? {},
    pipelineSchema: ctx.config?.pipeline?.stages,
    displayTitle: titlePath ? getNestedValue(ctx.store, titlePath) ?? taskId : taskId,
    completionSummary: summaryPath ? getNestedValue(ctx.store, summaryPath) : undefined,
    updatedAt: deriveUpdatedAt(ctx, pendingQuestion),
  });
});

// 6. Get task event timeline
tasksRoute.get("/tasks/:taskId/events", (c) => {
  const taskId = c.req.param("taskId");
  const events = loadEvents(taskId);
  return c.json({ taskId, events });
});
