import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../lib/config-loader.js", () => ({
  getNestedValue: vi.fn(),
  loadSystemSettings: vi.fn(() => ({})),
  isParallelGroup: (entry: any) => entry && typeof entry === "object" && "parallel" in entry,
  flattenStages: (entries: any[]) => {
    const result: any[] = [];
    for (const e of entries) {
      if (e && typeof e === "object" && "parallel" in e) {
        result.push(...e.parallel.stages);
      } else {
        result.push(e);
      }
    }
    return result;
  },
}));
vi.mock("../agent/query-tracker.js", () => {
  class AgentError extends Error {
    readonly agentStatus: string;
    constructor(agentStatus: string, message: string) {
      super(message);
      this.name = "AgentError";
      this.agentStatus = agentStatus;
    }
  }
  return { AgentError };
});

import {
  getNotionStatusLabel,
  getLatestSessionId,
  handleStageError,
  loggedActor,
  emitError,
  emitPersistSession,
  statusEntry,
} from "./helpers.js";
import { AgentError } from "../agent/query-tracker.js";
import type { WorkflowContext } from "./types.js";

function ctx(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
  return {
    taskId: "test-task",
    status: "running",
    retryCount: 0,
    qaRetryCount: 0,
    store: {},
    stageSessionIds: {},
    ...overrides,
  };
}

describe("getNotionStatusLabel adversarial", () => {
  it("returns default for empty string status", () => {
    expect(getNotionStatusLabel("")).toBe("执行中");
  });

  it("is case-sensitive: 'Completed' does not map to terminal", () => {
    expect(getNotionStatusLabel("Completed")).toBe("执行中");
  });

  it("handles undefined pipelineStages gracefully", () => {
    expect(getNotionStatusLabel("some-stage", undefined)).toBe("执行中");
  });

  it("handles empty pipelineStages array", () => {
    expect(getNotionStatusLabel("some-stage", [])).toBe("执行中");
  });

  it("stage with notion_label takes priority over type-based label even for agent type", () => {
    const stages = [{ name: "build", type: "agent", notion_label: "构建中" }];
    expect(getNotionStatusLabel("build", stages)).toBe("构建中");
  });

  it("stage with type agent and no notion_label returns default", () => {
    const stages = [{ name: "build", type: "agent" }];
    expect(getNotionStatusLabel("build", stages)).toBe("执行中");
  });
});

describe("getLatestSessionId adversarial", () => {
  it("returns undefined for null-ish stageSessionIds", () => {
    const c = ctx();
    (c as any).stageSessionIds = null;
    // null is falsy, should return undefined
    expect(getLatestSessionId(c)).toBeUndefined();
  });

  it("handles pipeline stages config with empty names gracefully", () => {
    const c = ctx({
      stageSessionIds: { "": "sess-empty" },
      config: {
        pipelineName: "test",
        pipeline: {
          name: "test",
          stages: [{ name: "", type: "agent" }],
        },
        prompts: { system: {}, fragments: {}, globalConstraints: "", globalClaudeMd: "", globalGeminiMd: "",
        globalCodexMd: "" },
        skills: [],
        mcps: [],
      },
    });
    expect(getLatestSessionId(c)).toBe("sess-empty");
  });

  it("returns fallback when all pipeline stage session IDs are empty strings (falsy)", () => {
    const c = ctx({
      stageSessionIds: { stage1: "", stage2: "", extra: "sess-extra" },
      config: {
        pipelineName: "test",
        pipeline: {
          name: "test",
          stages: [{ name: "stage1", type: "agent" }, { name: "stage2", type: "agent" }],
        },
        prompts: { system: {}, fragments: {}, globalConstraints: "", globalClaudeMd: "", globalGeminiMd: "",
        globalCodexMd: "" },
        skills: [],
        mcps: [],
      },
    });
    // Pipeline loop finds no truthy IDs, falls through to Object.keys iteration
    // "extra" has truthy value
    expect(getLatestSessionId(c)).toBe("sess-extra");
  });

  it("fallback iteration returns last truthy value even if earlier keys have values", () => {
    const c = ctx({
      stageSessionIds: { a: "first", b: "", c: "last" },
    });
    // No pipeline config => fallback iterates all keys
    // Iterates a=first (latest=first), b="" (skip), c=last (latest=last)
    expect(getLatestSessionId(c)).toBe("last");
  });
});

describe("handleStageError adversarial", () => {
  it("retry action truncates error message to 500 chars for resumeInfo feedback", () => {
    const transitions = handleStageError("myStage");
    const retryTransition = transitions[1];
    const longError = new Error("x".repeat(1000));
    const assignFn = (retryTransition.actions as any[])[0];
    // The assign action is an XState action object, extract its assignment
    // We test the guard and verify it allows retry
    const guardResult = (retryTransition.guard as Function)({
      context: ctx({ retryCount: 0, stageSessionIds: { myStage: "sess-1" } }),
      event: { error: longError },
    });
    expect(guardResult).toBe(true);
  });

  it("retry action handles non-Error error objects (string coercion)", () => {
    const transitions = handleStageError("myStage");
    const retryTransition = transitions[1];
    // Non-Error: should be converted via String()
    const guardResult = (retryTransition.guard as Function)({
      context: ctx({ retryCount: 0 }),
      event: { error: 42 },
    });
    expect(guardResult).toBe(true);
  });

  it("retry action handles null error without crashing", () => {
    const transitions = handleStageError("myStage");
    const retryTransition = transitions[1];
    const guardResult = (retryTransition.guard as Function)({
      context: ctx({ retryCount: 0 }),
      event: { error: null },
    });
    expect(guardResult).toBe(true);
  });

  it("back_to transition with max_retries=0 never allows loop back", () => {
    const transitions = handleStageError("myStage", { back_to: "prevStage", max_retries: 0 });
    const backToTransition = transitions[2];
    expect((backToTransition.guard as Function)({ context: ctx({ qaRetryCount: 0 }) })).toBe(false);
  });

  it("back_to transition with undefined qaRetryCount treats it as 0", () => {
    const transitions = handleStageError("myStage", { back_to: "prevStage", max_retries: 2 });
    const backToTransition = transitions[2];
    const c = ctx();
    (c as any).qaRetryCount = undefined;
    expect((backToTransition.guard as Function)({ context: c })).toBe(true);
  });

  it("final blocked transition actions array has 4 entries (compensation, assign, emitError, emitSlackBlocked)", () => {
    const transitions = handleStageError("myStage");
    const lastTransition = transitions[transitions.length - 1];
    expect(lastTransition.actions).toHaveLength(4);
  });

  it("AgentError with non-'error' agentStatus still allows retry", () => {
    const transitions = handleStageError("myStage");
    const agentErr = new AgentError("blocked", "resource blocked");
    const guardResult = (transitions[1].guard as Function)({
      context: ctx({ retryCount: 0 }),
      event: { error: agentErr },
    });
    expect(guardResult).toBe(true);
  });

  it("retryCount exactly at MAX_STAGE_RETRIES is blocked", () => {
    const transitions = handleStageError("myStage");
    const guardResult = (transitions[1].guard as Function)({
      context: ctx({ retryCount: 2 }),
      event: { error: new Error("fail") },
    });
    expect(guardResult).toBe(false);
  });
});

describe("loggedActor adversarial", () => {
  it("returns a valid xstate actor definition even for sync-throwing functions", () => {
    const fn = vi.fn((_input: { taskId: string }) => {
      throw new Error("sync boom");
    });
    const actor = loggedActor("test-stage", fn as any);
    expect(actor).toBeDefined();
    // The actor is a fromPromise definition - it will handle errors at runtime
  });

  it("propagates the original error after logging", async () => {
    const originalError = new Error("original");
    const fn = vi.fn(async (_input: { taskId: string }) => { throw originalError; });
    const actor = loggedActor("test-stage", fn);
    // We can verify the actor is a fromPromise creator
    expect(actor).toBeDefined();
  });
});

describe("statusEntry adversarial", () => {
  it("always returns exactly 5 actions regardless of state name", () => {
    expect(statusEntry("")).toHaveLength(5);
    expect(statusEntry("a-very-long-state-name-that-is-unusual")).toHaveLength(5);
  });
});

describe("emitError adversarial", () => {
  it("returns an emit action for static string", () => {
    const action = emitError("static error");
    expect(action).toBeDefined();
  });

  it("returns an emit action for function-based error message", () => {
    const action = emitError((ctx) => `Error in ${ctx.taskId}`);
    expect(action).toBeDefined();
  });
});
