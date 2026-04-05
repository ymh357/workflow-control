/**
 * Integration tests for condition, pipeline call, and foreach stage types.
 * Uses the REAL XState state machine with FAKE executors.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createActor, waitFor, type AnyActor } from "xstate";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../lib/logger.js", () => {
  const noop = () => noopLogger;
  const noopLogger: Record<string, any> = new Proxy({}, {
    get: () => noop,
  });
  return { logger: noopLogger, taskLogger: () => noopLogger };
});

vi.mock("../lib/slack.js", () => ({
  notifyStageComplete: vi.fn(async () => {}),
  notifyBlocked: vi.fn(async () => {}),
  notifyCompleted: vi.fn(async () => {}),
  notifyQuestionAsked: vi.fn(async () => {}),
  notifyCancelled: vi.fn(async () => {}),
  notifyGenericGate: vi.fn(async () => {}),
  withRetry: vi.fn(async (fn: () => Promise<any>) => fn()),
}));

vi.mock("../lib/notion.js", () => ({
  updateNotionPageStatus: vi.fn(async () => {}),
}));

vi.mock("../lib/artifacts.js", () => ({
  writeArtifact: vi.fn(async () => {}),
  readArtifact: vi.fn(async () => null),
  appendProgress: vi.fn(async () => {}),
  stageCompleted: vi.fn(async () => {}),
  artifactExists: vi.fn(async () => false),
}));

vi.mock("../lib/db.js", () => ({
  getDb: () => ({
    exec: vi.fn(),
    prepare: () => ({ run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) }),
  }),
}));

vi.mock("../sse/manager.js", () => {
  const mgr = { pushMessage: vi.fn(), addListener: vi.fn(() => () => {}) };
  return { sseManager: mgr };
});

const mockRunAgent = vi.fn<(...args: any[]) => any>();
const mockRunScript = vi.fn<(...args: any[]) => any>();

vi.mock("../agent/executor.js", () => ({
  runAgent: (...args: any[]) => mockRunAgent(...args),
  runScript: (...args: any[]) => mockRunScript(...args),
  cancelTask: vi.fn(),
  queueInterruptMessage: vi.fn(),
  interruptActiveQuery: vi.fn(async () => undefined),
  getActiveQueryInfo: vi.fn(),
  buildTier1Context: vi.fn(() => ""),
  generateSchemaPrompt: vi.fn(() => ""),
  AgentResult: {},
}));

vi.mock("../edge/actor.js", () => ({
  runEdgeAgent: vi.fn(async () => ({ resultText: "{}", costUsd: 0, durationMs: 0 })),
}));

const mockRunPipelineCall = vi.fn<(...args: any[]) => any>();
const mockRunForeach = vi.fn<(...args: any[]) => any>();

vi.mock("../agent/pipeline-executor.js", () => ({
  runPipelineCall: (...args: any[]) => mockRunPipelineCall(...args),
}));

vi.mock("../agent/foreach-executor.js", () => ({
  runForeach: (...args: any[]) => mockRunForeach(...args),
}));

// Real imports
import { createWorkflowMachine } from "../machine/machine.js";
import type { PipelineConfig } from "../lib/config-loader.js";
import type { WorkflowContext } from "../machine/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(pipeline: PipelineConfig): WorkflowContext["config"] {
  return {
    pipelineName: pipeline.name,
    pipeline,
    prompts: { system: {}, fragments: {}, globalConstraints: "", globalClaudeMd: "", globalGeminiMd: "",
        globalCodexMd: "" },
    skills: [],
    mcps: [],
  };
}

function startMachine(pipeline: PipelineConfig, store: Record<string, any> = {}, taskId = "test-1") {
  const machine = createWorkflowMachine(pipeline);
  const actor = createActor(machine);
  actor.start();
  actor.send({
    type: "START_ANALYSIS",
    taskId,
    taskText: "Test task",
    config: makeConfig(pipeline),
    initialStore: Object.keys(store).length > 0 ? store : undefined,
  });
  actor.send({ type: "LAUNCH" });
  return actor;
}

function agentResult(fields: Record<string, any>, cost = 0.01) {
  return {
    resultText: JSON.stringify(fields),
    costUsd: cost,
    durationMs: 100,
    sessionId: `session-${Date.now()}`,
  };
}

async function waitForStatus(actor: AnyActor, status: string, timeoutMs = 5000): Promise<void> {
  await waitFor(actor, (snap) => snap.context.status === status, { timeout: timeoutMs });
}

// ---------------------------------------------------------------------------
// Condition Stage
// ---------------------------------------------------------------------------

describe("Condition stage integration", () => {
  let actor: AnyActor;

  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { actor?.stop(); });

  // Condition routes to one of two agent stages. Both branch targets converge
  // to "completed" automatically (pipeline-builder detects condition branch targets
  // and overrides their nextTarget to the convergence point).
  function conditionPipeline(): PipelineConfig {
    return {
      name: "condition-test",
      stages: [
        {
          name: "analyze",
          type: "agent",
          runtime: { engine: "llm" as const, system_prompt: "analyze", writes: ["analysis"] },
        },
        {
          name: "route",
          type: "condition",
          runtime: {
            engine: "condition" as const,
            branches: [
              { when: "store.analysis.passed == true", to: "fast-track" },
              { default: true, to: "fallback" },
            ],
          },
        },
        {
          name: "fast-track",
          type: "agent",
          runtime: { engine: "llm" as const, system_prompt: "fast", writes: ["result"] },
        },
        {
          name: "fallback",
          type: "agent",
          runtime: { engine: "llm" as const, system_prompt: "fallback", writes: ["result"] },
        },
      ],
    };
  }

  it("routes to fast-track when condition matches (exclusive — fallback is NOT executed)", async () => {
    mockRunAgent
      .mockResolvedValueOnce(agentResult({ analysis: { passed: true } }))
      .mockResolvedValueOnce(agentResult({ result: { path: "fast" } }));

    actor = startMachine(conditionPipeline());
    await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

    const ctx = actor.getSnapshot().context;
    expect(ctx.status).toBe("completed");
    expect(ctx.store.result).toEqual({ path: "fast" });
    const stageNames = mockRunAgent.mock.calls.map((c: any[]) => c[1]?.stageName);
    expect(stageNames).toContain("fast-track");
    expect(stageNames).not.toContain("fallback");
    expect(mockRunAgent).toHaveBeenCalledTimes(2); // analyze + fast-track only
  });

  it("routes to default branch when no condition matches (exclusive — fast-track is NOT executed)", async () => {
    mockRunAgent
      .mockResolvedValueOnce(agentResult({ analysis: { passed: false } }))
      .mockResolvedValueOnce(agentResult({ result: { path: "fallback" } }));

    actor = startMachine(conditionPipeline());
    await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

    const ctx = actor.getSnapshot().context;
    expect(ctx.status).toBe("completed");
    expect(ctx.store.result).toEqual({ path: "fallback" });
    const stageNames = mockRunAgent.mock.calls.map((c: any[]) => c[1]?.stageName);
    expect(stageNames).toContain("fallback");
    expect(stageNames).not.toContain("fast-track");
    expect(mockRunAgent).toHaveBeenCalledTimes(2); // analyze + fallback only
  });

  it("handles numeric comparison — routes to medium, skips high and low", async () => {
    const pipeline: PipelineConfig = {
      name: "numeric-condition",
      stages: [
        { name: "score", type: "agent", runtime: { engine: "llm" as const, system_prompt: "score", writes: ["score"] } },
        {
          name: "route",
          type: "condition",
          runtime: {
            engine: "condition" as const,
            branches: [
              { when: "store.score > 80", to: "high" },
              { when: "store.score > 50", to: "medium" },
              { default: true, to: "low" },
            ],
          },
        },
        { name: "high", type: "agent", runtime: { engine: "llm" as const, system_prompt: "h", writes: ["result"] } },
        { name: "medium", type: "agent", runtime: { engine: "llm" as const, system_prompt: "m", writes: ["result"] } },
        { name: "low", type: "agent", runtime: { engine: "llm" as const, system_prompt: "l", writes: ["result"] } },
      ],
    };

    mockRunAgent
      .mockResolvedValueOnce(agentResult({ score: 65 }))
      .mockResolvedValueOnce(agentResult({ result: "medium-path" }));

    actor = startMachine(pipeline);
    await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

    const stageNames = mockRunAgent.mock.calls.map((c: any[]) => c[1]?.stageName);
    expect(stageNames).toContain("medium");
    expect(stageNames).not.toContain("high");
    expect(stageNames).not.toContain("low");
    expect(mockRunAgent).toHaveBeenCalledTimes(2); // score + medium only
  });

  it("falls back to default when expression evaluation fails", async () => {
    const pipeline: PipelineConfig = {
      name: "bad-expr",
      stages: [
        { name: "work", type: "agent", runtime: { engine: "llm" as const, system_prompt: "w", writes: ["data"] } },
        {
          name: "route",
          type: "condition",
          runtime: {
            engine: "condition" as const,
            branches: [
              // This expression will throw because store.nonexistent is undefined
              { when: "store.nonexistent.deeply.nested == true", to: "work" },
              { default: true, to: "completed" },
            ],
          },
        },
      ],
    };

    mockRunAgent.mockResolvedValueOnce(agentResult({ data: "hello" }));

    actor = startMachine(pipeline);
    await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

    // Expression fails → falls back to default → "completed"
    expect(actor.getSnapshot().context.status).toBe("completed");
    expect(mockRunAgent).toHaveBeenCalledTimes(1); // only "work"
  });
});

// ---------------------------------------------------------------------------
// Pipeline Call Stage
// ---------------------------------------------------------------------------

describe("Pipeline Call stage integration", () => {
  let actor: AnyActor;

  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { actor?.stop(); });

  function pipelineCallPipeline(): PipelineConfig {
    return {
      name: "parent-pipeline",
      stages: [
        {
          name: "prepare",
          type: "agent",
          runtime: { engine: "llm" as const, system_prompt: "prepare", writes: ["pr_url"] },
        },
        {
          name: "run-review",
          type: "pipeline",
          runtime: {
            engine: "pipeline" as const,
            pipeline_name: "code-review",
            reads: { url: "pr_url" },
            writes: ["review_summary", "passed"],
            timeout_sec: 60,
          },
        },
        {
          name: "finalize",
          type: "agent",
          runtime: { engine: "llm" as const, system_prompt: "finalize", writes: ["output"] },
        },
      ],
    };
  }

  it("happy path: calls sub-pipeline and merges writes back to parent store", async () => {
    mockRunAgent
      .mockResolvedValueOnce(agentResult({ pr_url: "https://github.com/pr/1" }))
      .mockResolvedValueOnce(agentResult({ output: { done: true } }));

    mockRunPipelineCall.mockResolvedValueOnce({
      review_summary: "LGTM",
      passed: true,
    });

    actor = startMachine(pipelineCallPipeline());
    await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

    const ctx = actor.getSnapshot().context;
    expect(ctx.status).toBe("completed");
    expect(ctx.store.review_summary).toBe("LGTM");
    expect(ctx.store.passed).toBe(true);
    expect(ctx.store.output).toEqual({ done: true });

    // Verify runPipelineCall was called with correct input
    expect(mockRunPipelineCall).toHaveBeenCalledTimes(1);
    const callInput = mockRunPipelineCall.mock.calls[0][1] as any;
    expect(callInput.stageName).toBe("run-review");
    expect(callInput.runtime.pipeline_name).toBe("code-review");
  });

  it("blocks when sub-pipeline fails after retries exhausted", async () => {
    mockRunAgent.mockResolvedValueOnce(agentResult({ pr_url: "https://github.com/pr/1" }));
    // MAX_STAGE_RETRIES = 2, so initial + 2 retries = 3 calls
    mockRunPipelineCall
      .mockRejectedValueOnce(new Error("Sub-pipeline failed"))
      .mockRejectedValueOnce(new Error("Sub-pipeline failed again"))
      .mockRejectedValueOnce(new Error("Sub-pipeline failed 3rd time"));

    actor = startMachine(pipelineCallPipeline());
    await waitForStatus(actor, "blocked");

    const ctx = actor.getSnapshot().context;
    expect(ctx.status).toBe("blocked");
    expect(ctx.lastStage).toBe("run-review");
    expect(ctx.error).toContain("Sub-pipeline failed");
  });

  it("retry from blocked re-invokes the pipeline call", async () => {
    mockRunAgent.mockResolvedValueOnce(agentResult({ pr_url: "url" }));
    mockRunPipelineCall
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("timeout again"))
      .mockRejectedValueOnce(new Error("timeout 3"));

    actor = startMachine(pipelineCallPipeline());
    await waitForStatus(actor, "blocked");
    expect(actor.getSnapshot().context.lastStage).toBe("run-review");

    // Retry
    mockRunPipelineCall.mockResolvedValueOnce({ review_summary: "ok", passed: true });
    mockRunAgent.mockResolvedValueOnce(agentResult({ output: { done: true } }));

    actor.send({ type: "RETRY" });
    await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });
    expect(actor.getSnapshot().context.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Foreach Stage
// ---------------------------------------------------------------------------

describe("Foreach stage integration", () => {
  let actor: AnyActor;

  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { actor?.stop(); });

  function foreachPipeline(): PipelineConfig {
    return {
      name: "foreach-test",
      stages: [
        {
          name: "gather",
          type: "agent",
          runtime: { engine: "llm" as const, system_prompt: "gather", writes: ["items"] },
        },
        {
          name: "process-each",
          type: "foreach",
          runtime: {
            engine: "foreach" as const,
            items: "store.items",
            item_var: "current_item",
            pipeline_name: "item-processor",
            max_concurrency: 2,
            collect_to: "results",
            item_writes: ["outcome"],
            on_item_error: "continue" as const,
          },
        },
        {
          name: "summarize",
          type: "agent",
          runtime: { engine: "llm" as const, system_prompt: "summarize", writes: ["summary"] },
        },
      ],
    };
  }

  it("happy path: iterates over items and collects results", async () => {
    mockRunAgent
      .mockResolvedValueOnce(agentResult({ items: ["a", "b", "c"] }))
      .mockResolvedValueOnce(agentResult({ summary: "all done" }));

    mockRunForeach.mockResolvedValueOnce({
      results: [
        { outcome: "processed-a" },
        { outcome: "processed-b" },
        { outcome: "processed-c" },
      ],
    });

    actor = startMachine(foreachPipeline());
    await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

    const ctx = actor.getSnapshot().context;
    expect(ctx.status).toBe("completed");
    expect(ctx.store.results).toEqual([
      { outcome: "processed-a" },
      { outcome: "processed-b" },
      { outcome: "processed-c" },
    ]);
    expect(ctx.store.summary).toBe("all done");

    // Verify runForeach was called with correct input
    expect(mockRunForeach).toHaveBeenCalledTimes(1);
    const callInput = mockRunForeach.mock.calls[0][1] as any;
    expect(callInput.stageName).toBe("process-each");
    expect(callInput.runtime.items).toBe("store.items");
    expect(callInput.runtime.max_concurrency).toBe(2);
  });

  it("blocks when foreach executor fails after retries exhausted", async () => {
    mockRunAgent.mockResolvedValueOnce(agentResult({ items: ["a"] }));
    // MAX_STAGE_RETRIES = 2, so initial + 2 retries = 3 calls
    mockRunForeach
      .mockRejectedValueOnce(new Error("items is not an array"))
      .mockRejectedValueOnce(new Error("items is not an array"))
      .mockRejectedValueOnce(new Error("items is not an array"));

    actor = startMachine(foreachPipeline());
    await waitForStatus(actor, "blocked");

    const ctx = actor.getSnapshot().context;
    expect(ctx.status).toBe("blocked");
    expect(ctx.lastStage).toBe("process-each");
    expect(ctx.error).toContain("items is not an array");
  });

  it("retry from blocked re-invokes foreach", async () => {
    mockRunAgent.mockResolvedValueOnce(agentResult({ items: ["x"] }));
    mockRunForeach
      .mockRejectedValueOnce(new Error("fail"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockRejectedValueOnce(new Error("fail 3"));

    actor = startMachine(foreachPipeline());
    await waitForStatus(actor, "blocked");

    // Retry with success
    mockRunForeach.mockResolvedValueOnce({ results: [{ outcome: "ok" }] });
    mockRunAgent.mockResolvedValueOnce(agentResult({ summary: "done" }));

    actor.send({ type: "RETRY" });
    await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });
    expect(actor.getSnapshot().context.status).toBe("completed");
    expect(actor.getSnapshot().context.store.results).toEqual([{ outcome: "ok" }]);
  });
});

// ---------------------------------------------------------------------------
// Condition with 3 branch targets (mutual exclusivity)
// ---------------------------------------------------------------------------

describe("Condition stage — 3-way branching (high/medium/low)", () => {
  let actor: AnyActor;

  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { actor?.stop(); });

  function threeWayPipeline(): PipelineConfig {
    return {
      name: "three-way",
      stages: [
        { name: "score", type: "agent", runtime: { engine: "llm" as const, system_prompt: "score", writes: ["score"] } },
        {
          name: "route", type: "condition",
          runtime: {
            engine: "condition" as const,
            branches: [
              { when: "store.score > 80", to: "high" },
              { when: "store.score > 50", to: "medium" },
              { default: true, to: "low" },
            ],
          },
        },
        { name: "high", type: "agent", runtime: { engine: "llm" as const, system_prompt: "h", writes: ["result"] } },
        { name: "medium", type: "agent", runtime: { engine: "llm" as const, system_prompt: "m", writes: ["result"] } },
        { name: "low", type: "agent", runtime: { engine: "llm" as const, system_prompt: "l", writes: ["result"] } },
      ],
    };
  }

  it("routes to high, skips medium and low", async () => {
    mockRunAgent
      .mockResolvedValueOnce(agentResult({ score: 90 }))
      .mockResolvedValueOnce(agentResult({ result: "high-path" }));

    actor = startMachine(threeWayPipeline());
    await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

    const stages = mockRunAgent.mock.calls.map((c: any[]) => c[1]?.stageName);
    expect(stages).toContain("high");
    expect(stages).not.toContain("medium");
    expect(stages).not.toContain("low");
    expect(mockRunAgent).toHaveBeenCalledTimes(2);
  });

  it("routes to low, skips high and medium", async () => {
    mockRunAgent
      .mockResolvedValueOnce(agentResult({ score: 30 }))
      .mockResolvedValueOnce(agentResult({ result: "low-path" }));

    actor = startMachine(threeWayPipeline());
    await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

    const stages = mockRunAgent.mock.calls.map((c: any[]) => c[1]?.stageName);
    expect(stages).toContain("low");
    expect(stages).not.toContain("high");
    expect(stages).not.toContain("medium");
    expect(mockRunAgent).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Foreach fail_fast stops subsequent items
// ---------------------------------------------------------------------------

describe("Foreach stage — fail_fast stops subsequent items", () => {
  let actor: AnyActor;

  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { actor?.stop(); });

  it("fail_fast prevents remaining items from executing", async () => {
    mockRunAgent.mockResolvedValueOnce(agentResult({ items: ["a", "b", "c", "d", "e"] }));

    let foreachCallCount = 0;
    mockRunForeach.mockImplementation(async () => {
      foreachCallCount++;
      throw new Error("First item failed immediately");
    });

    const pipeline: PipelineConfig = {
      name: "foreach-failfast",
      stages: [
        { name: "gather", type: "agent", runtime: { engine: "llm" as const, system_prompt: "g", writes: ["items"] } },
        {
          name: "loop", type: "foreach",
          runtime: {
            engine: "foreach" as const,
            items: "store.items", item_var: "item", pipeline_name: "child",
            max_concurrency: 1, on_item_error: "fail_fast" as const, collect_to: "results",
          },
        },
      ],
    };

    actor = startMachine(pipeline);
    await waitForStatus(actor, "blocked");

    const ctx = actor.getSnapshot().context;
    expect(ctx.status).toBe("blocked");
    expect(ctx.lastStage).toBe("loop");
    expect(ctx.error).toContain("First item failed");
  });

  it("fail_fast error message propagates to context.error with retry recovery", async () => {
    mockRunAgent.mockResolvedValueOnce(agentResult({ items: ["x", "y"] }));

    // First call: fail_fast throws
    mockRunForeach
      .mockRejectedValueOnce(new Error("item x exploded"))
      .mockRejectedValueOnce(new Error("item x exploded again"))
      .mockRejectedValueOnce(new Error("item x exploded 3rd"));

    const pipeline: PipelineConfig = {
      name: "foreach-failfast-retry",
      stages: [
        { name: "gather", type: "agent", runtime: { engine: "llm" as const, system_prompt: "g", writes: ["items"] } },
        {
          name: "loop", type: "foreach",
          runtime: {
            engine: "foreach" as const,
            items: "store.items", item_var: "item", pipeline_name: "child",
            max_concurrency: 1, on_item_error: "fail_fast" as const, collect_to: "results",
          },
        },
        { name: "finish", type: "agent", runtime: { engine: "llm" as const, system_prompt: "f", writes: ["done"] } },
      ],
    };

    actor = startMachine(pipeline);
    await waitForStatus(actor, "blocked");

    expect(actor.getSnapshot().context.error).toContain("item x exploded");

    // Retry succeeds
    mockRunForeach.mockResolvedValueOnce({ results: [{ ok: "x" }, { ok: "y" }] });
    mockRunAgent.mockResolvedValueOnce(agentResult({ done: true }));

    actor.send({ type: "RETRY" });
    await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

    const ctx2 = actor.getSnapshot().context;
    expect(ctx2.status).toBe("completed");
    expect(ctx2.store.results).toEqual([{ ok: "x" }, { ok: "y" }]);
    expect(ctx2.store.done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Combined: Condition + Pipeline Call
// ---------------------------------------------------------------------------

describe("Combined: condition routing into pipeline call", () => {
  let actor: AnyActor;

  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { actor?.stop(); });

  it("condition routes to pipeline call stage, which completes successfully", async () => {
    const pipeline: PipelineConfig = {
      name: "combined-test",
      stages: [
        {
          name: "check",
          type: "agent",
          runtime: { engine: "llm" as const, system_prompt: "check", writes: ["status"] },
        },
        {
          name: "decide",
          type: "condition",
          runtime: {
            engine: "condition" as const,
            branches: [
              { when: "store.status == 'needs_review'", to: "deep-review" },
              { default: true, to: "quick-finish" },
            ],
          },
        },
        {
          name: "deep-review",
          type: "pipeline",
          runtime: {
            engine: "pipeline" as const,
            pipeline_name: "review-pipeline",
            reads: { input: "status" },
            writes: ["review"],
          },
        },
        {
          name: "quick-finish",
          type: "script",
          runtime: { engine: "script" as const, script_id: "quick", writes: ["review"] },
        },
      ],
    };

    mockRunAgent.mockResolvedValueOnce(agentResult({ status: "needs_review" }));
    // Condition routes to deep-review; quick-finish is skipped (exclusive branches)
    mockRunPipelineCall.mockResolvedValueOnce({ review: "thorough review done" });

    actor = startMachine(pipeline);
    await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

    const ctx = actor.getSnapshot().context;
    expect(ctx.status).toBe("completed");
    expect(ctx.store.review).toBe("thorough review done");
    expect(mockRunPipelineCall).toHaveBeenCalledTimes(1);
    expect(mockRunAgent).toHaveBeenCalledTimes(1); // only check agent
    expect(mockRunScript).not.toHaveBeenCalled(); // quick-finish was skipped
  });
});

// ---------------------------------------------------------------------------
// CANCEL / INTERRUPT during pipeline call and foreach
// ---------------------------------------------------------------------------

describe("Cancel/Interrupt during new stage types", () => {
  let actor: AnyActor;

  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { actor?.stop(); });

  it("CANCEL during pipeline call transitions to cancelled", async () => {
    mockRunAgent.mockResolvedValueOnce(agentResult({ pr_url: "url" }));

    let resolvePipelineCall!: (value: any) => void;
    mockRunPipelineCall.mockImplementationOnce(
      () => new Promise((resolve) => { resolvePipelineCall = resolve; }),
    );

    const pipeline: PipelineConfig = {
      name: "cancel-pipeline-call",
      stages: [
        { name: "prep", type: "agent", runtime: { engine: "llm" as const, system_prompt: "p", writes: ["pr_url"] } },
        { name: "sub", type: "pipeline", runtime: { engine: "pipeline" as const, pipeline_name: "child", writes: ["out"] } },
      ],
    };

    actor = startMachine(pipeline);
    await waitForStatus(actor, "sub");

    actor.send({ type: "CANCEL" });
    await waitForStatus(actor, "cancelled");
    expect(actor.getSnapshot().context.lastStage).toBe("sub");
  });

  it("INTERRUPT during foreach transitions to blocked, RETRY recovers", async () => {
    mockRunAgent.mockResolvedValueOnce(agentResult({ items: [1, 2, 3] }));

    let resolveForeach!: (value: any) => void;
    mockRunForeach.mockImplementationOnce(
      () => new Promise((resolve) => { resolveForeach = resolve; }),
    );

    const pipeline: PipelineConfig = {
      name: "interrupt-foreach",
      stages: [
        { name: "gather", type: "agent", runtime: { engine: "llm" as const, system_prompt: "g", writes: ["items"] } },
        {
          name: "loop",
          type: "foreach",
          runtime: { engine: "foreach" as const, items: "store.items", item_var: "i", pipeline_name: "c", collect_to: "results" },
        },
      ],
    };

    actor = startMachine(pipeline);
    await waitForStatus(actor, "loop");

    actor.send({ type: "INTERRUPT", reason: "paused" } as any);
    await waitForStatus(actor, "blocked");
    expect(actor.getSnapshot().context.lastStage).toBe("loop");

    // Retry
    mockRunForeach.mockResolvedValueOnce({ results: [{ ok: true }] });
    actor.send({ type: "RETRY" });

    await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });
    expect(actor.getSnapshot().context.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Pipeline call: store merge — writes overwrite existing keys
// ---------------------------------------------------------------------------

describe("Pipeline Call — store merge overwrites existing keys", () => {
  let actor: AnyActor;

  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { actor?.stop(); });

  it("sub-pipeline writes overwrite parent store keys", async () => {
    const pipeline: PipelineConfig = {
      name: "store-merge",
      stages: [
        { name: "init", type: "agent", runtime: { engine: "llm" as const, system_prompt: "init", writes: ["data", "keep"] } },
        {
          name: "sub", type: "pipeline",
          runtime: {
            engine: "pipeline" as const,
            pipeline_name: "child",
            reads: { input: "data" },
            writes: ["data"],
          },
        },
      ],
    };

    mockRunAgent.mockResolvedValueOnce(agentResult({ data: "original", keep: "untouched" }));
    mockRunPipelineCall.mockResolvedValueOnce({ data: "overwritten" });

    actor = startMachine(pipeline);
    await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

    const ctx = actor.getSnapshot().context;
    expect(ctx.store.data).toBe("overwritten");
    expect(ctx.store.keep).toBe("untouched");
  });
});

// ---------------------------------------------------------------------------
// Pipeline call: empty output does not corrupt store
// ---------------------------------------------------------------------------

describe("Pipeline Call — empty output handling", () => {
  let actor: AnyActor;

  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { actor?.stop(); });

  it("empty output from sub-pipeline preserves existing store", async () => {
    const pipeline: PipelineConfig = {
      name: "null-output",
      stages: [
        { name: "init", type: "agent", runtime: { engine: "llm" as const, system_prompt: "init", writes: ["data"] } },
        {
          name: "sub", type: "pipeline",
          runtime: { engine: "pipeline" as const, pipeline_name: "child", writes: ["out"] },
        },
      ],
    };

    mockRunAgent.mockResolvedValueOnce(agentResult({ data: "hello" }));
    mockRunPipelineCall.mockResolvedValueOnce({});

    actor = startMachine(pipeline);
    await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

    const ctx = actor.getSnapshot().context;
    expect(ctx.store.data).toBe("hello");
    expect(ctx.store.out).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Condition → Foreach combination
// ---------------------------------------------------------------------------

describe("Condition routing into Foreach stage", () => {
  let actor: AnyActor;

  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { actor?.stop(); });

  it("condition routes to foreach, foreach completes, pipeline finishes", async () => {
    const pipeline: PipelineConfig = {
      name: "cond-foreach",
      stages: [
        { name: "check", type: "agent", runtime: { engine: "llm" as const, system_prompt: "check", writes: ["mode", "items"] } },
        {
          name: "route", type: "condition",
          runtime: {
            engine: "condition" as const,
            branches: [
              { when: "store.mode == 'batch'", to: "batch-loop" },
              { default: true, to: "single" },
            ],
          },
        },
        {
          name: "batch-loop", type: "foreach",
          runtime: {
            engine: "foreach" as const,
            items: "store.items", item_var: "item", pipeline_name: "processor",
            collect_to: "results", max_concurrency: 1, on_item_error: "continue" as const,
          },
        },
        { name: "single", type: "agent", runtime: { engine: "llm" as const, system_prompt: "single", writes: ["results"] } },
      ],
    };

    mockRunAgent.mockResolvedValueOnce(agentResult({ mode: "batch", items: ["a", "b"] }));
    mockRunForeach.mockResolvedValueOnce({
      results: [{ processed: "a" }, { processed: "b" }],
    });

    actor = startMachine(pipeline);
    await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

    const ctx = actor.getSnapshot().context;
    expect(ctx.status).toBe("completed");
    expect(ctx.store.results).toEqual([{ processed: "a" }, { processed: "b" }]);
    expect(mockRunForeach).toHaveBeenCalledTimes(1);
    const agentStages = mockRunAgent.mock.calls.map((c: any[]) => c[1]?.stageName);
    expect(agentStages).not.toContain("single");
  });
});

// ---------------------------------------------------------------------------
// Condition with invalid expression — falls back to default at runtime
// ---------------------------------------------------------------------------

describe("Condition — invalid expression falls back to default", () => {
  let actor: AnyActor;

  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { actor?.stop(); });

  it("malformed when expression silently falls through to default branch", async () => {
    const pipeline: PipelineConfig = {
      name: "bad-expr-rt",
      stages: [
        { name: "work", type: "agent", runtime: { engine: "llm" as const, system_prompt: "w", writes: ["data"] } },
        {
          name: "route", type: "condition",
          runtime: {
            engine: "condition" as const,
            branches: [
              { when: "store.data ++ invalid syntax !!", to: "work" },
              { default: true, to: "completed" },
            ],
          },
        },
      ],
    };

    mockRunAgent.mockResolvedValueOnce(agentResult({ data: "hello" }));

    actor = startMachine(pipeline);
    await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

    expect(actor.getSnapshot().context.status).toBe("completed");
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Foreach: no collect_to — results discarded
// ---------------------------------------------------------------------------

describe("Foreach — no collect_to, results discarded", () => {
  let actor: AnyActor;

  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { actor?.stop(); });

  it("foreach without collect_to completes and preserves existing store", async () => {
    const pipeline: PipelineConfig = {
      name: "foreach-no-collect",
      stages: [
        { name: "init", type: "agent", runtime: { engine: "llm" as const, system_prompt: "init", writes: ["items", "keep"] } },
        {
          name: "loop", type: "foreach",
          runtime: {
            engine: "foreach" as const,
            items: "store.items", item_var: "item", pipeline_name: "processor",
            max_concurrency: 1,
          },
        },
      ],
    };

    mockRunAgent.mockResolvedValueOnce(agentResult({ items: [1, 2], keep: "preserved" }));
    mockRunForeach.mockResolvedValueOnce({});

    actor = startMachine(pipeline);
    await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

    const ctx = actor.getSnapshot().context;
    expect(ctx.status).toBe("completed");
    expect(ctx.store.keep).toBe("preserved");
    expect(ctx.store.results).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Pipeline Call — retry resets retryCount, next stage gets correct store
// ---------------------------------------------------------------------------

describe("Pipeline Call — retryCount reset after success", () => {
  let actor: AnyActor;

  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { actor?.stop(); });

  it("after retry, next stage receives correct store from sub-pipeline", async () => {
    const pipeline: PipelineConfig = {
      name: "retry-store",
      stages: [
        { name: "prep", type: "agent", runtime: { engine: "llm" as const, system_prompt: "p", writes: ["input"] } },
        {
          name: "sub", type: "pipeline",
          runtime: { engine: "pipeline" as const, pipeline_name: "child", reads: { x: "input" }, writes: ["output"] },
        },
        { name: "final", type: "agent", runtime: { engine: "llm" as const, system_prompt: "f", writes: ["done"] } },
      ],
    };

    mockRunAgent.mockResolvedValueOnce(agentResult({ input: "data" }));
    mockRunPipelineCall
      .mockRejectedValueOnce(new Error("fail1"))
      .mockRejectedValueOnce(new Error("fail2"))
      .mockRejectedValueOnce(new Error("fail3"));

    actor = startMachine(pipeline);
    await waitForStatus(actor, "blocked");
    expect(actor.getSnapshot().context.lastStage).toBe("sub");

    mockRunPipelineCall.mockResolvedValueOnce({ output: "success" });
    mockRunAgent.mockResolvedValueOnce(agentResult({ done: true }));

    actor.send({ type: "RETRY" });
    await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

    const ctx = actor.getSnapshot().context;
    expect(ctx.status).toBe("completed");
    expect(ctx.store.input).toBe("data");
    expect(ctx.store.output).toBe("success");
    expect(ctx.store.done).toBe(true);
  });
});
