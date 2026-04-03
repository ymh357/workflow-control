import { describe, it, expect } from "vitest";
import { formatDuration } from "./utils.js";

describe("formatDuration", () => {
  it("returns '0s' for 0ms", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  it("returns '0s' for 999ms (less than 1 second)", () => {
    expect(formatDuration(999)).toBe("0s");
  });

  it("returns '1s' for 1000ms", () => {
    expect(formatDuration(1000)).toBe("1s");
  });

  it("returns '1m 30s' for 90000ms", () => {
    expect(formatDuration(90000)).toBe("1m 30s");
  });

  it("returns '1h' for 3600000ms", () => {
    expect(formatDuration(3600000)).toBe("1h");
  });

  it("returns '1h 1m 1s' for 3661000ms", () => {
    expect(formatDuration(3661000)).toBe("1h 1m 1s");
  });

  it("returns '1d' for 86400000ms", () => {
    expect(formatDuration(86400000)).toBe("1d");
  });

  it("returns '1d 1h 1m 1s' for 90061000ms", () => {
    expect(formatDuration(90061000)).toBe("1d 1h 1m 1s");
  });

  it("returns '0s' for negative numbers", () => {
    expect(formatDuration(-1)).toBe("0s");
  });

  it("returns '0s' for Infinity", () => {
    expect(formatDuration(Infinity)).toBe("0s");
  });

  it("returns '0s' for NaN", () => {
    expect(formatDuration(NaN)).toBe("0s");
  });
});
