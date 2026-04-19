import { describe, it, expect } from "vitest";
import { evaluateGuard } from "./guard-evaluator.js";

const ctx = {
  wireFrom: { stage: "A", port: "x" },
  wireTo: { stage: "B", port: "y" },
};

describe("evaluateGuard", () => {
  it("returns true for a passing numeric comparison", () => {
    expect(evaluateGuard("value > 5", 10, ctx)).toBe(true);
  });

  it("returns false for a failing numeric comparison", () => {
    expect(evaluateGuard("value > 5", 3, ctx)).toBe(false);
  });

  it("supports dotted access on object values", () => {
    expect(evaluateGuard("value.complexity > 8", { complexity: 9 }, ctx)).toBe(true);
    expect(evaluateGuard("value.complexity > 8", { complexity: 8 }, ctx)).toBe(false);
  });

  it("supports array .length", () => {
    expect(evaluateGuard("value.length > 0", [1, 2], ctx)).toBe(true);
    expect(evaluateGuard("value.length > 0", [], ctx)).toBe(false);
  });

  it("truthy bindings: strings, objects, numbers", () => {
    expect(evaluateGuard("value", "ok", ctx)).toBe(true);
    expect(evaluateGuard("value", {}, ctx)).toBe(true);
    expect(evaluateGuard("value", 0, ctx)).toBe(false);
    expect(evaluateGuard("value", "", ctx)).toBe(false);
    expect(evaluateGuard("value", null, ctx)).toBe(false);
    expect(evaluateGuard("value", undefined, ctx)).toBe(false);
  });

  it("syntactically invalid expression → false + onError called", () => {
    const errors: unknown[] = [];
    const result = evaluateGuard("value >>> ???", 1, ctx, {
      onError: (e) => errors.push(e),
    });
    expect(result).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it("runtime exception (e.g. property of undefined) → false + onError", () => {
    const errors: unknown[] = [];
    const result = evaluateGuard("value.foo.bar > 1", { foo: null }, ctx, {
      onError: (e) => errors.push(e),
    });
    expect(result).toBe(false);
    expect(errors.length).toBe(1);
  });

  it("non-boolean truthy expression result still returns true (Boolean coerce)", () => {
    expect(evaluateGuard("value + 1", 1, ctx)).toBe(true); // 2
    expect(evaluateGuard("value + 1", -1, ctx)).toBe(false); // 0
  });
});
