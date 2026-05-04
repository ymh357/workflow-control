import { describe, it, expect } from "vitest";
import { evaluateThreshold } from "../similarity/threshold.js";

describe("evaluateThreshold", () => {
  const NOW = 1_700_000_000_000;

  it("forming when distinct sessions < 3", () => {
    expect(evaluateThreshold({
      distinctSessionCount: 2, distinctDayCount: 5, suppressedUntil: null,
    }, NOW)).toBe("forming");
  });

  it("forming when distinct days < 2", () => {
    expect(evaluateThreshold({
      distinctSessionCount: 5, distinctDayCount: 1, suppressedUntil: null,
    }, NOW)).toBe("forming");
  });

  it("ripe when both met and not suppressed", () => {
    expect(evaluateThreshold({
      distinctSessionCount: 3, distinctDayCount: 2, suppressedUntil: null,
    }, NOW)).toBe("ripe");
  });

  it("forming when suppressed and now < suppressedUntil", () => {
    expect(evaluateThreshold({
      distinctSessionCount: 5, distinctDayCount: 5,
      suppressedUntil: NOW + 1_000_000,
    }, NOW)).toBe("forming");
  });

  it("ripe when suppression has expired", () => {
    expect(evaluateThreshold({
      distinctSessionCount: 5, distinctDayCount: 5,
      suppressedUntil: NOW - 1_000_000,
    }, NOW)).toBe("ripe");
  });

  it("ripe at exact boundary (sessions=3, days=2)", () => {
    expect(evaluateThreshold({
      distinctSessionCount: 3, distinctDayCount: 2, suppressedUntil: null,
    }, NOW)).toBe("ripe");
  });

  it("forming at sessions=3 days=1 (the day count alone fails)", () => {
    expect(evaluateThreshold({
      distinctSessionCount: 3, distinctDayCount: 1, suppressedUntil: null,
    }, NOW)).toBe("forming");
  });
});
