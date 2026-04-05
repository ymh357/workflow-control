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

async function freshBroadcaster() {
  vi.resetModules();
  const mod = await import("./task-list-broadcaster.js");
  return mod.taskListBroadcaster;
}

describe("TaskListBroadcaster — adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("broadcastTaskUpdate with taskId containing null byte", async () => {
    const broadcaster = await freshBroadcaster();
    broadcaster.setProviders(makeProviders(new Map()));

    const stream = broadcaster.createStream();
    const reader = stream.getReader();
    await reader.read(); // init event

    // Should not crash even with weird taskId
    expect(() => broadcaster.broadcastTaskUpdate("task\0evil")).not.toThrow();
    reader.releaseLock();
  });

  it("restoreWorkflow errors during first connection are silently ignored", async () => {
    const broadcaster = await freshBroadcaster();
    (loadAllPersistedTaskIds as ReturnType<typeof vi.fn>).mockReturnValue(["p-1", "p-2"]);

    const providers = makeProviders(new Map());
    (providers.restoreWorkflow as any).mockImplementation(() => {
      throw new Error("corrupt");
    });
    broadcaster.setProviders(providers);

    // Should not throw despite restore failures
    const stream = broadcaster.createStream();
    const reader = stream.getReader();
    const { value } = await reader.read();
    reader.releaseLock();

    const text = new TextDecoder().decode(value);
    expect(text).toContain("task_list_init");
    expect(text).toContain("corrupt");
  });

  it("broadcast to multiple connections where one is broken", async () => {
    const broadcaster = await freshBroadcaster();
    const actors = new Map([["t1", makeActor("t1")]]);
    broadcaster.setProviders(makeProviders(actors));

    // Create two streams
    const stream1 = broadcaster.createStream();
    const stream2 = broadcaster.createStream();

    // Cancel stream1 to simulate broken connection
    await stream1.cancel();
    await new Promise((r) => setTimeout(r, 10));

    // Broadcast should still deliver to stream2
    broadcaster.broadcastTaskRemoval("t1");

    const reader2 = stream2.getReader();
    await reader2.read(); // init
    const { value } = await reader2.read();
    reader2.releaseLock();

    const text = new TextDecoder().decode(value);
    expect(text).toContain("task_removed");
  });

  it("SSE data format is proper event-stream (data: prefix, double newline)", async () => {
    const broadcaster = await freshBroadcaster();
    broadcaster.setProviders(makeProviders(new Map()));

    const stream = broadcaster.createStream();
    const reader = stream.getReader();
    const { value } = await reader.read();
    reader.releaseLock();

    const text = new TextDecoder().decode(value);
    expect(text).toMatch(/^data: .+\n\n$/);
    // Verify it's valid JSON after "data: " prefix
    const jsonStr = text.replace(/^data: /, "").trim();
    expect(() => JSON.parse(jsonStr)).not.toThrow();
  });

  it("buildAllTaskSummaries only restores persisted tasks once (initialized flag)", async () => {
    const broadcaster = await freshBroadcaster();
    (loadAllPersistedTaskIds as ReturnType<typeof vi.fn>).mockReturnValue(["p-1"]);

    const providers = makeProviders(new Map());
    broadcaster.setProviders(providers);

    // First connection triggers restore
    broadcaster.createStream();
    expect(providers.restoreWorkflow).toHaveBeenCalledTimes(1);

    // Second connection should NOT restore again
    broadcaster.createStream();
    expect(providers.restoreWorkflow).toHaveBeenCalledTimes(1);
  });

  it("actor with null snapshot context is excluded from summaries", async () => {
    const broadcaster = await freshBroadcaster();
    const nullCtxActor = { getSnapshot: () => ({ value: "x", status: "x", context: null }) };
    const actors = new Map([["t1", nullCtxActor as any]]);
    broadcaster.setProviders(makeProviders(actors));

    const stream = broadcaster.createStream();
    const reader = stream.getReader();
    const { value } = await reader.read();
    reader.releaseLock();

    const text = new TextDecoder().decode(value);
    const event = JSON.parse(text.replace(/^data: /, "").trim());
    expect(event.tasks).toEqual([]);
  });

  it("handles rapid broadcastTaskUpdate + broadcastTaskRemoval for same task", async () => {
    const broadcaster = await freshBroadcaster();
    const actors = new Map([["t1", makeActor("t1")]]);
    broadcaster.setProviders(makeProviders(actors));

    const stream = broadcaster.createStream();
    const reader = stream.getReader();
    await reader.read(); // init

    // Fire update then immediately remove
    broadcaster.broadcastTaskUpdate("t1");
    broadcaster.broadcastTaskRemoval("t1");

    // Removal is immediate, update is debounced
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("task_removed");

    reader.releaseLock();
  });
});
