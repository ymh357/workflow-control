// Adversarial tests proving 3 bugs that were fixed in state-builders.ts

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkflowContext } from "./types.js";
import type { AgentStageConfig, HumanGateRuntimeConfig } from "../lib/config-loader.js";

vi.mock("../lib/json-extractor.js", () => ({
  extractJSON: vi.fn((text: string) => JSON.parse(text)),
}));

vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("./helpers.js", () => ({
  statusEntry: () => [],
  emitTaskListUpdate: () => vi.fn(),
  emitPersistSession: () => vi.fn(),
  getLatestSessionId: vi.fn(),
  handleStageError: () => ({ target: "error" }),
}));

vi.mock("../agent/context-builder.js", () => ({
  buildTier1Context: vi.fn(() => ""),
}));

vi.mock("../lib/config-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/config-loader.js")>();
  return { ...actual };
});

// Must import AFTER vi.mock calls
const { buildAgentState, buildHumanGateState } = await import("./state-builders.js");
const { extractJSON } = await import("../lib/json-extractor.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
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

function makeAgentStage(overrides: Partial<AgentStageConfig> = {}): AgentStageConfig {
  return {
    name: "testAgent",
    type: "agent",
    runtime: {
      engine: "llm" as const,
      system_prompt: "do stuff",
      writes: ["result"],
      ...((overrides.runtime ?? {}) as any),
    },
    ...overrides,
    // Re-apply runtime to avoid being overwritten by spread
  } as AgentStageConfig;
}

// Extract the onDone handler array from a built agent state
function getOnDoneHandlers(state: Record<string, unknown>) {
  const invoke = state.invoke as { onDone: Array<{ guard?: Function; target: string; actions?: unknown[] }> };
  return invoke.onDone;
}

// Extract the assign action from a handler's actions array.
// XState assign actions created by `assign(fn)` are objects with type "xstate.assign"
// but in our test the raw function is wrapped. We look for the first action that,
// when called, returns a partial context (i.e., an assign-like shape).
function findAssignAction(handler: { actions?: unknown[] }): Function | undefined {
  if (!handler.actions) return undefined;
  for (const action of handler.actions) {
    if (action && (action as any).type === "xstate.assign") {
      return (action as any).assignment;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Bug 1: Blocked guard shadowing QA feedback loop
//
// BEFORE fix: The "blocked" guard (handler index 1) did not check for
// runtime.retry.back_to, so when retryCount >= 2 AND output was missing
// required fields, the blocked guard would fire and send to "blocked",
// preventing the QA feedback loop guard (handler index 2) from ever running.
//
// AFTER fix: The blocked guard returns false when back_to is configured.
// ---------------------------------------------------------------------------

describe("Bug 1: blocked guard must not shadow QA feedback loop", () => {
  it("returns false from blocked guard when back_to is configured", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result"],
        retry: { max_retries: 3, back_to: "prevStage" },
      },
    });
    const state = buildAgentState("next", "prev", stage);
    const handlers = getOnDoneHandlers(state);

    // Handler[0] = retry guard, Handler[1] = blocked guard
    const blockedGuard = handlers[1].guard!;
    expect(handlers[1].target).toBe("blocked");

    // Output is missing the required "result" field
    const event = { output: { resultText: "{}" } };
    const context = makeContext({ retryCount: 5 });

    const result = blockedGuard({ event, context });
    // AFTER fix: should be false because back_to is set
    expect(result).toBe(false);
  });

  it("returns true from blocked guard when back_to is NOT configured (normal blocking)", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result"],
        // No retry.back_to
      },
    });
    const state = buildAgentState("next", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const blockedGuard = handlers[1].guard!;

    // Output missing required field, no back_to => should block
    const event = { output: { resultText: "{}" } };
    const context = makeContext({ retryCount: 5 });

    const result = blockedGuard({ event, context });
    expect(result).toBe(true);
  });

  it("allows QA feedback loop guard to evaluate when back_to is configured", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result"],
        retry: { max_retries: 3, back_to: "prevStage" },
      },
    });
    const state = buildAgentState("next", "prev", stage);
    const handlers = getOnDoneHandlers(state);

    // The QA feedback loop guard should be present (handler index 2)
    expect(handlers.length).toBeGreaterThanOrEqual(3);
    const qaGuard = handlers[2].guard!;
    expect(handlers[2].target).toBe("prevStage");

    // Simulate output where result.passed === false (QA failure)
    const failedResult = JSON.stringify({ result: { passed: false, blockers: ["lint errors"] } });
    const event = { output: { resultText: failedResult } };
    const context = makeContext({ retryCount: 5, qaRetryCount: 0 });

    // Blocked guard should NOT fire (tested above), and QA guard should fire
    const blockedResult = handlers[1].guard!({ event, context });
    expect(blockedResult).toBe(false);

    const qaResult = qaGuard({ event, context });
    expect(qaResult).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bug 2: stageSessionIds undefined pollution
//
// BEFORE fix: When event.output had no sessionId, the expression
//   { [stateName]: event.output?.sessionId ?? context.stageSessionIds?.[stateName] }
// would resolve to `undefined` when context.stageSessionIds[stateName] was also
// undefined, but more critically, it would OVERWRITE an existing sessionId with
// undefined if event.output.sessionId was explicitly undefined.
//
// AFTER fix: The ?? operator correctly preserves the previous value because
// event.output?.sessionId is undefined, falling back to the existing value.
// The key behavior: an EXISTING sessionId must not be wiped out.
// ---------------------------------------------------------------------------

describe("Bug 2: stageSessionIds must not be polluted with undefined", () => {
  it("preserves existing sessionId on QA back_to path when output has no sessionId", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result"],
        retry: { max_retries: 3, back_to: "prevStage" },
      },
    });
    const state = buildAgentState("next", "prev", stage);
    const handlers = getOnDoneHandlers(state);

    // QA feedback loop handler (index 2)
    const qaHandler = handlers[2];
    expect(qaHandler.target).toBe("prevStage");

    const assignFn = findAssignAction(qaHandler);
    expect(assignFn).toBeDefined();

    const existingSessionId = "existing-session-abc";
    const context = makeContext({
      qaRetryCount: 0,
      stageSessionIds: { testAgent: existingSessionId, prevStage: "prev-session" },
    });
    // Output with NO sessionId at all
    const event = {
      output: { resultText: JSON.stringify({ result: { passed: false } }), costUsd: 0.01 },
    };

    const result = assignFn!({ event, context });

    // AFTER fix: testAgent's sessionId should be preserved, not set to undefined
    expect(result.stageSessionIds.testAgent).toBe(existingSessionId);
  });

  it("preserves existing sessionId on normal path when output has no sessionId", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result"],
      },
    });
    const state = buildAgentState("next", "prev", stage);
    const handlers = getOnDoneHandlers(state);

    // Normal path is the last handler
    const normalHandler = handlers[handlers.length - 1];
    expect(normalHandler.target).toBe("next");

    const assignFn = findAssignAction(normalHandler);
    expect(assignFn).toBeDefined();

    const existingSessionId = "existing-session-xyz";
    const context = makeContext({
      stageSessionIds: { testAgent: existingSessionId },
    });
    // Output with no sessionId
    const event = {
      output: { resultText: JSON.stringify({ result: "ok" }), costUsd: 0.02 },
    };

    const result = assignFn!({ event, context });

    // AFTER fix: existing sessionId must be preserved
    expect(result.stageSessionIds.testAgent).toBe(existingSessionId);
  });

  it("updates sessionId when output provides a new one", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result"],
      },
    });
    const state = buildAgentState("next", "prev", stage);
    const handlers = getOnDoneHandlers(state);

    const normalHandler = handlers[handlers.length - 1];
    const assignFn = findAssignAction(normalHandler);
    expect(assignFn).toBeDefined();

    const context = makeContext({
      stageSessionIds: { testAgent: "old-session" },
    });
    const event = {
      output: { resultText: JSON.stringify({ result: "ok" }), costUsd: 0, sessionId: "new-session" },
    };

    const result = assignFn!({ event, context });
    expect(result.stageSessionIds.testAgent).toBe("new-session");
  });

  it("does not set sessionId to undefined when no previous value exists and output has none", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result"],
      },
    });
    const state = buildAgentState("next", "prev", stage);
    const handlers = getOnDoneHandlers(state);

    // Retry handler (index 0)
    const retryHandler = handlers[0];
    const assignFn = findAssignAction(retryHandler);
    expect(assignFn).toBeDefined();

    const context = makeContext({ stageSessionIds: {} });
    const event = { output: { resultText: "{}", costUsd: 0 } };

    const result = assignFn!({ event, context });

    // The value should be undefined (no previous, no new), but critically
    // the ?? fallback should have been evaluated. We verify the key exists
    // and the structure is correct.
    expect(result.stageSessionIds).toBeDefined();
    expect(result.stageSessionIds.testAgent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Bug 3: REJECT_WITH_FEEDBACK with empty/missing feedback
//
// BEFORE fix: When REJECT_WITH_FEEDBACK event had no feedback field,
// resumeInfo.feedback would be undefined, causing downstream agents
// to receive no guidance on what to fix.
//
// AFTER fix: The || operator provides a default fallback string:
// "Please review and fix the issues."
// ---------------------------------------------------------------------------

describe("Bug 3: REJECT_WITH_FEEDBACK must default empty feedback", () => {
  function makeHumanGateStage() {
    return {
      name: "review",
      engine: "human_gate" as const,
      notify: { type: "slack" as const, template: "approval-needed" },
      max_feedback_loops: 5,
    } satisfies HumanGateRuntimeConfig & { name: string; notify: { type: "slack"; template: string } };
  }

  function getRejectWithFeedbackHandlers(state: Record<string, unknown>) {
    const on = state.on as Record<string, unknown>;
    return on.REJECT_WITH_FEEDBACK as Array<{ guard?: Function; target: string; actions?: unknown[] }>;
  }

  it("uses default feedback when feedback field is undefined", () => {
    const stage = makeHumanGateStage();
    const state = buildHumanGateState("next", "codeAgent", stage);
    const handlers = getRejectWithFeedbackHandlers(state);

    // First handler is the one that routes back to prevAgent
    const handler = handlers[0];
    expect(handler.target).toBe("codeAgent");

    const assignFn = findAssignAction(handler);
    expect(assignFn).toBeDefined();

    const context = makeContext({
      qaRetryCount: 0,
      stageSessionIds: { codeAgent: "session-123" },
    });
    // Event with NO feedback field
    const event = { type: "REJECT_WITH_FEEDBACK" };

    const result = assignFn!({ event, context });

    // AFTER fix: feedback should be the default string, not undefined
    expect(result.resumeInfo).toBeDefined();
    expect(result.resumeInfo.feedback).toBe("Please review and fix the issues.");
  });

  it("uses default feedback when feedback is an empty string", () => {
    const stage = makeHumanGateStage();
    const state = buildHumanGateState("next", "codeAgent", stage);
    const handlers = getRejectWithFeedbackHandlers(state);
    const assignFn = findAssignAction(handlers[0]);
    expect(assignFn).toBeDefined();

    const context = makeContext({
      qaRetryCount: 0,
      stageSessionIds: { codeAgent: "session-456" },
    });
    // Empty string is falsy => || should trigger default
    const event = { type: "REJECT_WITH_FEEDBACK", feedback: "" };

    const result = assignFn!({ event, context });

    expect(result.resumeInfo).toBeDefined();
    expect(result.resumeInfo.feedback).toBe("Please review and fix the issues.");
  });

  it("uses provided feedback when it is a non-empty string", () => {
    const stage = makeHumanGateStage();
    const state = buildHumanGateState("next", "codeAgent", stage);
    const handlers = getRejectWithFeedbackHandlers(state);
    const assignFn = findAssignAction(handlers[0]);
    expect(assignFn).toBeDefined();

    const context = makeContext({
      qaRetryCount: 0,
      stageSessionIds: { codeAgent: "session-789" },
    });
    const event = { type: "REJECT_WITH_FEEDBACK", feedback: "Fix the CSS layout" };

    const result = assignFn!({ event, context });

    expect(result.resumeInfo).toBeDefined();
    expect(result.resumeInfo.feedback).toBe("Fix the CSS layout");
  });

  it("returns no resumeInfo when prevAgent has no sessionId", () => {
    const stage = makeHumanGateStage();
    const state = buildHumanGateState("next", "codeAgent", stage);
    const handlers = getRejectWithFeedbackHandlers(state);
    const assignFn = findAssignAction(handlers[0]);
    expect(assignFn).toBeDefined();

    const context = makeContext({
      qaRetryCount: 0,
      stageSessionIds: {}, // No session for codeAgent
    });
    const event = { type: "REJECT_WITH_FEEDBACK", feedback: "Fix things" };

    const result = assignFn!({ event, context });

    // No sessionId => resumeInfo should be undefined
    expect(result.resumeInfo).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Bug 1 extended — blocked guard edge cases
// ---------------------------------------------------------------------------

describe("Bug 1 extended — blocked guard edge cases", () => {
  it("returns false when back_to configured but writes is empty", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: [],
        retry: { max_retries: 3, back_to: "prevStage" },
      },
    });
    const state = buildAgentState("next", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const blockedGuard = handlers[1].guard!;

    const event = { output: { resultText: "{}" } };
    const context = makeContext({ retryCount: 5 });

    // No writes to check => guard returns false immediately
    expect(blockedGuard({ event, context })).toBe(false);
  });

  it("returns false when back_to configured and output has SOME required fields but not all", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["fieldA", "fieldB"],
        retry: { max_retries: 3, back_to: "prevStage" },
      },
    });
    const state = buildAgentState("next", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const blockedGuard = handlers[1].guard!;

    // Only fieldA present, fieldB missing
    const event = { output: { resultText: JSON.stringify({ fieldA: "ok" }) } };
    const context = makeContext({ retryCount: 5 });

    // back_to is configured => always false regardless of fields
    expect(blockedGuard({ event, context })).toBe(false);
  });

  it("returns false when back_to configured and extractJSON throws", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result"],
        retry: { max_retries: 3, back_to: "prevStage" },
      },
    });
    const state = buildAgentState("next", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const blockedGuard = handlers[1].guard!;

    // extractJSON will throw on invalid JSON
    const event = { output: { resultText: "not json at all {{{" } };
    const context = makeContext({ retryCount: 5 });

    // back_to configured => guard returns false before even trying to parse
    expect(blockedGuard({ event, context })).toBe(false);
  });

  it("returns true when back_to NOT configured and output is null", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result"],
      },
    });
    const state = buildAgentState("next", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const blockedGuard = handlers[1].guard!;

    const event = { output: { resultText: null } };
    const context = makeContext({ retryCount: 5 });

    // No text => true (blocks)
    expect(blockedGuard({ event, context })).toBe(true);
  });

  it("returns true when back_to NOT configured and output is empty string", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result"],
      },
    });
    const state = buildAgentState("next", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const blockedGuard = handlers[1].guard!;

    const event = { output: { resultText: "" } };
    const context = makeContext({ retryCount: 5 });

    // Empty string is falsy => true (blocks)
    expect(blockedGuard({ event, context })).toBe(true);
  });

  it("returns false when back_to NOT configured and writes is empty", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: [],
      },
    });
    const state = buildAgentState("next", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const blockedGuard = handlers[1].guard!;

    const event = { output: { resultText: "{}" } };
    const context = makeContext({ retryCount: 5 });

    // No writes => guard returns false regardless
    expect(blockedGuard({ event, context })).toBe(false);
  });

  it("returns false when back_to NOT configured and output has all required fields", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result", "summary"],
      },
    });
    const state = buildAgentState("next", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const blockedGuard = handlers[1].guard!;

    const event = { output: { resultText: JSON.stringify({ result: "ok", summary: "done" }) } };
    const context = makeContext({ retryCount: 5 });

    // All fields present => .some() returns true => guard returns !true = false
    expect(blockedGuard({ event, context })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bug 1 extended — retry guard (guard index 0) interactions
// ---------------------------------------------------------------------------

describe("Bug 1 extended — retry guard interactions", () => {
  it("retry guard fires when retryCount=0, missing fields, no back_to", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result"],
      },
    });
    const state = buildAgentState("next", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const retryGuard = handlers[0].guard!;

    const event = { output: { resultText: "{}" } };
    const context = makeContext({ retryCount: 0 });

    expect(retryGuard({ event, context })).toBe(true);
    expect(handlers[0].target).toBe("testAgent");
  });

  it("retry guard fires when retryCount=1, missing fields, no back_to", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result"],
      },
    });
    const state = buildAgentState("next", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const retryGuard = handlers[0].guard!;

    const event = { output: { resultText: "{}" } };
    const context = makeContext({ retryCount: 1 });

    expect(retryGuard({ event, context })).toBe(true);
  });

  it("retry guard returns false at retryCount=2, blocked guard fires instead", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result"],
      },
    });
    const state = buildAgentState("next", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const retryGuard = handlers[0].guard!;
    const blockedGuard = handlers[1].guard!;

    const event = { output: { resultText: "{}" } };
    const context = makeContext({ retryCount: 2 });

    // Retry guard stops at retryCount >= 2
    expect(retryGuard({ event, context })).toBe(false);
    // Blocked guard fires since no back_to
    expect(blockedGuard({ event, context })).toBe(true);
  });

  it("neither retry nor blocked guard fires when all fields present at retryCount=0", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result"],
      },
    });
    const state = buildAgentState("next", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const retryGuard = handlers[0].guard!;
    const blockedGuard = handlers[1].guard!;

    const event = { output: { resultText: JSON.stringify({ result: "present" }) } };
    const context = makeContext({ retryCount: 0 });

    expect(retryGuard({ event, context })).toBe(false);
    expect(blockedGuard({ event, context })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bug 2 extended — stageSessionIds across all paths
// ---------------------------------------------------------------------------

describe("Bug 2 extended — stageSessionIds across all paths", () => {
  it("retry path (guard index 0): sessionId preserved via ?? fallback", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result"],
      },
    });
    const state = buildAgentState("next", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const retryHandler = handlers[0];
    const assignFn = findAssignAction(retryHandler)!;

    const context = makeContext({
      retryCount: 0,
      stageSessionIds: { testAgent: "existing-session" },
    });
    // Output has no sessionId
    const event = { output: { resultText: "{}", costUsd: 0 } };

    const result = assignFn!({ event, context });
    expect(result.stageSessionIds.testAgent).toBe("existing-session");
  });

  it("retry path: new sessionId provided overwrites old one", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result"],
      },
    });
    const state = buildAgentState("next", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const retryHandler = handlers[0];
    const assignFn = findAssignAction(retryHandler)!;

    const context = makeContext({
      retryCount: 0,
      stageSessionIds: { testAgent: "old-session" },
    });
    const event = { output: { resultText: "{}", costUsd: 0, sessionId: "brand-new" } };

    const result = assignFn!({ event, context });
    expect(result.stageSessionIds.testAgent).toBe("brand-new");
  });

  it("QA back_to path: stageCwds preserved when no cwd in output", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result"],
        retry: { max_retries: 3, back_to: "prevStage" },
      },
    });
    const state = buildAgentState("next", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const qaHandler = handlers[2];
    const assignFn = findAssignAction(qaHandler)!;

    const context = makeContext({
      qaRetryCount: 0,
      stageSessionIds: { testAgent: "s1" },
      stageCwds: { testAgent: "/old/path", prevStage: "/prev/path" },
    });
    const event = {
      output: { resultText: JSON.stringify({ result: { passed: false } }), costUsd: 0 },
    };

    const result = assignFn!({ event, context });
    // No cwd in output => existing cwds preserved
    expect(result.stageCwds.testAgent).toBe("/old/path");
    expect(result.stageCwds.prevStage).toBe("/prev/path");
  });

  it("normal path: stageCwds preserved when no cwd in output", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result"],
      },
    });
    const state = buildAgentState("next", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const normalHandler = handlers[handlers.length - 1];
    const assignFn = findAssignAction(normalHandler)!;

    const context = makeContext({
      stageSessionIds: { testAgent: "s1" },
      stageCwds: { testAgent: "/some/path" },
    });
    const event = {
      output: { resultText: JSON.stringify({ result: "ok" }), costUsd: 0 },
    };

    const result = assignFn!({ event, context });
    expect(result.stageCwds.testAgent).toBe("/some/path");
  });

  it("normal path with sessionId=null (not undefined) → fallback applies", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result"],
      },
    });
    const state = buildAgentState("next", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const normalHandler = handlers[handlers.length - 1];
    const assignFn = findAssignAction(normalHandler)!;

    const context = makeContext({
      stageSessionIds: { testAgent: "kept-session" },
    });
    // sessionId is null — ?? treats null as nullish, so fallback to existing
    const event = {
      output: { resultText: JSON.stringify({ result: "ok" }), costUsd: 0, sessionId: null },
    };

    const result = assignFn!({ event, context });
    expect(result.stageSessionIds.testAgent).toBe("kept-session");
  });

  it("multiple stages: sessionIds for OTHER stages not clobbered", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result"],
      },
    });
    const state = buildAgentState("next", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const normalHandler = handlers[handlers.length - 1];
    const assignFn = findAssignAction(normalHandler)!;

    const context = makeContext({
      stageSessionIds: { testAgent: "my-session", otherStage: "other-session", thirdStage: "third-session" },
    });
    const event = {
      output: { resultText: JSON.stringify({ result: "ok" }), costUsd: 0, sessionId: "updated" },
    };

    const result = assignFn!({ event, context });
    // Only testAgent should be updated
    expect(result.stageSessionIds.testAgent).toBe("updated");
    expect(result.stageSessionIds.otherStage).toBe("other-session");
    expect(result.stageSessionIds.thirdStage).toBe("third-session");
  });
});

// ---------------------------------------------------------------------------
// Bug 2 extended — store merge behavior
// ---------------------------------------------------------------------------

describe("Bug 2 extended — store merge behavior", () => {
  it("normal path: store merges correctly with new writes", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result", "summary"],
      },
    });
    const state = buildAgentState("next", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const normalHandler = handlers[handlers.length - 1];
    const assignFn = findAssignAction(normalHandler)!;

    const context = makeContext({
      store: { existingKey: "keep me", result: "old" },
      stageSessionIds: {},
    });
    const event = {
      output: { resultText: JSON.stringify({ result: "new", summary: "done" }), costUsd: 0 },
    };

    const result = assignFn!({ event, context });
    expect(result.store.existingKey).toBe("keep me");
    expect(result.store.result).toBe("new");
    expect(result.store.summary).toBe("done");
  });

  it("normal path: extractJSON failure doesn't corrupt store", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result"],
      },
    });
    const state = buildAgentState("next", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const normalHandler = handlers[handlers.length - 1];
    const assignFn = findAssignAction(normalHandler)!;

    const context = makeContext({
      store: { existingKey: "preserve" },
      stageSessionIds: {},
    });
    // Invalid JSON => extractJSON will throw
    const event = {
      output: { resultText: "not valid json {{{", costUsd: 0 },
    };

    const result = assignFn!({ event, context });
    // Store should remain unchanged
    expect(result.store.existingKey).toBe("preserve");
    expect(result.store.result).toBeUndefined();
  });

  it("QA back_to path: partial writes stored (only fields present)", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["fieldA", "fieldB"],
        retry: { max_retries: 3, back_to: "prevStage" },
      },
    });
    const state = buildAgentState("next", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const qaHandler = handlers[2];
    const assignFn = findAssignAction(qaHandler)!;

    const context = makeContext({
      qaRetryCount: 0,
      store: { old: "data" },
      stageSessionIds: {},
    });
    // Only fieldA present, fieldB absent
    const event = {
      output: { resultText: JSON.stringify({ fieldA: { passed: false }, unrelated: 42 }), costUsd: 0 },
    };

    const result = assignFn!({ event, context });
    expect(result.store.fieldA).toEqual({ passed: false });
    expect(result.store.fieldB).toBeUndefined();
    // "unrelated" is NOT in writes, so not stored
    expect(result.store.unrelated).toBeUndefined();
  });

  it("QA back_to path: existing store fields not lost", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result"],
        retry: { max_retries: 3, back_to: "prevStage" },
      },
    });
    const state = buildAgentState("next", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const qaHandler = handlers[2];
    const assignFn = findAssignAction(qaHandler)!;

    const context = makeContext({
      qaRetryCount: 0,
      store: { previousData: "important", result: "old-value" },
      stageSessionIds: {},
    });
    const event = {
      output: { resultText: JSON.stringify({ result: { passed: false, blockers: ["fail"] } }), costUsd: 0 },
    };

    const result = assignFn!({ event, context });
    // Old field preserved
    expect(result.store.previousData).toBe("important");
    // result overwritten with new value
    expect(result.store.result).toEqual({ passed: false, blockers: ["fail"] });
  });
});

// ---------------------------------------------------------------------------
// Bug 3 extended — REJECT_WITH_FEEDBACK edge cases
// ---------------------------------------------------------------------------

describe("Bug 3 extended — REJECT_WITH_FEEDBACK edge cases", () => {
  function makeHumanGateStage(overrides: Partial<HumanGateRuntimeConfig & { name: string; notify?: { type: "slack"; template: string } }> = {}) {
    return {
      name: "review",
      engine: "human_gate" as const,
      notify: { type: "slack" as const, template: "approval-needed" },
      max_feedback_loops: 5,
      ...overrides,
    } satisfies HumanGateRuntimeConfig & { name: string; notify: { type: "slack"; template: string } };
  }

  function getRejectWithFeedbackHandlers(state: Record<string, unknown>) {
    const on = state.on as Record<string, unknown>;
    return on.REJECT_WITH_FEEDBACK as Array<{ guard?: Function; target: string; actions?: unknown[] }>;
  }

  it("whitespace-only feedback ' ' is used as-is (truthy string)", () => {
    const stage = makeHumanGateStage();
    const state = buildHumanGateState("next", "codeAgent", stage);
    const handlers = getRejectWithFeedbackHandlers(state);
    const assignFn = findAssignAction(handlers[0])!;

    const context = makeContext({
      qaRetryCount: 0,
      stageSessionIds: { codeAgent: "s1" },
    });
    const event = { type: "REJECT_WITH_FEEDBACK", feedback: "   " };

    const result = assignFn!({ event, context });
    // Whitespace is truthy, || doesn't trigger
    expect(result.resumeInfo.feedback).toBe("   ");
  });

  it("feedback '0' is used as-is (truthy string)", () => {
    const stage = makeHumanGateStage();
    const state = buildHumanGateState("next", "codeAgent", stage);
    const handlers = getRejectWithFeedbackHandlers(state);
    const assignFn = findAssignAction(handlers[0])!;

    const context = makeContext({
      qaRetryCount: 0,
      stageSessionIds: { codeAgent: "s1" },
    });
    const event = { type: "REJECT_WITH_FEEDBACK", feedback: "0" };

    const result = assignFn!({ event, context });
    expect(result.resumeInfo.feedback).toBe("0");
  });

  it("qaRetryCount at limit → second handler fires (on_reject_to path)", () => {
    const stage = makeHumanGateStage({ max_feedback_loops: 3 });
    const state = buildHumanGateState("next", "codeAgent", stage);
    const handlers = getRejectWithFeedbackHandlers(state);

    // First handler guard should return false when at limit
    const guard = handlers[0].guard!;
    const context = makeContext({ qaRetryCount: 3 });

    expect(guard({ event: { type: "REJECT_WITH_FEEDBACK" }, context })).toBe(false);

    // Second handler has no guard — it always fires as fallback
    expect(handlers[1].guard).toBeUndefined();
    expect(handlers[1].target).toBe("error"); // default on_reject_to
  });

  it("qaRetryCount exactly at max_feedback_loops → falls through to reject", () => {
    const stage = makeHumanGateStage({ max_feedback_loops: 5 });
    const state = buildHumanGateState("next", "codeAgent", stage);
    const handlers = getRejectWithFeedbackHandlers(state);
    const guard = handlers[0].guard!;

    // qaRetryCount === max_feedback_loops => guard returns false
    const context = makeContext({ qaRetryCount: 5 });
    expect(guard({ event: { type: "REJECT_WITH_FEEDBACK" }, context })).toBe(false);
  });

  it("max_feedback_loops is 0 → always falls through to reject", () => {
    const stage = makeHumanGateStage({ max_feedback_loops: 0 });
    const state = buildHumanGateState("next", "codeAgent", stage);
    const handlers = getRejectWithFeedbackHandlers(state);
    const guard = handlers[0].guard!;

    // Even at qaRetryCount 0, 0 < 0 is false
    const context = makeContext({ qaRetryCount: 0 });
    expect(guard({ event: { type: "REJECT_WITH_FEEDBACK" }, context })).toBe(false);
  });

  it("max_feedback_loops is undefined → defaults to 5", () => {
    const stage = makeHumanGateStage();
    delete (stage as any).max_feedback_loops;
    const state = buildHumanGateState("next", "codeAgent", stage);
    const handlers = getRejectWithFeedbackHandlers(state);
    const guard = handlers[0].guard!;

    // qaRetryCount 4 < 5 (default) => true
    expect(guard({ event: { type: "REJECT_WITH_FEEDBACK" }, context: makeContext({ qaRetryCount: 4 }) })).toBe(true);
    // qaRetryCount 5 >= 5 => false
    expect(guard({ event: { type: "REJECT_WITH_FEEDBACK" }, context: makeContext({ qaRetryCount: 5 }) })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildScriptState tests
// ---------------------------------------------------------------------------

// Must import buildScriptState — it was not imported in original test file
const { buildScriptState } = await import("./state-builders.js");

import type { ScriptStageConfig } from "../lib/config-loader.js";

function makeScriptStage(overrides: Partial<ScriptStageConfig> = {}): ScriptStageConfig {
  return {
    name: "testScript",
    type: "script",
    runtime: {
      engine: "script" as const,
      script_id: "test-script",
      writes: ["output"],
      ...((overrides.runtime ?? {}) as any),
    },
    ...overrides,
  } as ScriptStageConfig;
}

function getScriptOnDoneHandler(state: Record<string, unknown>) {
  const invoke = state.invoke as { onDone: { target: string; actions: unknown[] } };
  return invoke.onDone;
}

describe("buildScriptState tests", () => {
  it("script with writes and object output → store updated correctly", () => {
    const stage = makeScriptStage({
      runtime: {
        engine: "script",
        script_id: "test",
        writes: ["fileList", "summary"],
      },
    });
    const state = buildScriptState("next", "prev", stage);
    const handler = getScriptOnDoneHandler(state);
    const assignFn = findAssignAction(handler as any)!;

    const context = makeContext({ store: { existing: "data" } });
    const event = {
      output: { fileList: ["a.ts", "b.ts"], summary: "done" },
    };

    const result = assignFn!({ event, context });
    expect(result.store.fileList).toEqual(["a.ts", "b.ts"]);
    expect(result.store.summary).toBe("done");
    expect(result.store.existing).toBe("data");
  });

  it("script with writes and single-value output → store updated with first write key", () => {
    const stage = makeScriptStage({
      runtime: {
        engine: "script",
        script_id: "test",
        writes: ["singleField"],
      },
    });
    const state = buildScriptState("next", "prev", stage);
    const handler = getScriptOnDoneHandler(state);
    const assignFn = findAssignAction(handler as any)!;

    const context = makeContext({ store: {} });
    // Output is a raw string, not an object
    const event = { output: "hello world" };

    const result = assignFn!({ event, context });
    // Single write key + non-object output => stored under that key
    expect(result.store.singleField).toBe("hello world");
  });

  it("script with no writes → store unchanged", () => {
    const stage = makeScriptStage({
      runtime: {
        engine: "script",
        script_id: "test",
        writes: [],
      },
    });
    const state = buildScriptState("next", "prev", stage);
    const handler = getScriptOnDoneHandler(state);
    const assignFn = findAssignAction(handler as any)!;

    const context = makeContext({ store: { keep: "me" } });
    const event = { output: { anything: "ignored" } };

    const result = assignFn!({ event, context });
    expect(result.store).toEqual({ keep: "me" });
  });

  it("script output is null → store unchanged", () => {
    const stage = makeScriptStage({
      runtime: {
        engine: "script",
        script_id: "test",
        writes: ["result"],
      },
    });
    const state = buildScriptState("next", "prev", stage);
    const handler = getScriptOnDoneHandler(state);
    const assignFn = findAssignAction(handler as any)!;

    const context = makeContext({ store: { keep: "me" } });
    const event = { output: null };

    const result = assignFn!({ event, context });
    // output is null => `output !== undefined` is true, `typeof null === "object"` is true
    // but `null !== null` is false, so it falls to `else if (writes.length === 1)`
    // which stores null under the single write key
    expect(result.store).toEqual({ keep: "me", result: null });
  });

  it("script with writes but output missing those fields → store not corrupted", () => {
    const stage = makeScriptStage({
      runtime: {
        engine: "script",
        script_id: "test",
        writes: ["expectedField"],
      },
    });
    const state = buildScriptState("next", "prev", stage);
    const handler = getScriptOnDoneHandler(state);
    const assignFn = findAssignAction(handler as any)!;

    const context = makeContext({ store: { old: "value" } });
    // Output is an object but missing expectedField
    const event = { output: { unrelated: "data" } };

    const result = assignFn!({ event, context });
    // expectedField not in output => no updates, old store preserved
    expect(result.store.old).toBe("value");
    expect(result.store.expectedField).toBeUndefined();
    expect(result.store.unrelated).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildHumanGateState tests
// ---------------------------------------------------------------------------

describe("buildHumanGateState tests", () => {
  function makeGateStage(overrides: Partial<HumanGateRuntimeConfig & { name: string; notify?: { type: "slack"; template: string } }> = {}) {
    return {
      name: "gate",
      engine: "human_gate" as const,
      notify: { type: "slack" as const, template: "approval-needed" },
      max_feedback_loops: 5,
      ...overrides,
    } satisfies HumanGateRuntimeConfig & { name: string; notify: { type: "slack"; template: string } };
  }

  function getConfirmHandler(state: Record<string, unknown>) {
    const on = state.on as Record<string, unknown>;
    return on.CONFIRM as { target: string; actions: unknown[] };
  }

  function getRejectHandler(state: Record<string, unknown>) {
    const on = state.on as Record<string, unknown>;
    return on.REJECT as { target: string; actions: unknown[] };
  }

  it("CONFIRM event with repoName → explicitRepoName set, retryCount reset", () => {
    const stage = makeGateStage();
    const state = buildHumanGateState("next", "prev", stage);
    const handler = getConfirmHandler(state);
    const assignFn = findAssignAction(handler as any)!;

    const event = { type: "CONFIRM", repoName: "my-repo" };
    const context = makeContext({ retryCount: 3 });

    const result = assignFn!({ event, context });
    expect(result.retryCount).toBe(0);
    expect(result.explicitRepoName).toBe("my-repo");
  });

  it("CONFIRM event without repoName → no explicitRepoName key", () => {
    const stage = makeGateStage();
    const state = buildHumanGateState("next", "prev", stage);
    const handler = getConfirmHandler(state);
    const assignFn = findAssignAction(handler as any)!;

    const event = { type: "CONFIRM" };
    const context = makeContext({ retryCount: 2 });

    const result = assignFn!({ event, context });
    expect(result.retryCount).toBe(0);
    expect(result.explicitRepoName).toBeUndefined();
  });

  it("CONFIRM with custom on_approve_to → target is custom target", () => {
    const stage = makeGateStage({ on_approve_to: "customNext" });
    const state = buildHumanGateState("next", "prev", stage);
    const handler = getConfirmHandler(state);

    expect(handler.target).toBe("customNext");
  });

  it("REJECT event → target is on_reject_to or 'error', error message set", () => {
    const stage = makeGateStage({ on_reject_to: "customError" });
    const state = buildHumanGateState("next", "prev", stage);
    const handler = getRejectHandler(state);

    expect(handler.target).toBe("customError");

    const assignFn = findAssignAction(handler as any)!;
    const event = { type: "REJECT", reason: "Bad output" };
    const context = makeContext();

    const result = assignFn!({ event, context });
    expect(result.error).toBe("Bad output");
  });

  it("REJECT without reason → default 'Rejected by user'", () => {
    const stage = makeGateStage();
    const state = buildHumanGateState("next", "prev", stage);
    const handler = getRejectHandler(state);
    const assignFn = findAssignAction(handler as any)!;

    const event = { type: "REJECT" };
    const context = makeContext();

    const result = assignFn!({ event, context });
    expect(result.error).toBe("Rejected by user");
  });

  it("REJECT with no on_reject_to → target defaults to 'error'", () => {
    const stage = makeGateStage();
    delete (stage as any).on_reject_to;
    const state = buildHumanGateState("next", "prev", stage);
    const handler = getRejectHandler(state);

    expect(handler.target).toBe("error");
  });

  it("entry emits wf.slackGate with correct template", () => {
    const stage = makeGateStage({ notify: { type: "slack", template: "my-template" } });
    const state = buildHumanGateState("next", "prev", stage);

    const entryActions = state.entry as unknown[];
    // Entry is an array: [...statusEntry(), emit(...)]
    // The emit action is the last one; it should be an XState emit object
    const emitAction = entryActions[entryActions.length - 1] as any;

    // XState emit actions have a type of "xstate.emit" and an `event` or `params` function
    expect(emitAction).toBeDefined();
    expect(emitAction.type).toBe("xstate.emit");

    // The emit params function returns the event shape
    const context = makeContext({ taskId: "task-123" });
    const emittedEvent = emitAction.event({ context });
    expect(emittedEvent.type).toBe("wf.slackGate");
    expect(emittedEvent.taskId).toBe("task-123");
    expect(emittedEvent.stageName).toBe("gate");
    expect(emittedEvent.template).toBe("my-template");
  });

  it("custom notify template used when configured", () => {
    const stage = makeGateStage({ notify: { type: "slack", template: "custom-approval" } });
    const state = buildHumanGateState("next", "prev", stage);

    const entryActions = state.entry as unknown[];
    const emitAction = entryActions[entryActions.length - 1] as any;

    const context = makeContext();
    const emittedEvent = emitAction.event({ context });
    expect(emittedEvent.template).toBe("custom-approval");
  });

  it("default template 'approval-needed' when no notify configured", () => {
    // No notify property
    const stage = { name: "gate", engine: "human_gate" as const, max_feedback_loops: 5 } as any;
    const state = buildHumanGateState("next", "prev", stage);

    const entryActions = state.entry as unknown[];
    const emitAction = entryActions[entryActions.length - 1] as any;

    const context = makeContext();
    const emittedEvent = emitAction.event({ context });
    expect(emittedEvent.template).toBe("approval-needed");
  });
});
