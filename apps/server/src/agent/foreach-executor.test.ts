import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkflowContext } from "../machine/types.js";
import type { ForeachRuntimeConfig } from "../lib/config-loader.js";

vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockRunPipelineCall = vi.fn();

vi.mock("./pipeline-executor.js", () => ({
  runPipelineCall: (...args: any[]) => mockRunPipelineCall(...args),
}));

const mockGetAllWorkflows = vi.fn((..._: any[]) => new Map());
const mockSendEvent = vi.fn();

vi.mock("../machine/actor-registry.js", () => ({
  getAllWorkflows: (...args: any[]) => mockGetAllWorkflows(...args),
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

const mockCreateWorktree = vi.fn();
const mockCommitAll = vi.fn();
const mockCleanupWorktreeOnly = vi.fn();

const mockGetDiffStat = vi.fn();

vi.mock("../lib/git.js", () => ({
  createWorktreeFromExisting: (...args: any[]) => mockCreateWorktree(...args),
  commitAll: (...args: any[]) => mockCommitAll(...args),
  cleanupWorktreeOnly: (...args: any[]) => mockCleanupWorktreeOnly(...args),
  getDiffStat: (...args: any[]) => mockGetDiffStat(...args),
}));

import { runForeach } from "./foreach-executor.js";

function makeContext(store: Record<string, any> = {}): WorkflowContext {
  return {
    taskId: "p", status: "running",
    retryCount: 0, qaRetryCount: 0, stageSessionIds: {},
    store: { items: ["a", "b", "c"], ...store },
  };
}

function makeRuntime(overrides: Partial<ForeachRuntimeConfig> = {}): ForeachRuntimeConfig {
  return {
    engine: "foreach",
    items: "store.items",
    item_var: "current_item",
    pipeline_name: "child-pipeline",
    max_concurrency: 1,
    collect_to: "results",
    item_writes: ["outcome"],
    on_item_error: "fail_fast",
    ...overrides,
  };
}

describe("runForeach", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("iterates over each item and collects results", async () => {
    mockRunPipelineCall
      .mockResolvedValueOnce({ outcome: "done-a" })
      .mockResolvedValueOnce({ outcome: "done-b" })
      .mockResolvedValueOnce({ outcome: "done-c" });

    const result = await runForeach("", {
      taskId: "p", stageName: "loop", context: makeContext(), runtime: makeRuntime(),
    });

    expect(mockRunPipelineCall).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      results: [
        { outcome: "done-a" },
        { outcome: "done-b" },
        { outcome: "done-c" },
      ],
    });
  });

  it("injects item_var into each sub-pipeline's context store", async () => {
    mockRunPipelineCall.mockResolvedValue({ outcome: "ok" });

    await runForeach("", {
      taskId: "p", stageName: "loop", context: makeContext(), runtime: makeRuntime(),
    });

    // Each call should have the item injected under item_var key
    for (let i = 0; i < 3; i++) {
      const callInput = mockRunPipelineCall.mock.calls[i][1];
      expect(callInput.context.store.current_item).toBe(["a", "b", "c"][i]);
    }
  });

  it("fail_fast: throws on first item error", async () => {
    mockRunPipelineCall
      .mockResolvedValueOnce({ outcome: "ok" })
      .mockRejectedValueOnce(new Error("item 2 failed"));

    await expect(runForeach("", {
      taskId: "p", stageName: "loop", context: makeContext(), runtime: makeRuntime({ on_item_error: "fail_fast" }),
    })).rejects.toThrow("item 2 failed");
  });

  it("continue: records __error for failed items and completes", async () => {
    mockRunPipelineCall
      .mockResolvedValueOnce({ outcome: "ok-a" })
      .mockRejectedValueOnce(new Error("b failed"))
      .mockResolvedValueOnce({ outcome: "ok-c" });

    const result = await runForeach("", {
      taskId: "p", stageName: "loop", context: makeContext(), runtime: makeRuntime({ on_item_error: "continue" }),
    });

    expect(result).toEqual({
      results: [
        { outcome: "ok-a" },
        { __error: "b failed" },
        { outcome: "ok-c" },
      ],
    });
  });

  it("throws when items is not an array", async () => {
    const ctx = makeContext({ items: "not-an-array" });
    await expect(runForeach("", {
      taskId: "p", stageName: "loop", context: ctx, runtime: makeRuntime(),
    })).rejects.toThrow(/must resolve to an array/);
  });

  it("throws when items path resolves to undefined", async () => {
    const ctx = makeContext({});
    // items key doesn't exist in store (we remove default items)
    delete ctx.store.items;
    await expect(runForeach("", {
      taskId: "p", stageName: "loop", context: ctx, runtime: makeRuntime(),
    })).rejects.toThrow(/must resolve to an array/);
  });

  it("returns empty object when collect_to is not specified", async () => {
    mockRunPipelineCall.mockResolvedValue({ outcome: "ok" });

    const result = await runForeach("", {
      taskId: "p", stageName: "loop", context: makeContext(),
      runtime: makeRuntime({ collect_to: undefined }),
    });

    expect(result).toEqual({});
  });

  it("empty array produces empty results", async () => {
    const ctx = makeContext({ items: [] });
    const result = await runForeach("", {
      taskId: "p", stageName: "loop", context: ctx, runtime: makeRuntime(),
    });

    expect(result).toEqual({ results: [] });
    expect(mockRunPipelineCall).not.toHaveBeenCalled();
  });

  it("only picks item_writes fields from sub-pipeline results", async () => {
    mockRunPipelineCall.mockResolvedValue({ outcome: "wanted", internal: "unwanted" });

    const result = await runForeach("", {
      taskId: "p", stageName: "loop",
      context: makeContext({ items: ["x"] }),
      runtime: makeRuntime({ item_writes: ["outcome"] }),
    });

    expect(result).toEqual({ results: [{ outcome: "wanted" }] });
  });

  it("handles items path with store. prefix", async () => {
    mockRunPipelineCall.mockResolvedValue({ outcome: "ok" });

    const result = await runForeach("", {
      taskId: "p", stageName: "loop",
      context: makeContext({ items: ["x", "y"] }),
      runtime: makeRuntime({ items: "store.items" }),
    });

    expect(mockRunPipelineCall).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ results: [{ outcome: "ok" }, { outcome: "ok" }] });
  });

  it("handles items path without store. prefix", async () => {
    mockRunPipelineCall.mockResolvedValue({ outcome: "ok" });

    const result = await runForeach("", {
      taskId: "p", stageName: "loop",
      context: makeContext({ items: ["x"] }),
      runtime: makeRuntime({ items: "items" }),
    });

    expect(mockRunPipelineCall).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ results: [{ outcome: "ok" }] });
  });

  it("strips store. prefix from collect_to", async () => {
    mockRunPipelineCall.mockResolvedValue({ outcome: "ok" });

    const result = await runForeach("", {
      taskId: "p", stageName: "loop",
      context: makeContext({ items: ["x"] }),
      runtime: makeRuntime({ collect_to: "store.results" }),
    });

    expect(result).toHaveProperty("results");
    expect(result).not.toHaveProperty("store.results");
  });

  it("max_concurrency > 1 limits concurrent workers", async () => {
    let running = 0;
    let maxRunning = 0;

    mockRunPipelineCall.mockImplementation(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 30));
      running--;
      return { outcome: "ok" };
    });

    const ctx = makeContext({ items: [0, 1, 2] });
    await runForeach("", {
      taskId: "p", stageName: "loop", context: ctx,
      runtime: makeRuntime({ max_concurrency: 2 }),
    });

    expect(maxRunning).toBeLessThanOrEqual(2);
    expect(mockRunPipelineCall).toHaveBeenCalledTimes(3);
  });

  it("fail_fast aborts remaining workers after first error", async () => {
    let callCount = 0;
    mockRunPipelineCall.mockImplementation(async (_: any, input: any) => {
      callCount++;
      const idx = input.context.store.current_item;
      if (idx === 0) {
        // Item 0 fails quickly
        await new Promise((r) => setTimeout(r, 5));
        throw new Error("item 0 failed");
      }
      // Other items finish fast so the surviving worker can loop and attempt more items
      await new Promise((r) => setTimeout(r, 15));
      return { outcome: `done-${idx}` };
    });

    // 10 items with concurrency 2: workers 0 and 1 start items 0 and 1.
    // Item 0 fails at ~5ms and sets the abort signal.
    // Worker 1 finishes item 1 at ~15ms, then checks the while-loop condition.
    // Without the abort signal, worker 1 would pick up items 2, 3, ... in rapid succession.
    // With the abort signal, worker 1 stops after item 1.
    const ctx = makeContext({ items: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] });
    await expect(runForeach("", {
      taskId: "p", stageName: "loop", context: ctx,
      runtime: makeRuntime({ max_concurrency: 2, on_item_error: "fail_fast" }),
    })).rejects.toThrow("item 0 failed");

    // Wait for the surviving worker to finish its loop iterations (if any)
    await new Promise((r) => setTimeout(r, 200));

    // With the abort signal: only items 0 and 1 are attempted (one per worker).
    // Without the abort signal: worker 1 would continue to process items 2-9.
    expect(callCount).toBe(2);
  });

  it("returns empty object for item_writes fields that do not exist in result", async () => {
    mockRunPipelineCall.mockResolvedValue({ unrelated: "value" });

    const result = await runForeach("", {
      taskId: "p", stageName: "loop",
      context: makeContext({ items: ["x"] }),
      runtime: makeRuntime({ item_writes: ["nonexistent_field"] }),
    });

    expect(result).toEqual({ results: [{}] });
  });

  it("does not pass reads to sub-pipeline when foreach has no reads config", async () => {
    mockRunPipelineCall.mockResolvedValue({ outcome: "ok" });

    await runForeach("", {
      taskId: "p", stageName: "loop",
      context: makeContext({ items: ["x"] }),
      runtime: makeRuntime(),
    });

    const callInput = mockRunPipelineCall.mock.calls[0][1];
    // Only item_var is in reads
    expect(callInput.runtime.reads).toEqual({ current_item: "current_item" });
  });

  it("passes parent store reads to sub-pipeline when foreach has reads config", async () => {
    mockRunPipelineCall.mockResolvedValue({ outcome: "ok" });

    const parentStore = {
      items: ["x"],
      outputPlan: { deliverables: ["report"] },
      domainKnowledge: { protocols: ["LayerZero"] },
      onchainFacts: { verifiedClaims: 5 },
    };

    await runForeach("", {
      taskId: "p", stageName: "loop",
      context: makeContext(parentStore),
      runtime: makeRuntime({
        reads: {
          outputPlan: "outputPlan",
          domainKnowledge: "domainKnowledge",
          onchainFacts: "onchainFacts",
        },
      }),
    });

    const callInput = mockRunPipelineCall.mock.calls[0][1];
    // reads should include both the foreach reads and the item_var
    expect(callInput.runtime.reads).toEqual({
      outputPlan: "outputPlan",
      domainKnowledge: "domainKnowledge",
      onchainFacts: "onchainFacts",
      current_item: "current_item",
    });
    // context.store should contain all parent data + item
    expect(callInput.context.store.outputPlan).toEqual({ deliverables: ["report"] });
    expect(callInput.context.store.domainKnowledge).toEqual({ protocols: ["LayerZero"] });
    expect(callInput.context.store.onchainFacts).toEqual({ verifiedClaims: 5 });
    expect(callInput.context.store.current_item).toBe("x");
  });

  it("cleans up dangling sub-tasks after foreach completes with on_item_error=continue", async () => {
    // Item 0 succeeds, item 1 fails (simulating timeout), item 2 succeeds
    mockRunPipelineCall
      .mockResolvedValueOnce({ outcome: "ok-a" })
      .mockRejectedValueOnce(new Error("timed out"))
      .mockResolvedValueOnce({ outcome: "ok-c" });

    // Simulate a dangling sub-task left in "blocked" state by the timed-out item
    const danglingActor = { getSnapshot: () => ({ context: { status: "blocked" } }) };
    const completedActor = { getSnapshot: () => ({ context: { status: "completed" } }) };
    mockGetAllWorkflows.mockReturnValue(new Map([
      ["p-sub-loop-item-1-12345", danglingActor],
      ["p-sub-loop-item-0-12345", completedActor],
      ["unrelated-task", completedActor],
    ]));

    await runForeach("", {
      taskId: "p", stageName: "loop", context: makeContext(), runtime: makeRuntime({ on_item_error: "continue" }),
    });

    // The dangling "blocked" sub-task should be cancelled
    expect(mockSendEvent).toHaveBeenCalledWith("p-sub-loop-item-1-12345", { type: "CANCEL" });
    expect(mockCancelTask).toHaveBeenCalledWith("p-sub-loop-item-1-12345");

    // Completed sub-tasks and unrelated tasks should NOT be cancelled
    expect(mockSendEvent).not.toHaveBeenCalledWith("p-sub-loop-item-0-12345", expect.anything());
    expect(mockSendEvent).not.toHaveBeenCalledWith("unrelated-task", expect.anything());
  });

  it("respects max_concurrency (serial with max_concurrency=1)", async () => {
    const callOrder: number[] = [];
    mockRunPipelineCall.mockImplementation(async (_: any, input: any) => {
      const idx = input.context.store.current_item;
      callOrder.push(idx);
      // Small delay to verify serialization
      await new Promise((r) => setTimeout(r, 10));
      return { outcome: `done-${idx}` };
    });

    const ctx = makeContext({ items: [0, 1, 2] });
    await runForeach("", {
      taskId: "p", stageName: "loop", context: ctx,
      runtime: makeRuntime({ max_concurrency: 1 }),
    });

    // With max_concurrency=1, items should be processed in order
    expect(callOrder).toEqual([0, 1, 2]);
  });
});

describe("runForeach — worktree isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateWorktree.mockImplementation((_parent: string, suffix: string) =>
      Promise.resolve({ worktreePath: `/tmp/wt-${suffix}`, branchName: `main-${suffix}`, repoRoot: "/repo" }),
    );
    mockCommitAll.mockResolvedValue(true);
    mockCleanupWorktreeOnly.mockResolvedValue(undefined);
    mockGetDiffStat.mockResolvedValue({ filesChanged: ["src/a.ts", "src/b.ts"], diffStat: " 2 files changed" });
  });

  function makeIsolatedContext(): WorkflowContext {
    return {
      taskId: "t1", status: "running", retryCount: 0, qaRetryCount: 0,
      stageSessionIds: {}, worktreePath: "/parent/wt", branch: "main",
      store: { items: ["a", "b"] },
    };
  }

  function makeIsolatedRuntime(overrides: Partial<ForeachRuntimeConfig> = {}): ForeachRuntimeConfig {
    return {
      engine: "foreach", items: "items", item_var: "task",
      pipeline_name: "sub", isolation: "worktree",
      collect_to: "results", item_writes: ["out"],
      ...overrides,
    };
  }

  it("creates a worktree per item and passes isolated paths", async () => {
    mockRunPipelineCall.mockResolvedValue({ out: "ok" });

    await runForeach("", {
      taskId: "t1", stageName: "loop", context: makeIsolatedContext(), runtime: makeIsolatedRuntime(),
    });

    expect(mockCreateWorktree).toHaveBeenCalledTimes(2);
    expect(mockCreateWorktree.mock.calls[0][0]).toBe("/parent/wt");
    expect(mockCreateWorktree.mock.calls[1][0]).toBe("/parent/wt");

    // Sub-pipeline should receive isolated worktree path
    for (const call of mockRunPipelineCall.mock.calls) {
      expect(call[1].context.worktreePath).toMatch(/^\/tmp\/wt-/);
      expect(call[1].context.branch).toMatch(/^main-/);
    }
  });

  it("auto-commits in each item worktree on success", async () => {
    mockRunPipelineCall.mockResolvedValue({ out: "ok" });

    await runForeach("", {
      taskId: "t1", stageName: "loop", context: makeIsolatedContext(), runtime: makeIsolatedRuntime(),
    });

    expect(mockCommitAll).toHaveBeenCalledTimes(2);
  });

  it("skips auto-commit when auto_commit is false", async () => {
    mockRunPipelineCall.mockResolvedValue({ out: "ok" });

    await runForeach("", {
      taskId: "t1", stageName: "loop", context: makeIsolatedContext(),
      runtime: makeIsolatedRuntime({ auto_commit: false }),
    });

    expect(mockCommitAll).not.toHaveBeenCalled();
  });

  it("includes __branch in collected results", async () => {
    mockRunPipelineCall.mockResolvedValue({ out: "ok" });

    const result = await runForeach("", {
      taskId: "t1", stageName: "loop", context: makeIsolatedContext(), runtime: makeIsolatedRuntime(),
    });

    expect(result.results).toHaveLength(2);
    for (const r of result.results as Record<string, any>[]) {
      expect(r.__branch).toMatch(/^main-/);
      expect(r.out).toBe("ok");
    }
  });

  it("includes __filesChanged and __diffStat in collected results", async () => {
    mockRunPipelineCall.mockResolvedValue({ out: "ok" });

    const result = await runForeach("", {
      taskId: "t1", stageName: "loop", context: makeIsolatedContext(), runtime: makeIsolatedRuntime(),
    });

    expect(mockGetDiffStat).toHaveBeenCalledTimes(2);
    for (const r of result.results as Record<string, any>[]) {
      expect(r.__filesChanged).toEqual(["src/a.ts", "src/b.ts"]);
      expect(r.__diffStat).toBe(" 2 files changed");
    }
  });

  it("omits diff info when commitAll returns false (no changes)", async () => {
    mockCommitAll.mockResolvedValue(false);
    mockRunPipelineCall.mockResolvedValue({ out: "ok" });

    const result = await runForeach("", {
      taskId: "t1", stageName: "loop", context: makeIsolatedContext(), runtime: makeIsolatedRuntime(),
    });

    expect(mockGetDiffStat).not.toHaveBeenCalled();
    for (const r of result.results as Record<string, any>[]) {
      expect(r.__filesChanged).toBeUndefined();
    }
  });

  it("gracefully handles getDiffStat failure", async () => {
    mockGetDiffStat.mockRejectedValue(new Error("git error"));
    mockRunPipelineCall.mockResolvedValue({ out: "ok" });

    const result = await runForeach("", {
      taskId: "t1", stageName: "loop", context: makeIsolatedContext(), runtime: makeIsolatedRuntime(),
    });

    // Should not throw, just omit diff info
    for (const r of result.results as Record<string, any>[]) {
      expect(r.__branch).toBeDefined();
      expect(r.__filesChanged).toBeUndefined();
    }
  });

  it("detects file overlap and marks __conflictRisk with shared files", async () => {
    mockGetDiffStat
      .mockResolvedValueOnce({ filesChanged: ["src/shared.ts", "src/a.ts"], diffStat: "2 files" })
      .mockResolvedValueOnce({ filesChanged: ["src/shared.ts", "src/b.ts"], diffStat: "2 files" });
    mockRunPipelineCall.mockResolvedValue({ out: "ok" });

    const result = await runForeach("", {
      taskId: "t1", stageName: "loop", context: makeIsolatedContext(), runtime: makeIsolatedRuntime(),
    });

    const results = result.results as Record<string, any>[];
    expect(results[0].__conflictRisk).toBe(true);
    expect(results[0].__overlapsWithItems).toEqual([{ item: 1, files: ["src/shared.ts"] }]);
    expect(results[1].__conflictRisk).toBe(true);
    expect(results[1].__overlapsWithItems).toEqual([{ item: 0, files: ["src/shared.ts"] }]);
  });

  it("does not mark __conflictRisk when no file overlap", async () => {
    mockGetDiffStat
      .mockResolvedValueOnce({ filesChanged: ["src/a.ts"], diffStat: "1 file" })
      .mockResolvedValueOnce({ filesChanged: ["src/b.ts"], diffStat: "1 file" });
    mockRunPipelineCall.mockResolvedValue({ out: "ok" });

    const result = await runForeach("", {
      taskId: "t1", stageName: "loop", context: makeIsolatedContext(), runtime: makeIsolatedRuntime(),
    });

    const results = result.results as Record<string, any>[];
    expect(results[0].__conflictRisk).toBeUndefined();
    expect(results[1].__conflictRisk).toBeUndefined();
  });

  it("cleans up all worktrees in finally block", async () => {
    mockRunPipelineCall.mockResolvedValue({ out: "ok" });

    await runForeach("", {
      taskId: "t1", stageName: "loop", context: makeIsolatedContext(), runtime: makeIsolatedRuntime(),
    });

    expect(mockCleanupWorktreeOnly).toHaveBeenCalledTimes(2);
  });

  it("cleans up worktrees even when items fail", async () => {
    mockRunPipelineCall
      .mockResolvedValueOnce({ out: "ok" })
      .mockRejectedValueOnce(new Error("fail"));

    await expect(runForeach("", {
      taskId: "t1", stageName: "loop", context: makeIsolatedContext(),
      runtime: makeIsolatedRuntime({ on_item_error: "fail_fast" }),
    })).rejects.toThrow("fail");

    // Both worktrees should still be cleaned up
    expect(mockCleanupWorktreeOnly).toHaveBeenCalledTimes(2);
  });

  it("throws when isolation=worktree but no parent worktreePath", async () => {
    const ctx = makeIsolatedContext();
    ctx.worktreePath = undefined;

    await expect(runForeach("", {
      taskId: "t1", stageName: "loop", context: ctx, runtime: makeIsolatedRuntime(),
    })).rejects.toThrow(/worktree isolation requires a parent worktree/);
  });

  it("default isolation (shared) does not create worktrees", async () => {
    mockRunPipelineCall.mockResolvedValue({ out: "ok" });
    const ctx = makeIsolatedContext();

    await runForeach("", {
      taskId: "t1", stageName: "loop", context: ctx,
      runtime: makeIsolatedRuntime({ isolation: undefined }),
    });

    expect(mockCreateWorktree).not.toHaveBeenCalled();
    expect(mockCleanupWorktreeOnly).not.toHaveBeenCalled();
  });
});
