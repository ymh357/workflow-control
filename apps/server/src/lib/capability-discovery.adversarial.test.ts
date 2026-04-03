import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock MCP SDK: use class factories so `new Client()` returns mock instances
const _mockClientInstances: any[] = [];
const _mockTransportInstances: any[] = [];

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn(function (this: any) {
    const inst = _mockClientInstances.shift() ?? {
      connect: vi.fn().mockRejectedValue(new Error("no mock configured")),
      callTool: vi.fn().mockResolvedValue({ content: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    Object.assign(this, inst);
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn(function (this: any) {
    const inst = _mockTransportInstances.shift() ?? {
      close: vi.fn().mockResolvedValue(undefined),
    };
    Object.assign(this, inst);
  }),
}));

vi.mock("./config/settings.js", () => ({
  CONFIG_DIR: "/fake/config",
}));

vi.mock("./logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import { mkdirSync, writeFileSync } from "node:fs";
import { discoverExternalCapabilities, autoInstallSkill, type DiscoveredSkill } from "./capability-discovery.js";

const mockMkdirSync = vi.mocked(mkdirSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

function setupMcpMock(callToolResult: unknown, opts?: { connectThrows?: boolean; closeThrows?: boolean }) {
  const mockClose = opts?.closeThrows ? vi.fn().mockRejectedValue(new Error("close fail")) : vi.fn().mockResolvedValue(undefined);
  const mockConnect = opts?.connectThrows
    ? vi.fn().mockRejectedValue(new Error("connect fail"))
    : vi.fn().mockResolvedValue(undefined);
  const mockCallTool = vi.fn().mockResolvedValue(callToolResult);

  _mockClientInstances.push({
    connect: mockConnect,
    callTool: mockCallTool,
    close: mockClose,
  });

  const mockTransportClose = vi.fn().mockResolvedValue(undefined);
  _mockTransportInstances.push({ close: mockTransportClose });

  return { mockConnect, mockCallTool, mockClose, mockTransportClose };
}

function mockFetch(responses: Array<{ ok: boolean; json?: unknown; text?: string }>) {
  let skillIdx = 0;
  const spy = vi.fn(async (url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : String(url);

    // Official Registry calls get empty response by default in legacy tests
    if (urlStr.includes("registry.modelcontextprotocol.io")) {
      return { ok: false, json: async () => ({}), text: async () => "" } as Response;
    }

    // Skills (raw.githubusercontent.com) and other URLs
    const r = responses[skillIdx] ?? responses[responses.length - 1];
    skillIdx++;
    return {
      ok: r.ok,
      json: async () => r.json,
      text: async () => r.text ?? "",
    } as Response;
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function mockFetchByUrl(config: {
  registry?: { ok: boolean; json?: unknown };
  pulse?: { content: Array<{ type: string; text?: string }> } | null;
  skills?: Array<{ ok: boolean; json?: unknown; text?: string }>;
}) {
  let skillIdx = 0;
  const spy = vi.fn(async (url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : String(url);

    if (urlStr.includes("registry.modelcontextprotocol.io")) {
      const r = config.registry ?? { ok: true, json: { servers: [] } };
      return { ok: r.ok, json: async () => r.json, text: async () => "" } as Response;
    }

    // Skills (raw.githubusercontent.com)
    const r = config.skills?.[skillIdx] ?? config.skills?.[config.skills.length - 1] ?? { ok: false };
    skillIdx++;
    return { ok: r.ok, json: async () => (r as any).json, text: async () => (r as any).text ?? "" } as Response;
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function mcpServers(...servers: Array<Record<string, unknown>>) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ servers }),
    }],
  };
}

function npmServer(name: string, pkg: string, opts?: { stars?: number; description?: unknown }) {
  return {
    name,
    package_registry: "npm",
    package_name: pkg,
    description: opts?.description ?? `${name} description`,
    github_stars: opts?.stars ?? 0,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  _mockClientInstances.length = 0;
  _mockTransportInstances.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ────────────────────────────────────────────────────────────
// Scenario: One discovery source fails, the other succeeds
// ────────────────────────────────────────────────────────────

describe("independent failure: MCP and skills discovery are isolated", () => {
  it("returns MCP results when skills fetch fails", async () => {
    setupMcpMock(mcpServers(npmServer("Good MCP", "good-mcp", { stars: 100 })));
    mockFetch([{ ok: false }]);

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });

    expect(result.mcps).toHaveLength(1);
    expect(result.mcps[0].name).toBe("good-mcp");
    expect(result.skills).toEqual([]);
  });

  it("returns skills results when MCP connection fails", async () => {
    setupMcpMock(null, { connectThrows: true });
    mockFetch([{
      ok: true,
      json: {
        skills: [{ name: "my-skill", description: "A skill", repo: "user/repo", path: "SKILL.md", branch: "main", stars: 50 }],
      },
    }]);

    const result = await discoverExternalCapabilities("develop code", new Set(), new Set(), { timeoutMs: 5000 });

    expect(result.mcps).toEqual([]);
    expect(result.skills).toHaveLength(1);
  });

  it("returns empty for both when both fail", async () => {
    setupMcpMock(null, { connectThrows: true });
    mockFetch([{ ok: false }]);

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 1000 });

    expect(result.mcps).toEqual([]);
    expect(result.skills).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────
// Scenario: External API returns garbage — system stays robust
// ────────────────────────────────────────────────────────────

describe("malformed API responses should not crash or corrupt results", () => {
  it("one server with null name does not prevent other valid servers from being returned", async () => {
    setupMcpMock(mcpServers(
      { name: null, package_registry: "npm", package_name: "null-pkg", github_stars: 999 },
      npmServer("Valid Server", "valid-pkg", { stars: 100 }),
    ));
    mockFetch([{ ok: false }]);

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });

    expect(result.mcps).toHaveLength(1);
    expect(result.mcps[0].name).toBe("valid-server");
  });

  it("server with object description does not prevent other valid servers", async () => {
    setupMcpMock(mcpServers(
      { name: "Bad Desc", package_registry: "npm", package_name: "bad", description: { nested: true }, github_stars: 1 },
      npmServer("Good", "good-pkg", { stars: 50 }),
    ));
    mockFetch([{ ok: false }]);

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });

    expect(result.mcps.some(m => m.name === "good")).toBe(true);
  });

  it("server with numeric description gets empty string, not crash", async () => {
    setupMcpMock(mcpServers(
      { name: "NumDesc", package_registry: "npm", package_name: "num-pkg", description: 42, github_stars: 1 },
    ));
    mockFetch([{ ok: false }]);

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });

    expect(result.mcps).toHaveLength(1);
    expect(result.mcps[0].description).toBe("");
  });

  it("server with empty/undefined name is skipped", async () => {
    setupMcpMock(mcpServers(
      { name: "", package_registry: "npm", package_name: "empty-name" },
      { name: undefined, package_registry: "npm", package_name: "undef-name" },
    ));
    mockFetch([{ ok: false }]);

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });

    expect(result.mcps).toEqual([]);
  });

  it("server name that normalizes to empty string (all special chars) is skipped", async () => {
    setupMcpMock(mcpServers(
      npmServer("---", "dashes-pkg", { stars: 5 }),
      npmServer("***", "stars-pkg", { stars: 5 }),
    ));
    mockFetch([{ ok: false }]);

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });

    expect(result.mcps).toEqual([]);
  });

  it("non-JSON MCP response returns empty MCPs", async () => {
    setupMcpMock({ content: [{ type: "text", text: "not valid json" }] });
    mockFetch([{ ok: false }]);

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });

    expect(result.mcps).toEqual([]);
  });

  it("MCP response with no servers field returns empty MCPs", async () => {
    setupMcpMock({ content: [{ type: "text", text: JSON.stringify({ count: 0 }) }] });
    mockFetch([{ ok: false }]);

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });

    expect(result.mcps).toEqual([]);
  });

  it("MCP response with null content returns empty MCPs", async () => {
    setupMcpMock({ content: [{ type: "text" }] });
    mockFetch([{ ok: false }]);

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });

    expect(result.mcps).toEqual([]);
  });

  it("skills API returning non-JSON body returns empty skills", async () => {
    setupMcpMock(null, { connectThrows: true });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => { throw new SyntaxError("Unexpected token"); },
    } as any)));

    const result = await discoverExternalCapabilities("develop code", new Set(), new Set(), { timeoutMs: 5000 });

    expect(result.skills).toEqual([]);
  });

  it("skills with missing required fields (repo/path/branch) are filtered out", async () => {
    setupMcpMock(null, { connectThrows: true });
    mockFetch([{
      ok: true,
      json: {
        skills: [
          { name: "no-repo", description: "Missing repo", stars: 50 },
          { name: "no-path", description: "Missing path", repo: "r", stars: 50 },
          { name: "no-branch", description: "Missing branch", repo: "r", path: "p", stars: 50 },
          { name: "valid", description: "Valid", repo: "r", path: "p", branch: "main", stars: 10 },
        ],
      },
    }]);

    const result = await discoverExternalCapabilities("develop code", new Set(), new Set(), { timeoutMs: 5000 });

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("valid");
  });

  it("skill with non-string description gets empty string", async () => {
    setupMcpMock(null, { connectThrows: true });
    mockFetch([{
      ok: true,
      json: {
        skills: [
          { name: "num-desc", description: 42, repo: "r", path: "p", branch: "main", stars: 1 },
          { name: "obj-desc", description: { text: "x" }, repo: "r", path: "p", branch: "main", stars: 1 },
        ],
      },
    }]);

    const result = await discoverExternalCapabilities("develop code", new Set(), new Set(), { timeoutMs: 5000 });

    for (const skill of result.skills) {
      expect(skill.description).toBe("");
    }
  });

  it("skill with empty/null name is skipped", async () => {
    setupMcpMock(null, { connectThrows: true });
    mockFetch([{
      ok: true,
      json: {
        skills: [
          { name: "", description: "no name", repo: "r", path: "p", branch: "main" },
          { description: "null name", repo: "r", path: "p", branch: "main" },
          { name: "valid", description: "ok", repo: "r", path: "p", branch: "main", stars: 1 },
        ],
      },
    }]);

    const result = await discoverExternalCapabilities("develop code", new Set(), new Set(), { timeoutMs: 5000 });

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("valid");
  });
});

// ────────────────────────────────────────────────────────────
// Scenario: Filtering and deduplication
// ────────────────────────────────────────────────────────────

describe("already-installed items should be excluded from results", () => {
  it("MCP matching an installed name (after normalization) is excluded", async () => {
    setupMcpMock(mcpServers(
      npmServer("Context7", "context7-pkg", { stars: 200 }),
      npmServer("New MCP", "new-mcp", { stars: 50 }),
    ));
    mockFetch([{ ok: false }]);

    const result = await discoverExternalCapabilities("test", new Set(["context7"]), new Set(), { timeoutMs: 5000 });

    expect(result.mcps).toHaveLength(1);
    expect(result.mcps[0].name).toBe("new-mcp");
  });

  it("installed skill is excluded", async () => {
    setupMcpMock(null, { connectThrows: true });
    mockFetch([{
      ok: true,
      json: {
        skills: [
          { name: "installed-one", description: "d", repo: "r", path: "p", branch: "main", stars: 100 },
          { name: "new-one", description: "d", repo: "r", path: "p", branch: "main", stars: 50 },
        ],
      },
    }]);

    const result = await discoverExternalCapabilities("develop code", new Set(), new Set(["installed-one"]), { timeoutMs: 5000 });

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("new-one");
  });

  it("non-npm packages are filtered out", async () => {
    setupMcpMock(mcpServers(
      { name: "PyPI Server", package_registry: "pypi", package_name: "pypi-pkg", github_stars: 999 },
      { name: "No Package", package_registry: "npm", github_stars: 100 },
      npmServer("Valid", "valid-pkg", { stars: 10 }),
    ));
    mockFetch([{ ok: false }]);

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });

    expect(result.mcps).toHaveLength(1);
    expect(result.mcps[0].name).toBe("valid");
  });

  it("duplicate skills from multiple categories appear only once", async () => {
    setupMcpMock(null, { connectThrows: true });
    mockFetch([
      { ok: true, json: { skills: [
        { name: "shared", description: "d1", repo: "r", path: "p", branch: "main", stars: 10 },
        { name: "cat1-only", description: "d2", repo: "r", path: "p", branch: "main", stars: 5 },
      ] } },
      { ok: true, json: { skills: [
        { name: "shared", description: "d1-dup", repo: "r", path: "p", branch: "main", stars: 10 },
        { name: "cat2-only", description: "d3", repo: "r", path: "p", branch: "main", stars: 15 },
      ] } },
    ]);

    const result = await discoverExternalCapabilities("develop and test code", new Set(), new Set(), { timeoutMs: 5000 });

    expect(result.skills.filter(s => s.name === "shared")).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────
// Scenario: Sorting and limits
// ────────────────────────────────────────────────────────────

describe("results should be sorted by stars and limited by maxResults", () => {
  it("MCPs are sorted by github_stars descending", async () => {
    setupMcpMock(mcpServers(
      npmServer("Low", "low-pkg", { stars: 10 }),
      npmServer("High", "high-pkg", { stars: 1000 }),
      npmServer("Mid", "mid-pkg", { stars: 100 }),
    ));
    mockFetch([{ ok: false }]);

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { maxResults: 3, timeoutMs: 5000 });

    expect(result.mcps.map(m => m.name)).toEqual(["high", "mid", "low"]);
  });

  it("maxResults limits the number of returned MCPs", async () => {
    const servers = Array.from({ length: 10 }, (_, i) =>
      npmServer(`Server${i}`, `pkg-${i}`, { stars: i }),
    );
    setupMcpMock(mcpServers(...servers));
    mockFetch([{ ok: false }]);

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { maxResults: 3, timeoutMs: 5000 });

    expect(result.mcps).toHaveLength(3);
  });

  it("MCP with non-numeric github_stars gets undefined", async () => {
    setupMcpMock(mcpServers(
      { name: "NoStars", package_registry: "npm", package_name: "no-stars", github_stars: "not a number" },
    ));
    mockFetch([{ ok: false }]);

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });

    expect(result.mcps[0].githubStars).toBeUndefined();
  });

  it("long MCP description is truncated to 200 chars", async () => {
    setupMcpMock(mcpServers(npmServer("Long", "long-pkg", { description: "D".repeat(500) })));
    mockFetch([{ ok: false }]);

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });

    expect(result.mcps[0].description).toHaveLength(200);
  });

  it("long skill description is truncated to 200 chars", async () => {
    setupMcpMock(null, { connectThrows: true });
    mockFetch([{
      ok: true,
      json: {
        skills: [{ name: "v", description: "X".repeat(500), repo: "r", path: "p", branch: "main" }],
      },
    }]);

    const result = await discoverExternalCapabilities("develop code", new Set(), new Set(), { timeoutMs: 5000 });

    expect(result.skills[0].description).toHaveLength(200);
  });
});

// ────────────────────────────────────────────────────────────
// Scenario: MCP name normalization
// ────────────────────────────────────────────────────────────

describe("MCP names should be normalized to kebab-case", () => {
  it("normalizes special chars, case, and leading/trailing dashes", async () => {
    setupMcpMock(mcpServers(
      npmServer("My Awesome MCP!", "awesome"),
      npmServer("---Leading-Trailing---", "trimmed"),
      npmServer("UPPER_CASE", "upper"),
    ));
    mockFetch([{ ok: false }]);

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });

    const names = result.mcps.map(m => m.name);
    expect(names).toContain("my-awesome-mcp");
    expect(names).toContain("leading-trailing");
    expect(names).toContain("upper-case");
  });

  it("MCP that normalizes to already-installed name is excluded", async () => {
    setupMcpMock(mcpServers(npmServer("Context 7!", "ctx7")));
    mockFetch([{ ok: false }]);

    const result = await discoverExternalCapabilities("test", new Set(["context-7"]), new Set(), { timeoutMs: 5000 });

    expect(result.mcps).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────
// Scenario: Category matching for skills discovery
// ────────────────────────────────────────────────────────────

describe("skill category matching should use word boundaries", () => {
  it("'test' inside 'latest' does not trigger testing category", async () => {
    setupMcpMock(null, { connectThrows: true });
    const fetchSpy = mockFetch([{ ok: true, json: { skills: [] } }]);

    await discoverExternalCapabilities("install the latest version", new Set(), new Set(), { timeoutMs: 5000 });

    const urls = fetchSpy.mock.calls.map(c => c[0] as string);
    expect(urls.some(u => u.includes("/testing.json"))).toBe(false);
  });

  it("unrecognized query falls back to development category", async () => {
    setupMcpMock(null, { connectThrows: true });
    const fetchSpy = mockFetch([{
      ok: true,
      json: { skills: [{ name: "s1", description: "d", repo: "r", path: "p", branch: "main" }] },
    }]);

    await discoverExternalCapabilities("xyzzy foobar baz", new Set(), new Set(), { timeoutMs: 5000 });

    const urls = fetchSpy.mock.calls.map(c => c[0] as string);
    expect(urls.some(u => u.includes("/development.json"))).toBe(true);
  });

  it("empty query falls back to development category", async () => {
    setupMcpMock(null, { connectThrows: true });
    const fetchSpy = mockFetch([{ ok: true, json: { skills: [] } }]);

    await discoverExternalCapabilities("", new Set(), new Set(), { timeoutMs: 5000 });

    const urls = fetchSpy.mock.calls.map(c => c[0] as string);
    expect(urls.some(u => u.includes("/development.json"))).toBe(true);
  });

  it("query matching multiple categories fetches both", async () => {
    setupMcpMock(null, { connectThrows: true });
    const fetchSpy = mockFetch([
      { ok: true, json: { skills: [] } },
      { ok: true, json: { skills: [] } },
    ]);

    await discoverExternalCapabilities("develop and test code", new Set(), new Set(), { timeoutMs: 5000 });

    const urls = fetchSpy.mock.calls.map(c => c[0] as string);
    expect(urls.length).toBeGreaterThanOrEqual(2);
  });
});

// ────────────────────────────────────────────────────────────
// Scenario: Cleanup — client/transport resources on failure
// ────────────────────────────────────────────────────────────

describe("MCP client and transport should be cleaned up on failure", () => {
  it("cleans up when connect fails", async () => {
    const mocks = setupMcpMock(null, { connectThrows: true });
    mockFetch([{ ok: false }]);

    await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 1000 });

    expect(mocks.mockClose).toHaveBeenCalled();
    expect(mocks.mockTransportClose).toHaveBeenCalled();
  });

  it("does not crash if client.close throws", async () => {
    setupMcpMock(
      { content: [{ type: "text", text: JSON.stringify({ servers: [] }) }] },
      { closeThrows: true },
    );
    mockFetch([{ ok: false }]);

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });

    expect(result.mcps).toEqual([]);
  });

  it("handles transport constructor throwing", async () => {
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    vi.mocked(StdioClientTransport).mockImplementationOnce(() => {
      throw new Error("Failed to create transport");
    });
    mockFetch([{ ok: false }]);

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });

    expect(result.mcps).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────
// Scenario: autoInstallSkill — file system operations
// ────────────────────────────────────────────────────────────

describe("autoInstallSkill should handle file system failures gracefully", () => {
  const baseSkill: DiscoveredSkill = {
    name: "test-skill",
    description: "Test",
    repo: "owner/repo",
    path: "SKILL.md",
    branch: "main",
  };

  it("returns false when server returns 404", async () => {
    mockFetch([{ ok: false }]);

    expect(await autoInstallSkill(baseSkill)).toBe(false);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("returns false when fetch throws network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    expect(await autoInstallSkill(baseSkill)).toBe(false);
  });

  it("returns false when mkdirSync throws", async () => {
    mockFetch([{ ok: true, text: "content" }]);
    mockMkdirSync.mockImplementation(() => { throw new Error("EACCES"); });

    expect(await autoInstallSkill(baseSkill)).toBe(false);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("returns false when writeFileSync throws", async () => {
    mockFetch([{ ok: true, text: "content" }]);
    mockWriteFileSync.mockImplementation(() => { throw new Error("ENOSPC"); });

    expect(await autoInstallSkill(baseSkill)).toBe(false);
  });

  it("creates skills directory and writes file on success", async () => {
    mockFetch([{ ok: true, text: "# Skill content" }]);

    expect(await autoInstallSkill(baseSkill)).toBe(true);
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining("skills"),
      { recursive: true },
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining("test-skill.md"),
      "# Skill content",
      "utf-8",
    );
  });

  it("constructs correct GitHub raw URL from skill fields", async () => {
    const fetchSpy = mockFetch([{ ok: true, text: "content" }]);

    await autoInstallSkill({
      name: "s",
      description: "d",
      repo: "alice/my-repo",
      path: "skills/deep/SKILL.md",
      branch: "develop",
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/alice/my-repo/develop/skills/deep/SKILL.md",
      expect.any(Object),
    );
  });
});

// ────────────────────────────────────────────────────────────
// Official MCP Registry tests
// ────────────────────────────────────────────────────────────

function registryServer(
  name: string,
  packages: Array<{ registryType: string; identifier?: string; environmentVariables?: Array<{ name: string; isRequired: boolean }> }>,
  opts?: { description?: unknown },
) {
  return {
    server: {
      name,
      description: opts?.description ?? `${name} description`,
      packages,
    },
  };
}

function npmRegistryServer(name: string, identifier: string, opts?: {
  envVars?: Array<{ name: string; isRequired: boolean }>;
  description?: unknown;
}) {
  return registryServer(name, [{
    registryType: "npm",
    identifier,
    environmentVariables: opts?.envVars,
  }], opts);
}

describe("Official MCP Registry: npm package filtering", () => {
  it("pypi-only server is excluded", async () => {
    setupMcpMock(null, { connectThrows: true });
    mockFetchByUrl({
      registry: { ok: true, json: { servers: [
        registryServer("pypi-only", [{ registryType: "pypi", identifier: "some-pkg" }]),
        npmRegistryServer("valid-npm", "valid-npm-pkg"),
      ] } },
      skills: [{ ok: false }],
    });

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });
    expect(result.mcps.some(m => m.packageName === "valid-npm-pkg")).toBe(true);
    expect(result.mcps.some(m => m.packageName === "some-pkg")).toBe(false);
  });

  it("server with no packages is excluded", async () => {
    setupMcpMock(null, { connectThrows: true });
    mockFetchByUrl({
      registry: { ok: true, json: { servers: [
        registryServer("no-pkgs", []),
      ] } },
      skills: [{ ok: false }],
    });

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });
    expect(result.mcps).toEqual([]);
  });

  it("npm package with required env vars is excluded", async () => {
    setupMcpMock(null, { connectThrows: true });
    mockFetchByUrl({
      registry: { ok: true, json: { servers: [
        npmRegistryServer("needs-key", "needs-key-pkg", {
          envVars: [{ name: "API_KEY", isRequired: true }],
        }),
        npmRegistryServer("no-key", "no-key-pkg"),
      ] } },
      skills: [{ ok: false }],
    });

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });
    expect(result.mcps.some(m => m.packageName === "needs-key-pkg")).toBe(false);
    expect(result.mcps.some(m => m.packageName === "no-key-pkg")).toBe(true);
  });

  it("npm package with only optional env vars is kept", async () => {
    setupMcpMock(null, { connectThrows: true });
    mockFetchByUrl({
      registry: { ok: true, json: { servers: [
        npmRegistryServer("opt-env", "opt-env-pkg", {
          envVars: [{ name: "OPTIONAL_VAR", isRequired: false }],
        }),
      ] } },
      skills: [{ ok: false }],
    });

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });
    expect(result.mcps).toHaveLength(1);
    expect(result.mcps[0].packageName).toBe("opt-env-pkg");
  });

  it("npm package with no env vars is kept", async () => {
    setupMcpMock(null, { connectThrows: true });
    mockFetchByUrl({
      registry: { ok: true, json: { servers: [
        npmRegistryServer("clean", "clean-pkg"),
      ] } },
      skills: [{ ok: false }],
    });

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });
    expect(result.mcps).toHaveLength(1);
  });
});

describe("Official MCP Registry: field mapping", () => {
  it("extracts short name from namespaced server name", async () => {
    setupMcpMock(null, { connectThrows: true });
    mockFetchByUrl({
      registry: { ok: true, json: { servers: [
        npmRegistryServer("io.github.owner/my-mcp", "my-mcp-pkg"),
      ] } },
      skills: [{ ok: false }],
    });

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });
    expect(result.mcps[0].displayName).toBe("my-mcp");
    expect(result.mcps[0].name).toBe("my-mcp");
  });

  it("long description is truncated to 200 chars", async () => {
    setupMcpMock(null, { connectThrows: true });
    mockFetchByUrl({
      registry: { ok: true, json: { servers: [
        npmRegistryServer("long-desc", "long-desc-pkg", { description: "D".repeat(500) }),
      ] } },
      skills: [{ ok: false }],
    });

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });
    expect(result.mcps[0].description).toHaveLength(200);
  });

  it("missing description becomes empty string", async () => {
    setupMcpMock(null, { connectThrows: true });
    mockFetchByUrl({
      registry: { ok: true, json: { servers: [
        registryServer("no-desc", [{ registryType: "npm", identifier: "no-desc-pkg" }], { description: 42 }),
      ] } },
      skills: [{ ok: false }],
    });

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });
    expect(result.mcps[0].description).toBe("");
  });

  it("githubStars is always undefined", async () => {
    setupMcpMock(null, { connectThrows: true });
    mockFetchByUrl({
      registry: { ok: true, json: { servers: [
        npmRegistryServer("stars-test", "stars-pkg"),
      ] } },
      skills: [{ ok: false }],
    });

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });
    expect(result.mcps[0].githubStars).toBeUndefined();
  });
});

describe("Official MCP Registry: error resilience", () => {
  it("HTTP 500 returns empty array, does not affect PulseMCP", async () => {
    setupMcpMock(mcpServers(npmServer("Pulse", "pulse-pkg", { stars: 100 })));
    mockFetchByUrl({
      registry: { ok: false, json: undefined },
      skills: [{ ok: false }],
    });

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });
    expect(result.mcps).toHaveLength(1);
    expect(result.mcps[0].packageName).toBe("pulse-pkg");
  });

  it("fetch throwing returns empty array", async () => {
    setupMcpMock(mcpServers(npmServer("Pulse", "pulse-pkg", { stars: 100 })));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("registry.modelcontextprotocol.io")) {
        throw new Error("network timeout");
      }
      return { ok: false, json: async () => ({}), text: async () => "" } as Response;
    }));

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });
    expect(result.mcps).toHaveLength(1);
    expect(result.mcps[0].packageName).toBe("pulse-pkg");
  });

  it("non-JSON response returns empty array", async () => {
    setupMcpMock(null, { connectThrows: true });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("registry.modelcontextprotocol.io")) {
        return {
          ok: true,
          json: async () => { throw new SyntaxError("Unexpected token"); },
          text: async () => "not json",
        } as any;
      }
      return { ok: false, json: async () => ({}), text: async () => "" } as Response;
    }));

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });
    expect(result.mcps).toEqual([]);
  });

  it("malformed server entries do not crash", async () => {
    setupMcpMock(null, { connectThrows: true });
    mockFetchByUrl({
      registry: { ok: true, json: { servers: [
        { server: null },
        { server: { name: 42, packages: [] } },
        { server: { name: "valid", packages: [{ registryType: "npm", identifier: "valid-pkg" }] } },
        "not-an-object",
      ] } },
      skills: [{ ok: false }],
    });

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });
    expect(result.mcps).toHaveLength(1);
    expect(result.mcps[0].packageName).toBe("valid-pkg");
  });
});

describe("PulseMCP + Official Registry merge", () => {
  it("same npm package from both sources — PulseMCP version kept (has stars)", async () => {
    setupMcpMock(mcpServers(npmServer("Shared MCP", "shared-pkg", { stars: 200 })));
    mockFetchByUrl({
      registry: { ok: true, json: { servers: [
        npmRegistryServer("shared", "shared-pkg"),
      ] } },
      skills: [{ ok: false }],
    });

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });
    const shared = result.mcps.filter(m => m.packageName === "shared-pkg");
    expect(shared).toHaveLength(1);
    expect(shared[0].githubStars).toBe(200);
  });

  it("different packages from each source are both kept", async () => {
    setupMcpMock(mcpServers(npmServer("Pulse Only", "pulse-only-pkg", { stars: 100 })));
    mockFetchByUrl({
      registry: { ok: true, json: { servers: [
        npmRegistryServer("registry-only", "registry-only-pkg"),
      ] } },
      skills: [{ ok: false }],
    });

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { maxResults: 10, timeoutMs: 5000 });
    expect(result.mcps.some(m => m.packageName === "pulse-only-pkg")).toBe(true);
    expect(result.mcps.some(m => m.packageName === "registry-only-pkg")).toBe(true);
  });

  it("total count respects maxResults", async () => {
    const pulseServers = Array.from({ length: 5 }, (_, i) =>
      npmServer(`Pulse${i}`, `pulse-${i}`, { stars: 100 - i }),
    );
    setupMcpMock(mcpServers(...pulseServers));
    mockFetchByUrl({
      registry: { ok: true, json: { servers: Array.from({ length: 5 }, (_, i) =>
        npmRegistryServer(`reg-${i}`, `reg-pkg-${i}`),
      ) } },
      skills: [{ ok: false }],
    });

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { maxResults: 3, timeoutMs: 5000 });
    expect(result.mcps).toHaveLength(3);
  });

  it("PulseMCP failure — Official Registry results still returned", async () => {
    setupMcpMock(null, { connectThrows: true });
    mockFetchByUrl({
      registry: { ok: true, json: { servers: [
        npmRegistryServer("fallback", "fallback-pkg"),
      ] } },
      skills: [{ ok: false }],
    });

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });
    expect(result.mcps).toHaveLength(1);
    expect(result.mcps[0].packageName).toBe("fallback-pkg");
  });

  it("Official Registry failure — PulseMCP results still returned", async () => {
    setupMcpMock(mcpServers(npmServer("Pulse", "pulse-pkg", { stars: 50 })));
    mockFetchByUrl({
      registry: { ok: false, json: undefined },
      skills: [{ ok: false }],
    });

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });
    expect(result.mcps).toHaveLength(1);
    expect(result.mcps[0].packageName).toBe("pulse-pkg");
  });
});
