import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkflowContext } from "./types.js";
import type { AgentStageConfig, ScriptStageConfig, HumanGateRuntimeConfig, PipelineStageConfig } from "../lib/config-loader.js";

vi.mock("../lib/json-extractor.js", () => ({
  extractJSON: vi.fn((text: string) => JSON.parse(text)),
}));

vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("./helpers.js", () => ({
  statusEntry: () => [],
  emitStatus: vi.fn(() => vi.fn()),
  emitTaskListUpdate: vi.fn(() => vi.fn()),
  emitPersistSession: vi.fn(() => vi.fn()),
  getLatestSessionId: vi.fn(),
  handleStageError: vi.fn(() => ({ target: "error" })),
}));

vi.mock("../agent/context-builder.js", () => ({
  buildTier1Context: vi.fn(() => "tier1-context"),
}));

vi.mock("../lib/config-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/config-loader.js")>();
  return { ...actual };
});

vi.mock("./stage-registry.js", () => ({
  getStageBuilder: vi.fn(),
}));

const { buildAgentState, buildScriptState, buildHumanGateState, buildParallelGroupState } =
  await import("./state-builders.js");
const { extractJSON } = await import("../lib/json-extractor.js");
const { getStageBuilder } = await import("./stage-registry.js");

// ── Helpers ──

function makeCtx(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
  return {
    taskId: "task-1",
    status: "running",
    retryCount: 0,
    qaRetryCount: 0,
    store: {},
    stageSessionIds: {},
    ...overrides,
  };
}

function makeAgentStage(overrides: Partial<AgentStageConfig> = {}): AgentStageConfig {
  return {
    name: "analyze",
    type: "agent",
    runtime: { engine: "llm" as const, system_prompt: "do it", ...((overrides.runtime ?? {}) as any) },
    ...overrides,
  } as AgentStageConfig;
}

function makeScriptStage(overrides: Partial<ScriptStageConfig> = {}): ScriptStageConfig {
  return {
    name: "build",
    type: "script",
    runtime: { engine: "script" as const, script_id: "build-step", ...((overrides.runtime ?? {}) as any) },
    ...overrides,
  } as ScriptStageConfig;
}

function getOnDoneHandlers(state: Record<string, unknown>) {
  const invoke = state.invoke as {
    onDone: Array<{ guard?: Function; target: string; actions?: unknown[] }>;
  };
  return invoke.onDone;
}

function findAssignFn(handler: { actions?: unknown[] }): Function | undefined {
  if (!handler.actions) return undefined;
  for (const action of handler.actions) {
    if (action && (action as any).type === "xstate.assign") {
      return (action as any).assignment;
    }
  }
  return undefined;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(extractJSON).mockImplementation((text: string) => JSON.parse(text));
});

// ── buildAgentState: basic structure ──

describe("buildAgentState basic structure", () => {
  it("returns an object with invoke.src 'runAgent' for non-edge stages", () => {
    const state = buildAgentState("next", "prev", makeAgentStage());
    const invoke = state.invoke as { src: string };
    expect(invoke.src).toBe("runAgent");
  });

  it("uses 'runEdgeAgent' when execution_mode is 'edge'", () => {
    const stage = makeAgentStage({ execution_mode: "edge" } as any);
    const state = buildAgentState("next", "prev", stage);
    const invoke = state.invoke as { src: string };
    expect(invoke.src).toBe("runEdgeAgent");
  });

  it("uses 'runEdgeAgent' when execution_mode is 'any'", () => {
    const stage = makeAgentStage({ execution_mode: "any" } as any);
    const state = buildAgentState("next", "prev", stage);
    const invoke = state.invoke as { src: string };
    expect(invoke.src).toBe("runEdgeAgent");
  });

  it("onDone is an array (multiple guard transitions)", () => {
    const state = buildAgentState("next", "prev", makeAgentStage());
    const handlers = getOnDoneHandlers(state);
    expect(Array.isArray(handlers)).toBe(true);
    expect(handlers.length).toBeGreaterThanOrEqual(1);
  });

  it("last onDone handler has target=nextTarget (normal path)", () => {
    const state = buildAgentState("implementing", "prev", makeAgentStage());
    const handlers = getOnDoneHandlers(state);
    const last = handlers[handlers.length - 1];
    expect(last.target).toBe("implementing");
  });
});

// ── buildAgentState: invoke.input factory ──

describe("buildAgentState invoke.input", () => {
  it("input function passes taskId, stageName, and tier1Context", () => {
    const stage = makeAgentStage({ name: "myStage" });
    const state = buildAgentState("next", "prev", stage);
    const invoke = state.invoke as { input: Function };
    const ctx = makeCtx({ taskId: "abc-123" });

    const result = invoke.input({ context: ctx });

    expect(result.taskId).toBe("abc-123");
    expect(result.stageName).toBe("myStage");
    expect(result.tier1Context).toBeDefined();
  });

  it("input includes attempt count from context.retryCount", () => {
    const stage = makeAgentStage();
    const state = buildAgentState("next", "prev", stage);
    const invoke = state.invoke as { input: Function };
    const ctx = makeCtx({ retryCount: 3 });

    const result = invoke.input({ context: ctx });

    expect(result.attempt).toBe(3);
  });

  it("input resolves enabledSteps from store using enabled_steps_path", () => {
    const stage = makeAgentStage({
      runtime: { engine: "llm" as const, system_prompt: "do", enabled_steps_path: "config.steps" } as any,
    });
    const state = buildAgentState("next", "prev", stage);
    const invoke = state.invoke as { input: Function };
    const ctx = makeCtx({ store: { config: { steps: ["stepA", "stepB"] } } });

    const result = invoke.input({ context: ctx });

    expect(result.enabledSteps).toEqual(["stepA", "stepB"]);
  });
});

// ── buildAgentState: normal onDone path (no writes) ──

describe("buildAgentState normal path without writes", () => {
  it("advances to nextTarget when stage has no writes configured", () => {
    const stage = makeAgentStage({ runtime: { engine: "llm" as const, system_prompt: "x" } as any });
    const state = buildAgentState("done", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const last = handlers[handlers.length - 1];

    // No guard means no retry/block — last handler is normal advance
    expect(last.target).toBe("done");
    expect(last.guard).toBeUndefined();
  });

  it("assign in normal path accumulates totalCostUsd", () => {
    const stage = makeAgentStage();
    const state = buildAgentState("done", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const last = handlers[handlers.length - 1];
    const assignFn = findAssignFn(last as any);

    const ctx = makeCtx({ totalCostUsd: 0.5 });
    const event = { type: "done", output: { costUsd: 0.25, resultText: "" } };
    const result = (assignFn as Function)({ event, context: ctx });

    expect(result.totalCostUsd).toBeCloseTo(0.75);
  });

  it("assign stores sessionId in stageSessionIds", () => {
    const stage = makeAgentStage({ name: "myStage" });
    const state = buildAgentState("done", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const last = handlers[handlers.length - 1];
    const assignFn = findAssignFn(last as any);

    const ctx = makeCtx({ stageSessionIds: {} });
    const event = { type: "done", output: { sessionId: "sess-abc", resultText: "" } };
    const result = (assignFn as Function)({ event, context: ctx });

    expect(result.stageSessionIds.myStage).toBe("sess-abc");
  });

  it("assign stores cwd in stageCwds when output.cwd present", () => {
    const stage = makeAgentStage({ name: "buildStage" });
    const state = buildAgentState("done", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const last = handlers[handlers.length - 1];
    const assignFn = findAssignFn(last as any);

    const ctx = makeCtx();
    const event = { type: "done", output: { cwd: "/workspace/project", resultText: "" } };
    const result = (assignFn as Function)({ event, context: ctx });

    expect(result.stageCwds?.buildStage).toBe("/workspace/project");
  });
});

// ── buildAgentState: writes parsing ──

describe("buildAgentState writes field parsing", () => {
  it("assign parses JSON output and stores write fields in context.store", () => {
    const stage = makeAgentStage({
      runtime: { engine: "llm" as const, system_prompt: "x", writes: ["title", "body"] } as any,
    });
    const state = buildAgentState("done", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const last = handlers[handlers.length - 1];
    const assignFn = findAssignFn(last as any);

    const ctx = makeCtx({ store: { existing: "value" } });
    const event = {
      type: "done",
      output: { resultText: JSON.stringify({ title: "My Title", body: "Content" }), costUsd: 0 },
    };
    const result = (assignFn as Function)({ event, context: ctx });

    expect(result.store.title).toBe("My Title");
    expect(result.store.body).toBe("Content");
    expect(result.store.existing).toBe("value");
  });

  it("does not overwrite store when extractJSON fails on output", () => {
    vi.mocked(extractJSON).mockImplementation(() => { throw new SyntaxError("bad json"); });
    const stage = makeAgentStage({
      runtime: { engine: "llm" as const, system_prompt: "x", writes: ["result"] } as any,
    });
    const state = buildAgentState("done", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const last = handlers[handlers.length - 1];
    const assignFn = findAssignFn(last as any);

    const ctx = makeCtx({ store: { existing: "kept" } });
    const event = { type: "done", output: { resultText: "not valid", costUsd: 0 } };
    const result = (assignFn as Function)({ event, context: ctx });

    // Store should still be the original (no partial overwrites)
    expect(result.store.existing).toBe("kept");
  });

  it("resets retryCount to 0 on normal completion", () => {
    const stage = makeAgentStage();
    const state = buildAgentState("done", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const last = handlers[handlers.length - 1];
    const assignFn = findAssignFn(last as any);

    const ctx = makeCtx({ retryCount: 2 });
    const event = { type: "done", output: { resultText: "", costUsd: 0 } };
    const result = (assignFn as Function)({ event, context: ctx });

    expect(result.retryCount).toBe(0);
  });

  it("clears resumeInfo on normal completion", () => {
    const stage = makeAgentStage();
    const state = buildAgentState("done", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const last = handlers[handlers.length - 1];
    const assignFn = findAssignFn(last as any);

    const ctx = makeCtx({ resumeInfo: { sessionId: "old", feedback: "redo" } });
    const event = { type: "done", output: { resultText: "", costUsd: 0 } };
    const result = (assignFn as Function)({ event, context: ctx });

    expect(result.resumeInfo).toBeUndefined();
  });
});

// ── buildAgentState: retry guard (missing writes) ──

describe("buildAgentState retry guard", () => {
  it("retry guard returns false when no writes configured", () => {
    const stage = makeAgentStage({ runtime: { engine: "llm" as const, system_prompt: "x" } as any });
    const state = buildAgentState("done", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    // First handler is retry guard
    const retryHandler = handlers[0];
    if (!retryHandler.guard) return; // no guard means no retry path, test vacuously passes

    const ctx = makeCtx({ retryCount: 0 });
    const event = { output: { resultText: "" } };
    expect(retryHandler.guard!({ event, context: ctx })).toBe(false);
  });

  it("retry guard returns false when retryCount >= 2", () => {
    const stage = makeAgentStage({
      runtime: { engine: "llm" as const, system_prompt: "x", writes: ["result"] } as any,
    });
    const state = buildAgentState("done", "prev", stage);
    const [retryHandler] = getOnDoneHandlers(state);

    const ctx = makeCtx({ retryCount: 2 });
    const event = { output: { resultText: JSON.stringify({ result: "ok" }) } };
    expect(retryHandler.guard!({ event, context: ctx })).toBe(false);
  });

  it("retry guard returns true when output is missing required field and retryCount < 2", () => {
    const stage = makeAgentStage({
      runtime: { engine: "llm" as const, system_prompt: "x", writes: ["result"] } as any,
    });
    vi.mocked(extractJSON).mockImplementation((t: string) => JSON.parse(t));
    const state = buildAgentState("done", "prev", stage);
    const [retryHandler] = getOnDoneHandlers(state);

    const ctx = makeCtx({ retryCount: 0 });
    const event = { output: { resultText: JSON.stringify({ other: "val" }) } };
    expect(retryHandler.guard!({ event, context: ctx })).toBe(true);
  });

  it("retry handler target is the same stage name (reenter)", () => {
    const stage = makeAgentStage({
      name: "analyze",
      runtime: { engine: "llm" as const, system_prompt: "x", writes: ["result"] } as any,
    });
    const state = buildAgentState("done", "prev", stage);
    const [retryHandler] = getOnDoneHandlers(state);

    expect(retryHandler.target).toBe("analyze");
  });

  it("retry assign increments retryCount", () => {
    const stage = makeAgentStage({
      name: "analyze",
      runtime: { engine: "llm" as const, system_prompt: "x", writes: ["result"] } as any,
    });
    const state = buildAgentState("done", "prev", stage);
    const [retryHandler] = getOnDoneHandlers(state);
    const assignFn = findAssignFn(retryHandler as any);

    const ctx = makeCtx({ retryCount: 0, stageSessionIds: {} });
    const event = { output: { resultText: "", costUsd: 0 } };
    const result = (assignFn as Function)({ event, context: ctx });

    expect(result.retryCount).toBe(1);
  });
});

// ── buildScriptState: basic structure ──

describe("buildScriptState basic structure", () => {
  it("returns an object with invoke.src 'runScript'", () => {
    const state = buildScriptState("next", "prev", makeScriptStage());
    const invoke = state.invoke as { src: string };
    expect(invoke.src).toBe("runScript");
  });

  it("onDone.target equals nextTarget", () => {
    const state = buildScriptState("after-build", "prev", makeScriptStage());
    const invoke = state.invoke as { onDone: { target: string } };
    expect(invoke.onDone.target).toBe("after-build");
  });

  it("onDone has an assign action", () => {
    const state = buildScriptState("next", "prev", makeScriptStage());
    const invoke = state.invoke as { onDone: { actions: unknown[] } };
    const hasAssign = invoke.onDone.actions.some(
      (a) => a && (a as any).type === "xstate.assign",
    );
    expect(hasAssign).toBe(true);
  });
});

// ── buildScriptState: assign ──

describe("buildScriptState assign", () => {
  it("stores object output fields matching writes into store", () => {
    const stage = makeScriptStage({
      runtime: { engine: "script" as const, script_id: "x", writes: ["branch", "sha"] } as any,
    });
    const state = buildScriptState("next", "prev", stage);
    const invoke = state.invoke as { onDone: { actions: unknown[] } };
    const assignFn = findAssignFn({ actions: invoke.onDone.actions });

    const ctx = makeCtx({ store: {} });
    const event = { output: { branch: "feat/test", sha: "abc123", extra: "ignore" } };
    const result = (assignFn as Function)({ event, context: ctx });

    expect(result.store.branch).toBe("feat/test");
    expect(result.store.sha).toBe("abc123");
    expect(result.store.extra).toBeUndefined();
  });

  it("stores scalar output in the single write field", () => {
    const stage = makeScriptStage({
      runtime: { engine: "script" as const, script_id: "x", writes: ["result"] } as any,
    });
    const state = buildScriptState("next", "prev", stage);
    const invoke = state.invoke as { onDone: { actions: unknown[] } };
    const assignFn = findAssignFn({ actions: invoke.onDone.actions });

    const ctx = makeCtx({ store: {} });
    const event = { output: "scalar-value" };
    const result = (assignFn as Function)({ event, context: ctx });

    expect(result.store.result).toBe("scalar-value");
  });

  it("updates worktreePath from store.worktreePath.worktreePath", () => {
    const stage = makeScriptStage({
      runtime: { engine: "script" as const, script_id: "x", writes: ["worktreePath"] } as any,
    });
    const state = buildScriptState("next", "prev", stage);
    const invoke = state.invoke as { onDone: { actions: unknown[] } };
    const assignFn = findAssignFn({ actions: invoke.onDone.actions });

    const ctx = makeCtx({ store: {}, worktreePath: "/old" });
    const event = { output: { worktreePath: { worktreePath: "/new/path" } } };
    const result = (assignFn as Function)({ event, context: ctx });

    expect(result.worktreePath).toBe("/new/path");
  });

  it("resets retryCount to 0 after script completes", () => {
    const stage = makeScriptStage();
    const state = buildScriptState("next", "prev", stage);
    const invoke = state.invoke as { onDone: { actions: unknown[] } };
    const assignFn = findAssignFn({ actions: invoke.onDone.actions });

    const ctx = makeCtx({ retryCount: 2 });
    const event = { output: {} };
    const result = (assignFn as Function)({ event, context: ctx });

    expect(result.retryCount).toBe(0);
  });
});

// ── buildHumanGateState: basic structure ──

describe("buildHumanGateState basic structure", () => {
  function makeGateStage(overrides: Partial<HumanGateRuntimeConfig & { name: string; notify?: { type: "slack"; template: string } }> = {}) {
    return { name: "review", ...overrides } as HumanGateRuntimeConfig & { name: string; notify?: { type: "slack"; template: string } };
  }

  it("has CONFIRM and REJECT event handlers", () => {
    const state = buildHumanGateState("next", "prev", makeGateStage());
    const on = state.on as Record<string, unknown>;
    expect(on.CONFIRM).toBeDefined();
    expect(on.REJECT).toBeDefined();
  });

  it("CONFIRM transitions to nextTarget by default", () => {
    const state = buildHumanGateState("implementing", "prev", makeGateStage());
    const on = state.on as Record<string, { target: string }>;
    expect(on.CONFIRM.target).toBe("implementing");
  });

  it("CONFIRM transitions to on_approve_to when configured", () => {
    const state = buildHumanGateState("implementing", "prev", makeGateStage({ on_approve_to: "special" }));
    const on = state.on as Record<string, { target: string }>;
    expect(on.CONFIRM.target).toBe("special");
  });

  it("REJECT transitions to 'error' by default", () => {
    const state = buildHumanGateState("next", "prev", makeGateStage());
    const on = state.on as Record<string, { target: string }>;
    expect(on.REJECT.target).toBe("error");
  });

  it("REJECT transitions to on_reject_to when configured", () => {
    const state = buildHumanGateState("next", "prev", makeGateStage({ on_reject_to: "cancelled" }));
    const on = state.on as Record<string, { target: string }>;
    expect(on.REJECT.target).toBe("cancelled");
  });

  it("REJECT_WITH_FEEDBACK has two handlers (feedback loop and fallback)", () => {
    const state = buildHumanGateState("next", "prev", makeGateStage());
    const on = state.on as Record<string, unknown[]>;
    expect(Array.isArray(on.REJECT_WITH_FEEDBACK)).toBe(true);
    expect((on.REJECT_WITH_FEEDBACK as unknown[]).length).toBe(2);
  });
});

// ── buildHumanGateState: CONFIRM assign ──

describe("buildHumanGateState CONFIRM assign", () => {
  function makeGateStage(overrides: Partial<HumanGateRuntimeConfig & { name: string; notify?: { type: "slack"; template: string } }> = {}) {
    return { name: "review", ...overrides } as HumanGateRuntimeConfig & { name: string; notify?: { type: "slack"; template: string } };
  }

  it("CONFIRM resets retryCount to 0", () => {
    const state = buildHumanGateState("next", "prev", makeGateStage());
    const on = state.on as Record<string, { actions: unknown[] }>;
    const assignFn = findAssignFn(on.CONFIRM as any);

    const result = (assignFn as Function)({ event: { type: "CONFIRM" }, context: makeCtx({ retryCount: 3 }) });
    expect(result.retryCount).toBe(0);
  });

  it("CONFIRM stores repoName override when provided", () => {
    const state = buildHumanGateState("next", "prev", makeGateStage());
    const on = state.on as Record<string, { actions: unknown[] }>;
    const assignFn = findAssignFn(on.CONFIRM as any);

    const result = (assignFn as Function)({
      event: { type: "CONFIRM", repoName: "my-repo" },
      context: makeCtx(),
    });
    expect(result.explicitRepoName).toBe("my-repo");
  });
});

// ── buildHumanGateState: REJECT_WITH_FEEDBACK ──

describe("buildHumanGateState REJECT_WITH_FEEDBACK", () => {
  function makeGateStage(overrides: Partial<HumanGateRuntimeConfig & { name: string; notify?: { type: "slack"; template: string } }> = {}) {
    return { name: "review", ...overrides } as HumanGateRuntimeConfig & { name: string; notify?: { type: "slack"; template: string } };
  }

  it("first handler guard returns true when qaRetryCount < max_feedback_loops", () => {
    const state = buildHumanGateState("next", "prevAgent", makeGateStage({ max_feedback_loops: 3 }));
    const on = state.on as Record<string, Array<{ guard?: Function; target: string }>>;
    const [first] = on.REJECT_WITH_FEEDBACK;

    const ctx = makeCtx({ qaRetryCount: 1 });
    expect(first.guard!({ context: ctx })).toBe(true);
  });

  it("first handler guard returns false when qaRetryCount >= max_feedback_loops", () => {
    const state = buildHumanGateState("next", "prevAgent", makeGateStage({ max_feedback_loops: 3 }));
    const on = state.on as Record<string, Array<{ guard?: Function; target: string }>>;
    const [first] = on.REJECT_WITH_FEEDBACK;

    const ctx = makeCtx({ qaRetryCount: 3 });
    expect(first.guard!({ context: ctx })).toBe(false);
  });

  it("first handler target is prevAgentTarget", () => {
    const state = buildHumanGateState("next", "coding", makeGateStage());
    const on = state.on as Record<string, Array<{ target: string }>>;
    expect(on.REJECT_WITH_FEEDBACK[0].target).toBe("coding");
  });

  it("fallback handler target is on_reject_to or 'error'", () => {
    const state = buildHumanGateState("next", "prev", makeGateStage({ on_reject_to: "cancelled" }));
    const on = state.on as Record<string, Array<{ target: string }>>;
    expect(on.REJECT_WITH_FEEDBACK[1].target).toBe("cancelled");
  });

  it("first handler assign increments qaRetryCount", () => {
    const state = buildHumanGateState("next", "coding", makeGateStage());
    const on = state.on as Record<string, Array<{ actions?: unknown[] }>>;
    const assignFn = findAssignFn(on.REJECT_WITH_FEEDBACK[0] as any);

    const ctx = makeCtx({ qaRetryCount: 1, stageSessionIds: { coding: "sess-xyz" } });
    const event = { feedback: "Please fix the bugs" };
    const result = (assignFn as Function)({ event, context: ctx });

    expect(result.qaRetryCount).toBe(2);
  });

  it("first handler assign sets resumeInfo with sessionId from prevAgentTarget", () => {
    const state = buildHumanGateState("next", "coding", makeGateStage());
    const on = state.on as Record<string, Array<{ actions?: unknown[] }>>;
    const assignFn = findAssignFn(on.REJECT_WITH_FEEDBACK[0] as any);

    const ctx = makeCtx({ qaRetryCount: 0, stageSessionIds: { coding: "sess-abc" } });
    const event = { feedback: "Fix this" };
    const result = (assignFn as Function)({ event, context: ctx });

    expect(result.resumeInfo?.sessionId).toBe("sess-abc");
    expect(result.resumeInfo?.feedback).toContain("Fix this");
  });
});

// ── buildParallelGroupState: basic structure ──

describe("buildParallelGroupState basic structure", () => {
  function makeParallelGroup(stageNames: string[]) {
    return {
      name: "group1",
      stages: stageNames.map(name => ({
        name,
        type: "agent" as const,
        runtime: { engine: "llm" as const, system_prompt: "x" },
      })) as PipelineStageConfig[],
    };
  }

  beforeEach(() => {
    vi.mocked(getStageBuilder).mockImplementation(() => {
      // Returns a builder that produces a minimal state node
      return (_doneState: string, _prev: string, stage: any) => ({
        entry: [],
        invoke: { src: "runAgent", input: vi.fn(), onDone: [], onError: {} },
      });
    });
  });

  it("returns a state with type='parallel'", () => {
    const group = makeParallelGroup(["subA", "subB"]);
    const state = buildParallelGroupState(group, "next", "prev");
    expect((state as any).type).toBe("parallel");
  });

  it("creates a region for each stage", () => {
    const group = makeParallelGroup(["subA", "subB", "subC"]);
    const state = buildParallelGroupState(group, "next", "prev");
    const states = (state as any).states as Record<string, unknown>;
    expect(Object.keys(states)).toEqual(["subA", "subB", "subC"]);
  });

  it("each region has initial state matching stage name", () => {
    const group = makeParallelGroup(["subA", "subB"]);
    const state = buildParallelGroupState(group, "next", "prev");
    const states = (state as any).states as Record<string, any>;
    expect(states.subA.initial).toBe("subA");
    expect(states.subB.initial).toBe("subB");
  });

  it("onDone target is nextTarget", () => {
    const group = makeParallelGroup(["subA", "subB"]);
    const state = buildParallelGroupState(group, "after-group", "prev");
    const onDone = (state as any).onDone as { target: string };
    expect(onDone.target).toBe("after-group");
  });

  it("skips stage if getStageBuilder returns null", () => {
    vi.mocked(getStageBuilder).mockReturnValueOnce(null).mockReturnValue(() => ({}));
    const group = makeParallelGroup(["skipped", "included"]);
    const state = buildParallelGroupState(group, "next", "prev");
    const states = (state as any).states as Record<string, unknown>;
    expect(states.skipped).toBeUndefined();
    expect(states.included).toBeDefined();
  });

  it("onDone assign resets retryCount and clears parallelDone for the group", () => {
    const group = makeParallelGroup(["subA", "subB"]);
    const state = buildParallelGroupState(group, "next", "prev");
    const onDone = (state as any).onDone as { actions: unknown[] };
    const assignFn = findAssignFn({ actions: onDone.actions });

    const ctx = makeCtx({
      retryCount: 2,
      resumeInfo: { sessionId: "x", feedback: "y" },
      parallelDone: { group1: ["subA", "subB"], otherGroup: ["x"] },
    });
    const result = (assignFn as Function)({ context: ctx });

    expect(result.retryCount).toBe(0);
    expect(result.resumeInfo).toBeUndefined();
    // group1 cleared; otherGroup preserved
    expect(result.parallelDone?.group1).toBeUndefined();
    expect(result.parallelDone?.otherGroup).toEqual(["x"]);
  });
});

describe("buildAgentState compact summary generation", () => {
  it("generates __summary for large store values on normal completion", () => {
    const stage = makeAgentStage({
      runtime: { engine: "llm" as const, system_prompt: "x", writes: ["bigResult"] } as any,
    });
    const state = buildAgentState("done", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const last = handlers[handlers.length - 1];
    const assignFn = findAssignFn(last as any);

    const largeValue: Record<string, string> = {};
    for (let i = 0; i < 10; i++) largeValue[`field_${i}`] = "x".repeat(1000);
    const ctx = makeCtx({ store: {} });
    const event = {
      type: "done",
      output: { resultText: JSON.stringify({ bigResult: largeValue }), costUsd: 0 },
    };
    const result = (assignFn as Function)({ event, context: ctx });

    expect(result.store.bigResult).toEqual(largeValue);
    expect(result.store["bigResult.__summary"]).toBeDefined();
    expect(result.store["bigResult.__summary"]).toContain("[object]");
    expect(result.store["bigResult.__summary"]).toContain("field_0");
  });

  it("does not generate __summary for small store values", () => {
    const stage = makeAgentStage({
      runtime: { engine: "llm" as const, system_prompt: "x", writes: ["smallResult"] } as any,
    });
    const state = buildAgentState("done", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const last = handlers[handlers.length - 1];
    const assignFn = findAssignFn(last as any);

    const smallValue = { plan: "short plan" };
    const ctx = makeCtx({ store: {} });
    const event = {
      type: "done",
      output: { resultText: JSON.stringify({ smallResult: smallValue }), costUsd: 0 },
    };
    const result = (assignFn as Function)({ event, context: ctx });

    expect(result.store.smallResult).toEqual(smallValue);
    expect(result.store["smallResult.__summary"]).toBeUndefined();
  });
});
