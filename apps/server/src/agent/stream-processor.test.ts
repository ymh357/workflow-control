import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- Mocks ----

const queryTrackerMock = vi.hoisted(() => ({
  registerQuery: vi.fn(),
  unregisterQuery: vi.fn(),
  getActiveQuery: vi.fn(),
  consumePendingResume: vi.fn(),
  hasPendingResume: vi.fn().mockReturnValue(false),
  AgentError: class AgentError extends Error {
    readonly agentStatus: string;
    constructor(agentStatus: string, message: string) {
      super(message);
      this.name = "AgentError";
      this.agentStatus = agentStatus;
    }
  },
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
  persistSessionId: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./query-tracker.js", () => queryTrackerMock);

import { processAgentStream } from "./stream-processor.js";
import { sseManager } from "../sse/manager.js";
import { persistSessionId } from "./session-persister.js";

// ---- Helpers ----

function makeAsyncIterable(messages: any[]): any {
  let closed = false;
  return {
    close: vi.fn(() => { closed = true; }),
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (closed || i >= messages.length) return { done: true, value: undefined };
          return { done: false, value: messages[i++] };
        },
      };
    },
  };
}

function makeThrowingIterable(messages: any[], error: Error): any {
  let closed = false;
  return {
    close: vi.fn(() => { closed = true; }),
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (closed) return { done: true, value: undefined };
          if (i < messages.length) return { done: false, value: messages[i++] };
          throw error;
        },
      };
    },
  };
}

function defaultParams(overrides: Partial<Parameters<typeof processAgentStream>[0]> = {}) {
  return {
    taskId: "task-1",
    stageName: "testStage",
    agentQuery: makeAsyncIterable([]),
    resumeDepth: 0,
    onResume: vi.fn(),
    ...overrides,
  };
}

// ---- Tests ----

describe("processAgentStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    queryTrackerMock.hasPendingResume.mockReturnValue(false);
    queryTrackerMock.getActiveQuery.mockReturnValue(undefined);
    queryTrackerMock.consumePendingResume.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------- Basic happy path ----------

  it("returns empty result when stream has no messages", async () => {
    const promise = processAgentStream(defaultParams());
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toEqual({ resultText: "", sessionId: undefined, costUsd: 0, durationMs: 0 });
    expect(queryTrackerMock.registerQuery).toHaveBeenCalledWith("task-1", expect.anything());
    expect(queryTrackerMock.unregisterQuery).toHaveBeenCalledWith("task-1");
  });

  // ---------- Inactivity timeout ----------

  it("fires inactivity timeout after 10 minutes of silence", async () => {
    const query = makeAsyncIterable([]);
    // Make the iterator hang forever
    const origIterator = query[Symbol.asyncIterator];
    query[Symbol.asyncIterator] = function () {
      return {
        async next() {
          // Never resolves during the test — we advance timers instead
          return new Promise(() => {});
        },
      };
    };

    const promise = processAgentStream(defaultParams({ agentQuery: query }));

    // Advance past the 5-minute timeout
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(sseManager.pushMessage).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ type: "error" }),
    );
    expect(query.close).toHaveBeenCalled();
  });

  it("resets inactivity timer on each message", async () => {
    let resolvers: Array<(v: any) => void> = [];
    const query = {
      close: vi.fn(),
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          next() {
            if (i >= 2) return Promise.resolve({ done: true, value: undefined });
            i++;
            return new Promise((resolve) => { resolvers.push(resolve); });
          },
        };
      },
    };

    const promise = processAgentStream(defaultParams({ agentQuery: query }));

    // Advance 4 minutes — no timeout yet
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    expect(sseManager.pushMessage).not.toHaveBeenCalledWith("task-1", expect.objectContaining({ type: "error" }));

    // Deliver first message — resets the timer
    resolvers[0]!({ done: false, value: { type: "system", subtype: "init" } });
    await vi.advanceTimersByTimeAsync(0);

    // Another 4 minutes — should still not timeout because timer was reset
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    expect(sseManager.pushMessage).not.toHaveBeenCalledWith("task-1", expect.objectContaining({ type: "error" }));

    // End the stream
    resolvers[1]!({ done: true, value: undefined });
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;
    expect(result.resultText).toBe("");
  });

  it("clears inactivity timer in finally block on normal completion", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const promise = processAgentStream(defaultParams());
    await vi.runAllTimersAsync();
    await promise;
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("throws after stream completes if timedOut flag is set", async () => {
    // Simulate: timeout fires, then stream ends normally
    const query = {
      close: vi.fn(),
      [Symbol.asyncIterator]() {
        let delivered = false;
        return {
          async next() {
            if (!delivered) {
              delivered = true;
              // Wait long enough for timeout to fire
              await new Promise((r) => setTimeout(r, 10 * 60 * 1000));
              return { done: true, value: undefined };
            }
            return { done: true, value: undefined };
          },
        };
      },
    };

    const promise = processAgentStream(defaultParams({ agentQuery: query })).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/timed out after 10 minutes/);
  });

  // ---------- MAX_RESUME_DEPTH ----------

  it("throws when resumeDepth >= MAX_RESUME_DEPTH in catch path", async () => {
    const triggerErr = new Error("interrupted");
    const query = makeThrowingIterable(
      [{ type: "system", subtype: "init", session_id: "s1" }],
      triggerErr,
    );
    queryTrackerMock.hasPendingResume.mockReturnValue(true);

    const promise = processAgentStream(defaultParams({ agentQuery: query, resumeDepth: 3 })).catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    const caught = await promise;
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Max resume depth (3) exceeded");
  });

  it("throws when resumeDepth >= MAX_RESUME_DEPTH in post-completion path", async () => {
    const resultMsg = {
      type: "result",
      subtype: "success",
      result: "done",
      session_id: "s1",
      total_cost_usd: 0,
      duration_ms: 0,
    };
    const query = makeAsyncIterable([resultMsg]);
    queryTrackerMock.hasPendingResume.mockReturnValue(true);

    const promise = processAgentStream(defaultParams({ agentQuery: query, resumeDepth: 3 })).catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Max resume depth (3) exceeded");
  });

  // ---------- Resume race conditions ----------

  it("resumes on catch when pending resume exists and depth is valid", async () => {
    const err = new Error("interrupted");
    const query = makeThrowingIterable(
      [{ type: "system", subtype: "init", session_id: "s1" }],
      err,
    );
    queryTrackerMock.hasPendingResume.mockReturnValue(true);
    queryTrackerMock.consumePendingResume.mockReturnValue("user says hi");
    const onResume = vi.fn().mockResolvedValue({ resultText: "resumed", sessionId: "s2", costUsd: 0, durationMs: 0 });

    const promise = processAgentStream(defaultParams({ agentQuery: query, resumeDepth: 1, onResume }));
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(onResume).toHaveBeenCalledWith({ sessionId: "s1", resumePrompt: "user says hi" });
    expect(result.resultText).toBe("resumed");
    // handledResume = true, so unregisterQuery should NOT be called in finally
    expect(queryTrackerMock.unregisterQuery).not.toHaveBeenCalled();
  });

  it("resumes after normal completion when pending resume exists", async () => {
    const resultMsg = {
      type: "result",
      subtype: "success",
      result: "done",
      session_id: "s1",
      total_cost_usd: 0.01,
      duration_ms: 100,
    };
    const query = makeAsyncIterable([resultMsg]);
    queryTrackerMock.hasPendingResume.mockReturnValue(true);
    queryTrackerMock.consumePendingResume.mockReturnValue("continue please");
    const onResume = vi.fn().mockResolvedValue({ resultText: "more", sessionId: "s3", costUsd: 0, durationMs: 0 });

    const promise = processAgentStream(defaultParams({ agentQuery: query, resumeDepth: 0, onResume }));
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(onResume).toHaveBeenCalledWith({ sessionId: "s1", resumePrompt: "continue please" });
    expect(result.resultText).toBe("more");
  });

  it("re-throws original error when no pending resume in catch", async () => {
    const err = new Error("boom");
    const query = makeThrowingIterable([], err);
    queryTrackerMock.hasPendingResume.mockReturnValue(false);

    const promise = processAgentStream(defaultParams({ agentQuery: query })).catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    const caught = await promise;
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("boom");
  });

  // ---------- Message type: assistant ----------

  it("handles assistant text blocks and pushes SSE", async () => {
    const msg = {
      type: "assistant",
      message: { content: [{ type: "text", text: "hello world" }] },
    };
    const query = makeAsyncIterable([msg]);

    const promise = processAgentStream(defaultParams({ agentQuery: query }));
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.resultText).toBe("hello world");
    expect(sseManager.pushMessage).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ type: "agent_text" }),
    );
  });

  it("handles assistant thinking blocks", async () => {
    const msg = {
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "let me think..." }] },
    };
    const query = makeAsyncIterable([msg]);

    const promise = processAgentStream(defaultParams({ agentQuery: query }));
    await vi.runAllTimersAsync();
    await promise;

    expect(sseManager.pushMessage).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ type: "agent_thinking" }),
    );
  });

  it("handles assistant tool_use blocks and increments toolCallCount", async () => {
    const msg = {
      type: "assistant",
      message: { content: [
        { type: "tool_use", name: "myTool", input: { a: 1 } },
        { type: "tool_use", name: "myTool2", input: {} },
      ] },
    };
    const query = makeAsyncIterable([msg]);

    const promise = processAgentStream(defaultParams({ agentQuery: query }));
    await vi.runAllTimersAsync();
    await promise;

    // Should have agent_tool_use + agent_progress for each tool_use block
    const calls = (sseManager.pushMessage as any).mock.calls;
    const toolUseCalls = calls.filter((c: any) => c[1].type === "agent_tool_use");
    const progressCalls = calls.filter((c: any) => c[1].type === "agent_progress");
    expect(toolUseCalls).toHaveLength(2);
    expect(progressCalls).toHaveLength(2);
    expect(progressCalls[1][1].data.toolCallCount).toBe(2);
  });

  // ---------- Message type: result ----------

  it("handles result subtype=success with structured_output", async () => {
    const msg = {
      type: "result",
      subtype: "success",
      structured_output: { key: "value" },
      result: "fallback text",
      total_cost_usd: 0.05,
      duration_ms: 500,
      session_id: "s9",
    };
    const query = makeAsyncIterable([msg]);

    const promise = processAgentStream(defaultParams({ agentQuery: query }));
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.resultText).toBe(JSON.stringify({ key: "value" }));
    expect(result.costUsd).toBe(0.05);
    expect(result.durationMs).toBe(500);
    expect(result.sessionId).toBe("s9");
  });

  it("handles result subtype=success falling back to result text when no structured_output", async () => {
    const msg = {
      type: "result",
      subtype: "success",
      result: "plain text result",
      total_cost_usd: 0,
      duration_ms: 0,
    };
    const query = makeAsyncIterable([msg]);

    const promise = processAgentStream(defaultParams({ agentQuery: query }));
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.resultText).toBe("plain text result");
  });

  // ---------- error_max_budget_usd / error_max_turns ----------

  it("throws AgentError for error_max_budget_usd subtype", async () => {
    const msg = {
      type: "result",
      subtype: "error_max_budget_usd",
      total_cost_usd: 1.0,
      duration_ms: 10000,
    };
    const query = makeAsyncIterable([msg]);

    const promise = processAgentStream(defaultParams({ agentQuery: query })).catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    const caught = await promise;
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Budget limit reached for this stage");
    expect((caught as any).name).toBe("AgentError");
    expect((caught as any).agentStatus).toBe("error_max_budget_usd");
  });

  it("throws AgentError for error_max_turns subtype", async () => {
    const msg = {
      type: "result",
      subtype: "error_max_turns",
      error_message: "too many turns buddy",
      total_cost_usd: 0,
      duration_ms: 0,
    };
    const query = makeAsyncIterable([msg]);

    const promise = processAgentStream(defaultParams({ agentQuery: query })).catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    const caught = await promise;
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("too many turns buddy");
  });

  // ---------- structured_output fallback ----------

  it("falls back to last resultText on error_max_structured_output_retries", async () => {
    const textMsg = {
      type: "assistant",
      message: { content: [{ type: "text", text: "accumulated text" }] },
    };
    const resultMsg = {
      type: "result",
      subtype: "error_max_structured_output_retries",
      total_cost_usd: 0.1,
      duration_ms: 200,
      session_id: "s5",
    };
    const query = makeAsyncIterable([textMsg, resultMsg]);

    const promise = processAgentStream(defaultParams({ agentQuery: query }));
    await vi.runAllTimersAsync();
    const result = await promise;

    // Should keep accumulated text, not overwrite it
    expect(result.resultText).toBe("accumulated text");
  });

  // ---------- Session ID handling ----------

  it("persists session ID on first message with session_id", async () => {
    const activeRef = { sessionId: undefined as string | undefined, stageName: "testStage", query: {} };
    queryTrackerMock.getActiveQuery.mockReturnValue(activeRef);

    const msg = { type: "system", subtype: "init", session_id: "sess-abc" };
    const query = makeAsyncIterable([msg]);

    const promise = processAgentStream(defaultParams({ agentQuery: query }));
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(activeRef.sessionId).toBe("sess-abc");
    expect(persistSessionId).toHaveBeenCalledWith("task-1", "testStage", "sess-abc");
    expect(result.sessionId).toBe("sess-abc");
  });

  // ---------- system / default message types ----------

  it("handles system messages without error", async () => {
    const msg = { type: "system", subtype: "ping", data: {} };
    const query = makeAsyncIterable([msg]);

    const promise = processAgentStream(defaultParams({ agentQuery: query }));
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.resultText).toBe("");
  });

  it("handles unknown message types via default branch", async () => {
    const msg = { type: "totally_unknown", foo: "bar" };
    const query = makeAsyncIterable([msg]);

    const promise = processAgentStream(defaultParams({ agentQuery: query }));
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.resultText).toBe("");
  });
});
