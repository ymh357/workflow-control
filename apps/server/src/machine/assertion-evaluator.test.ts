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
      "len(value.summary) > 10",
      "len(keys(value.solutions)) >= 3",
    ];
    const result = evaluateAssertions("analysis", value, assertions);
    expect(result).toEqual([]);
  });

  it("returns failures for false assertions", () => {
    const value = { summary: "short", solutions: {} };
    const assertions = [
      "len(value.summary) > 200",
      "len(keys(value.solutions)) >= 3",
    ];
    const result = evaluateAssertions("analysis", value, assertions);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      key: "analysis",
      assertion: "len(value.summary) > 200",
      passed: false,
    });
  });

  it("treats expression errors as failures", () => {
    const result = evaluateAssertions("x", { a: 1 }, ["value.nonexistent.deep.path > 0"]);
    expect(result).toHaveLength(1);
    expect(result[0].passed).toBe(false);
  });

  it("handles includes check on strings", () => {
    const value = { summary: "I was unable to complete this task" };
    const result = evaluateAssertions("x", value, [
      "not(includes(value.summary, 'unable'))",
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].passed).toBe(false);
  });

  it("handles undefined value gracefully", () => {
    const result = evaluateAssertions("x", undefined, ["len(value) > 0"]);
    expect(result).toHaveLength(1);
    expect(result[0].passed).toBe(false);
  });

  it("handles array length checks via len()", () => {
    const value = { items: [1, 2, 3] };
    expect(evaluateAssertions("x", value, ["len(value.items) >= 3"])).toEqual([]);
    expect(evaluateAssertions("x", value, ["len(value.items) > 5"])).toHaveLength(1);
  });

  it("handles includes check on arrays", () => {
    const value = { tags: ["typescript", "react", "node"] };
    expect(evaluateAssertions("x", value, ["includes(value.tags, 'react')"])).toEqual([]);
    expect(evaluateAssertions("x", value, ["includes(value.tags, 'python')"])).toHaveLength(1);
  });

  it("fails assertions that reference __proto__ (prototype access is denied)", () => {
    const result = evaluateAssertions("x", { a: 1 }, ["value.__proto__ == null"]);
    expect(result).toHaveLength(1);
    expect(result[0].passed).toBe(false);
  });

  it("fails assertions that reference constructor", () => {
    const result = evaluateAssertions("x", { a: 1 }, ["value.constructor.name == 'Object'"]);
    expect(result).toHaveLength(1);
    expect(result[0].passed).toBe(false);
  });

  it("fails assertions that reference prototype", () => {
    const result = evaluateAssertions("x", { a: 1 }, ["value.prototype != null"]);
    expect(result).toHaveLength(1);
    expect(result[0].passed).toBe(false);
  });

  it("sanitizes __proto__ / constructor keys out of the value tree", () => {
    // Even if an attacker plants these keys in a store value, they're stripped
    // before evaluation — expressions that look them up resolve to undefined.
    const value = { nested: { __proto__: { malicious: true }, ok: 1 } };
    // nested.ok should still be reachable
    expect(evaluateAssertions("x", value, ["value.nested.ok == 1"])).toEqual([]);
  });
});
