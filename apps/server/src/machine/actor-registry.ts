import { createActor } from "xstate";
import { existsSync, unlinkSync } from "node:fs";
import type { WorkflowContext, WorkflowEvent } from "./types.js";
import { createWorkflowMachine } from "./machine.js";
import { registerSideEffects } from "./side-effects.js";
import { persistSnapshot, flushSnapshotSync, loadSnapshot, snapshotPath, pipelineFingerprint } from "./persistence.js";
import { sseManager } from "../sse/manager.js";
import { questionManager } from "../lib/question-manager.js";
import { cancelTask } from "../agent/query-tracker.js";
import { taskLogger } from "../lib/logger.js";
import { safeFire } from "../lib/safe-fire.js";
import { taskListBroadcaster } from "../sse/task-list-broadcaster.js";
import { loadPipelineConfig, flattenStages } from "../lib/config-loader.js";
import { snapshotGlobalConfig } from "./workflow-lifecycle.js";

// --- Types ---

export interface WorkflowActor {
  getSnapshot(): { value: string; status: string; context: WorkflowContext };
  getPersistedSnapshot(): unknown;
  subscribe(fn: (snap: { value: string; status: string; context: WorkflowContext }) => void): { unsubscribe(): void };
  send(event: WorkflowEvent): void;
  start(): void;
  stop(): void;
}

// --- Actor Registry ---

const actors = new Map<string, WorkflowActor>();
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

const ACTOR_CLEANUP_DELAY_MS = 5 * 60 * 1000;

function scheduleActorCleanup(taskId: string): void {
  const actor = actors.get(taskId);
  if (actor) flushSnapshotSync(taskId, actor);
  const existing = cleanupTimers.get(taskId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    cleanupTimers.delete(taskId);
    const existing = actors.get(taskId);
    if (existing) {
      const snap = existing.getSnapshot();
      if (snap.status === "done") {
        actors.delete(taskId);
        sseManager.closeStream(taskId);
      }
    }
  }, ACTOR_CLEANUP_DELAY_MS);
  cleanupTimers.set(taskId, timer);
}

function subscribeForPersistence(taskId: string, actor: WorkflowActor): void {
  actor.subscribe((snapshot: any) => {
    safeFire(persistSnapshot(taskId, actor), taskId, "persist snapshot failed");
    if (snapshot.status === "done") {
      scheduleActorCleanup(taskId);
    }
  });
}

export function deleteWorkflow(taskId: string): boolean {
  cancelTask(taskId);
  const timer = cleanupTimers.get(taskId);
  if (timer) { clearTimeout(timer); cleanupTimers.delete(taskId); }
  const actor = actors.get(taskId);
  if (actor) {
    actor.stop();
    actors.delete(taskId);
  }
  const p = snapshotPath(taskId);
  try { if (existsSync(p)) unlinkSync(p); } catch { /* best-effort */ }
  sseManager.closeStream(taskId);
  questionManager.cancelForTask(taskId);
  taskListBroadcaster.broadcastTaskRemoval(taskId);
  return true;
}

// --- Task Creation ---

export function createTaskDraft(
  taskId: string,
  repoName?: string,
  pipelineName?: string,
  taskText?: string,
  options?: { edge?: boolean; initialStore?: Record<string, any>; worktreePath?: string; branch?: string },
): WorkflowActor {
  const config = snapshotGlobalConfig(pipelineName);

  if (options?.edge) {
    config.pipeline.default_execution_mode = "edge";
  }

  const machine = createWorkflowMachine(config.pipeline);

  const actor = createActor(machine, {
    inspect: (event) => {
      if (event.type === "@xstate.snapshot") {
        const snap = event.snapshot as { value?: unknown; context?: WorkflowContext };
        taskLogger(taskId, "xstate").info({ state: snap.value, status: snap.context?.status }, "state transition");
      }
    },
  }) as unknown as WorkflowActor;

  actors.set(taskId, actor);
  registerSideEffects(actor as unknown as Parameters<typeof registerSideEffects>[0]);
  subscribeForPersistence(taskId, actor);
  actor.start();

  actor.send({
    type: "START_ANALYSIS",
    taskId,
    taskText,
    repoName,
    config,
    initialStore: options?.initialStore,
    worktreePath: options?.worktreePath,
    branch: options?.branch,
  });
  taskListBroadcaster.broadcastTaskUpdate(taskId);

  return actor;
}

export function launchTask(taskId: string): boolean {
  const actor = actors.get(taskId);
  if (!actor) return false;
  if (actor.getSnapshot().value !== "idle") return false;
  actor.send({ type: "LAUNCH" });
  return true;
}

export function startWorkflow(taskId: string, repoName?: string, pipelineName?: string, taskText?: string): WorkflowActor {
  const actor = createTaskDraft(taskId, repoName, pipelineName, taskText);
  launchTask(taskId);
  return actor;
}

// --- Task Restore ---

export function restoreWorkflow(taskId: string): WorkflowActor | undefined {
  if (actors.has(taskId)) return actors.get(taskId);
  let snapshot = loadSnapshot(taskId) as { value?: string; context?: WorkflowContext } | undefined;
  if (!snapshot) return undefined;

  if (snapshot.context && !snapshot.context.stageSessionIds) {
    (snapshot.context as WorkflowContext).stageSessionIds = {};
  }

  if (!snapshot.context?.config?.pipeline) {
    taskLogger(taskId).warn("restore: skipping legacy snapshot without embedded pipeline config");
    return undefined;
  }

  if (snapshot.value && snapshot.context) {
    const invokeStages = new Set(
      flattenStages(snapshot.context.config.pipeline.stages)
        .filter((s) => s.type === "agent" || s.type === "script" || s.type === "pipeline" || s.type === "foreach")
        .map((s) => s.name)
    );
    if (invokeStages.has(snapshot.value)) {
      const originalState = snapshot.value;
      taskLogger(taskId).warn({ oldState: originalState }, "restore: migrating invoke state to blocked");
      snapshot = {
        ...snapshot,
        value: "blocked",
        context: {
          ...snapshot.context,
          status: "blocked",
          lastStage: originalState,
          error: `Server restarted during ${originalState}. Use Retry to re-execute.`,
        },
      };
    }
  }

  const ctx = snapshot.context;
  if (ctx?.worktreePath && !existsSync(ctx.worktreePath)) {
    taskLogger(taskId).error({ worktreePath: ctx.worktreePath }, "restore: worktree missing");
    return undefined;
  }

  try {
    const pipeline = snapshot.context!.config!.pipeline;
    const currentPipeline = loadPipelineConfig();
    if (currentPipeline) {
      const snapshotFp = pipelineFingerprint(pipeline);
      const currentFp = pipelineFingerprint(currentPipeline);
      if (snapshotFp !== currentFp) {
        taskLogger(taskId).warn({ snapshotFp, currentFp }, "restore: pipeline mismatch, snapshot uses its own embedded pipeline (safe)");
      }
    }
    const machine = createWorkflowMachine(pipeline);

    const actor = createActor(machine, { snapshot: snapshot as any }) as unknown as WorkflowActor;
    actors.set(taskId, actor);
    registerSideEffects(actor as unknown as Parameters<typeof registerSideEffects>[0]);
    subscribeForPersistence(taskId, actor);
    actor.start();

    return actor;
  } catch (err) {
    taskLogger(taskId).error({ err }, "restore: failed to rebuild workflow machine from snapshot, skipping");
    return undefined;
  }
}

// --- Accessors ---

export function sendEvent(taskId: string, event: WorkflowEvent): boolean {
  const actor = actors.get(taskId);
  if (!actor) return false;
  actor.send(event);
  return true;
}

export function getWorkflow(taskId: string): WorkflowActor | undefined { return actors.get(taskId); }
export function getAllWorkflows(): Map<string, WorkflowActor> { return actors; }

// Inject providers into taskListBroadcaster to break circular dependency (sse -> machine)
taskListBroadcaster.setProviders({
  getWorkflow,
  getAllWorkflows,
  restoreWorkflow,
});
