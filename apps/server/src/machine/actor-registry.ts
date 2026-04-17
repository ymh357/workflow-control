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
import { loadPipelineConfig, flattenStages, loadSystemSettings, isParallelGroup } from "../lib/config-loader.js";
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
    if (!existing) return;
    const snap = existing.getSnapshot();
    // XState "done" covers completed/error (type:"final"); our "cancelled" is
    // a custom state (not final), and "blocked" may still be retryable. We
    // only clean up if the task is truly terminal by our own semantics.
    const domainStatus = snap.context?.status;
    const isTerminal = snap.status === "done" || domainStatus === "completed" || domainStatus === "error" || domainStatus === "cancelled";
    if (isTerminal) {
      actors.delete(taskId);
      sseManager.closeStream(taskId);
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
    // Trigger cleanup on XState "done" (terminal final state — i.e. completed/error)
    // AND on our domain-level terminal statuses. `blocked` keeps the actor alive
    // because the user may Retry; the sweepStaleActors path handles truly stale
    // blocked actors after STALE_ACTOR_MAX_AGE_MS.
    const domainStatus = snapshot.context?.status;
    if (snapshot.status === "done" || domainStatus === "completed" || domainStatus === "error" || domainStatus === "cancelled") {
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
  // Clean up per-task caches
  import("../agent/semantic-summary-cache.js").then(({ clearTaskSummaries }) => {
    clearTaskSummaries(taskId);
  }).catch((err) => { taskLogger(taskId).warn({ err }, "Failed to clear summary cache on delete"); });
  import("../agent/stage-executor.js").then(({ clearAppendPromptCache }) => {
    clearAppendPromptCache(taskId);
  }).catch((err) => { taskLogger(taskId).warn({ err }, "Failed to clear prompt cache on delete"); });
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
  if (inheritKeys === "*") {
    // Strip framework-internal sentinels (keys starting with "__") so they
    // don't leak across task boundaries. `__pipeline_depth` in particular
    // would otherwise make the next task start with a non-zero depth counter
    // and hit MAX_PIPELINE_DEPTH (3) well before its own recursion begins.
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(sourceStore)) {
      if (k.startsWith("__")) continue;
      result[k] = v;
    }
    return result;
  }
  const inherited: Record<string, any> = {};
  for (const key of inheritKeys) {
    if (key.startsWith("__")) continue; // explicit allowlist still blocks internals
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
  options?: {
    edge?: boolean;
    initialStore?: Record<string, any>;
    worktreePath?: string;
    branch?: string;
    inlineConfig?: NonNullable<WorkflowContext["config"]>;
  },
): WorkflowActor {
  if (actors.size >= MAX_ACTORS) {
    // Evict oldest terminal actors first
    sweepStaleActors();
    if (actors.size >= MAX_ACTORS) {
      throw new Error("Too many active tasks. Delete old tasks before creating new ones.");
    }
  }

  const config = options?.inlineConfig ?? snapshotGlobalConfig(pipelineName);

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
  // snapshot.value is a string for atomic states but an object like
  // `{ groupName: { child: "__run_child" } }` when an XState parallel state is
  // active. We accept either and branch below.
  let snapshot = loadSnapshot(taskId) as
    | { value?: string | Record<string, unknown>; context?: WorkflowContext }
    | undefined;
  if (!snapshot) return undefined;

  if (snapshot.context && !snapshot.context.stageSessionIds) {
    (snapshot.context as WorkflowContext).stageSessionIds = {};
  }

  // Backfill scratchPad for legacy snapshots — downstream code (MCP append-path)
  // assumes it exists; undefined would make the array default `?? []` orphaned
  // across the rest of the stage.
  if (snapshot.context && !snapshot.context.scratchPad) {
    (snapshot.context as WorkflowContext).scratchPad = [];
  }

  if (!snapshot.context?.config?.pipeline) {
    taskLogger(taskId).warn("restore: skipping legacy snapshot without embedded pipeline config");
    return undefined;
  }

  if (snapshot.value && snapshot.context) {
    // Collect all "mid-execution" state names: invoke stages (agent/script/pipeline/foreach)
    // PLUS parallel group names — the group itself is an XState parallel state whose
    // regions host invoke children. A server restart while a group is active leaves the
    // snapshot.value set to either the group name (single-session mode, which compiles
    // to a single invoke state) OR an object whose top-level key is the group name
    // (multi-session mode, XState parallel state). In both cases, recreating an actor
    // without migration restarts every child from scratch and double-charges work
    // already staged to parallelStagedWrites.
    const flat = flattenStages(snapshot.context.config.pipeline.stages);
    const invokeStages = new Set(
      flat
        .filter((s) => s.type === "agent" || s.type === "script" || s.type === "pipeline" || s.type === "foreach")
        .map((s) => s.name)
    );
    const parallelGroupNames = new Set<string>();
    for (const entry of snapshot.context.config.pipeline.stages) {
      if (isParallelGroup(entry)) parallelGroupNames.add(entry.parallel.name);
    }

    // Determine originalState from either string or object value.
    let originalState: string | undefined;
    let isGroup = false;
    if (typeof snapshot.value === "string") {
      if (invokeStages.has(snapshot.value) || parallelGroupNames.has(snapshot.value)) {
        originalState = snapshot.value;
        isGroup = parallelGroupNames.has(snapshot.value);
      }
    } else if (snapshot.value && typeof snapshot.value === "object") {
      // XState parallel state value has exactly one top-level key per active
      // parallel region. We only expect one active group at a time; if multiple
      // are active somehow, take the first one found in parallelGroupNames.
      for (const key of Object.keys(snapshot.value)) {
        if (parallelGroupNames.has(key)) {
          originalState = key;
          isGroup = true;
          break;
        }
      }
    }
    if (originalState) {
      taskLogger(taskId).warn({ oldState: originalState, isGroup }, "restore: migrating invoke state to blocked");
      // Pre-compute child names for the group being reset (TS can't narrow
      // through nested filter callbacks, so pull the lookup outside).
      const childNamesOfGroup = (() => {
        if (!isGroup) return new Set<string>();
        const groupEntry = snapshot.context.config.pipeline.stages.find(
          (e) => isParallelGroup(e) && e.parallel.name === originalState,
        );
        if (!groupEntry || !isParallelGroup(groupEntry)) return new Set<string>();
        return new Set(groupEntry.parallel.stages.map((s) => s.name));
      })();
      snapshot = {
        ...snapshot,
        value: "blocked",
        context: {
          ...snapshot.context,
          status: "blocked",
          lastStage: originalState,
          error: `Server restarted during ${originalState}. Use Retry to re-execute.`,
          // Reset group bookkeeping so Retry re-runs all children cleanly.
          // Leaving parallelDone / parallelStagedWrites populated would make the
          // re-entered group skip already-done children (possibly with stale store data).
          ...(isGroup
            ? {
                parallelDone: snapshot.context.parallelDone
                  ? Object.fromEntries(
                      Object.entries(snapshot.context.parallelDone).filter(([k]) => k !== originalState),
                    )
                  : undefined,
                parallelStagedWrites: snapshot.context.parallelStagedWrites
                  ? Object.fromEntries(
                      Object.entries(snapshot.context.parallelStagedWrites).filter(
                        ([k]) => !childNamesOfGroup.has(k),
                      ),
                    )
                  : undefined,
              }
            : {}),
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
