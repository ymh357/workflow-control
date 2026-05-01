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
  statSync: vi.fn(),
}));

import { readFileSync, existsSync, statSync } from "node:fs";

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockStatSync = vi.mocked(statSync);

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

  // B6.#16 (2026-04-30 review): pre-fix returned "\0MISSING\0" as a
  // mid-string sentinel that survived into downstream consumers
  // (DBs, shell args). Now leaves the literal placeholder in place;
  // interpolateObject decides field-level "disappear if missing"
  // semantics by detecting a sole-placeholder string.
  it("preserves the ${VAR} placeholder when no default and var missing", () => {
    const result = interpolateEnvVar("${TOTALLY_MISSING}");
    expect(result).toBe("${TOTALLY_MISSING}");
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

  // B6.#16 regression: mid-string missing var must NOT inject NUL
  // bytes into the result. The placeholder is preserved for any
  // downstream consumer that wants to detect it themselves.
  it("preserves ${VAR} in mid-string when var is missing (no NUL injection)", () => {
    const out = interpolateEnvVar("prefix${TOTALLY_MISSING_MID}suffix");
    expect(out).toBe("prefix${TOTALLY_MISSING_MID}suffix");
    expect(out).not.toContain("\0");
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

  // B6.#16 regression: mid-string missing var must NOT cause the
  // entire field to disappear, NOR inject NUL bytes. The field
  // should remain a string with the placeholder visible.
  it("preserves the field as a string when missing var is mid-string (no undefined, no NUL)", () => {
    const result = interpolateObject({ url: "https://${MISSING_HOST_FOO}/api" });
    expect(result.url).toBe("https://${MISSING_HOST_FOO}/api");
    expect(typeof result.url).toBe("string");
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
    expect(settings.agent!.claude_model).toBeDefined();
    expect(typeof settings.agent!.max_budget_usd).toBe("number");
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

  // B6.#15 (2026-04-30 review): pre-fix the cache had a 60s TTL with
  // no invalidator, so a mid-write read returned the pre-edit value
  // for up to a minute. Cache now keys on the YAML mtime, so any
  // disk write busts the cache on the next call.
  it("invalidates cache when system-settings.yaml mtime advances", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("paths: { data_dir: /v1 }");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockStatSync.mockReturnValue({ mtimeMs: 1000 } as any);
    clearSettingsCache();
    const first = loadSystemSettings();
    expect(first.paths?.data_dir).toBe("/v1");

    // Same mtime → still cached (object identity).
    const second = loadSystemSettings();
    expect(second).toBe(first);

    // mtime advances + new file content → cache busts and reads fresh.
    mockReadFileSync.mockReturnValue("paths: { data_dir: /v2 }");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockStatSync.mockReturnValue({ mtimeMs: 2000 } as any);
    const third = loadSystemSettings();
    expect(third).not.toBe(first);
    expect(third.paths?.data_dir).toBe("/v2");
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
      'notion:\n  token: "yaml-token"\n',
    );

    const settings = loadSystemSettings();
    expect(settings.notion!.token).toBe("yaml-token");
  });
});

// ---------- clearSettingsCache ----------

describe("clearSettingsCache", () => {
  it("does not throw when called with no cache", () => {
    expect(() => clearSettingsCache()).not.toThrow();
  });
});
