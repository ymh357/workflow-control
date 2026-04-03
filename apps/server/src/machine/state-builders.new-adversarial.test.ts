// Adversarial tests proving a regression introduced by the back_to blocked-guard fix.
//
// THE BUG: In buildAgentState, line 96 adds `if (runtime.retry?.back_to) return false;`
// to the "blocked" guard. This means when back_to is configured, the blocked guard NEVER
// fires. But when BOTH the retry count AND the QA back_to loop are exhausted:
//   - retry guard (line 55): retryCount >= 2, returns false
//   - blocked guard (line 93): has back_to, returns false  <-- THE FIX
//   - QA back_to guard (line 131): loopCount >= max_retries, returns false
//   - normal path (line 195): NO guard, fires unconditionally -- advances with bad output!
//
// The pipeline should enter "blocked" or "error" state, but instead it silently advances
// to the next stage with missing/empty data.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkflowContext } from "./types.js";
import type { AgentStageConfig } from "../lib/config-loader.js";

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
const { buildAgentState } = await import("./state-builders.js");

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
  } as AgentStageConfig;
}

function getOnDoneHandlers(state: Record<string, unknown>) {
  const invoke = state.invoke as { onDone: Array<{ guard?: Function; target: string; actions?: unknown[] }> };
  return invoke.onDone;
}

function findAssignAction(handler: { actions?: unknown[] }): Function | undefined {
  if (!handler.actions) return undefined;
  for (const action of handler.actions) {
    if (action && (action as any).type === "xstate.assign") {
      return (action as any).assignment;
    }
  }
  return undefined;
}

/**
 * Simulates XState guard evaluation order: returns the index of the first
 * handler whose guard returns true (or has no guard), or -1 if none match.
 */
function evaluateGuards(
  handlers: Array<{ guard?: Function; target: string }>,
  event: unknown,
  context: WorkflowContext,
): { index: number; target: string } {
  for (let i = 0; i < handlers.length; i++) {
    const h = handlers[i];
    if (!h.guard || h.guard({ event, context })) {
      return { index: i, target: h.target };
    }
  }
  return { index: -1, target: "" };
}

// ---------------------------------------------------------------------------
// Core bug: all guards exhausted with back_to configured -> falls through to normal path
// ---------------------------------------------------------------------------

describe("Regression: back_to configured + all retries exhausted -> incorrect advancement", () => {
  const stage = makeAgentStage({
    runtime: {
      engine: "llm",
      system_prompt: "do stuff",
      writes: ["result"],
      retry: { back_to: "some_stage", max_retries: 1 },
    },
  });

  it("should NOT advance to next stage when output is empty and all loops are exhausted", () => {
    const state = buildAgentState("nextStage", "prev", stage);
    const handlers = getOnDoneHandlers(state);

    // retryCount >= 2 exhausts retry guard; qaRetryCount >= max_retries (1) exhausts QA guard
    const context = makeContext({ retryCount: 2, qaRetryCount: 1 });
    const event = { output: { resultText: "" } };

    const { index, target } = evaluateGuards(handlers, event, context);

    // EXPECTED: should go to "blocked" (index 1)
    // ACTUAL BUG: blocked guard returns false due to back_to check, QA guard returns false
    // due to exhausted loops, so normal path (last handler, no guard) fires -> "nextStage"
    expect(target).not.toBe("nextStage");
    expect(target).toBe("blocked");
  });

  it("should NOT advance to next stage when output has valid JSON but missing required writes field", () => {
    const state = buildAgentState("nextStage", "prev", stage);
    const handlers = getOnDoneHandlers(state);

    const context = makeContext({ retryCount: 2, qaRetryCount: 1 });
    // Valid JSON but missing "result" field
    const event = { output: { resultText: JSON.stringify({ someOtherField: "value" }) } };

    const { target } = evaluateGuards(handlers, event, context);

    expect(target).not.toBe("nextStage");
    expect(target).toBe("blocked");
  });

  it("should NOT advance when output is unparseable JSON and all loops exhausted", () => {
    const state = buildAgentState("nextStage", "prev", stage);
    const handlers = getOnDoneHandlers(state);

    const context = makeContext({ retryCount: 2, qaRetryCount: 1 });
    const event = { output: { resultText: "this is not json at all" } };

    const { target } = evaluateGuards(handlers, event, context);

    expect(target).not.toBe("nextStage");
    expect(target).toBe("blocked");
  });

  it("should NOT advance when resultText is null/undefined and all loops exhausted", () => {
    const state = buildAgentState("nextStage", "prev", stage);
    const handlers = getOnDoneHandlers(state);

    const context = makeContext({ retryCount: 3, qaRetryCount: 2 });
    const event = { output: { resultText: undefined } };

    const { target } = evaluateGuards(handlers, event, context);

    expect(target).not.toBe("nextStage");
    expect(target).toBe("blocked");
  });
});

// ---------------------------------------------------------------------------
// Verify the store is corrupted when pipeline incorrectly advances
// ---------------------------------------------------------------------------

describe("Regression: store does not contain required fields when pipeline incorrectly advances", () => {
  it("store should lack the required 'result' field after advancing with empty output", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result"],
        retry: { back_to: "some_stage", max_retries: 1 },
      },
    });
    const state = buildAgentState("nextStage", "prev", stage);
    const handlers = getOnDoneHandlers(state);

    const context = makeContext({ retryCount: 2, qaRetryCount: 1, store: {} });
    const event = { output: { resultText: "" } };

    const { index, target } = evaluateGuards(handlers, event, context);

    // If the bug fires, we land on the normal path (last handler)
    // Demonstrate that the assign action on the normal path leaves store without "result"
    if (target === "nextStage") {
      const normalHandler = handlers[index];
      const assignFn = findAssignAction(normalHandler);
      expect(assignFn).toBeDefined();

      const assigned = assignFn!({ event, context });
      // The store should NOT have 'result' — pipeline advanced with missing data
      expect(assigned.store).not.toHaveProperty("result");
      // This is the proof the bug is harmful: advancing without the expected data
    }

    // The correct behavior should be "blocked", so this expectation shows the bug
    expect(target).toBe("blocked");
  });

  it("store should lack required fields when JSON output has wrong fields", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result", "summary"],
        retry: { back_to: "some_stage", max_retries: 1 },
      },
    });
    const state = buildAgentState("nextStage", "prev", stage);
    const handlers = getOnDoneHandlers(state);

    const context = makeContext({ retryCount: 2, qaRetryCount: 1, store: {} });
    // Has "unrelated" field but not "result" or "summary"
    const event = { output: { resultText: JSON.stringify({ unrelated: true }) } };

    const { index, target } = evaluateGuards(handlers, event, context);

    if (target === "nextStage") {
      const assignFn = findAssignAction(handlers[index]);
      const assigned = assignFn!({ event, context });
      expect(assigned.store).not.toHaveProperty("result");
      expect(assigned.store).not.toHaveProperty("summary");
    }

    expect(target).toBe("blocked");
  });
});

// ---------------------------------------------------------------------------
// Verify each guard individually to trace the root cause
// ---------------------------------------------------------------------------

describe("Guard-by-guard analysis with back_to + all retries exhausted", () => {
  const stage = makeAgentStage({
    runtime: {
      engine: "llm",
      system_prompt: "do stuff",
      writes: ["result"],
      retry: { back_to: "some_stage", max_retries: 1 },
    },
  });

  it("retry guard (index 0) returns false when retryCount >= 2", () => {
    const state = buildAgentState("nextStage", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const retryGuard = handlers[0].guard!;

    const context = makeContext({ retryCount: 2 });
    const event = { output: { resultText: "" } };

    expect(retryGuard({ event, context })).toBe(false);
  });

  it("blocked guard (index 1) returns true when back_to QA loop is also exhausted", () => {
    const state = buildAgentState("nextStage", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const blockedGuard = handlers[1].guard!;

    // qaRetryCount >= max_retries (1), so back_to loop is exhausted — blocked guard should fire
    const context = makeContext({ retryCount: 2, qaRetryCount: 1 });
    const event = { output: { resultText: "" } };

    expect(blockedGuard({ event, context })).toBe(true);
  });

  it("blocked guard (index 1) defers to QA loop when it still has retries left", () => {
    const state = buildAgentState("nextStage", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const blockedGuard = handlers[1].guard!;

    // qaRetryCount < max_retries (1), so back_to loop still has capacity — blocked guard defers
    const context = makeContext({ retryCount: 2, qaRetryCount: 0 });
    const event = { output: { resultText: "" } };

    expect(blockedGuard({ event, context })).toBe(false);
  });

  it("QA guard (index 2) returns false when qaRetryCount >= max_retries", () => {
    const state = buildAgentState("nextStage", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const qaGuard = handlers[2].guard!;

    const context = makeContext({ retryCount: 2, qaRetryCount: 1 });
    // Empty output — not a QA failure shape anyway
    const event = { output: { resultText: "" } };

    expect(qaGuard({ event, context })).toBe(false);
  });

  it("normal path (last handler) has NO guard and targets nextStage unconditionally", () => {
    const state = buildAgentState("nextStage", "prev", stage);
    const handlers = getOnDoneHandlers(state);
    const normalHandler = handlers[handlers.length - 1];

    expect(normalHandler.guard).toBeUndefined();
    expect(normalHandler.target).toBe("nextStage");
  });
});

// ---------------------------------------------------------------------------
// Edge cases: different max_retries values
// ---------------------------------------------------------------------------

describe("Regression with different max_retries configurations", () => {
  it("max_retries: 0 — QA loop immediately exhausted, should block on empty output", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result"],
        retry: { back_to: "some_stage", max_retries: 0 },
      },
    });
    const state = buildAgentState("nextStage", "prev", stage);
    const handlers = getOnDoneHandlers(state);

    // qaRetryCount 0 >= max_retries 0, so QA guard is exhausted immediately
    const context = makeContext({ retryCount: 2, qaRetryCount: 0 });
    const event = { output: { resultText: "" } };

    const { target } = evaluateGuards(handlers, event, context);
    expect(target).not.toBe("nextStage");
    expect(target).toBe("blocked");
  });

  it("max_retries: 5 but all 5 loops used — should block on missing fields", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result"],
        retry: { back_to: "some_stage", max_retries: 5 },
      },
    });
    const state = buildAgentState("nextStage", "prev", stage);
    const handlers = getOnDoneHandlers(state);

    const context = makeContext({ retryCount: 2, qaRetryCount: 5 });
    const event = { output: { resultText: JSON.stringify({ wrong: true }) } };

    const { target } = evaluateGuards(handlers, event, context);
    expect(target).not.toBe("nextStage");
    expect(target).toBe("blocked");
  });

  it("default max_retries (undefined -> 2) with both loops exhausted", () => {
    const stage = makeAgentStage({
      runtime: {
        engine: "llm",
        system_prompt: "do stuff",
        writes: ["result"],
        retry: { back_to: "some_stage" }, // max_retries defaults to 2
      },
    });
    const state = buildAgentState("nextStage", "prev", stage);
    const handlers = getOnDoneHandlers(state);

    // Default max_retries is 2, so qaRetryCount >= 2 exhausts QA guard
    const context = makeContext({ retryCount: 2, qaRetryCount: 2 });
    const event = { output: { resultText: JSON.stringify({ notResult: "x" }) } };

    const { target } = evaluateGuards(handlers, event, context);
    expect(target).not.toBe("nextStage");
    expect(target).toBe("blocked");
  });
});
