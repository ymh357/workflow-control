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

const TASK_IDS = ["adv-1", "adv-2", "adv-3", "adv-4", "adv-5"];
beforeEach(() => {
  for (const id of TASK_IDS) cancelTask(id);
});

describe("adversarial: registerQuery overwrites previous registration", () => {
  it("replacing a query does NOT close the old one", () => {
    const aq1 = createActiveQuery();
    const aq2 = createActiveQuery();
    registerQuery("adv-1", aq1);
    registerQuery("adv-1", aq2);

    expect(getActiveQuery("adv-1")).toBe(aq2);
    // Note: registerQuery does NOT call close on the old query — potential leak
    expect(aq1.query.close).not.toHaveBeenCalled();
  });
});

describe("adversarial: queueInterruptMessage with empty string sessionId", () => {
  it("returns false when sessionId is empty string (falsy)", () => {
    registerQuery("adv-1", createActiveQuery({ sessionId: "" }));
    // empty string is falsy, so !active?.sessionId -> true
    expect(queueInterruptMessage("adv-1", "msg")).toBe(false);
  });
});

describe("adversarial: interruptActiveQuery cleanup guarantees", () => {
  it("always removes query from map even if interrupt throws synchronously", async () => {
    const mockQuery = createMockQuery({
      interrupt: vi.fn(() => { throw new Error("sync throw"); }),
    });
    registerQuery("adv-1", createActiveQuery({ query: mockQuery, sessionId: "s" }));

    const sid = await interruptActiveQuery("adv-1");
    expect(sid).toBe("s");
    expect(getActiveQuery("adv-1")).toBeUndefined();
  });

  it("returns sessionId even when sessionId is undefined", async () => {
    registerQuery("adv-1", createActiveQuery({ sessionId: undefined }));
    const sid = await interruptActiveQuery("adv-1");
    expect(sid).toBeUndefined();
    expect(getActiveQuery("adv-1")).toBeUndefined();
  });
});

describe("adversarial: pendingResumes isolation between tasks", () => {
  it("different tasks have independent pending resumes", () => {
    registerQuery("adv-1", createActiveQuery({ sessionId: "s1" }));
    registerQuery("adv-2", createActiveQuery({ sessionId: "s2" }));

    queueInterruptMessage("adv-1", "msg-for-1");
    queueInterruptMessage("adv-2", "msg-for-2");

    expect(consumePendingResume("adv-1")).toBe("msg-for-1");
    expect(consumePendingResume("adv-2")).toBe("msg-for-2");
    // Each consumed independently
    expect(hasPendingResume("adv-1")).toBe(false);
    expect(hasPendingResume("adv-2")).toBe(false);
  });
});

describe("adversarial: AgentError inherits Error prototype chain", () => {
  it("is caught by generic Error catch", () => {
    const err = new AgentError("budget_exceeded", "Over budget");
    expect(err instanceof Error).toBe(true);
    expect(err instanceof AgentError).toBe(true);
  });

  it("has a proper stack trace", () => {
    const err = new AgentError("timeout", "Timed out");
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain("AgentError");
  });

  it("preserves agentStatus through serialization", () => {
    const err = new AgentError("max_turns", "Too many turns");
    // JSON.stringify loses the class info but agentStatus is enumerable
    const serialized = JSON.parse(JSON.stringify({ status: err.agentStatus, message: err.message }));
    expect(serialized.status).toBe("max_turns");
    expect(serialized.message).toBe("Too many turns");
  });
});

describe("adversarial: cancelTask does not affect other tasks", () => {
  it("cancelling one task leaves others intact", () => {
    registerQuery("adv-1", createActiveQuery({ sessionId: "s1" }));
    registerQuery("adv-2", createActiveQuery({ sessionId: "s2" }));
    queueInterruptMessage("adv-1", "m1");
    queueInterruptMessage("adv-2", "m2");

    cancelTask("adv-1");

    expect(getActiveQuery("adv-1")).toBeUndefined();
    expect(hasPendingResume("adv-1")).toBe(false);
    // adv-2 should be untouched
    expect(getActiveQuery("adv-2")).toBeDefined();
    expect(hasPendingResume("adv-2")).toBe(true);
  });
});

describe("adversarial: getActiveQueryInfo returns snapshot, not live reference", () => {
  it("returned info does not reflect later mutations to the ActiveQuery", () => {
    const aq = createActiveQuery({ sessionId: "s1", stageName: "coding" });
    registerQuery("adv-1", aq);

    const info = getActiveQueryInfo("adv-1");
    aq.sessionId = "s2";

    // getActiveQueryInfo returns a new object with values at call time
    expect(info?.sessionId).toBe("s1");
    // But actually looking at the code: it returns { sessionId: active.sessionId, stageName: active.stageName }
    // This is a value copy, so mutation after the call shouldn't affect it
    expect(info?.sessionId).toBe("s1");
  });
});
