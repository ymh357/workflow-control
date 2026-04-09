import { sendEvent, getWorkflow, getAllWorkflows, restoreWorkflow, deleteWorkflow, createTaskDraft, launchTask } from "../machine/actor-registry.js";
import { cancelTask, queueInterruptMessage, interruptActiveQuery, getActiveQueryInfo } from "../agent/executor.js";
import { questionManager } from "../lib/question-manager.js";
import { taskLogger, logger } from "../lib/logger.js";
import type { WorkflowContext } from "../machine/types.js";
import { type ErrorCodeValue } from "../lib/error-response.js";
import { flattenStages } from "../lib/config-loader.js";
import { execFile } from "node:child_process";
import path from "node:path";

// --- Result types ---

export type ActionResult<T = Record<string, unknown>> =
  | { ok: true; data: T }
  | { ok: false; code: ActionErrorCode; message: string };

export type ActionErrorCode = Extract<
  ErrorCodeValue,
  "TASK_NOT_FOUND" | "INVALID_STATE" | "VALIDATION_FAILED" | "INVALID_CONFIG" | "INTERNAL_ERROR" | "QUESTION_NOT_FOUND" | "QUESTION_STALE"
>;

function fail(code: ActionErrorCode, message: string): ActionResult<never> {
  return { ok: false, code, message };
}

function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

// --- Helpers ---

function getActor(taskId: string) {
  return getWorkflow(taskId) ?? restoreWorkflow(taskId);
}

function getContext(taskId: string): WorkflowContext | null {
  const actor = getActor(taskId);
  if (!actor) return null;
  return actor.getSnapshot().context;
}

function canInterruptStatus(status: string): boolean {
  return !["idle", "blocked", "cancelled", "completed", "error"].includes(status);
}

async function cleanupDeletedWorktree(taskId: string, worktreePath?: string): Promise<void> {
  if (!worktreePath) return;
  if (!path.isAbsolute(worktreePath) || worktreePath.includes("..")) return;
  await new Promise<void>((resolve) => {
    execFile("git", ["worktree", "remove", "--force", "--", worktreePath], { timeout: 30_000 }, (err) => {
      if (err) {
        taskLogger(taskId).warn({ err, worktreePath }, "delete: worktree cleanup failed");
      }
      resolve();
    });
  });
}

export function getTaskContext(taskId: string): WorkflowContext | null {
  return getContext(taskId);
}

// --- Actions ---

export function confirmGate(
  taskId: string,
  opts?: { repoName?: string },
): ActionResult<{ statusBefore: string; statusAfter: string }> {
  const ctx = getContext(taskId);
  if (!ctx) return fail("TASK_NOT_FOUND", `Task ${taskId} not found`);

  const stages = ctx.config?.pipeline?.stages ? flattenStages(ctx.config.pipeline.stages) : [];
  const isGate = stages.some((s) => s.name === ctx.status && s.type === "human_confirm");
  if (!isGate) return fail("INVALID_STATE", `Task is not awaiting confirmation (status: ${ctx.status})`);

  const statusBefore = ctx.status;
  sendEvent(taskId, { type: "CONFIRM", ...(opts?.repoName ? { repoName: opts.repoName } : {}) });
  const statusAfter = getContext(taskId)?.status ?? "unknown";

  // Idempotency: if status didn't change, the event was likely a duplicate
  if (statusAfter === statusBefore) {
    taskLogger(taskId, "action:confirm").warn({ statusBefore }, "Confirm had no effect — gate may already be resolved");
  }

  return ok({ statusBefore, statusAfter });
}

export function rejectGate(
  taskId: string,
  opts: { reason?: string; feedback?: string; targetStage?: string },
): ActionResult<{ statusBefore: string; statusAfter: string }> {
  const ctx = getContext(taskId);
  if (!ctx) return fail("TASK_NOT_FOUND", `Task ${taskId} not found`);

  const stages = ctx.config?.pipeline?.stages ? flattenStages(ctx.config.pipeline.stages) : [];
  const isGate = stages.some((s) => s.name === ctx.status && s.type === "human_confirm");
  if (!isGate) return fail("INVALID_STATE", `Task is not awaiting confirmation (status: ${ctx.status})`);

  if (opts.feedback && !opts.feedback.trim()) {
    return fail("VALIDATION_FAILED", "feedback text is required when decision is 'feedback'");
  }

  const statusBefore = ctx.status;
  if (opts.feedback) {
    sendEvent(taskId, { type: "REJECT_WITH_FEEDBACK", feedback: opts.feedback, ...(opts.targetStage ? { targetStage: opts.targetStage } : {}) });
  } else {
    sendEvent(taskId, { type: "REJECT", reason: opts.reason, ...(opts.targetStage ? { targetStage: opts.targetStage } : {}) });
  }
  const statusAfter = getContext(taskId)?.status ?? "unknown";

  // Idempotency: if status didn't change, the event was likely a duplicate
  if (statusAfter === statusBefore) {
    taskLogger(taskId, "action:reject").warn({ statusBefore }, "Reject had no effect — gate may already be resolved");
  }

  return ok({ statusBefore, statusAfter });
}

export function retryTask(
  taskId: string,
  opts?: { sync?: boolean; fromStage?: string },
): ActionResult<{ lastStage: string | undefined; statusAfter: string }> {
  const actor = getActor(taskId);
  if (!actor) return fail("TASK_NOT_FOUND", `Task ${taskId} not found`);

  const snap = actor.getSnapshot();
  const status = snap.context.status;
  const ctx = snap.context;
  const terminalStates = ["completed", "error"];

  if (terminalStates.includes(status)) {
    return fail("INVALID_STATE", `Cannot retry terminal state: ${status}`);
  }

  if (status === "blocked") {
    const lastStage = ctx.lastStage;

    if (opts?.fromStage) {
      sendEvent(taskId, { type: "RETRY_FROM", fromStage: opts.fromStage });
      const after = actor.getSnapshot();
      const statusAfter = after.context.status;
      if (statusAfter === "blocked") {
        return fail("INVALID_STATE", `Cannot retry from stage "${opts.fromStage}"`);
      }
      return ok({ lastStage, statusAfter });
    }

    const sessionId = lastStage && ctx.stageSessionIds?.[lastStage];

    if (opts?.sync && sessionId) {
      if (!sendEvent(taskId, { type: "SYNC_RETRY", sessionId })) {
        return fail("INTERNAL_ERROR", "Failed to send event to workflow");
      }
    } else {
      if (!sendEvent(taskId, { type: "RETRY" })) {
        return fail("INTERNAL_ERROR", "Failed to send event to workflow");
      }
    }

    const newSnap = actor.getSnapshot();
    if (newSnap.context.status === "blocked") {
      return fail("INVALID_STATE", `Stage "${ctx.lastStage}" is not retryable`);
    }
    return ok({ lastStage, statusAfter: newSnap.context.status });
  }

  if (status === "cancelled") {
    sendEvent(taskId, { type: "RESUME" });
    const newSnap = actor.getSnapshot();
    if (newSnap.context.status === "cancelled") {
      return fail("INVALID_STATE", `Stage "${ctx.lastStage}" is not resumable`);
    }
    return ok({ lastStage: ctx.lastStage, statusAfter: newSnap.context.status });
  }

  // Running/stale: kill agent, interrupt, then retry
  logger.info({ taskId: taskId.slice(0, 8), status }, "retry: killing stale agent and forcing retry");
  cancelTask(taskId);
  sendEvent(taskId, { type: "INTERRUPT", reason: "Force retry requested" });
  const snapAfterInterrupt = actor.getSnapshot();
  if (snapAfterInterrupt.context.status !== "blocked") {
    return fail("INVALID_STATE", "Failed to interrupt task for retry");
  }
  if (opts?.fromStage) {
    sendEvent(taskId, { type: "RETRY_FROM", fromStage: opts.fromStage });
  } else {
    sendEvent(taskId, { type: "RETRY" });
  }

  return ok({ lastStage: ctx.lastStage, statusAfter: actor.getSnapshot().context.status });
}

export async function cancelTask_(taskId: string): Promise<ActionResult<void>> {
  const actor = getActor(taskId);
  if (!actor) return fail("TASK_NOT_FOUND", `Task ${taskId} not found`);

  const status = actor.getSnapshot().context.status;
  const terminalStates = ["completed", "error", "cancelled"];
  if (terminalStates.includes(status)) {
    return fail("INVALID_STATE", `Task already in terminal state: ${status}`);
  }

  sendEvent(taskId, { type: "CANCEL" });

  // Wait for state machine to reach cancelled before aborting agent
  const reached = await new Promise<boolean>((resolve) => {
    let sub: { unsubscribe(): void } | undefined;
    const timeout = setTimeout(() => { sub?.unsubscribe(); resolve(false); }, 3000);
    const currentSnap = actor.getSnapshot();
    if (currentSnap.context?.status === "cancelled") {
      clearTimeout(timeout);
      resolve(true);
      return;
    }
    sub = actor.subscribe((snap: { context?: { status?: string } }) => {
      if (snap.context?.status === "cancelled") {
        sub!.unsubscribe();
        clearTimeout(timeout);
        resolve(true);
      }
    });
  });

  cancelTask(taskId);

  // Cascade: cancel any sub-tasks spawned by pipeline-call or foreach stages.
  // Sub-task IDs follow the convention: `{parentTaskId}-sub-{...}`
  cancelSubTasks(taskId);

  if (!reached) {
    taskLogger(taskId).warn("Cancel timed out waiting for state machine — agent was force-killed");
  }

  return ok(undefined as unknown as void);
}

/**
 * Best-effort cancel all sub-tasks whose ID starts with `{parentTaskId}-sub-`.
 * This covers both pipeline-call sub-tasks and foreach item sub-tasks.
 */
function cancelSubTasks(parentTaskId: string): void {
  const prefix = `${parentTaskId}-sub-`;
  const terminalStates = new Set(["completed", "error", "cancelled"]);
  const log = taskLogger(parentTaskId);
  let cleaned = 0;

  for (const [childId, actor] of getAllWorkflows()) {
    if (!childId.startsWith(prefix)) continue;
    const status = actor.getSnapshot().context?.status;
    if (status && !terminalStates.has(status)) {
      try {
        sendEvent(childId, { type: "CANCEL" });
        cancelTask(childId);
        cleaned++;
      } catch {
        // Best-effort — don't propagate cleanup failures
      }
    }
  }

  if (cleaned > 0) {
    log.info({ cleaned }, "Cancelled dangling sub-tasks");
  }
}

export function resumeTask(taskId: string): ActionResult<{ statusAfter: string }> {
  const actor = getActor(taskId);
  if (!actor) return fail("TASK_NOT_FOUND", `Task ${taskId} not found`);

  const snap = actor.getSnapshot();
  const status = snap.context.status;

  if (status === "cancelled") {
    sendEvent(taskId, { type: "RESUME" });
    const newSnap = actor.getSnapshot();
    if (newSnap.context.status === "cancelled") {
      return fail("INVALID_STATE", `Stage "${snap.context.lastStage}" is not resumable`);
    }
    return ok({ statusAfter: newSnap.context.status });
  }

  if (status === "blocked") {
    sendEvent(taskId, { type: "RETRY" });
    const newSnap = actor.getSnapshot();
    if (newSnap.context.status === "blocked") {
      return fail("INVALID_STATE", `Stage "${snap.context.lastStage}" is not retryable`);
    }
    return ok({ statusAfter: newSnap.context.status });
  }

  return fail("INVALID_STATE", `Cannot resume from status: ${status}`);
}

export async function interruptTask(
  taskId: string,
  message?: string,
): Promise<ActionResult<void>> {
  const actor = getActor(taskId);
  if (!actor) return fail("TASK_NOT_FOUND", `Task ${taskId} not found`);
  const status = actor.getSnapshot().context.status;
  if (!canInterruptStatus(status)) {
    return fail("INVALID_STATE", `Cannot interrupt task from status: ${status}`);
  }

  const reason = message?.trim() || "Interrupted by user";
  const statusBefore = status;
  sendEvent(taskId, { type: "INTERRUPT", reason });
  const statusAfter = actor.getSnapshot().context.status;

  const info = getActiveQueryInfo(taskId);
  if (info) {
    await interruptActiveQuery(taskId);
  }

  if (!info && statusAfter === statusBefore) {
    return fail("INVALID_STATE", `Interrupt had no effect from status: ${statusBefore}`);
  }

  return ok(undefined as unknown as void);
}

export async function sendMessage(
  taskId: string,
  message: string,
): Promise<ActionResult<void>> {
  if (!message.trim()) return fail("VALIDATION_FAILED", "message is required");

  const actor = getActor(taskId);
  if (!actor) return fail("TASK_NOT_FOUND", `Task ${taskId} not found`);
  const statusBefore = actor.getSnapshot().context.status;
  if (!canInterruptStatus(statusBefore)) {
    return fail("INVALID_STATE", `Cannot send message from status: ${statusBefore}`);
  }

  const log = taskLogger(taskId, "action:message");
  const info = getActiveQueryInfo(taskId);

  if (info?.sessionId) {
    const queued = queueInterruptMessage(taskId, message);
    if (!queued) return fail("INTERNAL_ERROR", "Failed to queue message");
    log.info({ sessionId: info.sessionId }, "Queued user message, interrupting active query");
    await interruptActiveQuery(taskId);
  } else {
    log.info("No sessionId available, falling back to INTERRUPT event");
    actor.send({ type: "INTERRUPT", reason: message });
    await interruptActiveQuery(taskId).catch(() => {});
    const statusAfter = actor.getSnapshot().context.status;
    if (statusAfter === statusBefore) {
      return fail("INVALID_STATE", `Message interrupt had no effect from status: ${statusBefore}`);
    }
  }

  return ok(undefined as unknown as void);
}

export function answerQuestion(
  taskId: string,
  questionId: string,
  answer: string,
): ActionResult<void> {
  const answered = questionManager.answer(questionId, answer, taskId);
  if (answered === "stale") {
    return fail("QUESTION_STALE", "Question was persisted but the agent session is gone (server restarted). Retry the stage instead.");
  }
  if (!answered) {
    return fail("QUESTION_NOT_FOUND", "Question not found or already answered");
  }
  return ok(undefined as unknown as void);
}

export async function deleteTask(taskId: string): Promise<ActionResult<void>> {
  const actor = getActor(taskId);
  if (!actor) return fail("TASK_NOT_FOUND", `Task ${taskId} not found`);

  const snap = actor.getSnapshot();
  const { status, worktreePath } = snap.context;
  if (!["completed", "error", "cancelled"].includes(status)) {
    const cancelled = await cancelTask_(taskId);
    if (!cancelled.ok && cancelled.code !== "INVALID_STATE") {
      return cancelled;
    }
  } else {
    cancelSubTasks(taskId);
    cancelTask(taskId);
  }

  await cleanupDeletedWorktree(taskId, worktreePath);
  deleteWorkflow(taskId);
  return ok(undefined as unknown as void);
}

export function createTask(
  opts: { taskText: string; repoName?: string; pipelineName?: string; edge?: boolean },
): ActionResult<{ taskId: string }> {
  if (!opts.taskText) {
    return fail("VALIDATION_FAILED", "taskText is required");
  }
  const taskId = crypto.randomUUID();
  try {
    createTaskDraft(taskId, opts.repoName, opts.pipelineName, opts.taskText, opts.edge ? { edge: true } : undefined);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Task creation failed";
    if (msg.includes("already in progress") || msg.includes("already exists")) {
      return fail("INVALID_STATE", msg);
    }
    if (msg.toLowerCase().includes("not found")) {
      return fail("INVALID_CONFIG", msg);
    }
    return fail("INTERNAL_ERROR", msg);
  }
  return ok({ taskId });
}

export function launch(taskId: string): ActionResult<void> {
  const actor = getActor(taskId);
  if (!actor) return fail("TASK_NOT_FOUND", "Task not found");
  const snap = actor.getSnapshot();
  const isIdle = snap.value === "idle" || snap.context.status === "idle";
  if (!isIdle) {
    return fail("INVALID_STATE", "Task is already launched or not in draft state");
  }
  const launched = launchTask(taskId);
  if (!launched) return fail("INTERNAL_ERROR", "Failed to launch task");
  return ok(undefined as unknown as void);
}
