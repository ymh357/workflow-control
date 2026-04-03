import { loadAllPersistedTaskIds } from "../machine/persistence.js";
import type { WorkflowContext } from "../machine/types.js";
import { getLatestSessionId } from "../machine/helpers.js";
import { getNestedValue } from "../lib/config-loader.js";
import { questionManager } from "../lib/question-manager.js";
import type { TaskSummary, TaskListSSEEvent } from "@workflow-control/shared";

interface GlobalSSEConnection {
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
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

  setProviders(p: TaskListProviders): void {
    this.providers = p;
  }

  createStream(): ReadableStream<Uint8Array> {
    const activeCount = this.connections.filter((c) => !c.closed).length;
    if (activeCount >= TaskListBroadcaster.MAX_CONNECTIONS) {
      throw new Error(`Too many global SSE connections (limit: ${TaskListBroadcaster.MAX_CONNECTIONS})`);
    }

    return new ReadableStream({
      start: (controller) => {
        const conn: GlobalSSEConnection = { controller, closed: false };
        this.connections.push(conn);

        // Push full task list on connection
        const tasks = this.buildAllTaskSummaries();
        const initEvent: TaskListSSEEvent = { type: "task_list_init", tasks };
        this.sendToController(controller, initEvent);
      },
      cancel: () => {
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

      return {
        id: taskId,
        taskText: ctx.taskText,
        status: ctx.status || "unknown",
        currentStage: ctx.lastStage,
        sessionId: getLatestSessionId(ctx),
        branch: ctx.branch,
        error: ctx.error,
        totalCostUsd: ctx.totalCostUsd ?? 0,
        store: ctx.store ?? {},
        displayTitle: titlePath ? getNestedValue(ctx.store, titlePath) ?? taskId : taskId,
        updatedAt: new Date().toISOString(),
        pendingQuestion: !!questionManager.getPersistedPending(taskId),
      };
    } catch {
      return null;
    }
  }

  private buildAllTaskSummaries(): TaskSummary[] {
    if (!this.providers) return [];

    if (!this.initialized) {
      for (const id of loadAllPersistedTaskIds(50)) {
        if (!this.providers.getWorkflow(id)) {
          try { this.providers.restoreWorkflow(id); } catch { /* skip failed restores */ }
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
    this.connections = this.connections.filter((c) => !c.closed);
  }
}

export const taskListBroadcaster = new TaskListBroadcaster();
