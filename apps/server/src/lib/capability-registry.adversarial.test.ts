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
import { readdirSync, readFileSync } from "node:fs";

const mockLoadMcpRegistry = vi.mocked(loadMcpRegistry);
const mockBuildMcp = vi.mocked(buildMcpFromRegistry);
const mockReaddirSync = vi.mocked(readdirSync);
const mockReadFileSync = vi.mocked(readFileSync);

beforeEach(() => {
  vi.resetAllMocks();
  mockLoadMcpRegistry.mockReturnValue(null);
  mockReaddirSync.mockImplementation(() => { throw new Error("ENOENT"); });
});

// ────────────────────────────────────────────────────────────
// Scenario: Skills directory doesn't exist or has errors
// ────────────────────────────────────────────────────────────

describe("skills enumeration should be resilient to filesystem issues", () => {
  it("returns empty skills when skills directory does not exist", () => {
    mockReaddirSync.mockImplementation(() => { throw new Error("ENOENT"); });

    const summary = buildCapabilitySummary();
    expect(summary.skills).toEqual([]);
  });

  it("returns empty skills on permission denied", () => {
    mockReaddirSync.mockImplementation(() => { throw new Error("EPERM"); });

    const summary = buildCapabilitySummary();
    expect(summary.skills).toEqual([]);
  });

  it("only processes .md files, ignores other file types", () => {
    mockReaddirSync.mockReturnValue(["notes.txt", ".gitkeep", "skill.md", "readme.MD"] as any);
    mockReadFileSync.mockReturnValue("Some skill description\nMore text");

    const summary = buildCapabilitySummary();
    expect(summary.skills).toHaveLength(1);
    expect(summary.skills[0].id).toBe("skill");
  });

  it("still returns the skill entry if readFileSync throws for one file", () => {
    mockReaddirSync.mockReturnValue(["good.md", "bad.md"] as any);
    let callCount = 0;
    mockReadFileSync.mockImplementation(() => {
      callCount++;
      if (callCount === 2) throw new Error("EACCES");
      return "Good skill description";
    });

    const summary = buildCapabilitySummary();
    expect(summary.skills).toHaveLength(2);
    expect(summary.skills[0].description).toBe("Good skill description");
    expect(summary.skills[1].description).toBe("");
  });
});

// ────────────────────────────────────────────────────────────
// Scenario: Skill file content edge cases
// ────────────────────────────────────────────────────────────

describe("skill description extraction should handle unusual file contents", () => {
  it("empty file returns empty description", () => {
    mockReaddirSync.mockReturnValue(["empty.md"] as any);
    mockReadFileSync.mockReturnValue("");

    const summary = buildCapabilitySummary();
    expect(summary.skills[0].description).toBe("");
  });

  it("file with only blank lines returns empty description", () => {
    mockReaddirSync.mockReturnValue(["blanks.md"] as any);
    mockReadFileSync.mockReturnValue("\n\n   \n\n");

    const summary = buildCapabilitySummary();
    expect(summary.skills[0].description).toBe("");
  });

  it("skips to first non-empty line", () => {
    mockReaddirSync.mockReturnValue(["spaced.md"] as any);
    mockReadFileSync.mockReturnValue("\n\n\nActual description here");

    const summary = buildCapabilitySummary();
    expect(summary.skills[0].description).toBe("Actual description here");
  });

  it("strips markdown heading prefix", () => {
    mockReaddirSync.mockReturnValue(["perf.md"] as any);
    mockReadFileSync.mockReturnValue("### Performance audit skill\nDetails...");

    const summary = buildCapabilitySummary();
    expect(summary.skills[0].description).toBe("Performance audit skill");
  });

  it("strips heading even without space after hash", () => {
    mockReaddirSync.mockReturnValue(["compact.md"] as any);
    mockReadFileSync.mockReturnValue("#NoSpace");

    const summary = buildCapabilitySummary();
    expect(summary.skills[0].description).toBe("NoSpace");
  });

  it("truncates description to 100 characters", () => {
    mockReaddirSync.mockReturnValue(["verbose.md"] as any);
    mockReadFileSync.mockReturnValue("A".repeat(200));

    const summary = buildCapabilitySummary();
    expect(summary.skills[0].description).toHaveLength(100);
  });
});

// ────────────────────────────────────────────────────────────
// Scenario: formatCapabilityPrompt output correctness
// ────────────────────────────────────────────────────────────

describe("capability prompt should accurately reflect the summary", () => {
  it("shows 'No capabilities registered' when everything is empty", () => {
    const summary: CapabilitySummary = { mcps: [], scripts: [], skills: [] };
    const prompt = formatCapabilityPrompt(summary);
    expect(prompt).toContain("No capabilities registered.");
    expect(prompt).not.toContain("### MCP");
  });

  it("does not show 'No capabilities' when only skills exist", () => {
    const summary: CapabilitySummary = {
      mcps: [], scripts: [],
      skills: [{ id: "test-skill", description: "A test skill" }],
    };
    const prompt = formatCapabilityPrompt(summary);
    expect(prompt).not.toContain("No capabilities registered.");
    expect(prompt).toContain("### Skills");
    expect(prompt).toContain("test-skill");
  });

  it("shows (no description) for empty skill description", () => {
    const summary: CapabilitySummary = {
      mcps: [], scripts: [],
      skills: [{ id: "no-desc", description: "" }],
    };
    const prompt = formatCapabilityPrompt(summary);
    expect(prompt).toContain("(no description)");
  });

  it("renders all three sections when all populated", () => {
    const summary: CapabilitySummary = {
      mcps: [{ name: "notion", description: "Notion", available: true }],
      scripts: [{ id: "git-commit", description: "Commit", helpMd: "" }],
      skills: [{ id: "review", description: "Code review" }],
    };
    const prompt = formatCapabilityPrompt(summary);
    expect(prompt).toContain("### MCP Servers");
    expect(prompt).toContain("### Built-in Scripts");
    expect(prompt).toContain("### Skills");
  });
});
