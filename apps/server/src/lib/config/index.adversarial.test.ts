import { describe, it, expect, vi, beforeEach } from "vitest";

const mockClearSettingsCache = vi.fn();
const mockClearDynamicScriptCache = vi.fn();

vi.mock("./settings.js", () => ({
  clearSettingsCache: (...a: unknown[]) => mockClearSettingsCache(...a),
  CONFIG_DIR: "/fake/config",
  interpolateEnvVar: vi.fn((v: string) => v),
  interpolateObject: vi.fn((v: unknown) => v),
  getNestedValue: vi.fn(),
  loadSystemSettings: vi.fn(() => ({})),
  SystemSettingsSchema: { safeParse: vi.fn() },
}));

vi.mock("../script-loader.js", () => ({
  clearDynamicScriptCache: (...a: unknown[]) => mockClearDynamicScriptCache(...a),
  loadDynamicScript: vi.fn(),
}));

import { clearConfigCache } from "./index.js";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("clearConfigCache error isolation", () => {
  it("clearSettingsCache throws — error propagates and stops subsequent calls", () => {
    mockClearSettingsCache.mockImplementation(() => { throw new Error("settings cache error"); });
    expect(() => clearConfigCache()).toThrow("settings cache error");
  });

  it("clearDynamicScriptCache throws — settings was already called", () => {
    mockClearDynamicScriptCache.mockImplementation(() => { throw new Error("script cache error"); });
    expect(() => clearConfigCache()).toThrow("script cache error");
    expect(mockClearSettingsCache).toHaveBeenCalled();
  });
});

describe("clearConfigCache idempotency", () => {
  it("calling twice — does not throw on second call", () => {
    clearConfigCache();
    expect(() => clearConfigCache()).not.toThrow();
  });

  it("calling ten times — each sub-function called ten times", () => {
    for (let i = 0; i < 10; i++) {
      clearConfigCache();
    }
    expect(mockClearSettingsCache).toHaveBeenCalledTimes(10);
    expect(mockClearDynamicScriptCache).toHaveBeenCalledTimes(10);
  });
});

describe("clearConfigCache call order", () => {
  it("both sub-functions are called in a single invocation", () => {
    clearConfigCache();
    expect(mockClearSettingsCache).toHaveBeenCalledOnce();
    expect(mockClearDynamicScriptCache).toHaveBeenCalledOnce();
  });

  it("sub-functions are called with no arguments", () => {
    clearConfigCache();
    expect(mockClearSettingsCache).toHaveBeenCalledWith();
    expect(mockClearDynamicScriptCache).toHaveBeenCalledWith();
  });

  it("clearConfigCache returns void (undefined)", () => {
    const result = clearConfigCache();
    expect(result).toBeUndefined();
  });
});
