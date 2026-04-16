import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));
vi.mock("../sse/manager.js", () => ({
  sseManager: { pushMessage: vi.fn() },
}));
vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock("./session-persister.js", () => ({
  persistSessionId: vi.fn(),
}));
vi.mock("../lib/mcp-config.js", () => ({
  buildMcpServers: vi.fn(() => ({})),
}));
vi.mock("../lib/child-env.js", () => ({
  buildChildEnv: vi.fn(() => ({})),
}));
vi.mock("./executor-hooks.js", () => ({
  createAskUserQuestionInterceptor: vi.fn(() => vi.fn()),
  createPathRestrictionHook: vi.fn(() => vi.fn()),
}));
vi.mock("../lib/config-loader.js", () => ({
  loadSystemSettings: vi.fn(() => ({})),
}));
vi.mock("./prompt-builder.js", () => ({
  buildSystemAppendPrompt: vi.fn(async () => ({
    prompt: "append",
    fragmentIds: [],
  })),
  buildStaticPromptPrefix: vi.fn(() => ""),
}));
vi.mock("./red-flag-detector.js", () => {
  class MockRedFlagAccumulator {
    append = vi.fn(() => []);
    getFlagSummary = vi.fn(() => null);
  }
  return { RedFlagAccumulator: MockRedFlagAccumulator };
});

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { sseManager } from "../sse/manager.js";
import { SessionManager, type ExecuteStageParams } from "./session-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createFakeQuery(messages: Array<Record<string, unknown>>) {
  let index = 0;
  const iterator = {
    next: () => {
      if (index >= messages.length)
        return Promise.resolve({ value: undefined, done: true as const });
      return Promise.resolve({
        value: messages[index++],
        done: false as const,
      });
    },
  };
  const q = {
    [Symbol.asyncIterator]: () => iterator,
    setModel: vi.fn().mockResolvedValue(undefined),
    setMcpServers: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
  return q;
}

function baseParams(overrides?: Partial<ExecuteStageParams>): ExecuteStageParams {
  return {
    taskId: "task-1",
    stageName: "stage-a",
    tier1Context: "tier1 context",
    stagePrompt: "do the work",
    stageConfig: {
      model: "claude-sonnet-4-6",
      mcpServices: [],
      permissionMode: "bypassPermissions",
      maxTurns: 50,
      maxBudgetUsd: 5,
      thinking: { type: "disabled" },
    },
    worktreePath: "/tmp/work",
    interactive: false,
    runtime: { engine: "llm", system_prompt: "stage-a" } as any,
    context: {
      taskId: "task-1",
      status: "running",
      retryCount: 0,
      qaRetryCount: 0,
      store: {},
      stageSessionIds: {},
    } as any,
    ...overrides,
  };
}

function createManager() {
  return new SessionManager({
    taskId: "task-1",
    claudePath: "/usr/bin/claude",
    idleTimeoutMs: 60_000,
    cwd: "/tmp/work",
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates query on first executeStage and returns AgentResult", async () => {
    const fakeQuery = createFakeQuery([
      {
        type: "assistant",
        session_id: "sess-1",
        message: {
          content: [{ type: "text", text: "working on it" }],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "sess-1",
        result: '{"answer": 42}',
        total_cost_usd: 0.01,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 20,
        },
      },
    ]);

    (sdkQuery as ReturnType<typeof vi.fn>).mockReturnValue(fakeQuery);

    const mgr = createManager();
    const result = await mgr.executeStage(baseParams());

    expect(sdkQuery).toHaveBeenCalledTimes(1);
    expect(result.resultText).toBe('{"answer": 42}');
    expect(result.sessionId).toBe("sess-1");
    expect(result.costUsd).toBeCloseTo(0.01);
    expect(result.tokenUsage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      totalTokens: 150,
    });
    expect(result.cwd).toBe("/tmp/work");
    expect(typeof result.durationMs).toBe("number");

    mgr.close();
  });

  it("reuses query on second executeStage and computes differential cost", async () => {
    const fakeQuery = createFakeQuery([
      // Stage 1 messages
      {
        type: "assistant",
        session_id: "sess-1",
        message: { content: [{ type: "text", text: "stage 1 output" }] },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "sess-1",
        result: "stage1-result",
        total_cost_usd: 0.05,
        usage: {
          input_tokens: 200,
          output_tokens: 100,
          cache_read_input_tokens: 50,
        },
      },
      // Stage 2 messages
      {
        type: "assistant",
        session_id: "sess-1",
        message: { content: [{ type: "text", text: "stage 2 output" }] },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "sess-1",
        result: "stage2-result",
        total_cost_usd: 0.12,
        usage: {
          input_tokens: 500,
          output_tokens: 250,
          cache_read_input_tokens: 100,
        },
      },
    ]);

    (sdkQuery as ReturnType<typeof vi.fn>).mockReturnValue(fakeQuery);

    const mgr = createManager();

    const result1 = await mgr.executeStage(baseParams());
    expect(result1.resultText).toBe("stage1-result");
    expect(result1.costUsd).toBeCloseTo(0.05);
    expect(result1.tokenUsage!.inputTokens).toBe(200);

    const result2 = await mgr.executeStage(
      baseParams({ stageName: "stage-b", stagePrompt: "do stage 2" }),
    );

    // query() should only be called once (reused)
    expect(sdkQuery).toHaveBeenCalledTimes(1);
    expect(result2.resultText).toBe("stage2-result");
    // Differential cost: 0.12 - 0.05 = 0.07
    expect(result2.costUsd).toBeCloseTo(0.07);
    // Differential tokens: 500 - 200 = 300 input, 250 - 100 = 150 output
    expect(result2.tokenUsage!.inputTokens).toBe(300);
    expect(result2.tokenUsage!.outputTokens).toBe(150);
    expect(result2.tokenUsage!.cacheReadTokens).toBe(50);

    mgr.close();
  });

  it("calls setModel when model changes between stages", async () => {
    const fakeQuery = createFakeQuery([
      {
        type: "result",
        subtype: "success",
        session_id: "sess-1",
        result: "r1",
        total_cost_usd: 0.01,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "sess-1",
        result: "r2",
        total_cost_usd: 0.02,
        usage: { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 0 },
      },
    ]);

    (sdkQuery as ReturnType<typeof vi.fn>).mockReturnValue(fakeQuery);

    const mgr = createManager();
    await mgr.executeStage(baseParams());

    // Second stage with different model
    await mgr.executeStage(
      baseParams({
        stageName: "stage-b",
        stageConfig: {
          model: "claude-opus-4-6",
          mcpServices: [],
          permissionMode: "bypassPermissions",
          maxTurns: 50,
          maxBudgetUsd: 5,
          thinking: { type: "disabled" },
        },
      }),
    );

    expect(fakeQuery.setModel).toHaveBeenCalledWith("claude-opus-4-6");

    mgr.close();
  });

  it("yields feedback prompt on retry (resumeInfo present)", async () => {
    const fakeQuery = createFakeQuery([
      // First stage
      {
        type: "result",
        subtype: "success",
        session_id: "sess-1",
        result: "initial-result",
        total_cost_usd: 0.01,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
      },
      // Retry with feedback
      {
        type: "result",
        subtype: "success",
        session_id: "sess-1",
        result: "retry-result",
        total_cost_usd: 0.03,
        usage: { input_tokens: 30, output_tokens: 15, cache_read_input_tokens: 0 },
      },
    ]);

    (sdkQuery as ReturnType<typeof vi.fn>).mockReturnValue(fakeQuery);

    const mgr = createManager();

    const result1 = await mgr.executeStage(baseParams());
    expect(result1.resultText).toBe("initial-result");

    // Retry the same stage with feedback
    const result2 = await mgr.executeStage(
      baseParams({
        resumeInfo: { feedback: "Missing required JSON fields, try again" },
      }),
    );

    // Should reuse same query (called only once)
    expect(sdkQuery).toHaveBeenCalledTimes(1);
    expect(result2.resultText).toBe("retry-result");
    // Differential cost: 0.03 - 0.01 = 0.02
    expect(result2.costUsd).toBeCloseTo(0.02);

    mgr.close();
  });

  it("close() terminates the query", async () => {
    const fakeQuery = createFakeQuery([
      {
        type: "result",
        subtype: "success",
        session_id: "sess-1",
        result: "done",
        total_cost_usd: 0.01,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
      },
    ]);

    (sdkQuery as ReturnType<typeof vi.fn>).mockReturnValue(fakeQuery);

    const mgr = createManager();
    await mgr.executeStage(baseParams());

    mgr.close();

    expect(fakeQuery.close).toHaveBeenCalledTimes(1);
  });

  it("emits stage_change SSE at start of consumeUntilResult", async () => {
    const fakeQuery = createFakeQuery([
      {
        type: "result",
        subtype: "success",
        session_id: "sess-1",
        result: "ok",
        total_cost_usd: 0.01,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
      },
    ]);

    (sdkQuery as ReturnType<typeof vi.fn>).mockReturnValue(fakeQuery);

    const mgr = createManager();
    await mgr.executeStage(baseParams());

    const pushCalls = (sseManager.pushMessage as ReturnType<typeof vi.fn>).mock
      .calls;
    const stageChangeCall = pushCalls.find(
      (call: any[]) => call[1]?.type === "stage_change",
    );
    expect(stageChangeCall).toBeDefined();
    expect(stageChangeCall![1].data.stage).toBe("stage-a");

    mgr.close();
  });

  it("throws on error result subtype", async () => {
    const fakeQuery = createFakeQuery([
      {
        type: "result",
        subtype: "error_max_turns",
        session_id: "sess-1",
        result: "Max turns reached",
        total_cost_usd: 0.01,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
      },
    ]);

    (sdkQuery as ReturnType<typeof vi.fn>).mockReturnValue(fakeQuery);

    const mgr = createManager();
    await expect(mgr.executeStage(baseParams())).rejects.toThrow(
      "Max turns reached",
    );

    mgr.close();
  });

  it("throws when query ends unexpectedly (done=true without result)", async () => {
    const fakeQuery = createFakeQuery([
      // No messages — iterator returns done immediately
    ]);

    (sdkQuery as ReturnType<typeof vi.fn>).mockReturnValue(fakeQuery);

    const mgr = createManager();
    await expect(mgr.executeStage(baseParams())).rejects.toThrow(
      'Single-session query ended unexpectedly during stage "stage-a"',
    );

    mgr.close();
  });
});
