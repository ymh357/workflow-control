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
import { loadMcpRegistry, buildMcpFromRegistry } from "./mcp.js";
import type { McpRegistryEntry } from "./types.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockInterpolateEnvVar = vi.mocked(interpolateEnvVar);

beforeEach(() => {
  vi.clearAllMocks();
  mockInterpolateEnvVar.mockImplementation((val: string) => val);
});

// ---------- loadMcpRegistry ----------

describe("loadMcpRegistry", () => {
  it("returns null when registry file does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(loadMcpRegistry()).toBeNull();
  });

  it("returns parsed YAML when file exists", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      "github:\n  command: npx\n  args:\n    - github-mcp\n",
    );
    const result = loadMcpRegistry();
    expect(result).toEqual({
      github: { command: "npx", args: ["github-mcp"] },
    });
  });

  it("returns null and logs warning on parse error", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => { throw new Error("bad yaml"); });
    expect(loadMcpRegistry()).toBeNull();
  });
});

// ---------- buildMcpFromRegistry ----------

describe("buildMcpFromRegistry", () => {
  it("returns null when entry has no command", () => {
    const entry: McpRegistryEntry = {};
    expect(buildMcpFromRegistry("test", entry)).toBeNull();
  });

  it("returns basic config with command and args", () => {
    const entry: McpRegistryEntry = {
      command: "npx",
      args: ["-y", "@mcp/server"],
    };
    const result = buildMcpFromRegistry("test", entry);
    expect(result).toEqual({
      command: "npx",
      args: ["-y", "@mcp/server"],
    });
  });

  it("returns config without args when none provided", () => {
    const entry: McpRegistryEntry = { command: "my-server" };
    const result = buildMcpFromRegistry("test", entry);
    expect(result).toEqual({ command: "my-server" });
  });

  it("interpolates string env values", () => {
    mockInterpolateEnvVar.mockReturnValue("resolved-token");
    const entry: McpRegistryEntry = {
      command: "server",
      env: { API_TOKEN: "${MY_TOKEN}" },
    };
    const result = buildMcpFromRegistry("test", entry);
    expect(result).toEqual({
      command: "server",
      env: { API_TOKEN: "resolved-token" },
    });
  });

  it("returns null when env interpolation has MISSING", () => {
    mockInterpolateEnvVar.mockReturnValue("\0MISSING\0");
    const entry: McpRegistryEntry = {
      command: "server",
      env: { API_TOKEN: "${MISSING_VAR}" },
    };
    expect(buildMcpFromRegistry("test", entry)).toBeNull();
  });

  it("handles json env values by stringifying", () => {
    mockInterpolateEnvVar.mockImplementation((v: string) => v);
    const entry: McpRegistryEntry = {
      command: "server",
      env: {
        CONFIG: { json: { key1: "val1", key2: "val2" } },
      },
    };
    const result = buildMcpFromRegistry("test", entry);
    expect(result!.env!.CONFIG).toBe(JSON.stringify({ key1: "val1", key2: "val2" }));
  });

  it("returns null when json env value has MISSING", () => {
    mockInterpolateEnvVar.mockImplementation((v: string) =>
      v === "val1" ? "\0MISSING\0" : v,
    );
    const entry: McpRegistryEntry = {
      command: "server",
      env: {
        CONFIG: { json: { key1: "val1", key2: "val2" } },
      },
    };
    expect(buildMcpFromRegistry("test", entry)).toBeNull();
  });

  it("omits env from result when entry has no env", () => {
    const entry: McpRegistryEntry = { command: "server" };
    const result = buildMcpFromRegistry("test", entry);
    expect(result).toEqual({ command: "server" });
    expect(result).not.toHaveProperty("env");
  });
});
