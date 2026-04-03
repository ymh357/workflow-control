import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  statSync: vi.fn(),
  readdirSync: vi.fn(() => []),
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => "/usr/bin/claude\n"),
}));

vi.mock("./config-loader.js", () => ({
  loadSystemSettings: vi.fn(() => ({})),
  getNestedValue: vi.fn((obj: any, path: string) => {
    if (!obj || !path) return undefined;
    return path.split(".").reduce((acc: any, part: string) => acc && acc[part], obj);
  }),
}));

vi.mock("./config/mcp.js", () => ({
  loadMcpRegistry: vi.fn(() => null),
  buildMcpFromRegistry: vi.fn(() => null),
}));

vi.mock("../scripts/index.js", () => ({
  scriptRegistry: {
    getAllScripts: vi.fn(() => []),
  },
}));

import { runPreflight, printPreflightResults } from "./preflight.js";
import { loadSystemSettings, getNestedValue } from "./config-loader.js";
import { loadMcpRegistry, buildMcpFromRegistry } from "./config/mcp.js";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { scriptRegistry } from "../scripts/index.js";

const mockLoadSystemSettings = vi.mocked(loadSystemSettings);
const mockGetNestedValue = vi.mocked(getNestedValue);
const mockExecFileSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockLoadMcpRegistry = vi.mocked(loadMcpRegistry);
const mockBuildMcpFromRegistry = vi.mocked(buildMcpFromRegistry);
const mockGetAllScripts = vi.mocked(scriptRegistry.getAllScripts);

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadSystemSettings.mockReturnValue({});
  mockGetNestedValue.mockImplementation((obj: any, path: string) => {
    if (!obj || !path) return undefined;
    return path.split(".").reduce((acc: any, part: string) => acc && acc[part], obj);
  });
  mockExecFileSync.mockReturnValue("/usr/bin/claude\n");
  mockExistsSync.mockReturnValue(false);
  mockReaddirSync.mockReturnValue([]);
  mockLoadMcpRegistry.mockReturnValue(null);
  mockBuildMcpFromRegistry.mockReturnValue(null);
  mockGetAllScripts.mockReturnValue([]);
});

describe("preflight adversarial", () => {
  it("execFileSync timeout for 'which' does not crash preflight", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("Command timed out");
    });

    const { passed, results } = runPreflight();

    const claudeResult = results.find((r) => r.name === "Claude Executable");
    expect(claudeResult?.ok).toBe(false);
    // Should still return results, not throw
    expect(results.length).toBeGreaterThan(0);
  });

  it("non-string value from getNestedValue is displayed via String()", () => {
    const settings = { custom: { count: 42 } };
    mockLoadSystemSettings.mockReturnValue(settings);
    mockGetNestedValue.mockImplementation((obj: any, path: string) => {
      if (path === "custom.count") return 42;
      if (!obj || !path) return undefined;
      return path.split(".").reduce((acc: any, part: string) => acc && acc[part], obj);
    });
    mockGetAllScripts.mockReturnValue([
      { metadata: { id: "s1", name: "s1", requiredSettings: ["custom.count"] }, run: vi.fn() } as any,
    ]);

    const { results } = runPreflight();
    const countResult = results.find((r) => r.name === "Setting: custom.count");
    expect(countResult?.ok).toBe(true);
    expect(countResult?.detail).toBe("42");
  });

  it("MCP with missing credentials is reported but does not fail preflight", () => {
    mockLoadMcpRegistry.mockReturnValue({
      figma: { description: "Figma designs", command: "npx", args: [] },
    });
    mockBuildMcpFromRegistry.mockReturnValue(null);

    const { results } = runPreflight();
    const figmaResult = results.find((r) => r.name === "MCP: figma");
    expect(figmaResult).toBeDefined();
    expect(figmaResult!.ok).toBe(true); // MCP availability is not a hard failure
    expect(figmaResult!.detail).toContain("Missing credentials");
  });

  it("empty MCP registry is handled gracefully", () => {
    mockLoadMcpRegistry.mockReturnValue({});

    const { results } = runPreflight();
    const mcpResults = results.filter((r) => r.name.startsWith("MCP:"));
    expect(mcpResults).toHaveLength(0);
  });

  it("scripts with empty requiredSettings are handled", () => {
    mockGetAllScripts.mockReturnValue([
      { metadata: { id: "s1", name: "s1", requiredSettings: [] }, run: vi.fn() } as any,
    ]);

    expect(() => runPreflight()).not.toThrow();
  });

  it("scripts with undefined requiredSettings are handled", () => {
    mockGetAllScripts.mockReturnValue([
      { metadata: { id: "s1", name: "s1" }, run: vi.fn() } as any,
    ]);

    expect(() => runPreflight()).not.toThrow();
  });

  it("printPreflightResults with empty results uses -Infinity for padEnd (edge case)", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Math.max(...[].map(...)) returns -Infinity
    // padEnd(-Infinity) treats it as 0, so it doesn't crash but produces no padding
    printPreflightResults([]);
    // The function logs header, separator, and footer even with no results
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("readdirSync returning directories without pipeline.yaml are excluded", () => {
    mockExistsSync.mockImplementation((p: any) => {
      const s = p as string;
      if (s.endsWith("pipelines")) return true;
      // pipeline.yaml does NOT exist in any subdirectory
      if (s.endsWith("pipeline.yaml")) return false;
      return false;
    });
    mockReaddirSync.mockReturnValue([
      { name: "empty-dir", isDirectory: () => true, isFile: () => false, isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false, isSymbolicLink: () => false, parentPath: "", path: "" },
    ] as any);

    const { results } = runPreflight();
    const pipelineResult = results.find((r) => r.name === "Pipeline configuration");
    expect(pipelineResult?.ok).toBe(false);
  });
});
