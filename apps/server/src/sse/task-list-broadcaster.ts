import { loadAllPersistedTaskIds } from "../machine/persistence.js";
import type { WorkflowContext } from "../machine/types.js";
import { getLatestSessionId } from "../machine/helpers.js";
import { getNestedValue } from "../lib/config-loader.js";
import { questionManager } from "../lib/question-manager.js";
import { deriveCurrentStage, deriveUpdatedAt } from "../lib/task-view-helpers.js";
import { redactSensitive } from "../lib/redact.js";
import type { TaskSummary, TaskListSSEEvent, FailedRestoreSummary } from "@workflow-control/shared";

interface GlobalSSEConnection {
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
  heartbeat?: ReturnType<typeof setInterval>;
}

interface ActorSnapshot {
  getSnapshot(): { value: string; status: string; context: WorkflowContext };
}

export interface TaskListProviders {
  getWorkflow: (taskId: string) => ActorSnapshot | undefined;
  getAllWorkflows: () => Map<string, ActorSnapshot>;
  restoreWorkflow: (taskId: string) => unknown;
}

const encoder = new TextEncoder();

class TaskListBroadcaster {
  private static readonly MAX_CONNECTIONS = 20;
  private static readonly DEBOUNCE_MS = 200;
  private connections: GlobalSSEConnection[] = [];
  private pendingUpdates = new Map<string, ReturnType<typeof setTimeout>>();
  private initialized = false;
  private providers?: TaskListProviders;
  private failedRestores: FailedRestoreSummary[] = [];

  setProviders(p: TaskListProviders): void {
    this.providers = p;
  }

  createStream(): ReadableStream<Uint8Array> {
    const activeCount = this.connections.filter((c) => !c.closed).length;
    if (activeCount >= TaskListBroadcaster.MAX_CONNECTIONS) {
      throw new Error(`Too many global SSE connections (limit: ${TaskListBroadcaster.MAX_CONNECTIONS})`);
    }

    let conn: GlobalSSEConnection;

    return new ReadableStream({
      start: (controller) => {
        conn = { controller, closed: false };
        this.connections.push(conn);

        conn.heartbeat = setInterval(() => {
          if (conn.closed) { clearInterval(conn.heartbeat); return; }
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            conn.closed = true;
            clearInterval(conn.heartbeat);
          }
        }, 30_000);

        // Push full task list on connection
        const tasks = this.buildAllTaskSummaries();
        const initEvent: TaskListSSEEvent = {
          type: "task_list_init",
          tasks,
          failedRestores: [...this.failedRestores],
        };
        this.sendToController(controller, initEvent);
      },
      cancel: () => {
        if (conn) {
          if (conn.heartbeat) clearInterval(conn.heartbeat);
          conn.closed = true;
        }
        this.cleanupClosedConnections();
      },
    });
  }

  broadcastTaskUpdate(taskId: string): void {
    const existing = this.pendingUpdates.get(taskId);
    if (existing) clearTimeout(existing);
    this.pendingUpdates.set(taskId, setTimeout(() => {
      this.pendingUpdates.delete(taskId);
      const summary = this.buildTaskSummary(taskId);
      if (!summary) return;
      this.broadcast({ type: "task_updated", task: summary });
    }, TaskListBroadcaster.DEBOUNCE_MS));
  }

  broadcastTaskRemoval(taskId: string): void {
    this.broadcast({ type: "task_removed", taskId });
  }

  private buildTaskSummary(taskId: string): TaskSummary | null {
    if (!this.providers) return null;
    const actor = this.providers.getWorkflow(taskId);
    if (!actor) return null;

    try {
      const snap = actor.getSnapshot();
      if (!snap?.context) return null;

      const ctx = snap.context;
      const pipeline = ctx.config?.pipeline;
      const titlePath = pipeline?.display?.title_path;
      const pendingQuestion = questionManager.getPersistedPending(taskId);
      const redactedStore = redactSensitive(ctx.store ?? {}) as Record<string, unknown>;

      return {
        id: taskId,
        taskText: ctx.taskText,
        status: ctx.status || "unknown",
        currentStage: deriveCurrentStage(ctx),
        sessionId: getLatestSessionId(ctx),
        branch: ctx.branch,
        error: ctx.error,
        totalCostUsd: ctx.totalCostUsd ?? 0,
        store: redactedStore,
        displayTitle: titlePath ? getNestedValue(redactedStore, titlePath) ?? taskId : taskId,
        updatedAt: deriveUpdatedAt(ctx, pendingQuestion),
        pendingQuestion: !!pendingQuestion,
      };
    } catch {
      return null;
    }
  }

  private buildAllTaskSummaries(): TaskSummary[] {
    if (!this.providers) return [];

    if (!this.initialized) {
      this.failedRestores = [];
      for (const id of loadAllPersistedTaskIds(50)) {
        if (!this.providers.getWorkflow(id)) {
          try {
            const restored = this.providers.restoreWorkflow(id);
            if (!restored) {
              this.failedRestores.push({ id, reason: "Task snapshot could not be restored" });
            }
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            this.failedRestores.push({ id, reason });
          }
        }
      }
      this.initialized = true;
    }

    const tasks: TaskSummary[] = [];
    for (const [id] of this.providers.getAllWorkflows().entries()) {
      const summary = this.buildTaskSummary(id);
      if (summary) tasks.push(summary);
    }
    return tasks;
  }

  private broadcast(event: TaskListSSEEvent): void {
    for (const conn of this.connections) {
      if (conn.closed) continue;
      try {
        this.sendToController(conn.controller, event);
      } catch {
        conn.closed = true;
      }
    }
    this.cleanupClosedConnections();
  }

  private sendToController(
    controller: ReadableStreamDefaultController<Uint8Array>,
    event: TaskListSSEEvent,
  ): void {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    controller.enqueue(encoder.encode(data));
  }

  private cleanupClosedConnections(): void {
    for (const c of this.connections) {
      if (c.closed && c.heartbeat) clearInterval(c.heartbeat);
    }
    this.connections = this.connections.filter((c) => !c.closed);
  }
}

export const taskListBroadcaster = new TaskListBroadcaster();
