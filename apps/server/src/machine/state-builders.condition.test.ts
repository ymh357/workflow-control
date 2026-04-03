/**
 * Tests for buildConditionState — verifies actual expr-eval expression evaluation,
 * NOT mocked. These tests exercise the guard functions directly.
 */

import { describe, it, expect, vi } from "vitest";
import type { WorkflowContext } from "./types.js";
import type { ConditionStageConfig } from "../lib/config-loader.js";

vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("./helpers.js", () => ({
  statusEntry: () => [],
}));

vi.mock("../lib/config-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/config-loader.js")>();
  return { ...actual };
});

const { buildConditionState } = await import("./state-builders.js");

function makeContext(store: Record<string, any> = {}): WorkflowContext {
  return {
    taskId: "cond-test", status: "running",
    retryCount: 0, qaRetryCount: 0, stageSessionIds: {}, store,
  };
}

function makeConditionStage(branches: Array<{ when?: string; default?: true; to: string }>): ConditionStageConfig {
  return {
    name: "route",
    type: "condition",
    runtime: { engine: "condition" as const, branches },
  };
}

function extractGuards(state: Record<string, unknown>): Array<{ guard?: (args: { context: WorkflowContext }) => boolean; target: string }> {
  return (state.always as any[]).map((t: any) => ({
    guard: t.guard,
    target: t.target,
  }));
}

describe("buildConditionState — real expr-eval evaluation", () => {
  it("boolean equality: store.passed == true", () => {
    const stage = makeConditionStage([
      { when: "store.passed == true", to: "yes" },
      { default: true, to: "no" },
    ]);
    const state = buildConditionState("next", "prev", stage);
    const guards = extractGuards(state);

    expect(guards[0].guard!({ context: makeContext({ passed: true }) })).toBe(true);
    expect(guards[0].guard!({ context: makeContext({ passed: false }) })).toBe(false);
  });

  it("numeric comparison: store.score > 80", () => {
    const stage = makeConditionStage([
      { when: "store.score > 80", to: "high" },
      { default: true, to: "low" },
    ]);
    const guards = extractGuards(buildConditionState("next", "prev", stage));

    expect(guards[0].guard!({ context: makeContext({ score: 90 }) })).toBe(true);
    expect(guards[0].guard!({ context: makeContext({ score: 80 }) })).toBe(false);
    expect(guards[0].guard!({ context: makeContext({ score: 50 }) })).toBe(false);
  });

  it("string equality: store.status == 'approved'", () => {
    const stage = makeConditionStage([
      { when: "store.status == 'approved'", to: "go" },
      { default: true, to: "wait" },
    ]);
    const guards = extractGuards(buildConditionState("next", "prev", stage));

    expect(guards[0].guard!({ context: makeContext({ status: "approved" }) })).toBe(true);
    expect(guards[0].guard!({ context: makeContext({ status: "pending" }) })).toBe(false);
  });

  it("nested property access: store.analysis.passed", () => {
    const stage = makeConditionStage([
      { when: "store.analysis.passed == true", to: "yes" },
      { default: true, to: "no" },
    ]);
    const guards = extractGuards(buildConditionState("next", "prev", stage));

    expect(guards[0].guard!({ context: makeContext({ analysis: { passed: true } }) })).toBe(true);
    expect(guards[0].guard!({ context: makeContext({ analysis: { passed: false } }) })).toBe(false);
  });

  it("and operator: store.a == true and store.b > 5", () => {
    const stage = makeConditionStage([
      { when: "store.a == true and store.b > 5", to: "both" },
      { default: true, to: "not" },
    ]);
    const guards = extractGuards(buildConditionState("next", "prev", stage));

    expect(guards[0].guard!({ context: makeContext({ a: true, b: 10 }) })).toBe(true);
    expect(guards[0].guard!({ context: makeContext({ a: true, b: 3 }) })).toBe(false);
    expect(guards[0].guard!({ context: makeContext({ a: false, b: 10 }) })).toBe(false);
  });

  it("or operator: store.x == 1 or store.x == 2", () => {
    const stage = makeConditionStage([
      { when: "store.x == 1 or store.x == 2", to: "match" },
      { default: true, to: "no" },
    ]);
    const guards = extractGuards(buildConditionState("next", "prev", stage));

    expect(guards[0].guard!({ context: makeContext({ x: 1 }) })).toBe(true);
    expect(guards[0].guard!({ context: makeContext({ x: 2 }) })).toBe(true);
    expect(guards[0].guard!({ context: makeContext({ x: 3 }) })).toBe(false);
  });

  it("undefined property returns false (not throws)", () => {
    const stage = makeConditionStage([
      { when: "store.nonexistent.deep == true", to: "y" },
      { default: true, to: "n" },
    ]);
    const guards = extractGuards(buildConditionState("next", "prev", stage));

    // Should not throw, should return false
    expect(guards[0].guard!({ context: makeContext({}) })).toBe(false);
  });

  it("default branch has no guard", () => {
    const stage = makeConditionStage([
      { when: "store.x == 1", to: "a" },
      { default: true, to: "b" },
    ]);
    const guards = extractGuards(buildConditionState("next", "prev", stage));

    expect(guards[0].guard).toBeDefined();
    expect(guards[1].guard).toBeUndefined();
    expect(guards[1].target).toBe("b");
  });

  it("first matching branch wins (order matters)", () => {
    const stage = makeConditionStage([
      { when: "store.x > 0", to: "first" },
      { when: "store.x > 5", to: "second" },
      { default: true, to: "default" },
    ]);
    const guards = extractGuards(buildConditionState("next", "prev", stage));

    // x=10 matches both, but first guard wins
    const ctx = makeContext({ x: 10 });
    expect(guards[0].guard!({ context: ctx })).toBe(true);
    // In XState always transitions, the first matching transition is taken
  });

  it("not-equal: store.status != 'error'", () => {
    const stage = makeConditionStage([
      { when: "store.status != 'error'", to: "ok" },
      { default: true, to: "bad" },
    ]);
    const guards = extractGuards(buildConditionState("next", "prev", stage));

    expect(guards[0].guard!({ context: makeContext({ status: "ok" }) })).toBe(true);
    expect(guards[0].guard!({ context: makeContext({ status: "error" }) })).toBe(false);
  });

  it("arithmetic expression: store.x + 5 > 10", () => {
    const stage = makeConditionStage([
      { when: "store.x + 5 > 10", to: "yes" },
      { default: true, to: "no" },
    ]);
    const guards = extractGuards(buildConditionState("next", "prev", stage));

    expect(guards[0].guard!({ context: makeContext({ x: 6 }) })).toBe(true);  // 6+5=11 > 10
    expect(guards[0].guard!({ context: makeContext({ x: 5 }) })).toBe(false); // 5+5=10, not > 10
    expect(guards[0].guard!({ context: makeContext({ x: 10 }) })).toBe(true); // 10+5=15 > 10
  });

  it("implicit boolean: truthy/falsy store.flag", () => {
    const stage = makeConditionStage([
      { when: "store.flag", to: "yes" },
      { default: true, to: "no" },
    ]);
    const guards = extractGuards(buildConditionState("next", "prev", stage));

    expect(guards[0].guard!({ context: makeContext({ flag: true }) })).toBe(true);
    expect(guards[0].guard!({ context: makeContext({ flag: 1 }) })).toBe(true);
    expect(guards[0].guard!({ context: makeContext({ flag: "yes" }) })).toBe(true);
    expect(guards[0].guard!({ context: makeContext({ flag: false }) })).toBe(false);
    expect(guards[0].guard!({ context: makeContext({ flag: 0 }) })).toBe(false);
    expect(guards[0].guard!({ context: makeContext({ flag: "" }) })).toBe(false);
  });

  it("missing property falls back to default (guard returns false)", () => {
    // expr-eval doesn't support `undefined` as a literal, so missing properties
    // cause evaluation to fail and the guard returns false, falling through to default.
    const stage = makeConditionStage([
      { when: "store.x > 0", to: "exists" },
      { default: true, to: "missing" },
    ]);
    const guards = extractGuards(buildConditionState("next", "prev", stage));

    // When store.x is not set, expression fails → guard returns false → default branch taken
    expect(guards[0].guard!({ context: makeContext({}) })).toBe(false);
    // When store.x exists and satisfies condition
    expect(guards[0].guard!({ context: makeContext({ x: 5 }) })).toBe(true);
    // When store.x is 0 (falsy but defined)
    expect(guards[0].guard!({ context: makeContext({ x: 0 }) })).toBe(false);
  });

  it("falsy values: store.count == 0", () => {
    const stage = makeConditionStage([
      { when: "store.count == 0", to: "zero" },
      { default: true, to: "nonzero" },
    ]);
    const guards = extractGuards(buildConditionState("next", "prev", stage));

    expect(guards[0].guard!({ context: makeContext({ count: 0 }) })).toBe(true);
    expect(guards[0].guard!({ context: makeContext({ count: 1 }) })).toBe(false);
  });

  it("invalid expression syntax falls back to false (not throws)", () => {
    const stage = makeConditionStage([
      { when: "store.x +++ y !!!", to: "bad" },
      { default: true, to: "fallback" },
    ]);
    const guards = extractGuards(buildConditionState("next", "prev", stage));

    // Invalid syntax → parser.parse throws → guard returns false → fallback taken
    expect(guards[0].guard!({ context: makeContext({ x: 1 }) })).toBe(false);
  });

  it("empty when expression falls back to false", () => {
    const stage = makeConditionStage([
      { when: "", to: "empty" },
      { default: true, to: "fallback" },
    ]);
    const guards = extractGuards(buildConditionState("next", "prev", stage));

    expect(guards[0].guard!({ context: makeContext({}) })).toBe(false);
  });

  it("no default branch adds fallback to blocked", () => {
    const stage: ConditionStageConfig = {
      name: "route",
      type: "condition",
      runtime: {
        engine: "condition" as const,
        branches: [{ when: "store.x == 1", to: "a" }],
      },
    };
    const state = buildConditionState("next", "prev", stage);
    const transitions = state.always as any[];

    // Last transition should have no guard (fallback) and target "blocked"
    const lastTransition = transitions[transitions.length - 1];
    expect(lastTransition.guard).toBeUndefined();
    expect(lastTransition.target).toBe("blocked");
  });

  it("array truthiness: non-empty array is truthy", () => {
    const stage = makeConditionStage([
      { when: "store.items", to: "has" },
      { default: true, to: "empty" },
    ]);
    const guards = extractGuards(buildConditionState("next", "prev", stage));

    expect(guards[0].guard!({ context: makeContext({ items: ["a", "b"] }) })).toBe(true);
    expect(guards[0].guard!({ context: makeContext({ items: [] }) })).toBe(true); // empty array is truthy in JS
  });

  it("nested array truthiness: store.config.items", () => {
    const stage = makeConditionStage([
      { when: "store.config.items", to: "has" },
      { default: true, to: "empty" },
    ]);
    const guards = extractGuards(buildConditionState("next", "prev", stage));

    expect(guards[0].guard!({ context: makeContext({ config: { items: ["Monad Bridge"] } }) })).toBe(true);
    expect(guards[0].guard!({ context: makeContext({ config: { items: [] } }) })).toBe(true);
    // Missing property falls through to default
    expect(guards[0].guard!({ context: makeContext({ config: {} }) })).toBe(false);
    expect(guards[0].guard!({ context: makeContext({}) })).toBe(false);
  });

  it("&& operator is NOT supported by expr-eval (falls back to false)", () => {
    const stage = makeConditionStage([
      { when: "store.a == true && store.b == true", to: "both" },
      { default: true, to: "fallback" },
    ]);
    const guards = extractGuards(buildConditionState("next", "prev", stage));

    // && is not valid expr-eval syntax, parse fails, guard returns false
    expect(guards[0].guard!({ context: makeContext({ a: true, b: true }) })).toBe(false);
  });

  it("no default branch with custom blockedTarget", () => {
    const stage: ConditionStageConfig = {
      name: "route",
      type: "condition",
      runtime: {
        engine: "condition" as const,
        branches: [{ when: "store.x == 1", to: "a" }],
      },
    };
    const state = buildConditionState("next", "prev", stage, { blockedTarget: "error" });
    const transitions = state.always as any[];

    const lastTransition = transitions[transitions.length - 1];
    expect(lastTransition.target).toBe("error");
  });
});
