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

describe("runPipelineCall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a child task with correct initialStore from reads mapping", async () => {
    const childSnap = { context: { status: "completed", store: { output: "result" }, error: undefined } };
    mockGetWorkflow.mockReturnValue({ getSnapshot: () => childSnap });

    const ctx = makeContext({ data: "hello" });
    const runtime = makeRuntime();

    const result = await runPipelineCall("", { taskId: "parent-task", stageName: "sub", context: ctx, runtime });

    expect(mockCreateTaskDraft).toHaveBeenCalledTimes(1);
    const [childTaskId, repoName, pipelineName, taskText, options] = mockCreateTaskDraft.mock.calls[0];
    expect(childTaskId).toContain("parent-task-sub-sub-");
    expect(pipelineName).toBe("child-pipeline");
    expect(options.initialStore).toEqual({ input: "hello" });
    expect(options.worktreePath).toBe("/tmp/wt");
    expect(options.branch).toBe("feat/test");

    expect(mockLaunchTask).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ output: "result" });
  });

  it("returns only writes-specified fields from child store", async () => {
    const childSnap = {
      context: { status: "completed", store: { output: "wanted", internal: "unwanted" }, error: undefined },
    };
    mockGetWorkflow.mockReturnValue({ getSnapshot: () => childSnap });

    const runtime = makeRuntime({ writes: ["output"] });
    const result = await runPipelineCall("", { taskId: "p", stageName: "s", context: makeContext(), runtime });

    expect(result).toEqual({ output: "wanted" });
    expect(result).not.toHaveProperty("internal");
  });

  it("throws when child pipeline errors", async () => {
    const childSnap = { context: { status: "error", store: {}, error: "child exploded" } };
    mockGetWorkflow.mockReturnValue({ getSnapshot: () => childSnap });

    await expect(
      runPipelineCall("", { taskId: "p", stageName: "s", context: makeContext(), runtime: makeRuntime() }),
    ).rejects.toThrow("child exploded");
  });

  it("throws when child pipeline is cancelled", async () => {
    const childSnap = { context: { status: "cancelled", store: {}, error: undefined } };
    mockGetWorkflow.mockReturnValue({ getSnapshot: () => childSnap });

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
    mockGetWorkflow.mockReturnValue({ getSnapshot: () => childSnap });

    const runtime = makeRuntime({ writes: undefined });
    const result = await runPipelineCall("", { taskId: "p", stageName: "s", context: makeContext(), runtime });

    expect(result).toEqual({});
  });

  it("strips store. prefix from reads values", async () => {
    const childSnap = { context: { status: "completed", store: { output: "result" }, error: undefined } };
    mockGetWorkflow.mockReturnValue({ getSnapshot: () => childSnap });

    const ctx = makeContext({ data: "hello" });
    const runtime = makeRuntime({ reads: { x: "store.data" } });
    await runPipelineCall("", { taskId: "p", stageName: "s", context: ctx, runtime });

    const options = mockCreateTaskDraft.mock.calls[0][4];
    expect(options.initialStore).toEqual({ x: "hello" });
  });

  it("reads values without store. prefix work the same way", async () => {
    const childSnap = { context: { status: "completed", store: { output: "result" }, error: undefined } };
    mockGetWorkflow.mockReturnValue({ getSnapshot: () => childSnap });

    const ctx = makeContext({ data: "hello" });
    const runtime = makeRuntime({ reads: { x: "data" } });
    await runPipelineCall("", { taskId: "p", stageName: "s", context: ctx, runtime });

    const options = mockCreateTaskDraft.mock.calls[0][4];
    expect(options.initialStore).toEqual({ x: "hello" });
  });

  it("builds empty initialStore when no reads specified", async () => {
    const childSnap = { context: { status: "completed", store: {}, error: undefined } };
    mockGetWorkflow.mockReturnValue({ getSnapshot: () => childSnap });

    const runtime = makeRuntime({ reads: undefined });
    await runPipelineCall("", { taskId: "p", stageName: "s", context: makeContext({ x: 1 }), runtime });

    const options = mockCreateTaskDraft.mock.calls[0][4];
    expect(options.initialStore).toEqual({});
  });

  it("throws timeout error when child pipeline stays running", async () => {
    // Child never completes — always returns "running"
    const runningSnap = { context: { status: "running", store: {}, error: undefined } };
    mockGetWorkflow.mockReturnValue({ getSnapshot: () => runningSnap });

    // Use very short timeout to avoid slow test
    const runtime = makeRuntime({ timeout_sec: 1 });

    await expect(
      runPipelineCall("", { taskId: "p", stageName: "s", context: makeContext(), runtime }),
    ).rejects.toThrow(/timed out after 1s/);
  }, 10000);

  it("cancels child task on timeout before throwing", async () => {
    const runningSnap = { context: { status: "running", store: {}, error: undefined } };
    mockGetWorkflow.mockReturnValue({ getSnapshot: () => runningSnap });

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

  it("polls multiple times before child completes", async () => {
    let pollCount = 0;
    const runningSnap = { context: { status: "running", store: {}, error: undefined } };
    const completedSnap = { context: { status: "completed", store: { output: "done" }, error: undefined } };

    mockGetWorkflow.mockImplementation(() => {
      pollCount++;
      // Return running for first 2 polls, then completed
      if (pollCount < 3) {
        return { getSnapshot: () => runningSnap };
      }
      return { getSnapshot: () => completedSnap };
    });

    const runtime = makeRuntime({ timeout_sec: 30 });
    const result = await runPipelineCall("", { taskId: "p", stageName: "s", context: makeContext(), runtime });

    expect(result).toEqual({ output: "done" });
    expect(pollCount).toBeGreaterThanOrEqual(3);
  }, 15000);

  it("child pipeline transitions from running to error mid-poll", async () => {
    let pollCount = 0;
    const runningSnap = { context: { status: "running", store: {}, error: undefined } };
    const errorSnap = { context: { status: "error", store: {}, error: "child crashed mid-run" } };

    mockGetWorkflow.mockImplementation(() => {
      pollCount++;
      if (pollCount < 2) {
        return { getSnapshot: () => runningSnap };
      }
      return { getSnapshot: () => errorSnap };
    });

    const runtime = makeRuntime({ timeout_sec: 30 });
    await expect(
      runPipelineCall("", { taskId: "p", stageName: "s", context: makeContext(), runtime }),
    ).rejects.toThrow("child crashed mid-run");
  }, 15000);

  it("child actor disappears after initial polls", async () => {
    let pollCount = 0;
    const runningSnap = { context: { status: "running", store: {}, error: undefined } };

    mockGetWorkflow.mockImplementation(() => {
      pollCount++;
      if (pollCount < 2) {
        return { getSnapshot: () => runningSnap };
      }
      return undefined; // actor disappeared
    });

    const runtime = makeRuntime({ timeout_sec: 30 });
    await expect(
      runPipelineCall("", { taskId: "p", stageName: "s", context: makeContext(), runtime }),
    ).rejects.toThrow(/disappeared unexpectedly/);
  }, 15000);

  it("passes worktreePath and branch from parent context to child task", async () => {
    const childSnap = { context: { status: "completed", store: {}, error: undefined } };
    mockGetWorkflow.mockReturnValue({ getSnapshot: () => childSnap });

    const ctx = makeContext({});
    ctx.worktreePath = "/projects/repo-wt";
    ctx.branch = "feature/nested";

    await runPipelineCall("", { taskId: "p", stageName: "s", context: ctx, runtime: makeRuntime() });

    const options = mockCreateTaskDraft.mock.calls[0][4];
    expect(options.worktreePath).toBe("/projects/repo-wt");
    expect(options.branch).toBe("feature/nested");
  });
});
