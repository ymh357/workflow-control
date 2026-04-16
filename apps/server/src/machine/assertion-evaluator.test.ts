import { describe, it, expect } from "vitest";
import { evaluateAssertions, type AssertionResult } from "./assertion-evaluator.js";

describe("evaluateAssertions", () => {
  it("returns empty array when no assertions defined", () => {
    const result = evaluateAssertions("analysis", { summary: "hello" }, []);
    expect(result).toEqual([]);
  });

  it("passes when all assertions are true", () => {
    const value = { summary: "A long enough summary with details", solutions: { a: 1, b: 2, c: 3 } };
    const assertions = [
      "value.summary && value.summary.length > 10",
      "Object.keys(value.solutions || {}).length >= 3",
    ];
    const result = evaluateAssertions("analysis", value, assertions);
    expect(result).toEqual([]);
  });

  it("returns failures for false assertions", () => {
    const value = { summary: "short", solutions: {} };
    const assertions = [
      "value.summary && value.summary.length > 200",
      "Object.keys(value.solutions || {}).length >= 3",
    ];
    const result = evaluateAssertions("analysis", value, assertions);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      key: "analysis",
      assertion: "value.summary && value.summary.length > 200",
      passed: false,
    });
  });

  it("treats expression errors as failures", () => {
    const result = evaluateAssertions("x", { a: 1 }, ["value.nonexistent.deep.path > 0"]);
    expect(result).toHaveLength(1);
    expect(result[0].passed).toBe(false);
  });

  it("handles string-contains check", () => {
    const value = { summary: "I was unable to complete this task" };
    const result = evaluateAssertions("x", value, [
      "!value.summary.includes('I was unable')",
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].passed).toBe(false);
  });

  it("handles undefined value gracefully", () => {
    const result = evaluateAssertions("x", undefined, ["value.length > 0"]);
    expect(result).toHaveLength(1);
    expect(result[0].passed).toBe(false);
  });
});
