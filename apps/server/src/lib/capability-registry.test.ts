import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./config/mcp.js", () => ({
  loadMcpRegistry: vi.fn(),
  buildMcpFromRegistry: vi.fn(),
}));

vi.mock("../scripts/index.js", () => ({
  scriptRegistry: {
    getAllMetadata: vi.fn(() => []),
  },
}));

vi.mock("node:fs", () => ({
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("./config/settings.js", () => ({
  CONFIG_DIR: "/fake/config",
}));

import { buildCapabilitySummary, formatCapabilityPrompt, type CapabilitySummary } from "./capability-registry.js";
import { loadMcpRegistry, buildMcpFromRegistry } from "./config/mcp.js";
import { scriptRegistry } from "../scripts/index.js";
import { readdirSync, readFileSync } from "node:fs";

const mockLoadMcpRegistry = vi.mocked(loadMcpRegistry);
const mockBuildMcp = vi.mocked(buildMcpFromRegistry);
const mockGetAllMetadata = vi.mocked(scriptRegistry.getAllMetadata);
const mockReaddirSync = vi.mocked(readdirSync);
const mockReadFileSync = vi.mocked(readFileSync);

beforeEach(() => {
  vi.resetAllMocks();
  mockLoadMcpRegistry.mockReturnValue(null);
  mockGetAllMetadata.mockReturnValue([]);
  mockReaddirSync.mockReturnValue([] as any);
});

// ── buildCapabilitySummary: MCP loading ──

describe("buildCapabilitySummary MCP loading", () => {
  it("loadMcpRegistry returns null — mcps is empty array", () => {
    mockLoadMcpRegistry.mockReturnValue(null);
    const summary = buildCapabilitySummary();
    expect(summary.mcps).toEqual([]);
  });

  it("registry with one entry, buildMcpFromRegistry returns config — available: true", () => {
    mockLoadMcpRegistry.mockReturnValue({
      notion: { description: "Notion integration" },
    } as any);
    mockBuildMcp.mockReturnValue({ command: "npx", args: [] } as any);

    const summary = buildCapabilitySummary();
    expect(summary.mcps).toHaveLength(1);
    expect(summary.mcps[0]).toMatchObject({ name: "notion", description: "Notion integration", available: true });
  });

  it("buildMcpFromRegistry returns null — available: false", () => {
    mockLoadMcpRegistry.mockReturnValue({
      notion: { description: "Notion integration" },
    } as any);
    mockBuildMcp.mockReturnValue(null);

    const summary = buildCapabilitySummary();
    expect(summary.mcps[0].available).toBe(false);
  });

  it("multiple registry entries are all processed in order", () => {
    mockLoadMcpRegistry.mockReturnValue({
      mcp1: { description: "First" },
      mcp2: { description: "Second" },
      mcp3: { description: "Third" },
    } as any);
    mockBuildMcp.mockReturnValue({ command: "npx", args: [] } as any);

    const summary = buildCapabilitySummary();
    expect(summary.mcps).toHaveLength(3);
    expect(summary.mcps.map(m => m.name)).toEqual(["mcp1", "mcp2", "mcp3"]);
  });

  it("registry entry without description field — description is empty string", () => {
    mockLoadMcpRegistry.mockReturnValue({
      bare: {},
    } as any);
    mockBuildMcp.mockReturnValue(null);

    const summary = buildCapabilitySummary();
    expect(summary.mcps[0].description).toBe("");
  });
});

// ── buildCapabilitySummary: scripts ──

describe("buildCapabilitySummary scripts", () => {
  it("getAllMetadata returns empty array — scripts is empty", () => {
    mockGetAllMetadata.mockReturnValue([]);
    const summary = buildCapabilitySummary();
    expect(summary.scripts).toEqual([]);
  });

  it("multiple metadata entries are mapped to { id, description, helpMd }", () => {
    mockGetAllMetadata.mockReturnValue([
      { id: "git-commit", description: "Create a git commit", helpMd: "### Git Commit" } as any,
      { id: "create-branch", description: "Create a new branch" } as any,
    ]);
    const summary = buildCapabilitySummary();
    expect(summary.scripts).toEqual([
      { id: "git-commit", description: "Create a git commit", helpMd: "### Git Commit" },
      { id: "create-branch", description: "Create a new branch", helpMd: "" },
    ]);
  });

  it("id and description come from metadata fields", () => {
    mockGetAllMetadata.mockReturnValue([
      { id: "pr-creation", description: "Open a PR on GitHub" } as any,
    ]);
    const summary = buildCapabilitySummary();
    expect(summary.scripts[0].id).toBe("pr-creation");
    expect(summary.scripts[0].description).toBe("Open a PR on GitHub");
  });
});

// ── buildCapabilitySummary: skills ──

describe("buildCapabilitySummary skills", () => {
  it("skills directory with multiple .md files — all are processed", () => {
    mockReaddirSync.mockReturnValue(["review.md", "deploy.md"] as any);
    mockReadFileSync.mockReturnValue("# Skill title\nSome details");

    const summary = buildCapabilitySummary();
    expect(summary.skills).toHaveLength(2);
  });

  it("skill id is filename without .md extension", () => {
    mockReaddirSync.mockReturnValue(["my-skill.md"] as any);
    mockReadFileSync.mockReturnValue("Some content");

    const summary = buildCapabilitySummary();
    expect(summary.skills[0].id).toBe("my-skill");
  });

  it("description is taken from first non-empty line with heading prefix removed", () => {
    mockReaddirSync.mockReturnValue(["perf.md"] as any);
    mockReadFileSync.mockReturnValue("# Performance Audit\nDetailed instructions...");

    const summary = buildCapabilitySummary();
    expect(summary.skills[0].description).toBe("Performance Audit");
  });

  it("heading '# My Skill' becomes description 'My Skill'", () => {
    mockReaddirSync.mockReturnValue(["skill.md"] as any);
    mockReadFileSync.mockReturnValue("# My Skill\n\nContent here.");

    const summary = buildCapabilitySummary();
    expect(summary.skills[0].description).toBe("My Skill");
  });

  it("empty skills directory returns empty skills array", () => {
    mockReaddirSync.mockReturnValue([] as any);
    const summary = buildCapabilitySummary();
    expect(summary.skills).toEqual([]);
  });
});

// ── formatCapabilityPrompt: output format ──

describe("formatCapabilityPrompt output format", () => {
  it("all empty — outputs 'No capabilities registered.'", () => {
    const summary: CapabilitySummary = { mcps: [], scripts: [], skills: [] };
    const prompt = formatCapabilityPrompt(summary);
    expect(prompt).toContain("No capabilities registered.");
    expect(prompt).not.toContain("### MCP");
    expect(prompt).not.toContain("### Built-in Scripts");
    expect(prompt).not.toContain("### Skills");
  });

  it("MCP section includes table header and each MCP entry", () => {
    const summary: CapabilitySummary = {
      mcps: [{ name: "notion", description: "Notion integration", available: true }],
      scripts: [],
      skills: [],
    };
    const prompt = formatCapabilityPrompt(summary);
    expect(prompt).toContain("### MCP Servers");
    expect(prompt).toContain("| Name | Description | Status |");
    expect(prompt).toContain("notion");
    expect(prompt).toContain("Notion integration");
  });

  it("available: true shows status 'ready'; available: false shows 'missing credentials'", () => {
    const summary: CapabilitySummary = {
      mcps: [
        { name: "ready-mcp", description: "desc", available: true },
        { name: "missing-mcp", description: "desc", available: false },
      ],
      scripts: [],
      skills: [],
    };
    const prompt = formatCapabilityPrompt(summary);
    expect(prompt).toContain("ready");
    expect(prompt).toContain("missing credentials");
  });

  it("scripts section includes table header and each script entry", () => {
    const summary: CapabilitySummary = {
      mcps: [],
      scripts: [{ id: "git-commit", description: "Create a commit", helpMd: "" }],
      skills: [],
    };
    const prompt = formatCapabilityPrompt(summary);
    expect(prompt).toContain("### Built-in Scripts");
    expect(prompt).toContain("| ID | Description |");
    expect(prompt).toContain("git-commit");
    expect(prompt).toContain("Create a commit");
  });

  it("scripts with helpMd include interface reference section", () => {
    const summary: CapabilitySummary = {
      mcps: [],
      scripts: [{ id: "build_gate", description: "Build gate", helpMd: "### Build & Test Gate\nRuns build and test." }],
      skills: [],
    };
    const prompt = formatCapabilityPrompt(summary);
    expect(prompt).toContain("#### Script Interface Reference");
    expect(prompt).toContain("### Build & Test Gate");
    expect(prompt).toContain("Runs build and test.");
  });

  it("skill with empty description renders '(no description)'", () => {
    const summary: CapabilitySummary = {
      mcps: [],
      scripts: [],
      skills: [{ id: "no-desc-skill", description: "" }],
    };
    const prompt = formatCapabilityPrompt(summary);
    expect(prompt).toContain("(no description)");
    expect(prompt).toContain("no-desc-skill");
  });
});
