import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../lib/config-loader.js", () => ({
  getNestedValue: vi.fn(),
  loadSystemSettings: vi.fn(() => ({})),
}));
vi.mock("../machine/persistence.js", () => ({
  loadAllPersistedTaskIds: vi.fn(() => []),
}));
vi.mock("../machine/helpers.js", () => ({
  getLatestSessionId: vi.fn(() => "sess-1"),
}));
vi.mock("../lib/question-manager.js", () => ({
  questionManager: { getPersistedPending: vi.fn(() => null) },
}));

import type { TaskListProviders } from "./task-list-broadcaster.js";
import { loadAllPersistedTaskIds } from "../machine/persistence.js";

function makeActor(taskId: string, overrides: Record<string, any> = {}) {
  return {
    getSnapshot: () => ({
      value: "running",
      status: "started",
      context: {
        taskId,
        status: "running",
        retryCount: 0,
        qaRetryCount: 0,
        store: {},
        stageSessionIds: {},
        ...overrides,
      },
    }),
  };
}

function makeProviders(workflows: Map<string, ReturnType<typeof makeActor>>): TaskListProviders {
  return {
    getWorkflow: (id) => workflows.get(id),
    getAllWorkflows: () => workflows as any,
    restoreWorkflow: vi.fn(),
  };
}

// Each describe block gets a fresh module instance to avoid singleton state leaking
async function freshBroadcaster() {
  vi.resetModules();
  const mod = await import("./task-list-broadcaster.js");
  return mod.taskListBroadcaster;
}

describe("TaskListBroadcaster", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createStream", () => {
    it("returns a ReadableStream", async () => {
      const broadcaster = await freshBroadcaster();
      broadcaster.setProviders(makeProviders(new Map()));
      const stream = broadcaster.createStream();
      expect(stream).toBeInstanceOf(ReadableStream);
    });

    it("sends task_list_init event on connection", async () => {
      const broadcaster = await freshBroadcaster();
      const actors = new Map([["t1", makeActor("t1")]]);
      broadcaster.setProviders(makeProviders(actors));

      const stream = broadcaster.createStream();
      const reader = stream.getReader();
      const { value } = await reader.read();
      reader.releaseLock();

      const text = new TextDecoder().decode(value);
      expect(text).toContain("task_list_init");
      expect(text).toContain('"id":"t1"');
    });

    it("restores persisted tasks on first connection", async () => {
      const broadcaster = await freshBroadcaster();
      (loadAllPersistedTaskIds as ReturnType<typeof vi.fn>).mockReturnValue(["persisted-1"]);
      const actors = new Map<string, ReturnType<typeof makeActor>>();
      const providers = makeProviders(actors);
      broadcaster.setProviders(providers);

      broadcaster.createStream();
      expect(providers.restoreWorkflow).toHaveBeenCalledWith("persisted-1");
    });

    it("includes failed restore details in init event when restore returns undefined", async () => {
      const broadcaster = await freshBroadcaster();
      (loadAllPersistedTaskIds as ReturnType<typeof vi.fn>).mockReturnValue(["broken-1"]);
      const providers = makeProviders(new Map());
      (providers.restoreWorkflow as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      broadcaster.setProviders(providers);

      const stream = broadcaster.createStream();
      const reader = stream.getReader();
      const { value } = await reader.read();
      reader.releaseLock();

      const event = JSON.parse(new TextDecoder().decode(value).replace(/^data: /, "").trim());
      expect(event.failedRestores).toEqual([
        { id: "broken-1", reason: "Task snapshot could not be restored" },
      ]);
    });

    it("enforces MAX_CONNECTIONS (20) limit", async () => {
      const broadcaster = await freshBroadcaster();
      broadcaster.setProviders(makeProviders(new Map()));

      for (let i = 0; i < 20; i++) {
        broadcaster.createStream();
      }
      expect(() => broadcaster.createStream()).toThrow(/Too many global SSE connections.*limit: 20/);
    });

    it("counts only non-closed connections toward the limit", async () => {
      const broadcaster = await freshBroadcaster();
      broadcaster.setProviders(makeProviders(new Map()));

      // Create one stream, then cancel it (cancel callback cleans up closed ones)
      // Broadcast to mark closed connections via failed enqueue
      const stream1 = broadcaster.createStream();
      await stream1.cancel();
      await new Promise(r => setTimeout(r, 10));

      // The broadcast triggers cleanup of connections marked closed
      broadcaster.broadcastTaskRemoval("x");

      // Remaining capacity should allow creating streams
      // (up to 20, since the cancelled one was cleaned up)
      expect(() => broadcaster.createStream()).not.toThrow();
    });
  });

  describe("broadcastTaskUpdate", () => {
    it("debounces updates (200ms)", async () => {
      const broadcaster = await freshBroadcaster();
      const actors = new Map([["t1", makeActor("t1")]]);
      broadcaster.setProviders(makeProviders(actors));

      const stream = broadcaster.createStream();
      const reader = stream.getReader();
      // Read the init event
      await reader.read();

      // Fire multiple rapid updates
      broadcaster.broadcastTaskUpdate("t1");
      broadcaster.broadcastTaskUpdate("t1");
      broadcaster.broadcastTaskUpdate("t1");

      // Wait for debounce
      await new Promise(r => setTimeout(r, 300));

      const { value } = await reader.read();
      reader.releaseLock();

      const text = new TextDecoder().decode(value);
      expect(text).toContain("task_updated");
      const matches = text.match(/task_updated/g);
      expect(matches?.length).toBe(1);
    });

    it("does nothing when workflow not found for task", async () => {
      const broadcaster = await freshBroadcaster();
      broadcaster.setProviders(makeProviders(new Map()));
      const stream = broadcaster.createStream();

      broadcaster.broadcastTaskUpdate("nonexistent");
      await new Promise(r => setTimeout(r, 300));

      // No error, stream is still alive
      expect(stream).toBeDefined();
    });

    it("uses pending question createdAt as updatedAt for actionable tasks", async () => {
      const broadcaster = await freshBroadcaster();
      const actors = new Map([["t1", makeActor("t1", { updatedAt: "2026-01-01T00:00:00.000Z" })]]);
      broadcaster.setProviders(makeProviders(actors));
      const { questionManager } = await import("../lib/question-manager.js");
      vi.mocked(questionManager.getPersistedPending).mockReturnValue({
        questionId: "q1",
        question: "Need input",
        createdAt: "2026-01-02T00:00:00.000Z",
      });

      const stream = broadcaster.createStream();
      const reader = stream.getReader();
      const { value } = await reader.read();
      reader.releaseLock();

      const text = new TextDecoder().decode(value);
      expect(text).toContain('"updatedAt":"2026-01-02T00:00:00.000Z"');
      expect(text).toContain('"pendingQuestion":true');
    });
  });

  describe("broadcastTaskRemoval", () => {
    it("sends task_removed event to all connections", async () => {
      const broadcaster = await freshBroadcaster();
      broadcaster.setProviders(makeProviders(new Map()));

      const stream = broadcaster.createStream();
      const reader = stream.getReader();
      // Read init event
      await reader.read();

      broadcaster.broadcastTaskRemoval("task-gone");

      const { value } = await reader.read();
      reader.releaseLock();

      const text = new TextDecoder().decode(value);
      expect(text).toContain("task_removed");
      expect(text).toContain("task-gone");
    });

    it("sends removal immediately without debounce", async () => {
      const broadcaster = await freshBroadcaster();
      broadcaster.setProviders(makeProviders(new Map()));

      const stream = broadcaster.createStream();
      const reader = stream.getReader();
      await reader.read();

      broadcaster.broadcastTaskRemoval("task-1");

      const result = await Promise.race([
        reader.read(),
        new Promise<null>(r => setTimeout(() => r(null), 50)),
      ]);

      expect(result).not.toBeNull();
      reader.releaseLock();
    });
  });

  describe("connection cleanup", () => {
    it("marks connection as closed when enqueue throws", async () => {
      const broadcaster = await freshBroadcaster();
      const actors = new Map([["t1", makeActor("t1")]]);
      broadcaster.setProviders(makeProviders(actors));

      const stream = broadcaster.createStream();
      await stream.cancel();
      await new Promise(r => setTimeout(r, 10));

      // Should not throw even with broken connections
      expect(() => broadcaster.broadcastTaskRemoval("t1")).not.toThrow();
    });
  });

  describe("buildTaskSummary", () => {
    it("returns null when providers are not set", async () => {
      const broadcaster = await freshBroadcaster();
      // Don't set providers

      const stream = broadcaster.createStream();
      const reader = stream.getReader();
      const { value } = await reader.read();
      reader.releaseLock();

      const text = new TextDecoder().decode(value);
      // task_list_init with empty tasks since no providers
      expect(text).toContain("task_list_init");
      expect(text).toContain('"tasks":[]');
    });

    it("includes task summary fields", async () => {
      const broadcaster = await freshBroadcaster();
      const actors = new Map([
        ["t1", makeActor("t1", { taskText: "my task", branch: "feat-1", totalCostUsd: 1.5 })],
      ]);
      broadcaster.setProviders(makeProviders(actors));

      const stream = broadcaster.createStream();
      const reader = stream.getReader();
      const { value } = await reader.read();
      reader.releaseLock();

      const text = new TextDecoder().decode(value);
      expect(text).toContain('"id":"t1"');
      expect(text).toContain('"taskText":"my task"');
      expect(text).toContain('"branch":"feat-1"');
      expect(text).toContain('"totalCostUsd":1.5');
    });

    it("handles actor.getSnapshot() throwing gracefully", async () => {
      const broadcaster = await freshBroadcaster();
      const badActor = {
        getSnapshot: () => { throw new Error("snapshot error"); },
      };
      const actors = new Map([["t1", badActor as any]]);
      broadcaster.setProviders(makeProviders(actors));

      const stream = broadcaster.createStream();
      const reader = stream.getReader();
      const { value } = await reader.read();
      reader.releaseLock();

      const text = new TextDecoder().decode(value);
      // Should still send task_list_init, just with empty tasks
      expect(text).toContain("task_list_init");
    });
  });
});
