import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkflowContext } from "../machine/types.js";
import type { PipelineCallRuntimeConfig } from "../lib/config-loader.js";

vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockCreateTaskDraft = vi.fn();
const mockLaunchTask = vi.fn();
const mockGetWorkflow = vi.fn();
const mockSendEvent = vi.fn();

vi.mock("../machine/actor-registry.js", () => ({
  createTaskDraft: (...args: any[]) => mockCreateTaskDraft(...args),
  launchTask: (...args: any[]) => mockLaunchTask(...args),
  getWorkflow: (...args: any[]) => mockGetWorkflow(...args),
  sendEvent: (...args: any[]) => mockSendEvent(...args),
}));

const mockCancelTask = vi.fn();

vi.mock("./query-tracker.js", () => ({
  cancelTask: (...args: any[]) => mockCancelTask(...args),
}));

vi.mock("../lib/config-loader.js", () => ({
  getNestedValue: (obj: Record<string, unknown>, path: string) => {
    return path.split(".").reduce((acc: unknown, key: string) => {
      if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
      return undefined;
    }, obj);
  },
}));

import { runPipelineCall } from "./pipeline-executor.js";

function makeContext(store: Record<string, any> = {}): WorkflowContext {
  return {
    taskId: "test-task", status: "running",
    retryCount: 0, qaRetryCount: 0, stageSessionIds: {}, store,
    worktreePath: "/tmp/wt", branch: "feat/test",
  };
}

function makeRuntime(overrides: Partial<PipelineCallRuntimeConfig> = {}): PipelineCallRuntimeConfig {
  return {
    engine: "pipeline",
    pipeline_name: "child-pipeline",
    reads: { input: "data" },
    writes: ["output"],
    timeout_sec: 10,
    ...overrides,
  };
}

/**
 * Creates a mock actor that supports subscribe().
 * The subscribe callback fires immediately with initialSnap, then can be
 * triggered again via the returned emit() helper.
 */
function makeMockActor(initialSnap: Record<string, any>) {
  type Listener = (snap: Record<string, any>) => void;
  const listeners: Listener[] = [];
  let currentSnap = initialSnap;

  const actor = {
    getSnapshot: () => currentSnap,
    subscribe: (cb: Listener) => {
      listeners.push(cb);
      // XState subscribe fires immediately with current state
      cb(currentSnap);
      return {
        unsubscribe: () => {
          const idx = listeners.indexOf(cb);
          if (idx >= 0) listeners.splice(idx, 1);
        },
      };
    },
  };

  const emit = (snap: Record<string, any>) => {
    currentSnap = snap;
    for (const cb of [...listeners]) cb(snap);
  };

  return { actor, emit };
}

describe("runPipelineCall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a child task with correct initialStore from reads mapping", async () => {
    const childSnap = { context: { status: "completed", store: { output: "result" }, error: undefined } };
    const { actor } = makeMockActor(childSnap);
    mockGetWorkflow.mockReturnValue(actor);

    const ctx = makeContext({ data: "hello" });
    const runtime = makeRuntime();

    const result = await runPipelineCall("", { taskId: "parent-task", stageName: "sub", context: ctx, runtime });

    expect(mockCreateTaskDraft).toHaveBeenCalledTimes(1);
    const [childTaskId, repoName, pipelineName, taskText, options] = mockCreateTaskDraft.mock.calls[0];
    expect(childTaskId).toContain("parent-task-sub-sub-");
    expect(pipelineName).toBe("child-pipeline");
    expect(options.initialStore).toEqual({ input: "hello", __pipeline_depth: 1 });
    expect(options.worktreePath).toBe("/tmp/wt");
    expect(options.branch).toBe("feat/test");

    expect(mockLaunchTask).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ output: "result" });
  });

  it("returns only writes-specified fields from child store", async () => {
    const childSnap = {
      context: { status: "completed", store: { output: "wanted", internal: "unwanted" }, error: undefined },
    };
    const { actor } = makeMockActor(childSnap);
    mockGetWorkflow.mockReturnValue(actor);

    const runtime = makeRuntime({ writes: ["output"] });
    const result = await runPipelineCall("", { taskId: "p", stageName: "s", context: makeContext(), runtime });

    expect(result).toEqual({ output: "wanted" });
    expect(result).not.toHaveProperty("internal");
  });

  it("throws when child pipeline errors", async () => {
    const childSnap = { context: { status: "error", store: {}, error: "child exploded" } };
    const { actor } = makeMockActor(childSnap);
    mockGetWorkflow.mockReturnValue(actor);

    await expect(
      runPipelineCall("", { taskId: "p", stageName: "s", context: makeContext(), runtime: makeRuntime() }),
    ).rejects.toThrow("child exploded");
  });

  it("throws when child pipeline is cancelled", async () => {
    const childSnap = { context: { status: "cancelled", store: {}, error: undefined } };
    const { actor } = makeMockActor(childSnap);
    mockGetWorkflow.mockReturnValue(actor);

    await expect(
      runPipelineCall("", { taskId: "p", stageName: "s", context: makeContext(), runtime: makeRuntime() }),
    ).rejects.toThrow(/cancelled/);
  });

  it("throws when child actor disappears", async () => {
    mockGetWorkflow.mockReturnValue(undefined);

    await expect(
      runPipelineCall("", { taskId: "p", stageName: "s", context: makeContext(), runtime: makeRuntime() }),
    ).rejects.toThrow(/disappeared unexpectedly/);
  });

  it("returns empty object when no writes specified", async () => {
    const childSnap = { context: { status: "completed", store: { a: 1, b: 2 }, error: undefined } };
    const { actor } = makeMockActor(childSnap);
    mockGetWorkflow.mockReturnValue(actor);

    const runtime = makeRuntime({ writes: undefined });
    const result = await runPipelineCall("", { taskId: "p", stageName: "s", context: makeContext(), runtime });

    expect(result).toEqual({});
  });

  it("strips store. prefix from reads values", async () => {
    const childSnap = { context: { status: "completed", store: { output: "result" }, error: undefined } };
    const { actor } = makeMockActor(childSnap);
    mockGetWorkflow.mockReturnValue(actor);

    const ctx = makeContext({ data: "hello" });
    const runtime = makeRuntime({ reads: { x: "store.data" } });
    await runPipelineCall("", { taskId: "p", stageName: "s", context: ctx, runtime });

    const options = mockCreateTaskDraft.mock.calls[0][4];
    expect(options.initialStore).toEqual({ x: "hello", __pipeline_depth: 1 });
  });

  it("reads values without store. prefix work the same way", async () => {
    const childSnap = { context: { status: "completed", store: { output: "result" }, error: undefined } };
    const { actor } = makeMockActor(childSnap);
    mockGetWorkflow.mockReturnValue(actor);

    const ctx = makeContext({ data: "hello" });
    const runtime = makeRuntime({ reads: { x: "data" } });
    await runPipelineCall("", { taskId: "p", stageName: "s", context: ctx, runtime });

    const options = mockCreateTaskDraft.mock.calls[0][4];
    expect(options.initialStore).toEqual({ x: "hello", __pipeline_depth: 1 });
  });

  it("builds empty initialStore (apart from depth counter) when no reads specified", async () => {
    const childSnap = { context: { status: "completed", store: {}, error: undefined } };
    const { actor } = makeMockActor(childSnap);
    mockGetWorkflow.mockReturnValue(actor);

    const runtime = makeRuntime({ reads: undefined });
    await runPipelineCall("", { taskId: "p", stageName: "s", context: makeContext({ x: 1 }), runtime });

    const options = mockCreateTaskDraft.mock.calls[0][4];
    expect(options.initialStore).toEqual({ __pipeline_depth: 1 });
  });

  it("throws timeout error when child pipeline stays running", async () => {
    const runningSnap = { context: { status: "running", store: {}, error: undefined } };
    const { actor } = makeMockActor(runningSnap);
    mockGetWorkflow.mockReturnValue(actor);

    const runtime = makeRuntime({ timeout_sec: 1 });

    await expect(
      runPipelineCall("", { taskId: "p", stageName: "s", context: makeContext(), runtime }),
    ).rejects.toThrow(/timed out after 1s/);
  }, 10000);

  it("cancels child task on timeout before throwing", async () => {
    const runningSnap = { context: { status: "running", store: {}, error: undefined } };
    const { actor } = makeMockActor(runningSnap);
    mockGetWorkflow.mockReturnValue(actor);

    const runtime = makeRuntime({ timeout_sec: 1 });

    await expect(
      runPipelineCall("", { taskId: "p", stageName: "s", context: makeContext(), runtime }),
    ).rejects.toThrow(/timed out/);

    // Verify CANCEL event was sent and agent process was killed
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.stringContaining("p-sub-s-"),
      { type: "CANCEL" },
    );
    expect(mockCancelTask).toHaveBeenCalledWith(
      expect.stringContaining("p-sub-s-"),
    );
  }, 10000);

  it("resolves after state transitions from running to completed", async () => {
    const runningSnap = { context: { status: "running", store: {}, error: undefined } };
    const completedSnap = { context: { status: "completed", store: { output: "done" }, error: undefined } };

    const { actor, emit } = makeMockActor(runningSnap);
    mockGetWorkflow.mockReturnValue(actor);

    const runtime = makeRuntime({ timeout_sec: 30 });
    const promise = runPipelineCall("", { taskId: "p", stageName: "s", context: makeContext(), runtime });

    // Simulate async state transition
    emit(completedSnap);

    const result = await promise;
    expect(result).toEqual({ output: "done" });
  });

  it("child pipeline transitions from running to error mid-subscription", async () => {
    const runningSnap = { context: { status: "running", store: {}, error: undefined } };
    const errorSnap = { context: { status: "error", store: {}, error: "child crashed mid-run" } };

    const { actor, emit } = makeMockActor(runningSnap);
    mockGetWorkflow.mockReturnValue(actor);

    const runtime = makeRuntime({ timeout_sec: 30 });
    const promise = runPipelineCall("", { taskId: "p", stageName: "s", context: makeContext(), runtime });

    emit(errorSnap);

    await expect(promise).rejects.toThrow("child crashed mid-run");
  });

  it("passes worktreePath and branch from parent context to child task", async () => {
    const childSnap = { context: { status: "completed", store: {}, error: undefined } };
    const { actor } = makeMockActor(childSnap);
    mockGetWorkflow.mockReturnValue(actor);

    const ctx = makeContext({});
    ctx.worktreePath = "/projects/repo-wt";
    ctx.branch = "feature/nested";

    await runPipelineCall("", { taskId: "p", stageName: "s", context: ctx, runtime: makeRuntime() });

    const options = mockCreateTaskDraft.mock.calls[0][4];
    expect(options.worktreePath).toBe("/projects/repo-wt");
    expect(options.branch).toBe("feature/nested");
  });
});
