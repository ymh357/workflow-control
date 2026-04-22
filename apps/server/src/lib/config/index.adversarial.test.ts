import { describe, it, expect, vi, beforeEach } from "vitest";

const mockClearSettingsCache = vi.fn();

vi.mock("./settings.js", () => ({
  clearSettingsCache: (...a: unknown[]) => mockClearSettingsCache(...a),
  CONFIG_DIR: "/fake/config",
  interpolateEnvVar: vi.fn((v: string) => v),
  interpolateObject: vi.fn((v: unknown) => v),
  getNestedValue: vi.fn(),
  loadSystemSettings: vi.fn(() => ({})),
  SystemSettingsSchema: { safeParse: vi.fn() },
}));

import { clearConfigCache } from "./index.js";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("clearConfigCache", () => {
  it("clearSettingsCache throws — error propagates", () => {
    mockClearSettingsCache.mockImplementation(() => { throw new Error("settings cache error"); });
    expect(() => clearConfigCache()).toThrow("settings cache error");
  });

  it("calling twice does not throw", () => {
    clearConfigCache();
    expect(() => clearConfigCache()).not.toThrow();
  });

  it("calling ten times — clearSettingsCache called ten times", () => {
    for (let i = 0; i < 10; i++) {
      clearConfigCache();
    }
    expect(mockClearSettingsCache).toHaveBeenCalledTimes(10);
  });

  it("returns void", () => {
    const result = clearConfigCache();
    expect(result).toBeUndefined();
  });
});
