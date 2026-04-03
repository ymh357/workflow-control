import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  registerQuery,
  unregisterQuery,
  getActiveQuery,
  cancelTask,
  queueInterruptMessage,
  interruptActiveQuery,
  getActiveQueryInfo,
  consumePendingResume,
  hasPendingResume,
  AgentError,
  type AgentQuery,
  type ActiveQuery,
} from "./query-tracker.js";

function createMockQuery(overrides?: Partial<AgentQuery>): AgentQuery {
  return {
    close: vi.fn(),
    interrupt: vi.fn(),
    [Symbol.asyncIterator]: vi.fn(),
    ...overrides,
  };
}

function createActiveQuery(overrides?: Partial<ActiveQuery>): ActiveQuery {
  return {
    query: createMockQuery(),
    stageName: "coding",
    ...overrides,
  };
}

// Clean up shared module-level state between tests.
// cancelTask clears both activeQueries and pendingResumes.
const TASK_IDS = ["task-1", "task-2", "task-3", "task-cleanup"];
beforeEach(() => {
  for (const id of TASK_IDS) {
    cancelTask(id);
  }
});

describe("query lifecycle", () => {
  it("registerQuery and getActiveQuery", () => {
    const aq = createActiveQuery();
    registerQuery("task-1", aq);
    expect(getActiveQuery("task-1")).toBe(aq);
  });

  it("getActiveQuery returns undefined for unknown taskId", () => {
    expect(getActiveQuery("nonexistent")).toBeUndefined();
  });

  it("unregisterQuery removes the query", () => {
    registerQuery("task-1", createActiveQuery());
    unregisterQuery("task-1");
    expect(getActiveQuery("task-1")).toBeUndefined();
  });

  it("unregisterQuery is safe for unknown taskId", () => {
    expect(() => unregisterQuery("nonexistent")).not.toThrow();
  });
});

describe("cancelTask", () => {
  it("calls query.close() and removes query", () => {
    const aq = createActiveQuery();
    registerQuery("task-1", aq);
    cancelTask("task-1");
    expect(aq.query.close).toHaveBeenCalledOnce();
    expect(getActiveQuery("task-1")).toBeUndefined();
  });

  it("also clears pending resume", () => {
    const aq = createActiveQuery({ sessionId: "sess-1" });
    registerQuery("task-1", aq);
    queueInterruptMessage("task-1", "please fix");
    expect(hasPendingResume("task-1")).toBe(true);
    cancelTask("task-1");
    expect(hasPendingResume("task-1")).toBe(false);
  });

  it("is safe when no active query exists", () => {
    expect(() => cancelTask("nonexistent")).not.toThrow();
  });
});

describe("queueInterruptMessage", () => {
  it("returns false when no active query", () => {
    expect(queueInterruptMessage("task-1", "msg")).toBe(false);
  });

  it("returns false when active query has no sessionId", () => {
    registerQuery("task-1", createActiveQuery({ sessionId: undefined }));
    expect(queueInterruptMessage("task-1", "msg")).toBe(false);
  });

  it("returns true and queues message when sessionId exists", () => {
    registerQuery("task-1", createActiveQuery({ sessionId: "sess-1" }));
    expect(queueInterruptMessage("task-1", "fix this")).toBe(true);
    expect(hasPendingResume("task-1")).toBe(true);
  });
});

describe("interruptActiveQuery", () => {
  it("returns undefined when no active query", async () => {
    expect(await interruptActiveQuery("task-1")).toBeUndefined();
  });

  it("calls interrupt and returns sessionId", async () => {
    const aq = createActiveQuery({ sessionId: "sess-42" });
    registerQuery("task-1", aq);
    const sid = await interruptActiveQuery("task-1");
    expect(sid).toBe("sess-42");
    expect(aq.query.interrupt).toHaveBeenCalledOnce();
    expect(getActiveQuery("task-1")).toBeUndefined();
  });

  it("falls back to close() when interrupt() throws", async () => {
    const mockQuery = createMockQuery({
      interrupt: vi.fn().mockRejectedValue(new Error("interrupt failed")),
    });
    const aq = createActiveQuery({ query: mockQuery, sessionId: "sess-err" });
    registerQuery("task-1", aq);
    const sid = await interruptActiveQuery("task-1");
    expect(sid).toBe("sess-err");
    expect(mockQuery.close).toHaveBeenCalledOnce();
    expect(getActiveQuery("task-1")).toBeUndefined();
  });
});

describe("getActiveQueryInfo", () => {
  it("returns undefined for unknown task", () => {
    expect(getActiveQueryInfo("unknown")).toBeUndefined();
  });

  it("returns sessionId and stageName", () => {
    registerQuery("task-1", createActiveQuery({ sessionId: "sess-1", stageName: "analyzing" }));
    expect(getActiveQueryInfo("task-1")).toEqual({
      sessionId: "sess-1",
      stageName: "analyzing",
    });
  });

  it("returns undefined sessionId when not set", () => {
    registerQuery("task-1", createActiveQuery({ sessionId: undefined, stageName: "coding" }));
    expect(getActiveQueryInfo("task-1")).toEqual({
      sessionId: undefined,
      stageName: "coding",
    });
  });
});

describe("pending resume management", () => {
  it("consumePendingResume returns undefined when nothing queued", () => {
    expect(consumePendingResume("task-1")).toBeUndefined();
  });

  it("consumePendingResume returns and removes the message", () => {
    registerQuery("task-1", createActiveQuery({ sessionId: "s" }));
    queueInterruptMessage("task-1", "please retry");
    expect(consumePendingResume("task-1")).toBe("please retry");
    expect(consumePendingResume("task-1")).toBeUndefined();
  });

  it("hasPendingResume reflects state correctly", () => {
    registerQuery("task-1", createActiveQuery({ sessionId: "s" }));
    expect(hasPendingResume("task-1")).toBe(false);
    queueInterruptMessage("task-1", "msg");
    expect(hasPendingResume("task-1")).toBe(true);
    consumePendingResume("task-1");
    expect(hasPendingResume("task-1")).toBe(false);
  });
});

describe("AgentError", () => {
  it("has agentStatus property and correct name", () => {
    const err = new AgentError("failed", "Something went wrong");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AgentError");
    expect(err.agentStatus).toBe("failed");
    expect(err.message).toBe("Something went wrong");
  });
});

describe("interruptActiveQuery (additional)", () => {
  it("falls back to close() when interrupt() throws, and close() also throws", async () => {
    const mockQuery = createMockQuery({
      interrupt: vi.fn().mockRejectedValue(new Error("interrupt failed")),
      close: vi.fn().mockImplementation(() => { throw new Error("close failed"); }),
    });
    const aq = createActiveQuery({ query: mockQuery, sessionId: "sess-double-err" });
    registerQuery("task-1", aq);

    // Should not throw even though both interrupt and close fail
    const sid = await interruptActiveQuery("task-1");
    expect(sid).toBe("sess-double-err");
    expect(mockQuery.interrupt).toHaveBeenCalledOnce();
    expect(mockQuery.close).toHaveBeenCalledOnce();
    expect(getActiveQuery("task-1")).toBeUndefined();
  });
});

describe("cancelTask (additional)", () => {
  it("clears pendingResumes even when no active query", () => {
    // Queue a resume for a task that has a query
    registerQuery("task-1", createActiveQuery({ sessionId: "s1" }));
    queueInterruptMessage("task-1", "fix it");
    expect(hasPendingResume("task-1")).toBe(true);

    cancelTask("task-1");

    expect(hasPendingResume("task-1")).toBe(false);
    expect(getActiveQuery("task-1")).toBeUndefined();
  });

  it("calling cancelTask twice is safe", () => {
    registerQuery("task-1", createActiveQuery({ sessionId: "s1" }));
    cancelTask("task-1");
    expect(() => cancelTask("task-1")).not.toThrow();
  });
});

describe("queueInterruptMessage (additional)", () => {
  it("returns false when no sessionId present on active query", () => {
    registerQuery("task-1", createActiveQuery({ sessionId: undefined }));
    expect(queueInterruptMessage("task-1", "msg")).toBe(false);
  });

  it("overwrites previous pending resume with new message", () => {
    registerQuery("task-1", createActiveQuery({ sessionId: "s1" }));
    queueInterruptMessage("task-1", "first message");
    queueInterruptMessage("task-1", "second message");
    expect(consumePendingResume("task-1")).toBe("second message");
  });
});
