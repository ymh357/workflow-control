import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockCloseStream,
  mockCancelForTask,
  mockBroadcastTaskUpdate,
  mockBroadcastTaskRemoval,
  mockSetProviders,
} = vi.hoisted(() => ({
  mockCloseStream: vi.fn(),
  mockCancelForTask: vi.fn(),
  mockBroadcastTaskUpdate: vi.fn(),
  mockBroadcastTaskRemoval: vi.fn(),
  mockSetProviders: vi.fn(),
}));

vi.mock("../sse/manager.js", () => ({
  sseManager: {
    closeStream: (...args: any[]) => mockCloseStream(...args),
  },
}));
vi.mock("../lib/question-manager.js", () => ({
  questionManager: {
    cancelForTask: (...args: any[]) => mockCancelForTask(...args),
  },
}));
vi.mock("../agent/query-tracker.js", () => ({
  cancelTask: vi.fn(),
}));
vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock("../lib/safe-fire.js", () => ({
  safeFire: vi.fn(),
}));
vi.mock("../sse/task-list-broadcaster.js", () => ({
  taskListBroadcaster: {
    broadcastTaskUpdate: (...args: any[]) => mockBroadcastTaskUpdate(...args),
    broadcastTaskRemoval: (...args: any[]) => mockBroadcastTaskRemoval(...args),
    setProviders: (...args: any[]) => mockSetProviders(...args),
  },
}));
vi.mock("./persistence.js", () => ({
  persistSnapshot: vi.fn().mockResolvedValue(undefined),
  flushSnapshotSync: vi.fn(),
  loadSnapshot: vi.fn().mockReturnValue(undefined),
  snapshotPath: vi.fn().mockReturnValue("/tmp/fake-snapshot.json"),
  pipelineFingerprint: vi.fn().mockReturnValue("fp-123"),
}));
vi.mock("./side-effects.js", () => ({
  registerSideEffects: vi.fn(),
}));

const mockSnapshotGlobalConfig = vi.fn().mockReturnValue({
  pipelineName: "test",
  pipeline: {
    name: "test",
    stages: [
      { name: "plan", type: "agent", runtime: { engine: "claude", max_turns: 3, budget_usd: 1 } },
    ],
  },
  prompts: {
    system: {},
    fragments: {},
    globalConstraints: "",
    globalClaudeMd: "",
    globalGeminiMd: "",
  },
  skills: [],
  mcps: [],
});
vi.mock("./workflow-lifecycle.js", () => ({
  snapshotGlobalConfig: (...args: any[]) => mockSnapshotGlobalConfig(...args),
}));
vi.mock("./machine.js", () => {
  const { setup, assign } = require("xstate");
  const trivialSetup = setup({
    types: { context: {} as any, events: {} as any, emitted: {} as any },
  });
  return {
    createWorkflowMachine: vi.fn().mockReturnValue(
      trivialSetup.createMachine({
        id: "workflow",
        initial: "idle",
        context: {
          taskId: "",
          status: "idle",
          retryCount: 0,
          qaRetryCount: 0,
          stageSessionIds: {},
          store: {},
        },
        states: {
          idle: {
            on: {
              START_ANALYSIS: {
                actions: assign(({ event }: any) => ({
                  taskId: event.taskId,
                })),
              },
              LAUNCH: { target: "plan" },
            },
          },
          plan: {
            entry: assign({ status: "plan" }),
            on: {
              CONFIRM: { target: "completed" },
            },
          },
          completed: { type: "final" },
          error: { type: "final" },
          blocked: {},
          cancelled: {},
        },
      }),
    ),
  };
});
vi.mock("../lib/config-loader.js", () => ({
  loadPipelineConfig: vi.fn(),
  getNestedValue: vi.fn(),
}));

import {
  getWorkflow,
  getAllWorkflows,
  sendEvent,
  createTaskDraft,
  launchTask,
  startWorkflow,
  deleteWorkflow,
  restoreWorkflow,
} from "./actor-registry.js";
import { loadSnapshot, pipelineFingerprint } from "./persistence.js";
import { loadPipelineConfig } from "../lib/config-loader.js";

describe("actor-registry adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    for (const [id] of getAllWorkflows()) {
      deleteWorkflow(id);
    }
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("createTaskDraft with empty string skips URL dedup entirely", () => {
    // Empty URL should not trigger URL-based dedup
    const a1 = createTaskDraft("t-empty-url-1");
    const a2 = createTaskDraft("t-empty-url-2");
    expect(a1).toBeDefined();
    expect(a2).toBeDefined();
    expect(getWorkflow("t-empty-url-1")).toBeDefined();
    expect(getWorkflow("t-empty-url-2")).toBeDefined();
  });

  it("createTaskDraft propagates config errors", () => {
    mockSnapshotGlobalConfig.mockImplementationOnce(() => {
      throw new Error("config broken");
    });
    expect(() => createTaskDraft("t-throw")).toThrow("config broken");
  });

  it("launchTask returns false if actor is not in idle state", () => {
    createTaskDraft("t-not-idle");
    launchTask("t-not-idle");
    // Now actor is in "plan" state
    expect(launchTask("t-not-idle")).toBe(false);
  });

  it("deleteWorkflow returns true even for non-existent task", () => {
    const result = deleteWorkflow("nonexistent-task-xyz");
    expect(result).toBe(true);
  });

  it("deleteWorkflow stops actor before deleting", () => {
    createTaskDraft("t-stop");
    const actor = getWorkflow("t-stop")!;
    const stopSpy = vi.spyOn(actor, "stop");
    deleteWorkflow("t-stop");
    expect(stopSpy).toHaveBeenCalled();
    expect(getWorkflow("t-stop")).toBeUndefined();
  });

  it("startWorkflow creates and launches in one call", () => {
    const actor = startWorkflow("t-start", "repo", "pipe", "text");
    expect(actor).toBeDefined();
    const snap = actor.getSnapshot();
    // After createTaskDraft + launchTask, should be past idle
    expect(snap.value).not.toBe("idle");
  });

  it("sendEvent to an existing actor returns true even for unhandled event types", () => {
    createTaskDraft("t-unhandled");
    // RETRY is not handled in "idle" state, but sendEvent should still return true
    const result = sendEvent("t-unhandled", { type: "RETRY" });
    expect(result).toBe(true);
  });

  it("restoreWorkflow returns existing in-memory actor if present", () => {
    const actor = createTaskDraft("t-mem");
    const restored = restoreWorkflow("t-mem");
    expect(restored).toBe(actor);
    // loadSnapshot should not have been called
    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it("restoreWorkflow skips legacy snapshot without embedded pipeline config", () => {
    vi.mocked(loadSnapshot).mockReturnValueOnce({
      value: "plan",
      context: { taskId: "t-legacy", status: "plan", stageSessionIds: {} },
    });
    const result = restoreWorkflow("t-legacy");
    expect(result).toBeUndefined();
  });
});
