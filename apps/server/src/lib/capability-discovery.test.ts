import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock MCP SDK with class factories
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

// ── Test helpers ──

function setupMcpMock(callToolResult: unknown) {
  const mockClose = vi.fn().mockResolvedValue(undefined);
  const mockConnect = vi.fn().mockResolvedValue(undefined);
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

function setupMcpConnectFail() {
  _mockClientInstances.push({
    connect: vi.fn().mockRejectedValue(new Error("connect fail")),
    callTool: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  });
  _mockTransportInstances.push({ close: vi.fn().mockResolvedValue(undefined) });
}

function mcpServers(...servers: Array<Record<string, unknown>>) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ servers }),
    }],
  };
}

function npmServer(name: string, pkg: string, opts?: { stars?: number; description?: string }) {
  return {
    name,
    package_registry: "npm",
    package_name: pkg,
    description: opts?.description ?? `${name} description`,
    github_stars: opts?.stars ?? 0,
  };
}

/** Mock fetch: registry returns empty/fail, skills return given responses */
function mockSkillsFetch(responses: Array<{ ok: boolean; json?: unknown; text?: string }>) {
  let idx = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : String(url);
    if (urlStr.includes("registry.modelcontextprotocol.io")) {
      return { ok: false, json: async () => ({}), text: async () => "" } as Response;
    }
    const r = responses[idx] ?? responses[responses.length - 1];
    idx++;
    return { ok: r.ok, json: async () => r.json, text: async () => r.text ?? "" } as Response;
  }));
}

/** Mock fetch: both registry and skills controlled */
function mockAllFetch(config: {
  registry?: { ok: boolean; json?: unknown };
  skills?: Array<{ ok: boolean; json?: unknown; text?: string }>;
}) {
  let skillIdx = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : String(url);
    if (urlStr.includes("registry.modelcontextprotocol.io")) {
      const r = config.registry ?? { ok: true, json: { servers: [] } };
      return { ok: r.ok, json: async () => r.json, text: async () => "" } as Response;
    }
    const r = config.skills?.[skillIdx] ?? { ok: false };
    skillIdx++;
    return { ok: r.ok, json: async () => (r as any).json, text: async () => (r as any).text ?? "" } as Response;
  }));
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

// ── Success paths ──

describe("discoverExternalCapabilities success paths", () => {
  it("PulseMCP returns 2 valid npm servers — results.mcps contains both with correct fields", async () => {
    setupMcpMock(mcpServers(
      npmServer("Notion MCP", "notion-pkg", { stars: 500, description: "Notion integration" }),
      npmServer("GitHub MCP", "github-pkg", { stars: 300, description: "GitHub tools" }),
    ));
    mockSkillsFetch([{ ok: false }]);

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });

    expect(result.mcps).toHaveLength(2);
    const notion = result.mcps.find(m => m.packageName === "notion-pkg");
    expect(notion).toBeDefined();
    expect(notion!.name).toBe("notion-mcp");
    expect(notion!.description).toBe("Notion integration");
    expect(notion!.githubStars).toBe(500);
  });

  it("skills fetch succeeds — results.skills contains all fields mapped correctly", async () => {
    setupMcpConnectFail();
    mockSkillsFetch([{
      ok: true,
      json: {
        skills: [{
          name: "code-review",
          description: "Automated code review",
          repo: "owner/skill-repo",
          path: "skills/code-review.md",
          branch: "main",
          stars: 42,
        }],
      },
    }]);

    const result = await discoverExternalCapabilities("develop code", new Set(), new Set(), { timeoutMs: 5000 });

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({
      name: "code-review",
      description: "Automated code review",
      repo: "owner/skill-repo",
      path: "skills/code-review.md",
      branch: "main",
      stars: 42,
    });
  });

  it("omitting maxResults defaults to 5 — results do not exceed 5", async () => {
    const servers = Array.from({ length: 10 }, (_, i) =>
      npmServer(`Server${i}`, `pkg-${i}`, { stars: i }),
    );
    setupMcpMock(mcpServers(...servers));
    mockSkillsFetch([{ ok: false }]);

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });

    expect(result.mcps.length).toBeLessThanOrEqual(5);
  });

  it("query 'develop' triggers development category fetch URL", async () => {
    setupMcpConnectFail();
    const fetchSpy = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : String(url);
      if (urlStr.includes("registry.modelcontextprotocol.io")) {
        return { ok: false, json: async () => ({}), text: async () => "" } as Response;
      }
      return { ok: true, json: async () => ({ skills: [] }), text: async () => "" } as Response;
    });
    vi.stubGlobal("fetch", fetchSpy);

    await discoverExternalCapabilities("develop", new Set(), new Set(), { timeoutMs: 5000 });

    const urls = fetchSpy.mock.calls
      .map(c => c[0] as string)
      .filter((u: string) => u.includes("raw.githubusercontent.com"));
    expect(urls.some((u: string) => u.includes("/development.json"))).toBe(true);
  });

  it("query 'test code' triggers testing category fetch URL", async () => {
    setupMcpConnectFail();
    const fetchSpy = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : String(url);
      if (urlStr.includes("registry.modelcontextprotocol.io")) {
        return { ok: false, json: async () => ({}), text: async () => "" } as Response;
      }
      return { ok: true, json: async () => ({ skills: [] }), text: async () => "" } as Response;
    });
    vi.stubGlobal("fetch", fetchSpy);

    await discoverExternalCapabilities("test code", new Set(), new Set(), { timeoutMs: 5000 });

    const urls = fetchSpy.mock.calls
      .map(c => c[0] as string)
      .filter((u: string) => u.includes("raw.githubusercontent.com"));
    expect(urls.some((u: string) => u.includes("/testing.json"))).toBe(true);
  });
});

// ── Merge and dedup ──

describe("merge and deduplication", () => {
  it("PulseMCP and Official Registry return different packageNames — both appear in results", async () => {
    setupMcpMock(mcpServers(npmServer("Pulse Only", "pulse-only-pkg", { stars: 100 })));
    mockAllFetch({
      registry: { ok: true, json: { servers: [
        { server: { name: "registry-only", description: "reg desc", packages: [{ registryType: "npm", identifier: "registry-only-pkg" }] } },
      ] } },
      skills: [{ ok: false }],
    });

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { maxResults: 10, timeoutMs: 5000 });

    expect(result.mcps.some(m => m.packageName === "pulse-only-pkg")).toBe(true);
    expect(result.mcps.some(m => m.packageName === "registry-only-pkg")).toBe(true);
  });

  it("same packageName from both sources — only one entry returned (PulseMCP version with stars)", async () => {
    setupMcpMock(mcpServers(npmServer("Shared MCP", "shared-pkg", { stars: 200 })));
    mockAllFetch({
      registry: { ok: true, json: { servers: [
        { server: { name: "shared", description: "shared desc", packages: [{ registryType: "npm", identifier: "shared-pkg" }] } },
      ] } },
      skills: [{ ok: false }],
    });

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { maxResults: 10, timeoutMs: 5000 });

    const shared = result.mcps.filter(m => m.packageName === "shared-pkg");
    expect(shared).toHaveLength(1);
    expect(shared[0].githubStars).toBe(200); // PulseMCP version
  });

  it("skills from multiple categories are sorted by stars descending", async () => {
    setupMcpConnectFail();
    mockSkillsFetch([
      { ok: true, json: { skills: [
        { name: "low-stars", description: "d", repo: "r", path: "p", branch: "main", stars: 5 },
        { name: "high-stars", description: "d", repo: "r", path: "p", branch: "main", stars: 100 },
      ] } },
      { ok: true, json: { skills: [
        { name: "mid-stars", description: "d", repo: "r", path: "p", branch: "main", stars: 50 },
      ] } },
    ]);

    const result = await discoverExternalCapabilities("develop and test code", new Set(), new Set(), { timeoutMs: 5000 });

    const stars = result.skills.map(s => s.stars ?? 0);
    for (let i = 1; i < stars.length; i++) {
      expect(stars[i - 1]).toBeGreaterThanOrEqual(stars[i]);
    }
  });
});

// ── autoInstallSkill success paths ──

describe("autoInstallSkill success paths", () => {
  const baseSkill: DiscoveredSkill = {
    name: "test-skill",
    description: "Test skill",
    repo: "owner/repo",
    path: "SKILL.md",
    branch: "main",
  };

  it("successful fetch returns true and writes file", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "# Skill content\nInstruction here",
    }));

    const result = await autoInstallSkill(baseSkill);

    expect(result).toBe(true);
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it("writes to path '{CONFIG_DIR}/skills/{skill.name}.md'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "content",
    }));

    await autoInstallSkill(baseSkill);

    const writtenPath = mockWriteFileSync.mock.calls[0][0] as string;
    expect(writtenPath).toBe("/fake/config/skills/test-skill.md");
  });

  it("mkdirSync is called with { recursive: true }", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "content",
    }));

    await autoInstallSkill(baseSkill);

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.any(String),
      { recursive: true },
    );
  });
});

// ── Official Registry name normalization ──

describe("Official Registry name normalization via discoverExternalCapabilities", () => {
  function registryOnlyFetch(servers: Array<{ name: string; identifier: string }>) {
    mockAllFetch({
      registry: { ok: true, json: { servers: servers.map(s => ({
        server: {
          name: s.name,
          description: "desc",
          packages: [{ registryType: "npm", identifier: s.identifier }],
        },
      })) } },
      skills: [{ ok: false }],
    });
  }

  beforeEach(() => {
    setupMcpConnectFail();
  });

  it("'io.github.owner/repo-name' extracts last segment 'repo-name'", async () => {
    registryOnlyFetch([{ name: "io.github.owner/repo-name", identifier: "pkg1" }]);

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });

    expect(result.mcps[0].displayName).toBe("repo-name");
    expect(result.mcps[0].name).toBe("repo-name");
  });

  it("uppercase letters in display name are lowercased", async () => {
    registryOnlyFetch([{ name: "io.github.owner/MyMCP", identifier: "pkg2" }]);

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });

    expect(result.mcps[0].name).toBe("mymcp");
  });

  it("underscores and spaces in display name are converted to dashes", async () => {
    registryOnlyFetch([{ name: "my_mcp_server", identifier: "pkg3" }]);

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });

    expect(result.mcps[0].name).toBe("my-mcp-server");
  });

  it("leading and trailing dashes are stripped from normalized name", async () => {
    registryOnlyFetch([{ name: "---my-server---", identifier: "pkg4" }]);

    const result = await discoverExternalCapabilities("test", new Set(), new Set(), { timeoutMs: 5000 });

    expect(result.mcps[0].name).toBe("my-server");
  });
});
