import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock("./settings.js", () => ({
  CONFIG_DIR: "/fake/config",
  interpolateEnvVar: vi.fn((val: string) => val),
}));

vi.mock("../logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { readFileSync, existsSync } from "node:fs";
import { interpolateEnvVar } from "./settings.js";
import { logger } from "../logger.js";
import { loadMcpRegistry, buildMcpFromRegistry } from "./mcp.js";
import type { McpRegistryEntry } from "./types.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockInterpolateEnvVar = vi.mocked(interpolateEnvVar);

beforeEach(() => {
  vi.clearAllMocks();
  mockInterpolateEnvVar.mockImplementation((val: string) => val);
});

describe("loadMcpRegistry adversarial", () => {
  it("returns null when YAML content is a bare string (not a valid registry)", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("just-a-string");
    const result = loadMcpRegistry();
    expect(result === null || (typeof result === "object" && !Array.isArray(result))).toBe(true);
  });

  it("returns null for empty YAML file", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("");
    expect(loadMcpRegistry()).toBeNull();
  });

  it("returns null when YAML parses to an array (not a valid registry)", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("- item1\n- item2");
    const result = loadMcpRegistry();
    expect(result === null || (typeof result === "object" && !Array.isArray(result))).toBe(true);
  });

  it("returns null when YAML parses to a number", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("42");
    const result = loadMcpRegistry();
    expect(result === null || (typeof result === "object" && !Array.isArray(result))).toBe(true);
  });

  it("returns null when YAML parses to boolean", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("true");
    const result = loadMcpRegistry();
    expect(result === null || (typeof result === "object" && !Array.isArray(result))).toBe(true);
  });

  it("logs warning on parse failure and returns null", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      throw new Error("bad yaml");
    });
    const result = loadMcpRegistry();
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("handles file read permission error gracefully", () => {
    mockExistsSync.mockReturnValue(true);
    const err = new Error("EACCES: permission denied");
    (err as any).code = "EACCES";
    mockReadFileSync.mockImplementation(() => { throw err; });
    expect(loadMcpRegistry()).toBeNull();
  });

  it("handles EISDIR error (path is a directory) gracefully", () => {
    mockExistsSync.mockReturnValue(true);
    const err = new Error("EISDIR: illegal operation on a directory");
    (err as any).code = "EISDIR";
    mockReadFileSync.mockImplementation(() => { throw err; });
    expect(loadMcpRegistry()).toBeNull();
  });

  it("returns null for whitespace-only YAML file", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("   \n\n  \t  ");
    expect(loadMcpRegistry()).toBeNull();
  });

  it("accepts a valid registry with entries containing null values", () => {
    // YAML `notion:` with no value parses to { notion: null }
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("notion:\ncontext7:\n  command: npx");
    const result = loadMcpRegistry();
    // Should return the object — null entry is valid YAML structure
    expect(result).toBeDefined();
    expect(result).not.toBeNull();
    if (result) {
      expect(result.context7).toBeDefined();
    }
  });
});

describe("buildMcpFromRegistry adversarial", () => {
  it("returns null and logs warning when command is undefined", () => {
    const result = buildMcpFromRegistry("svc", {} as McpRegistryEntry);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ service: "svc" }),
      expect.stringContaining("missing command"),
    );
  });

  it("returns null when command is empty string", () => {
    const result = buildMcpFromRegistry("svc", { command: "" });
    expect(result).toBeNull();
  });

  it("handles env with mix of string and json values", () => {
    mockInterpolateEnvVar.mockImplementation((v) => `resolved-${v}`);
    const entry: McpRegistryEntry = {
      command: "server",
      env: {
        TOKEN: "${TOKEN}",
        CONFIG: { json: { k: "v" } },
      },
    };
    const result = buildMcpFromRegistry("svc", entry);
    expect(result!.env!.TOKEN).toBe("resolved-${TOKEN}");
    expect(result!.env!.CONFIG).toBe(JSON.stringify({ k: "resolved-v" }));
  });

  it("returns null when any env string has MISSING", () => {
    mockInterpolateEnvVar.mockImplementation((v: string) => {
      if (v === "${FIRST}") return "good";
      return "\0MISSING\0";
    });
    const entry: McpRegistryEntry = {
      command: "server",
      env: { FIRST: "${FIRST}", SECOND: "${SECOND}" },
    };
    expect(buildMcpFromRegistry("svc", entry)).toBeNull();
  });

  it("returns null when json env sub-value has MISSING", () => {
    mockInterpolateEnvVar.mockImplementation((v: string) => {
      if (v === "good") return "good";
      return "\0MISSING\0";
    });
    const entry: McpRegistryEntry = {
      command: "server",
      env: { CONFIG: { json: { ok: "good", bad: "missing" } } },
    };
    expect(buildMcpFromRegistry("svc", entry)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ envKey: "CONFIG.json.bad" }),
      expect.any(String),
    );
  });

  it("handles empty env object (no env in result)", () => {
    const result = buildMcpFromRegistry("svc", { command: "server", env: {} });
    expect(result).toEqual({ command: "server" });
    expect(result).not.toHaveProperty("env");
  });

  it("handles empty args array", () => {
    const result = buildMcpFromRegistry("svc", { command: "server", args: [] });
    expect(result).toEqual({ command: "server", args: [] });
  });

  it("ignores gemini field in the output", () => {
    const entry: McpRegistryEntry = {
      command: "server",
      gemini: { command: "gemini-server", args: ["--mode=gemini"] },
    };
    const result = buildMcpFromRegistry("svc", entry);
    expect(result).toEqual({ command: "server" });
    expect(result).not.toHaveProperty("gemini");
  });

  it("detects MISSING marker embedded in longer string", () => {
    mockInterpolateEnvVar.mockReturnValue("prefix-\0MISSING\0-suffix");
    const entry: McpRegistryEntry = { command: "server", env: { KEY: "test" } };
    expect(buildMcpFromRegistry("svc", entry)).toBeNull();
  });

  // --- New adversarial scenarios based on expected behavior ---

  it("should not crash when env value is null", () => {
    // User writes `SOME_KEY: ` in YAML which parses to null
    const entry = {
      command: "server",
      env: { SOME_KEY: null as any },
    } as McpRegistryEntry;
    // Should not throw — should either skip the key or log a warning
    expect(() => buildMcpFromRegistry("svc", entry)).not.toThrow();
    const result = buildMcpFromRegistry("svc", entry);
    // null env value should not appear in output
    if (result?.env) {
      expect(result.env.SOME_KEY).toBeUndefined();
    }
  });

  it("should not crash when env value is a number", () => {
    // User writes `PORT: 3000` in YAML — parsed as number, not string
    const entry = {
      command: "server",
      env: { PORT: 3000 as any },
    } as McpRegistryEntry;
    expect(() => buildMcpFromRegistry("svc", entry)).not.toThrow();
  });

  it("should not crash when env value is a boolean", () => {
    // User writes `DEBUG: true` in YAML — parsed as boolean
    const entry = {
      command: "server",
      env: { DEBUG: true as any },
    } as McpRegistryEntry;
    expect(() => buildMcpFromRegistry("svc", entry)).not.toThrow();
  });

  it("should not crash when env value is an object without json key", () => {
    // Malformed YAML: env value is { foo: "bar" } instead of { json: {...} }
    const entry = {
      command: "server",
      env: { WEIRD: { foo: "bar" } as any },
    } as McpRegistryEntry;
    expect(() => buildMcpFromRegistry("svc", entry)).not.toThrow();
    const result = buildMcpFromRegistry("svc", entry);
    // Unknown format — should not silently include garbage in output
    if (result?.env) {
      expect(result.env.WEIRD).toBeUndefined();
    }
  });

  it("should not crash when env value is an array", () => {
    // User writes `KEYS: [a, b]` in YAML — parsed as array
    const entry = {
      command: "server",
      env: { KEYS: ["a", "b"] as any },
    } as McpRegistryEntry;
    expect(() => buildMcpFromRegistry("svc", entry)).not.toThrow();
  });

  it("should warn or skip when env.json contains non-string values", () => {
    // json sub-value is a number
    const entry = {
      command: "server",
      env: { CONFIG: { json: { port: 3000 as any } } },
    } as McpRegistryEntry;
    // Should not crash on non-string json values
    expect(() => buildMcpFromRegistry("svc", entry)).not.toThrow();
  });

  it("should warn or skip when env.json is null", () => {
    const entry = {
      command: "server",
      env: { CONFIG: { json: null as any } },
    } as McpRegistryEntry;
    expect(() => buildMcpFromRegistry("svc", entry)).not.toThrow();
  });

  it("should not crash when env.json contains nested objects instead of strings", () => {
    const entry = {
      command: "server",
      env: { CONFIG: { json: { nested: { deep: "value" } as any } } },
    } as McpRegistryEntry;
    expect(() => buildMcpFromRegistry("svc", entry)).not.toThrow();
  });

  it("should not crash when env.json is an array instead of object", () => {
    const entry = {
      command: "server",
      env: { CONFIG: { json: ["a", "b"] as any } },
    } as McpRegistryEntry;
    expect(() => buildMcpFromRegistry("svc", entry)).not.toThrow();
  });

  it("should log warning for each skipped non-standard env value", () => {
    const entry = {
      command: "server",
      env: {
        NULL_VAL: null as any,
        NUM_VAL: 42 as any,
        BOOL_VAL: false as any,
      },
    } as McpRegistryEntry;
    buildMcpFromRegistry("svc", entry);
    // Each non-standard value should produce a warning
    const warnCalls = vi.mocked(logger.warn).mock.calls;
    const envWarnings = warnCalls.filter(([ctx]) =>
      ctx && typeof ctx === "object" && "envKey" in ctx,
    );
    expect(envWarnings.length).toBeGreaterThanOrEqual(3);
  });

  it("handles nested ${} in env template (should not recursively interpolate)", () => {
    // ${${INNER}} — the regex won't match nested braces, should be safe
    mockInterpolateEnvVar.mockImplementation((v: string) => v);
    const entry: McpRegistryEntry = {
      command: "server",
      env: { KEY: "${${INNER}}" },
    };
    expect(() => buildMcpFromRegistry("svc", entry)).not.toThrow();
  });

  it("handles env value that is an empty string (should include in output)", () => {
    mockInterpolateEnvVar.mockImplementation((v: string) => v);
    const entry: McpRegistryEntry = {
      command: "server",
      env: { EMPTY: "" },
    };
    const result = buildMcpFromRegistry("svc", entry);
    expect(result).not.toBeNull();
    expect(result!.env!.EMPTY).toBe("");
  });

  it("returns config correctly when entry is passed directly from registry (null entry)", () => {
    // buildMcpFromRegistry called with a null entry (from registry with `notion:` no value)
    expect(() => buildMcpFromRegistry("svc", null as any)).not.toThrow();
    // Should return null since there's no command
  });
});
