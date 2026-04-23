// P5.3 / D7 — pure helper tests for rate-limit backoff.

import { describe, it, expect } from "vitest";
import {
  shouldPause,
  rateLimitBackoffMs,
  RATE_LIMIT_UTIL_THRESHOLD,
  RATE_LIMIT_BASE_MS,
  RATE_LIMIT_MAX_MS,
} from "./rate-limit-backoff.js";

describe("rate-limit-backoff: pure helpers", () => {
  describe("shouldPause", () => {
    it("true when utilization at threshold", () => {
      expect(shouldPause({ utilization: RATE_LIMIT_UTIL_THRESHOLD })).toBe(true);
    });
    it("true when utilization above threshold", () => {
      expect(shouldPause({ utilization: 0.95 })).toBe(true);
    });
    it("false when utilization below threshold", () => {
      expect(shouldPause({ utilization: 0.5 })).toBe(false);
    });
    it("false when utilization at 0", () => {
      expect(shouldPause({ utilization: 0 })).toBe(false);
    });
  });

  describe("rateLimitBackoffMs", () => {
    it("1st signal = base (500ms)", () => {
      expect(rateLimitBackoffMs(1)).toBe(RATE_LIMIT_BASE_MS);
    });
    it("2nd signal = 2x base (1000ms)", () => {
      expect(rateLimitBackoffMs(2)).toBe(RATE_LIMIT_BASE_MS * 2);
    });
    it("3rd signal = 4x base (2000ms)", () => {
      expect(rateLimitBackoffMs(3)).toBe(RATE_LIMIT_BASE_MS * 4);
    });
    it("caps at max (30s)", () => {
      expect(rateLimitBackoffMs(100)).toBe(RATE_LIMIT_MAX_MS);
    });
    it("0th signal treated as 1st", () => {
      expect(rateLimitBackoffMs(0)).toBe(RATE_LIMIT_BASE_MS);
    });
    it("negative treated as 1st", () => {
      expect(rateLimitBackoffMs(-3)).toBe(RATE_LIMIT_BASE_MS);
    });
  });
});
