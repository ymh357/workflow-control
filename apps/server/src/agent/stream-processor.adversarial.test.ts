import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

describe("adversarial: session_id only captured once", () => {
  it("ignores subsequent session_id values after the first", async () => {
    const activeRef = { sessionId: undefined as string | undefined, stageName: "testStage", query: {} };
    queryTrackerMock.getActiveQuery.mockReturnValue(activeRef);

    const messages = [
      { type: "system", session_id: "first-id" },
      { type: "system", session_id: "second-id" },
      { type: "result", subtype: "success", result: "ok", session_id: "result-id", total_cost_usd: 0, duration_ms: 0 },
    ];
    const query = makeAsyncIterable(messages);

    const promise = processAgentStream(defaultParams({ agentQuery: query }));
    await vi.runAllTimersAsync();
    const result = await promise;

    // Result session_id from a "result" message overwrites, but the early capture should be "first-id"
    expect(activeRef.sessionId).toBe("first-id");
    // Final result gets session_id from result message
    expect(result.sessionId).toBe("result-id");
  });
});

describe("adversarial: assistant message with mixed content blocks", () => {
  it("processes text, thinking, and tool_use blocks in a single message", async () => {
    const msg = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "hello" },
          { type: "thinking", thinking: "hmm" },
          { type: "tool_use", name: "bash", input: { cmd: "ls" } },
          { type: "text", text: " world" },
        ],
      },
    };
    const query = makeAsyncIterable([msg]);

    const promise = processAgentStream(defaultParams({ agentQuery: query }));
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.resultText).toBe("hello world");
    const calls = (sseManager.pushMessage as any).mock.calls;
    const types = calls.map((c: any) => c[1].type);
    expect(types).toContain("agent_text");
    expect(types).toContain("agent_thinking");
    expect(types).toContain("agent_tool_use");
  });
});

describe("adversarial: result with no subtype throws with 'unknown error'", () => {
  it("throws AgentError with 'unknown error' when subtype is undefined and no error_message/result", async () => {
    const msg = {
      type: "result",
      // no subtype, no error_message, no result
      total_cost_usd: 0,
      duration_ms: 0,
    };
    const query = makeAsyncIterable([msg]);

    const promise = processAgentStream(defaultParams({ agentQuery: query })).catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    const caught = await promise;
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("unknown error");
  });
});

describe("adversarial: result uses error_message over result for error subtypes", () => {
  it("prefers error_message when both error_message and result are present", async () => {
    const msg = {
      type: "result",
      subtype: "error_max_budget_usd",
      error_message: "Budget exceeded: $5.00",
      result: "Some fallback text",
      total_cost_usd: 5,
      duration_ms: 0,
    };
    const query = makeAsyncIterable([msg]);

    const promise = processAgentStream(defaultParams({ agentQuery: query })).catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    const caught = await promise;
    expect((caught as Error).message).toBe("Budget exceeded: $5.00");
  });
});

describe("adversarial: catch path without sessionId does not resume even with pending", () => {
  it("re-throws error when catch has pending resume but no sessionId was captured", async () => {
    const err = new Error("interrupted");
    const query = makeThrowingIterable([], err);
    queryTrackerMock.hasPendingResume.mockReturnValue(true);

    const promise = processAgentStream(defaultParams({ agentQuery: query })).catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    const caught = await promise;
    // No sessionId was captured (no messages), so hasPendingResume is true but sessionId is undefined
    // The condition is: hasPendingResume(taskId) && sessionId
    // sessionId is undefined, so it falls through to re-throw
    expect(caught).toBe(err);
  });
});

describe("adversarial: post-completion resume without sessionId does not resume", () => {
  it("returns normal result when hasPendingResume but no sessionId after completion", async () => {
    // No session_id in any message
    const msg = {
      type: "result",
      subtype: "success",
      result: "done",
      total_cost_usd: 0,
      duration_ms: 0,
    };
    const query = makeAsyncIterable([msg]);
    queryTrackerMock.hasPendingResume.mockReturnValue(true);
    const onResume = vi.fn();

    const promise = processAgentStream(defaultParams({ agentQuery: query, onResume }));
    await vi.runAllTimersAsync();
    const result = await promise;

    // Should NOT call onResume because sessionId is undefined
    expect(onResume).not.toHaveBeenCalled();
    expect(result.resultText).toBe("done");
  });
});

describe("adversarial: empty text block does not append to resultText", () => {
  it("ignores text blocks with empty string", async () => {
    const msg = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "" },
          { type: "text", text: "real" },
        ],
      },
    };
    const query = makeAsyncIterable([msg]);

    const promise = processAgentStream(defaultParams({ agentQuery: query }));
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.resultText).toBe("real");
  });
});

describe("adversarial: multiple result messages — last one wins", () => {
  it("overwrites costUsd and durationMs from later result messages", async () => {
    // NOTE: In practice only one result should be sent, but testing the code path
    const messages = [
      {
        type: "result",
        subtype: "error_max_structured_output_retries",
        total_cost_usd: 0.1,
        duration_ms: 100,
      },
      {
        type: "result",
        subtype: "success",
        result: "final",
        total_cost_usd: 0.5,
        duration_ms: 500,
        session_id: "s2",
      },
    ];
    const query = makeAsyncIterable(messages);

    const promise = processAgentStream(defaultParams({ agentQuery: query }));
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.costUsd).toBe(0.5);
    expect(result.durationMs).toBe(500);
    expect(result.resultText).toBe("final");
  });
});

describe("adversarial: unregisterQuery called even on timeout", () => {
  it("unregisters query in finally block on timeout path", async () => {
    const query = {
      close: vi.fn(),
      [Symbol.asyncIterator]() {
        let delivered = false;
        return {
          async next() {
            if (!delivered) {
              delivered = true;
              await new Promise((r) => setTimeout(r, 5 * 60 * 1000));
              return { done: true, value: undefined };
            }
            return { done: true, value: undefined };
          },
        };
      },
    };

    const promise = processAgentStream(defaultParams({ agentQuery: query })).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    await promise;
    // finally block should have called unregisterQuery since handledResume is false
    expect(queryTrackerMock.unregisterQuery).toHaveBeenCalledWith("task-1");
  });
});
