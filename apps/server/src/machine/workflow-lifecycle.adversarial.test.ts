import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLoadPipelineConfig = vi.fn();
const mockLoadPipelineConstraints = vi.fn();
const mockLoadPipelineSystemPrompt = vi.fn();
const mockGetFragmentRegistry = vi.fn();
const mockLoadSystemSettings = vi.fn();

vi.mock("../lib/config-loader.js", () => ({
  loadPipelineConfig: (...args: unknown[]) => mockLoadPipelineConfig(...args),
  loadPipelineConstraints: (...args: unknown[]) => mockLoadPipelineConstraints(...args),
  loadPipelineSystemPrompt: (...args: unknown[]) => mockLoadPipelineSystemPrompt(...args),
  getFragmentRegistry: (...args: unknown[]) => mockGetFragmentRegistry(...args),
  loadSystemSettings: (...args: unknown[]) => mockLoadSystemSettings(...args),
  flattenStages: (stages: any[]) => {
    const result: any[] = [];
    for (const e of stages) {
      if ("parallel" in e) result.push(...e.parallel.stages);
      else result.push(e);
    }
    return result;
  },
  CONFIG_DIR: "/tmp/test-config",
  getNestedValue: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
}));

import { snapshotGlobalConfig } from "./workflow-lifecycle.js";
import { existsSync, readdirSync } from "node:fs";

const mockExistsSync = vi.mocked(existsSync);
const mockReaddirSync = vi.mocked(readdirSync);

describe("workflow-lifecycle adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadPipelineConfig.mockReturnValue({
      name: "test",
      stages: [],
      skills: [],
    });
    mockLoadPipelineConstraints.mockReturnValue("");
    mockLoadPipelineSystemPrompt.mockReturnValue(null);
    mockGetFragmentRegistry.mockReturnValue({
      getAllEntries: () => new Map(),
    });
    mockLoadSystemSettings.mockReturnValue({});
    mockExistsSync.mockReturnValue(false);
  });

  it("throws with descriptive message when pipeline config returns null", () => {
    mockLoadPipelineConfig.mockReturnValue(null);
    expect(() => snapshotGlobalConfig("nonexistent")).toThrow(
      'Pipeline config not found for "nonexistent"'
    );
  });

  it("throws with descriptive message when pipeline config returns undefined", () => {
    mockLoadPipelineConfig.mockReturnValue(undefined);
    expect(() => snapshotGlobalConfig("missing")).toThrow(
      /Pipeline config not found/
    );
  });

  it("handles loadPipelineConstraints returning undefined", () => {
    mockLoadPipelineConstraints.mockReturnValue(undefined);
    const snap = snapshotGlobalConfig();
    expect(snap.prompts.globalConstraints).toBe("");
  });

  it("toCamelCase handles multiple consecutive hyphens", () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p).includes("prompts/system");
    });
    mockReaddirSync.mockReturnValue(["a--b---c.md"] as any);
    mockLoadPipelineSystemPrompt.mockReturnValue("content");
    const snap = snapshotGlobalConfig();
    expect(snap.prompts.system).toHaveProperty("a-B--C");
  });

  it("toCamelCase preserves already camelCase names", () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p).includes("prompts/system");
    });
    mockReaddirSync.mockReturnValue(["alreadyCamel.md"] as any);
    mockLoadPipelineSystemPrompt.mockReturnValue("content");
    const snap = snapshotGlobalConfig();
    expect(snap.prompts.system).toHaveProperty("alreadyCamel");
  });

  it("filters non-.md files from system prompts directory", () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p).includes("prompts/system");
    });
    mockReaddirSync.mockReturnValue(["valid.md", "ignore.txt", "also.yaml", "another.md"] as any);
    mockLoadPipelineSystemPrompt.mockReturnValue("content");
    const snap = snapshotGlobalConfig();
    expect(Object.keys(snap.prompts.system)).toHaveLength(2);
    expect(snap.prompts.system).toHaveProperty("valid");
    expect(snap.prompts.system).toHaveProperty("another");
  });

  it("handles loadPipelineSystemPrompt returning null for some files", () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p).includes("prompts/system");
    });
    mockReaddirSync.mockReturnValue(["exists.md", "missing.md"] as any);
    mockLoadPipelineSystemPrompt.mockImplementation((_p: string, name: string) => {
      if (name === "missing") return null;
      return "has content";
    });
    const snap = snapshotGlobalConfig();
    expect(snap.prompts.system.exists).toBe("has content");
    expect(snap.prompts.system.missing).toBe("");
  });

  it("handles empty fragment registry", () => {
    mockGetFragmentRegistry.mockReturnValue({
      getAllEntries: () => new Map(),
    });
    const snap = snapshotGlobalConfig();
    expect(snap.prompts.fragments).toEqual({});
    expect(snap.prompts.fragmentMeta).toEqual({});
  });

  it("sandbox and agent are undefined when not in system settings", () => {
    mockLoadSystemSettings.mockReturnValue({});
    const snap = snapshotGlobalConfig();
    expect(snap.sandbox).toBeUndefined();
    expect(snap.agent).toBeUndefined();
  });

  it("collects MCPs from pipeline stages with parallel groups", () => {
    mockLoadPipelineConfig.mockReturnValue({
      name: "test",
      stages: [
        { name: "s1", type: "agent", mcps: ["mcp-x"] },
        { parallel: { name: "p1", stages: [
          { name: "s2", type: "agent", mcps: ["mcp-y"] },
          { name: "s3", type: "agent", mcps: ["mcp-x", "mcp-z"] },
        ]}},
      ],
    });
    const snap = snapshotGlobalConfig();
    expect(snap.mcps.sort()).toEqual(["mcp-x", "mcp-y", "mcp-z"]);
  });
});
