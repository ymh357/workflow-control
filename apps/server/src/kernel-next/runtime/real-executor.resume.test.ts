// M-R5: unit tests for SDK session-resume helpers. Integration-style
// tests that exercise RealStageExecutor end-to-end live alongside
// real-executor.test.ts; this file covers only the pure helpers so the
// regression can pin down regressions in the math without spinning up
// a full queryFn mock harness.

import { describe, it, expect } from "vitest";
import { clampMaxTurns, parseNumTurnsFromStream } from "./real-executor.js";

describe("clampMaxTurns", () => {
  it("returns configured when no prior turns have been used", () => {
    expect(clampMaxTurns(30, 0)).toBe(30);
  });

  it("subtracts prior turns from the configured budget", () => {
    expect(clampMaxTurns(30, 10)).toBe(20);
  });

  it("floors at 1 when prior turns exhaust the budget", () => {
    expect(clampMaxTurns(30, 29)).toBe(1);
    expect(clampMaxTurns(30, 30)).toBe(1);
  });

  it("floors at 1 when prior exceeds configured (e.g. SDK system turns on resume)", () => {
    expect(clampMaxTurns(30, 100)).toBe(1);
  });
});

describe("parseNumTurnsFromStream", () => {
  it("returns 0 for null / empty", () => {
    expect(parseNumTurnsFromStream(null)).toBe(0);
    expect(parseNumTurnsFromStream(undefined)).toBe(0);
    expect(parseNumTurnsFromStream("")).toBe(0);
    expect(parseNumTurnsFromStream("[]")).toBe(0);
  });

  it("sums num_turns from result messages", () => {
    const stream = JSON.stringify([
      { type: "result", num_turns: 5 },
      { type: "assistant" },
      { type: "result", num_turns: 3 },
    ]);
    expect(parseNumTurnsFromStream(stream)).toBe(8);
  });

  it("ignores result messages without a numeric num_turns", () => {
    const stream = JSON.stringify([
      { type: "result", num_turns: "seven" },
      { type: "result" },
      { type: "result", num_turns: 2 },
    ]);
    expect(parseNumTurnsFromStream(stream)).toBe(2);
  });

  it("returns 0 for non-JSON input", () => {
    expect(parseNumTurnsFromStream("not json")).toBe(0);
  });

  it("returns 0 when the JSON is not an array", () => {
    expect(parseNumTurnsFromStream('{"foo":1}')).toBe(0);
  });
});
