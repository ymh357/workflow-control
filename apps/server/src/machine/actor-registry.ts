import { createActor } from "xstate";
import { existsSync, unlinkSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
import { loadPipelineConfig, flattenStages, loadSystemSettings } from "../lib/config-loader.js";
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
const MAX_ACTORS = 200;
const STALE_ACTOR_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const STALE_ACTOR_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour for non-terminal actors with no updates

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

export function sweepStaleActors(): void {
  const terminalStates = new Set(["completed", "error", "cancelled"]);
  const now = Date.now();
  const toRemove: string[] = [];

  // First pass: identify terminal actors
  for (const [taskId, actor] of actors) {
    try {
      const snap = actor.getSnapshot();
      if (terminalStates.has(snap.context?.status)) {
        flushSnapshotSync(taskId, actor);
        toRemove.push(taskId);
      }
    } catch {
      toRemove.push(taskId);
    }
  }

  // Remove collected
  for (const taskId of toRemove) {
    const actor = actors.get(taskId);
    if (actor) actor.stop();
    actors.delete(taskId);
    sseManager.closeStream(taskId);
    const timer = cleanupTimers.get(taskId);
    if (timer) { clearTimeout(timer); cleanupTimers.delete(taskId); }
  }

  // Second pass: blocked actors older than max age
  if (actors.size >= MAX_ACTORS) {
    const staleBlocked: string[] = [];
    for (const [taskId, actor] of actors) {
      try {
        const snap = actor.getSnapshot();
        const ctx = snap.context;
        if (ctx?.status === "blocked") {
          const updated = ctx.updatedAt ? new Date(ctx.updatedAt).getTime() : 0;
          if (now - updated > STALE_ACTOR_MAX_AGE_MS) {
            flushSnapshotSync(taskId, actor);
            staleBlocked.push(taskId);
          }
        }
      } catch {
        staleBlocked.push(taskId);
      }
    }
    for (const taskId of staleBlocked) {
      const actor = actors.get(taskId);
      if (actor) actor.stop();
      actors.delete(taskId);
      sseManager.closeStream(taskId);
    }
  }

  // Third pass: running actors with no updates for > 2 hours (likely stuck)
  if (actors.size >= MAX_ACTORS) {
    const stuckRunning: string[] = [];
    const STUCK_RUNNING_MAX_AGE_MS = 2 * 60 * 60 * 1000;
    for (const [taskId, actor] of actors) {
      try {
        const snap = actor.getSnapshot();
        const ctx = snap.context;
        if (ctx?.status && !terminalStates.has(ctx.status) && ctx.status !== "blocked" && ctx.status !== "idle") {
          const updated = ctx.updatedAt ? new Date(ctx.updatedAt).getTime() : 0;
          if (now - updated > STUCK_RUNNING_MAX_AGE_MS) {
            flushSnapshotSync(taskId, actor);
            stuckRunning.push(taskId);
          }
        }
      } catch {
        stuckRunning.push(taskId);
      }
    }
    for (const taskId of stuckRunning) {
      const actor = actors.get(taskId);
      if (actor) actor.stop();
      actors.delete(taskId);
      sseManager.closeStream(taskId);
    }
  }
}

const sweepTimer = setInterval(sweepStaleActors, STALE_ACTOR_SWEEP_INTERVAL_MS);

export function stopSweepTimer(): void {
  clearInterval(sweepTimer);
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

// --- Pipeline Index (O7: fast store inheritance lookup) ---

function readPipelineIndex(dataDir: string): Record<string, { taskId: string; completedAt: string }> {
  const indexPath = join(dataDir, "tasks", "_pipeline_index.json");
  try {
    return JSON.parse(readFileSync(indexPath, "utf-8"));
  } catch {
    return {};
  }
}

// Pipeline index is updated by side-effects.ts on task completion.
// readPipelineIndex is used by resolveInheritedStore below.

// --- Store Inheritance ---

function extractInheritedKeys(
  sourceStore: Record<string, any>,
  inheritKeys: string[] | "*",
): Record<string, any> {
  if (inheritKeys === "*") return { ...sourceStore };
  const inherited: Record<string, any> = {};
  for (const key of inheritKeys) {
    if (sourceStore[key] !== undefined) {
      inherited[key] = sourceStore[key];
      const summaryKey = `${key}.__semantic_summary`;
      if (sourceStore[summaryKey] !== undefined) inherited[summaryKey] = sourceStore[summaryKey];
      const mechanicalKey = `${key}.__summary`;
      if (sourceStore[mechanicalKey] !== undefined) inherited[mechanicalKey] = sourceStore[mechanicalKey];
    }
  }
  return inherited;
}

export function resolveInheritedStore(
  pipelineName: string | undefined,
  storePersistence: { inherit_from: string; inherit_keys: string[] | "*" } | undefined,
): Record<string, any> {
  if (!pipelineName || !storePersistence || storePersistence.inherit_from === "none") return {};

  try {
    const settings = loadSystemSettings();
    const dataDir = settings.paths?.data_dir || "/tmp/workflow-control-data";

    // Fast path: use pipeline index
    const index = readPipelineIndex(dataDir);
    const entry = index[pipelineName];

    if (entry) {
      try {
        const snapshotFile = join(dataDir, "tasks", `${entry.taskId}.json`);
        const raw = JSON.parse(readFileSync(snapshotFile, "utf-8"));
        const snap = raw?.persistedSnapshot ?? raw;
        const ctx = snap?.context;
        if (ctx?.status === "completed" && ctx.store) {
          return extractInheritedKeys(ctx.store, storePersistence.inherit_keys);
        }
      } catch {
        // Index entry stale, fall through to scan
      }
    }

    // Fallback: directory scan (first run or stale index)
    const tasksDir = join(dataDir, "tasks");
    let files: string[];
    try {
      files = readdirSync(tasksDir).filter(f => f.endsWith(".json") && !f.startsWith("_")).sort().reverse();
    } catch {
      return {};
    }

    for (const file of files) {
      try {
        const raw = JSON.parse(readFileSync(join(tasksDir, file), "utf-8"));
        const snap = raw?.persistedSnapshot ?? raw;
        const ctx = snap?.context;
        if (!ctx || ctx.status !== "completed") continue;
        if (ctx.config?.pipelineName !== pipelineName) continue;
        return extractInheritedKeys(ctx.store ?? {}, storePersistence.inherit_keys);
      } catch {
        continue;
      }
    }
  } catch (err) {
    taskLogger("system").warn({ err, pipelineName }, "Store inheritance scan failed");
  }

  return {};
}

// --- Task Creation ---

export function createTaskDraft(
  taskId: string,
  repoName?: string,
  pipelineName?: string,
  taskText?: string,
  options?: { edge?: boolean; initialStore?: Record<string, any>; worktreePath?: string; branch?: string },
): WorkflowActor {
  if (actors.size >= MAX_ACTORS) {
    // Evict oldest terminal actors first
    sweepStaleActors();
    if (actors.size >= MAX_ACTORS) {
      throw new Error("Too many active tasks. Delete old tasks before creating new ones.");
    }
  }

  const config = snapshotGlobalConfig(pipelineName);

  if (options?.edge) {
    config.pipeline.default_execution_mode = "edge";
  }

  const inherited = resolveInheritedStore(
    pipelineName ?? config.pipelineName,
    config.pipeline.store_persistence,
  );
  const mergedInitialStore = { ...inherited, ...(options?.initialStore ?? {}) };

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
    initialStore: mergedInitialStore,
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
    const currentPipeline = loadPipelineConfig(snapshot.context?.config?.pipelineName ?? "pipeline-generator");
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
