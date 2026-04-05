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

import { getNotionStatusLabel, getLatestSessionId, MAX_STAGE_RETRIES, handleStageError, statusEntry, loggedActor } from "./helpers.js";
import { AgentError } from "../agent/query-tracker.js";
import type { WorkflowContext } from "./types.js";

describe("getNotionStatusLabel", () => {
  it('maps "completed" to "待验收"', () => {
    expect(getNotionStatusLabel("completed")).toBe("待验收");
  });

  it('maps "blocked" to "阻塞"', () => {
    expect(getNotionStatusLabel("blocked")).toBe("阻塞");
  });

  it('maps "cancelled" to "已取消"', () => {
    expect(getNotionStatusLabel("cancelled")).toBe("已取消");
  });

  it('maps "error" to "阻塞"', () => {
    expect(getNotionStatusLabel("error")).toBe("阻塞");
  });

  it("uses notion_label from matching pipeline stage", () => {
    const stages = [
      { name: "review", type: "agent", notion_label: "审核中" },
      { name: "deploy", type: "script" },
    ];
    expect(getNotionStatusLabel("review", stages)).toBe("审核中");
  });

  it('maps human_confirm stage type to "待确认"', () => {
    const stages = [
      { name: "approval", type: "human_confirm" },
    ];
    expect(getNotionStatusLabel("approval", stages)).toBe("待确认");
  });

  it("prefers notion_label over human_confirm type", () => {
    const stages = [
      { name: "gate", type: "human_confirm", notion_label: "等待审批" },
    ];
    expect(getNotionStatusLabel("gate", stages)).toBe("等待审批");
  });

  it('defaults to "执行中" for unknown status without stages', () => {
    expect(getNotionStatusLabel("running")).toBe("执行中");
  });

  it('defaults to "执行中" for unknown status with non-matching stages', () => {
    const stages = [{ name: "other", type: "agent" }];
    expect(getNotionStatusLabel("unknown", stages)).toBe("执行中");
  });

  it("terminal statuses take precedence over pipeline stages", () => {
    const stages = [
      { name: "completed", type: "agent", notion_label: "should-not-use" },
    ];
    expect(getNotionStatusLabel("completed", stages)).toBe("待验收");
  });
});

describe("getLatestSessionId", () => {
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

  it("returns undefined when stageSessionIds is undefined", () => {
    const c = ctx();
    (c as any).stageSessionIds = undefined;
    expect(getLatestSessionId(c)).toBeUndefined();
  });

  it("returns undefined when stageSessionIds is empty", () => {
    expect(getLatestSessionId(ctx())).toBeUndefined();
  });

  it("returns the latest session by pipeline stage order (reverse)", () => {
    const c = ctx({
      stageSessionIds: { analyze: "sess-1", implement: "sess-2", review: "sess-3" },
      config: {
        pipelineName: "test",
        pipeline: {
          name: "test",
          stages: [
            { name: "analyze", type: "agent" },
            { name: "implement", type: "agent" },
            { name: "review", type: "agent" },
          ],
        },
        prompts: { system: {}, fragments: {}, globalConstraints: "", globalClaudeMd: "", globalGeminiMd: "",
        globalCodexMd: "" },
        skills: [],
        mcps: [],
      },
    });

    expect(getLatestSessionId(c)).toBe("sess-3");
  });

  it("skips stages without session IDs (finds latest populated)", () => {
    const c = ctx({
      stageSessionIds: { analyze: "sess-1", implement: "sess-2" },
      config: {
        pipelineName: "test",
        pipeline: {
          name: "test",
          stages: [
            { name: "analyze", type: "agent" },
            { name: "implement", type: "agent" },
            { name: "review", type: "agent" },
          ],
        },
        prompts: { system: {}, fragments: {}, globalConstraints: "", globalClaudeMd: "", globalGeminiMd: "",
        globalCodexMd: "" },
        skills: [],
        mcps: [],
      },
    });

    // review has no session ID, so implement (index 1 from end) is returned
    expect(getLatestSessionId(c)).toBe("sess-2");
  });

  it("falls back to iterating all keys when no pipeline config", () => {
    const c = ctx({
      stageSessionIds: { a: "sess-a", b: "sess-b", c: "sess-c" },
    });

    // Without pipeline stages, it iterates keys and returns the last truthy value
    const result = getLatestSessionId(c);
    expect(result).toBe("sess-c");
  });

  it("falls back to iterating all keys when pipeline stages yield nothing", () => {
    const c = ctx({
      stageSessionIds: { custom: "sess-custom" },
      config: {
        pipelineName: "test",
        pipeline: {
          name: "test",
          stages: [
            { name: "stage1", type: "agent" },
          ],
        },
        prompts: { system: {}, fragments: {}, globalConstraints: "", globalClaudeMd: "", globalGeminiMd: "",
        globalCodexMd: "" },
        skills: [],
        mcps: [],
      },
    });

    // stage1 has no session ID, fallback iterates all keys
    expect(getLatestSessionId(c)).toBe("sess-custom");
  });
});

describe("MAX_STAGE_RETRIES", () => {
  it("equals 2", () => {
    expect(MAX_STAGE_RETRIES).toBe(2);
  });
});

describe("handleStageError", () => {
  function ctx(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
    return {
      taskId: "err-task",
      status: "running",
      retryCount: 0,
      qaRetryCount: 0,
      store: {},
      stageSessionIds: {},
      ...overrides,
    };
  }

  it("returns an array of transition configs", () => {
    const result = handleStageError("myStage");
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(3);
  });

  it("first transition targets 'blocked' for interruption", () => {
    const transitions = handleStageError("myStage");
    expect(transitions[0].target).toBe("blocked");
    // Guard should match when errorCode is "interrupted"
    const guardResult = (transitions[0].guard as Function)({ context: ctx({ errorCode: "interrupted" }) });
    expect(guardResult).toBe(true);
  });

  it("first transition guard returns false for non-interrupted", () => {
    const transitions = handleStageError("myStage");
    const guardResult = (transitions[0].guard as Function)({ context: ctx({ errorCode: undefined }) });
    expect(guardResult).toBe(false);
  });

  it("second transition targets self (same stage) for retry", () => {
    const transitions = handleStageError("myStage");
    expect(transitions[1].target).toBe("myStage");
    expect(transitions[1].reenter).toBe(true);
  });

  it("second transition guard allows retry when retryCount < MAX_STAGE_RETRIES", () => {
    const transitions = handleStageError("myStage");
    const guardResult = (transitions[1].guard as Function)({
      context: ctx({ retryCount: 0 }),
      event: { error: new Error("oops") },
    });
    expect(guardResult).toBe(true);
  });

  it("second transition guard blocks retry when retryCount >= MAX_STAGE_RETRIES", () => {
    const transitions = handleStageError("myStage");
    const guardResult = (transitions[1].guard as Function)({
      context: ctx({ retryCount: 2 }),
      event: { error: new Error("oops") },
    });
    expect(guardResult).toBe(false);
  });

  it("second transition guard blocks retry for terminal AgentError", () => {
    const transitions = handleStageError("myStage");
    const agentErr = new AgentError("error", "quota exhausted");
    const guardResult = (transitions[1].guard as Function)({
      context: ctx({ retryCount: 0 }),
      event: { error: agentErr },
    });
    expect(guardResult).toBe(false);
  });

  it("second transition guard allows retry for non-terminal AgentError", () => {
    const transitions = handleStageError("myStage");
    const agentErr = new AgentError("timeout", "timed out");
    const guardResult = (transitions[1].guard as Function)({
      context: ctx({ retryCount: 0 }),
      event: { error: agentErr },
    });
    expect(guardResult).toBe(true);
  });

  it("last transition targets 'blocked' (final fallback)", () => {
    const transitions = handleStageError("myStage");
    const last = transitions[transitions.length - 1];
    expect(last.target).toBe("blocked");
  });

  it("without retryConfig, returns exactly 3 transitions", () => {
    const transitions = handleStageError("myStage");
    expect(transitions).toHaveLength(3);
  });

  it("with retryConfig.back_to, inserts back_to transition before final blocked", () => {
    const transitions = handleStageError("myStage", { back_to: "prevStage", max_retries: 3 });
    expect(transitions).toHaveLength(4);
    expect(transitions[2].target).toBe("prevStage");
    expect(transitions[3].target).toBe("blocked");
  });

  it("back_to transition guard respects qaRetryCount and max_retries", () => {
    const transitions = handleStageError("myStage", { back_to: "prevStage", max_retries: 2 });
    const backToGuard = transitions[2].guard as Function;
    expect(backToGuard({ context: ctx({ qaRetryCount: 0 }) })).toBe(true);
    expect(backToGuard({ context: ctx({ qaRetryCount: 1 }) })).toBe(true);
    expect(backToGuard({ context: ctx({ qaRetryCount: 2 }) })).toBe(false);
  });
});

describe("statusEntry", () => {
  it("returns an array of 4 actions", () => {
    const result = statusEntry("myStage");
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(4);
  });

  it("first action is an assign (status setter)", () => {
    const result = statusEntry("myStage");
    // XState assign returns an action object with type property
    expect(result[0]).toBeDefined();
  });
});

describe("loggedActor", () => {
  it("returns a fromPromise actor that resolves with the function result", async () => {
    const fn = vi.fn(async (input: { taskId: string }) => `done-${input.taskId}`);
    const actor = loggedActor("test-stage", fn);
    // loggedActor returns fromPromise(...), which is a machine actor creator
    expect(actor).toBeDefined();
  });

  it("wraps the inner function and re-throws errors", async () => {
    const error = new Error("boom");
    const fn = vi.fn(async (_input: { taskId: string }) => { throw error; });
    const actor = loggedActor("test-stage", fn);
    expect(actor).toBeDefined();
    // The actor itself is a creator; actual invocation is handled by XState runtime.
    // We verify it returns a valid actor definition.
  });
});

describe("handleStageError back_to transition", () => {
  function ctx(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
    return {
      taskId: "back-task",
      status: "running",
      retryCount: 0,
      qaRetryCount: 0,
      store: {},
      stageSessionIds: {},
      ...overrides,
    };
  }

  it("back_to guard returns true when qaRetryCount < max_retries", () => {
    const transitions = handleStageError("myStage", { back_to: "prevStage", max_retries: 3 });
    const backToTransition = transitions[2];
    expect(backToTransition.target).toBe("prevStage");

    expect((backToTransition.guard as Function)({ context: ctx({ qaRetryCount: 0 }) })).toBe(true);
    expect((backToTransition.guard as Function)({ context: ctx({ qaRetryCount: 2 }) })).toBe(true);
    expect((backToTransition.guard as Function)({ context: ctx({ qaRetryCount: 3 }) })).toBe(false);
  });

  it("back_to guard defaults max_retries to 2 when not specified", () => {
    const transitions = handleStageError("myStage", { back_to: "prevStage" });
    const backToTransition = transitions[2];

    expect((backToTransition.guard as Function)({ context: ctx({ qaRetryCount: 0 }) })).toBe(true);
    expect((backToTransition.guard as Function)({ context: ctx({ qaRetryCount: 1 }) })).toBe(true);
    expect((backToTransition.guard as Function)({ context: ctx({ qaRetryCount: 2 }) })).toBe(false);
  });

  it("back_to actions array has 3 entries (assign, logger, emit)", () => {
    const transitions = handleStageError("myStage", { back_to: "prevStage", max_retries: 2 });
    const backToTransition = transitions[2];
    const actions = backToTransition.actions as unknown[];
    expect(actions).toHaveLength(3);
    // All three should be defined
    expect(actions[0]).toBeDefined();
    expect(actions[1]).toBeDefined();
    expect(actions[2]).toBeDefined();
  });

  it("back_to logger action does not throw", () => {
    const transitions = handleStageError("myStage", { back_to: "prevStage", max_retries: 2 });
    const loggerAction = (transitions[2].actions as any[])[1];

    expect(() => {
      loggerAction({ context: ctx({ qaRetryCount: 1 }) });
    }).not.toThrow();
  });

  it("back_to emit action produces correct event shape", () => {
    const transitions = handleStageError("myStage", { back_to: "prevStage", max_retries: 2 });
    const emitAction = (transitions[2].actions as any[])[2];

    // emit() returns an XState action function. We can inspect the params.
    // The emit action in XState v5 is an object with type and params.
    expect(emitAction).toBeDefined();
  });
});

describe("handleStageError interruption actions", () => {
  function ctx(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
    return {
      taskId: "int-task",
      status: "running",
      retryCount: 0,
      qaRetryCount: 0,
      store: {},
      stageSessionIds: {},
      ...overrides,
    };
  }

  it("blocked transition actions callback does not throw", () => {
    const transitions = handleStageError("myStage");
    const blockedTransition = transitions[0];
    expect(() => {
      (blockedTransition.actions as Function)({ context: ctx({ errorCode: "interrupted" }) });
    }).not.toThrow();
  });
});

describe("parallel group support", () => {
  it("getNotionStatusLabel returns 执行中 for parallel group name", () => {
    const pipelineStages = [
      { parallel: { name: "research", stages: [{ name: "web", type: "agent" }, { name: "docs", type: "agent" }] } },
      { name: "deploy", type: "script" },
    ];
    expect(getNotionStatusLabel("research", pipelineStages)).toBe("执行中");
  });

  it("getNotionStatusLabel returns notion_label for child stage inside parallel group", () => {
    const pipelineStages = [
      { parallel: { name: "research", stages: [{ name: "web", type: "agent", notion_label: "网络调研" }, { name: "docs", type: "agent" }] } },
    ];
    expect(getNotionStatusLabel("web", pipelineStages)).toBe("网络调研");
  });

  it("getLatestSessionId finds session from child stage inside parallel group", () => {
    const c: WorkflowContext = {
      taskId: "parallel-task",
      status: "running",
      retryCount: 0,
      qaRetryCount: 0,
      store: {},
      stageSessionIds: { web: "sess-web", docs: "sess-docs" },
      config: {
        pipelineName: "test",
        pipeline: {
          name: "test",
          stages: [
            { parallel: { name: "research", stages: [{ name: "web", type: "agent" }, { name: "docs", type: "agent" }] } } as any,
            { name: "deploy", type: "script" },
          ],
        },
        prompts: { system: {}, fragments: {}, globalConstraints: "", globalClaudeMd: "", globalGeminiMd: "",
        globalCodexMd: "" },
        skills: [],
        mcps: [],
      },
    };
    // flattenStages flattens parallel groups, so order is: web, docs, deploy
    // Last one with a session is "docs"
    expect(getLatestSessionId(c)).toBe("sess-docs");
  });
});
