import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  loadSystemSettings,
  clearSettingsCache,
  getNestedValue,
  interpolateEnvVar,
  interpolateObject,
} from "./settings.js";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

import { readFileSync, existsSync } from "node:fs";

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);

describe("getNestedValue adversarial", () => {
  it("handles path with leading dot", () => {
    // ".a" splits to ["", "a"]; obj[""] is undefined
    expect(getNestedValue({ a: 1 }, ".a")).toBeUndefined();
  });

  it("handles path with trailing dot", () => {
    // "a." splits to ["a", ""]; obj.a is 1, then 1[""] is undefined
    expect(getNestedValue({ a: 1 }, "a.")).toBeUndefined();
  });

  it("handles path with consecutive dots", () => {
    expect(getNestedValue({ a: { "": { b: 42 } } }, "a..b")).toBe(42);
  });

  it("returns the whole object for a single key that matches", () => {
    const nested = { x: 1, y: 2 };
    expect(getNestedValue({ data: nested }, "data")).toBe(nested);
  });

  it("handles array values at intermediate path", () => {
    // [1,2,3]["1"] returns 2 in JavaScript
    expect(getNestedValue({ a: [10, 20, 30] }, "a.1")).toBe(20);
  });

  it("handles numeric-like string keys in objects", () => {
    expect(getNestedValue({ "0": "zero" }, "0")).toBe("zero");
  });
});

describe("interpolateEnvVar adversarial", () => {
  afterEach(() => {
    delete process.env.ADV_TEST;
  });

  it("handles env var set to empty string", () => {
    process.env.ADV_TEST = "";
    // Empty string is !== undefined, so it returns ""
    expect(interpolateEnvVar("${ADV_TEST}")).toBe("");
  });

  it("does not interpolate $VAR without braces", () => {
    process.env.ADV_TEST = "value";
    expect(interpolateEnvVar("$ADV_TEST")).toBe("$ADV_TEST");
  });

  it("handles default value with special characters", () => {
    expect(interpolateEnvVar("${MISSING:-https://example.com}")).toBe("https://example.com");
  });

  it("does NOT match empty default value (regex requires at least one char)", () => {
    // The regex :-([^}]+) requires one or more chars for default value
    // So ${MISSING:-} doesn't match the default branch, treated as no default
    expect(interpolateEnvVar("${MISSING:-}")).toBe("${MISSING:-}");
  });

  it("does not process nested interpolation", () => {
    process.env.ADV_TEST = "inner";
    expect(interpolateEnvVar("${MISSING:-${ADV_TEST}}")).toBe("${ADV_TEST}");
    delete process.env.ADV_TEST;
  });

  it("handles template with only the placeholder", () => {
    process.env.ADV_TEST = "full";
    expect(interpolateEnvVar("${ADV_TEST}")).toBe("full");
  });

  it("regex only matches word characters in var name", () => {
    // Hyphen is not \\w, so ${MY-VAR} won't match
    expect(interpolateEnvVar("${MY-VAR}")).toBe("${MY-VAR}");
  });
});

describe("interpolateObject adversarial", () => {
  it("handles null at top level", () => {
    expect(interpolateObject(null)).toBeNull();
  });

  it("handles number at top level", () => {
    expect(interpolateObject(42)).toBe(42);
  });

  it("handles boolean at top level", () => {
    expect(interpolateObject(false)).toBe(false);
  });

  it("handles deeply nested arrays within objects", () => {
    process.env.DEEP_TEST = "found";
    const result = interpolateObject({ a: [{ b: ["${DEEP_TEST}"] }] });
    expect(result.a[0].b[0]).toBe("found");
    delete process.env.DEEP_TEST;
  });

  it("converts MISSING sentinel to undefined in nested objects", () => {
    const result = interpolateObject({ a: { b: "${COMPLETELY_NONEXISTENT}" } });
    expect(result.a.b).toBeUndefined();
  });

  it("handles mixed content: some resolved, some missing", () => {
    process.env.PARTIAL = "yes";
    const result = interpolateObject({
      found: "${PARTIAL}",
      missing: "${NOPE_NOT_HERE}",
    });
    expect(result.found).toBe("yes");
    expect(result.missing).toBeUndefined();
    delete process.env.PARTIAL;
  });
});

describe("loadSystemSettings adversarial", () => {
  beforeEach(() => {
    clearSettingsCache();
    vi.resetAllMocks();
  });

  afterEach(() => {
    clearSettingsCache();
  });

  it("handles YAML that parses to null (empty file)", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("");
    // parseYAML("") returns null, `|| {}` makes it empty
    const settings = loadSystemSettings();
    expect(settings.paths).toBeDefined();
    expect(settings.agent).toBeDefined();
  });

  it("handles YAML with scalar value (non-object)", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("42");
    // parseYAML("42") returns 42, Object.entries(42) yields nothing
    const settings = loadSystemSettings();
    expect(settings.paths).toBeDefined();
  });

  it("SETTING_ env with only one part after prefix is ignored (needs >= 2)", () => {
    mockExistsSync.mockReturnValue(false);
    process.env.SETTING_SINGLE = "value";
    try {
      clearSettingsCache();
      const settings = loadSystemSettings();
      // "SINGLE" splits to ["SINGLE"], length < 2, so ignored
      expect(settings.single).toBeUndefined();
    } finally {
      delete process.env.SETTING_SINGLE;
    }
  });

  it("SETTING_ env with multiple underscores joins key parts", () => {
    mockExistsSync.mockReturnValue(false);
    process.env.SETTING_SECTION_MULTI_PART_KEY = "value";
    try {
      clearSettingsCache();
      const settings = loadSystemSettings();
      expect(settings.section?.multi_part_key).toBe("value");
    } finally {
      delete process.env.SETTING_SECTION_MULTI_PART_KEY;
    }
  });

  it("SETTING_ env with empty value is ignored", () => {
    mockExistsSync.mockReturnValue(false);
    process.env.SETTING_SECTION_KEY = "";
    try {
      clearSettingsCache();
      const settings = loadSystemSettings();
      // Empty string is falsy, so the `&& envVal` check skips it
      expect(settings.section?.key).toBeUndefined();
    } finally {
      delete process.env.SETTING_SECTION_KEY;
    }
  });

  it("YAML section overrides core defaults with shallow merge", () => {
    mockExistsSync.mockReturnValue(true);
    // Only override repos_base; other paths defaults should be preserved
    mockReadFileSync.mockReturnValue('paths:\n  repos_base: "/override"\n');

    const settings = loadSystemSettings();
    expect(settings.paths!.repos_base).toBe("/override");
    // Other paths defaults should still exist via { ...merged[key], ...value }
    expect(settings.paths!.claude_executable).toBeDefined();
  });

  it("YAML non-object value replaces core default section entirely", () => {
    mockExistsSync.mockReturnValue(true);
    // Replace paths with a string
    mockReadFileSync.mockReturnValue("paths: /simple/string\n");

    const settings = loadSystemSettings();
    // typeof value is string, not object, and merged.paths exists
    // But `typeof value === "object"` is false, so falls to else: merged.paths = "/simple/string"
    expect(settings.paths).toBe("/simple/string");
  });

  it("NaN max_budget_usd defaults to 10.0 via Number() || fallback", () => {
    mockExistsSync.mockReturnValue(false);
    const origBudget = process.env.MAX_BUDGET_USD;
    process.env.MAX_BUDGET_USD = "not-a-number";
    try {
      clearSettingsCache();
      const settings = loadSystemSettings();
      // Number("not-a-number") is NaN, NaN || 10.0 = 10.0
      expect(settings.agent!.max_budget_usd).toBe(10.0);
    } finally {
      if (origBudget !== undefined) process.env.MAX_BUDGET_USD = origBudget;
      else delete process.env.MAX_BUDGET_USD;
    }
  });
});
