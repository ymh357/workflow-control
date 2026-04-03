import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  loadSystemSettings,
  clearSettingsCache,
  getNestedValue,
  interpolateEnvVar,
  interpolateObject,
} from "./settings.js";

// Mock node:fs
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

import { readFileSync, existsSync } from "node:fs";

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);

// ---------- getNestedValue ----------

describe("getNestedValue", () => {
  it("returns value for simple key", () => {
    expect(getNestedValue({ foo: "bar" }, "foo")).toBe("bar");
  });

  it("returns value for nested key", () => {
    expect(getNestedValue({ a: { b: { c: 42 } } }, "a.b.c")).toBe(42);
  });

  it("returns undefined for missing key", () => {
    expect(getNestedValue({ a: 1 }, "b")).toBeUndefined();
  });

  it("returns undefined for deeply missing key", () => {
    expect(getNestedValue({ a: { b: 1 } }, "a.c.d")).toBeUndefined();
  });

  it("returns undefined for null obj", () => {
    expect(getNestedValue(null, "a")).toBeUndefined();
  });

  it("returns undefined for undefined obj", () => {
    expect(getNestedValue(undefined, "a")).toBeUndefined();
  });

  it("returns undefined for empty path", () => {
    expect(getNestedValue({ a: 1 }, "")).toBeUndefined();
  });
});

// ---------- interpolateEnvVar ----------

describe("interpolateEnvVar", () => {
  beforeEach(() => {
    process.env.TEST_VAR = "hello";
  });

  afterEach(() => {
    delete process.env.TEST_VAR;
  });

  it("replaces ${VAR} with env value", () => {
    expect(interpolateEnvVar("value is ${TEST_VAR}")).toBe("value is hello");
  });

  it("uses default when env var is missing", () => {
    expect(interpolateEnvVar("${MISSING_VAR:-fallback}")).toBe("fallback");
  });

  it("returns MISSING sentinel when no default and var missing", () => {
    const result = interpolateEnvVar("${TOTALLY_MISSING}");
    expect(result).toContain("\0MISSING\0");
  });

  it("leaves plain strings unchanged", () => {
    expect(interpolateEnvVar("no interpolation")).toBe("no interpolation");
  });

  it("returns empty string for empty input", () => {
    expect(interpolateEnvVar("")).toBe("");
  });

  it("handles multiple replacements", () => {
    process.env.A = "x";
    process.env.B = "y";
    expect(interpolateEnvVar("${A}-${B}")).toBe("x-y");
    delete process.env.A;
    delete process.env.B;
  });
});

// ---------- interpolateObject ----------

describe("interpolateObject", () => {
  beforeEach(() => {
    process.env.INTERP_TEST = "resolved";
  });

  afterEach(() => {
    delete process.env.INTERP_TEST;
  });

  it("interpolates string values in objects", () => {
    const result = interpolateObject({ key: "${INTERP_TEST}" });
    expect(result.key).toBe("resolved");
  });

  it("interpolates nested objects", () => {
    const result = interpolateObject({ a: { b: "${INTERP_TEST}" } });
    expect(result.a.b).toBe("resolved");
  });

  it("interpolates arrays", () => {
    const result = interpolateObject(["${INTERP_TEST}", "plain"]);
    expect(result).toEqual(["resolved", "plain"]);
  });

  it("replaces missing vars with undefined", () => {
    const result = interpolateObject({ key: "${COMPLETELY_MISSING_VAR}" });
    expect(result.key).toBeUndefined();
  });

  it("passes through non-string primitives", () => {
    const result = interpolateObject({ num: 42, bool: true, nil: null });
    expect(result).toEqual({ num: 42, bool: true, nil: null });
  });
});

// ---------- loadSystemSettings ----------

describe("loadSystemSettings", () => {
  beforeEach(() => {
    clearSettingsCache();
    vi.resetAllMocks();
  });

  afterEach(() => {
    clearSettingsCache();
  });

  it("returns defaults when settings file does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    const settings = loadSystemSettings();

    expect(settings.paths).toBeDefined();
    expect(settings.paths!.claude_executable).toBeDefined();
    expect(settings.agent).toBeDefined();
    expect(settings.agent!.default_engine).toBe("claude");
  });

  it("merges YAML config over defaults", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      'paths:\n  repos_base: "/custom/repos"\nagent:\n  max_budget_usd: 25\n',
    );

    const settings = loadSystemSettings();
    expect(settings.paths!.repos_base).toBe("/custom/repos");
    expect(settings.agent!.max_budget_usd).toBe(25);
    // Defaults still present
    expect(settings.paths!.claude_executable).toBeDefined();
  });

  it("handles malformed YAML gracefully", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      throw new Error("yaml parse error");
    });

    const settings = loadSystemSettings();
    // Should return defaults
    expect(settings.paths).toBeDefined();
  });

  it("caches result and returns same object on subsequent call", () => {
    mockExistsSync.mockReturnValue(false);
    const first = loadSystemSettings();
    const second = loadSystemSettings();
    expect(first).toBe(second);
    // existsSync should be called only once because of cache
    expect(mockExistsSync).toHaveBeenCalledTimes(1);
  });

  it("returns fresh result after clearSettingsCache", () => {
    mockExistsSync.mockReturnValue(false);
    const first = loadSystemSettings();
    clearSettingsCache();
    const second = loadSystemSettings();
    expect(first).not.toBe(second);
  });

  it("reads SETTING_* env vars into settings", () => {
    mockExistsSync.mockReturnValue(false);
    process.env.SETTING_NOTION_TOKEN = "secret-token";
    try {
      clearSettingsCache();
      const settings = loadSystemSettings();
      expect(settings.notion?.token).toBe("secret-token");
    } finally {
      delete process.env.SETTING_NOTION_TOKEN;
    }
  });

  it("YAML values override core defaults", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      'slack:\n  bot_token: "yaml-token"\n',
    );

    const settings = loadSystemSettings();
    expect(settings.slack!.bot_token).toBe("yaml-token");
  });
});

// ---------- clearSettingsCache ----------

describe("clearSettingsCache", () => {
  it("does not throw when called with no cache", () => {
    expect(() => clearSettingsCache()).not.toThrow();
  });
});
