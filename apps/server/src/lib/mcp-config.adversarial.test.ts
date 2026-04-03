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

beforeEach(() => {
  vi.resetAllMocks();
});

describe("buildMcpServers adversarial", () => {
  it("duplicate service names in array produces single entry", () => {
    mockLoadMcpRegistry.mockReturnValue({
      context7: { command: "npx", args: ["context7-pkg"] },
    });
    mockBuildMcpFromRegistry.mockReturnValue({ command: "npx", args: ["context7-pkg"] });

    const result = buildMcpServers(["context7", "context7"]);
    expect(Object.keys(result)).toHaveLength(1);
    expect(result.context7).toBeDefined();
  });

  it("registry entry exists but buildMcpFromRegistry throws", () => {
    mockLoadMcpRegistry.mockReturnValue({
      context7: { command: "bad" },
    });
    mockBuildMcpFromRegistry.mockImplementation(() => {
      throw new Error("build error");
    });

    expect(() => buildMcpServers(["context7"])).toThrow("build error");
  });

  it("gemini engine with no gemini override falls through to default registry entry", () => {
    mockLoadMcpRegistry.mockReturnValue({
      notion: { command: "npx", args: ["default-pkg"] },
    });
    mockBuildMcpFromRegistry.mockReturnValue({
      command: "npx",
      args: ["default-pkg"],
    });

    const result = buildMcpServers(["notion"], "gemini");
    expect(result.notion.command).toBe("npx");
    expect(result.notion.args).toEqual(["default-pkg"]);
  });

  it("gemini override returns null, falls through to default registry entry", () => {
    const geminiEntry = { command: "gemini-npx" };
    mockLoadMcpRegistry.mockReturnValue({
      notion: {
        command: "npx",
        args: ["default"],
        gemini: geminiEntry,
      },
    });
    mockBuildMcpFromRegistry.mockImplementation((_name, entry) => {
      if (entry === geminiEntry) return null;
      return { command: "npx", args: ["default"] };
    });

    const result = buildMcpServers(["notion"], "gemini");
    expect(result.notion.command).toBe("npx");
    expect(result.notion.args).toEqual(["default"]);
  });

  it("unknown service name not in registry is skipped", () => {
    mockLoadMcpRegistry.mockReturnValue({
      notion: { command: "npx" },
    });

    const result = buildMcpServers(["unknown" as any]);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("multiple services, only those in registry with successful build are included", () => {
    mockLoadMcpRegistry.mockReturnValue({
      notion: { command: "npx", args: ["notion-pkg"] },
      context7: { command: "npx", args: ["context7-pkg"] },
    });
    mockBuildMcpFromRegistry.mockImplementation((_name, entry) => {
      if ((entry as any).args?.[0] === "notion-pkg") return null;
      return { command: "npx", args: (entry as any).args };
    });

    const result = buildMcpServers(["notion", "figma", "context7"]);
    expect(result.notion).toBeUndefined();
    expect(result.figma).toBeUndefined();
    expect(result.context7).toBeDefined();
  });

  // --- Robustness against malformed registry ---

  it("should return empty result when registry is a string (not an object)", () => {
    // loadMcpRegistry might return a bare string if YAML is malformed
    mockLoadMcpRegistry.mockReturnValue("just-a-string" as any);
    // Accessing string["notion"] returns undefined, which is fine,
    // but we should not crash
    expect(() => buildMcpServers(["notion"])).not.toThrow();
    const result = buildMcpServers(["notion"]);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("should return empty result when registry is an array (not an object)", () => {
    mockLoadMcpRegistry.mockReturnValue(["item1", "item2"] as any);
    expect(() => buildMcpServers(["notion"])).not.toThrow();
    const result = buildMcpServers(["notion"]);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("should handle empty services array", () => {
    mockLoadMcpRegistry.mockReturnValue({ notion: { command: "npx" } });
    const result = buildMcpServers([]);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("should handle service name that is a JS prototype property (e.g. 'constructor')", () => {
    mockLoadMcpRegistry.mockReturnValue({});
    // "constructor" exists on every object via prototype
    // registry?.["constructor"] would be truthy — should not cause issues
    expect(() => buildMcpServers(["constructor"])).not.toThrow();
    const result = buildMcpServers(["constructor"]);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("should handle '__proto__' service name safely", () => {
    mockLoadMcpRegistry.mockReturnValue({});
    expect(() => buildMcpServers(["__proto__"])).not.toThrow();
    const result = buildMcpServers(["__proto__"]);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("should handle 'toString' service name safely", () => {
    mockLoadMcpRegistry.mockReturnValue({});
    expect(() => buildMcpServers(["toString"])).not.toThrow();
    const result = buildMcpServers(["toString"]);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("should handle registry being null (no registry.yaml)", () => {
    mockLoadMcpRegistry.mockReturnValue(null);
    const result = buildMcpServers(["notion", "context7"]);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("should not include undefined config values in result", () => {
    mockLoadMcpRegistry.mockReturnValue({
      notion: { command: "npx" },
    });
    mockBuildMcpFromRegistry.mockReturnValue(null);
    const result = buildMcpServers(["notion"]);
    // result.notion should be undefined, not null
    expect(result.notion).toBeUndefined();
    expect("notion" in result).toBe(false);
  });

  it("should handle very large services array without issues", () => {
    mockLoadMcpRegistry.mockReturnValue({
      svc0: { command: "npx" },
    });
    mockBuildMcpFromRegistry.mockReturnValue({ command: "npx" });
    const services = Array.from({ length: 100 }, (_, i) => `svc${i}`);
    const result = buildMcpServers(services);
    // Only svc0 is in registry
    expect(Object.keys(result)).toHaveLength(1);
  });
});
