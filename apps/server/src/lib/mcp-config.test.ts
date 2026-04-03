import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./config-loader.js", () => ({
  loadMcpRegistry: vi.fn(),
  buildMcpFromRegistry: vi.fn(),
}));

vi.mock("./logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { buildMcpServers } from "./mcp-config.js";
import { loadMcpRegistry, buildMcpFromRegistry } from "./config-loader.js";

const mockLoadMcpRegistry = vi.mocked(loadMcpRegistry);
const mockBuildMcpFromRegistry = vi.mocked(buildMcpFromRegistry);

describe("buildMcpServers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns empty object when no services requested", () => {
    mockLoadMcpRegistry.mockReturnValue(null);
    const result = buildMcpServers([]);
    expect(result).toEqual({});
  });

  it("uses registry config when available", () => {
    mockLoadMcpRegistry.mockReturnValue({
      notion: { command: "npx", args: ["-y", "@notionhq/notion-mcp-server"] },
    });
    mockBuildMcpFromRegistry.mockReturnValue({
      command: "npx",
      args: ["-y", "@notionhq/notion-mcp-server"],
    });

    const result = buildMcpServers(["notion"]);
    expect(result.notion).toBeDefined();
    expect(result.notion.command).toBe("npx");
    expect(mockBuildMcpFromRegistry).toHaveBeenCalled();
  });

  it("skips service when registry is null", () => {
    mockLoadMcpRegistry.mockReturnValue(null);
    const result = buildMcpServers(["context7"]);
    expect(result.context7).toBeUndefined();
  });

  it("skips service when registry entry build returns null", () => {
    mockLoadMcpRegistry.mockReturnValue({
      context7: { command: "npx" },
    });
    mockBuildMcpFromRegistry.mockReturnValue(null);

    const result = buildMcpServers(["context7"]);
    expect(result.context7).toBeUndefined();
  });

  it("skips unknown services not in registry", () => {
    mockLoadMcpRegistry.mockReturnValue({
      notion: { command: "npx" },
    });

    const result = buildMcpServers(["unknown-mcp"]);
    expect(result["unknown-mcp"]).toBeUndefined();
  });

  it("uses gemini-specific registry entry when engine is gemini", () => {
    const geminiEntry = { command: "gemini-npx", args: ["gemini-pkg"] };
    mockLoadMcpRegistry.mockReturnValue({
      notion: {
        command: "npx",
        args: ["default-pkg"],
        gemini: geminiEntry,
      },
    });

    mockBuildMcpFromRegistry.mockImplementation((_name, entry) => {
      if (entry === geminiEntry) {
        return { command: "gemini-npx", args: ["gemini-pkg"] };
      }
      return { command: "npx", args: ["default-pkg"] };
    });

    const result = buildMcpServers(["notion"], "gemini");
    expect(result.notion.command).toBe("gemini-npx");
  });

  it("falls back to default registry entry when engine is claude", () => {
    mockLoadMcpRegistry.mockReturnValue({
      notion: {
        command: "npx",
        args: ["claude-pkg"],
        gemini: { command: "gemini-npx", args: ["gemini-pkg"] },
      },
    });

    mockBuildMcpFromRegistry.mockReturnValue({
      command: "npx",
      args: ["claude-pkg"],
    });

    const result = buildMcpServers(["notion"], "claude");
    expect(result.notion.command).toBe("npx");
    expect(result.notion.args).toEqual(["claude-pkg"]);
  });

  it("accepts codex as engine parameter without error", () => {
    mockLoadMcpRegistry.mockReturnValue(null);
    expect(() => buildMcpServers([], "codex")).not.toThrow();
  });

  it("builds configs for multiple services from registry", () => {
    mockLoadMcpRegistry.mockReturnValue({
      notion: { command: "npx", args: ["notion-pkg"] },
      context7: { command: "npx", args: ["context7-pkg"] },
    });
    mockBuildMcpFromRegistry.mockImplementation((_name, entry) => ({
      command: (entry as any).command,
      args: (entry as any).args,
    }));

    const result = buildMcpServers(["notion", "context7"]);
    expect(Object.keys(result)).toHaveLength(2);
    expect(result.notion).toBeDefined();
    expect(result.context7).toBeDefined();
  });
});
