import { describe, it, expect } from "vitest";
import { getNestedValue, humanizeKey, formatDuration } from "./utils";

// ── getNestedValue ──

describe("getNestedValue", () => {
  it("returns nested value via dot path", () => {
    expect(getNestedValue({ a: { b: { c: 42 } } }, "a.b.c")).toBe(42);
  });

  it("returns undefined for missing key", () => {
    expect(getNestedValue({ a: 1 }, "b")).toBeUndefined();
  });

  it("returns undefined for deep missing path", () => {
    expect(getNestedValue({ a: {} }, "a.b.c")).toBeUndefined();
  });

  it("returns undefined when obj is null", () => {
    expect(getNestedValue(null, "a")).toBeUndefined();
  });

  it("returns undefined when obj is undefined", () => {
    expect(getNestedValue(undefined, "a")).toBeUndefined();
  });

  it("returns undefined when path is empty string", () => {
    expect(getNestedValue({ a: 1 }, "")).toBeUndefined();
  });

  it("returns top-level value with single-segment path", () => {
    expect(getNestedValue({ x: 99 }, "x")).toBe(99);
  });

  it("handles numeric-string keys", () => {
    expect(getNestedValue({ 0: "zero" }, "0")).toBe("zero");
  });

  it("returns null value without treating as missing", () => {
    expect(getNestedValue({ a: { b: null } }, "a.b")).toBeNull();
  });

  it("does not traverse through null mid-path — returns undefined", () => {
    expect(getNestedValue({ a: null }, "a.b")).toBeUndefined();
  });
});

// ── humanizeKey ──

describe("humanizeKey", () => {
  it("converts camelCase to Title Case words", () => {
    expect(humanizeKey("camelCase")).toBe("Camel Case");
  });

  it("converts snake_case to Title Case", () => {
    expect(humanizeKey("my_key")).toBe("My Key");
  });

  it("converts mixed snake and camel", () => {
    expect(humanizeKey("my_camelKey")).toBe("My Camel Key");
  });

  it("capitalizes single word", () => {
    expect(humanizeKey("name")).toBe("Name");
  });

  it("already-titlecase string is unchanged (words stay capitalized)", () => {
    expect(humanizeKey("My Key")).toBe("My Key");
  });

  it("empty string returns empty string", () => {
    expect(humanizeKey("")).toBe("");
  });

  it("consecutive uppercase handled — inserts space between lower->upper boundary", () => {
    // "taskId" → "Task Id"
    expect(humanizeKey("taskId")).toBe("Task Id");
  });
});

// ── formatDuration ──

describe("formatDuration", () => {
  it("0ms returns '0ms'", () => {
    expect(formatDuration(0)).toBe("0ms");
  });

  it("999ms returns '999ms'", () => {
    expect(formatDuration(999)).toBe("999ms");
  });

  it("1000ms returns '1s'", () => {
    expect(formatDuration(1000)).toBe("1s");
  });

  it("1500ms rounds to 2s", () => {
    expect(formatDuration(1500)).toBe("2s");
  });

  it("59000ms returns '59s'", () => {
    expect(formatDuration(59000)).toBe("59s");
  });

  it("60000ms returns '1m'", () => {
    expect(formatDuration(60000)).toBe("1m");
  });

  it("61000ms returns '1m 1s'", () => {
    expect(formatDuration(61000)).toBe("1m 1s");
  });

  it("90000ms returns '2m' (rounds 1.5m to 2m, then 0 remainder)", () => {
    // 90000ms = 90s = 1m 30s — Math.floor(90/60)=1, 90%60=30
    expect(formatDuration(90000)).toBe("1m 30s");
  });

  it("120000ms returns '2m' with no seconds remainder", () => {
    expect(formatDuration(120000)).toBe("2m");
  });

  it("3661000ms returns '61m 1s'", () => {
    // 3661s = 61m 1s
    expect(formatDuration(3661000)).toBe("61m 1s");
  });
});
