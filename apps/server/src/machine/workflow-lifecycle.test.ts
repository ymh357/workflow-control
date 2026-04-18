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

describe("snapshotGlobalConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadPipelineConfig.mockReturnValue({
      name: "test",
      stages: [
        { name: "s1", type: "agent", mcps: ["mcp-a"] },
        { name: "s2", type: "agent", mcps: ["mcp-b", "mcp-a"] },
      ],
      skills: ["sk1"],
    });
    mockLoadPipelineConstraints.mockReturnValue("no bad code");
    mockLoadPipelineSystemPrompt.mockReturnValue(null);
    mockGetFragmentRegistry.mockReturnValue({
      getAllEntries: () => new Map<string, { content: string; meta: { id: string; keywords: string[]; stages: string[]; always: boolean } }>(),
    });
    mockLoadSystemSettings.mockReturnValue({
      sandbox: { enabled: true },
      agent: { default_engine: "claude" },
    });
    mockExistsSync.mockReturnValue(false);
  });

  it("uses 'pipeline-generator' as default pipeline name", () => {
    snapshotGlobalConfig();
    expect(mockLoadPipelineConfig).toHaveBeenCalledWith("pipeline-generator");
  });

  it("uses provided pipeline name", () => {
    snapshotGlobalConfig("custom-pipeline");
    expect(mockLoadPipelineConfig).toHaveBeenCalledWith("custom-pipeline");
  });

  it("throws when pipeline config is not found", () => {
    mockLoadPipelineConfig.mockReturnValue(null);
    expect(() => snapshotGlobalConfig("missing")).toThrow(/Pipeline config not found for "missing"/);
  });

  it("returns snapshot with pipeline and pipelineName", () => {
    const snap = snapshotGlobalConfig("my-pipe");
    expect(snap.pipelineName).toBe("my-pipe");
    expect(snap.pipeline).toEqual(expect.objectContaining({ name: "test" }));
  });

  it("collects MCPs only from pipeline stages", () => {
    const snap = snapshotGlobalConfig();
    expect(snap.mcps.sort()).toEqual(["mcp-a", "mcp-b"]);
  });

  it("returns empty MCPs when no stages reference MCPs", () => {
    mockLoadPipelineConfig.mockReturnValue({ name: "test", stages: [{ name: "s1", type: "agent" }] });
    const snap = snapshotGlobalConfig();
    expect(snap.mcps).toEqual([]);
  });

  it("includes global constraints", () => {
    const snap = snapshotGlobalConfig();
    expect(snap.prompts.globalConstraints).toBe("no bad code");
  });

  it("defaults global constraints to empty string when null", () => {
    mockLoadPipelineConstraints.mockReturnValue(null);
    const snap = snapshotGlobalConfig();
    expect(snap.prompts.globalConstraints).toBe("");
  });

  it("loads system prompts from pipeline prompts directory", () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p).includes("prompts/system");
    });
    mockReaddirSync.mockReturnValue(["code-review.md", "analysis.md"] as any);
    mockLoadPipelineSystemPrompt.mockImplementation((_pipeline: string, name: string) => `prompt for ${name}`);

    const snap = snapshotGlobalConfig();
    expect(snap.prompts.system).toEqual({
      codeReview: "prompt for code-review",
      analysis: "prompt for analysis",
    });
  });

  it("converts kebab-case filenames to camelCase keys", () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p).includes("prompts/system");
    });
    mockReaddirSync.mockReturnValue(["my-long-name.md"] as any);
    mockLoadPipelineSystemPrompt.mockReturnValue("content");

    const snap = snapshotGlobalConfig();
    expect(snap.prompts.system).toHaveProperty("myLongName");
  });

  it("does not load fragments from global registry (pipeline isolation)", () => {
    const snap = snapshotGlobalConfig();
    expect(snap.prompts.fragments).toEqual({});
    expect(snap.prompts.fragmentMeta).toEqual({});
  });

  it("reads globalClaudeMd from pipeline.claude_md.global", () => {
    mockLoadPipelineConfig.mockReturnValue({
      name: "test", stages: [],
      claude_md: { global: "# Pipeline Claude Instructions" },
    });
    const snap = snapshotGlobalConfig();
    expect(snap.prompts.globalClaudeMd).toBe("# Pipeline Claude Instructions");
  });

  it("reads globalGeminiMd from pipeline.gemini_md.global", () => {
    mockLoadPipelineConfig.mockReturnValue({
      name: "test", stages: [],
      gemini_md: { global: "# Pipeline Gemini Instructions" },
    });
    const snap = snapshotGlobalConfig();
    expect(snap.prompts.globalGeminiMd).toBe("# Pipeline Gemini Instructions");
  });

  it("defaults globalClaudeMd and globalGeminiMd to empty when pipeline has no claude_md/gemini_md", () => {
    mockLoadPipelineConfig.mockReturnValue({ name: "test", stages: [] });
    const snap = snapshotGlobalConfig();
    expect(snap.prompts.globalClaudeMd).toBe("");
    expect(snap.prompts.globalGeminiMd).toBe("");
  });

  it("includes skills from pipeline config", () => {
    const snap = snapshotGlobalConfig();
    expect(snap.skills).toEqual(["sk1"]);
  });

  it("defaults skills to empty array when pipeline has none", () => {
    mockLoadPipelineConfig.mockReturnValue({ name: "test", stages: [] });
    const snap = snapshotGlobalConfig();
    expect(snap.skills).toEqual([]);
  });

  it("includes sandbox and agent settings from system settings", () => {
    const snap = snapshotGlobalConfig();
    expect(snap.sandbox).toEqual({ enabled: true });
    expect(snap.agent).toEqual({ default_engine: "claude" });
  });

  // Phase 2 / Step 2.3 — pipelineVersionHash captured with the snapshot

  it("captures a 64-char pipelineVersionHash", () => {
    const snap = snapshotGlobalConfig();
    expect(snap.pipelineVersionHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("pipelineVersionHash is stable across calls with identical inputs", () => {
    const first = snapshotGlobalConfig();
    const second = snapshotGlobalConfig();
    expect(second.pipelineVersionHash).toBe(first.pipelineVersionHash);
  });

  it("pipelineVersionHash changes when pipeline structure changes", () => {
    const before = snapshotGlobalConfig().pipelineVersionHash!;
    mockLoadPipelineConfig.mockReturnValue({
      name: "test",
      stages: [
        { name: "s1", type: "agent", mcps: ["mcp-a"] },
        { name: "s2", type: "agent", mcps: ["mcp-b", "mcp-a"] },
        { name: "s3", type: "agent" }, // new stage added
      ],
      skills: ["sk1"],
    });
    const after = snapshotGlobalConfig().pipelineVersionHash!;
    expect(after).not.toBe(before);
  });

  it("pipelineVersionHash changes when an activated fragment's content changes", () => {
    // Fragment set 1
    mockGetFragmentRegistry.mockReturnValue({
      getAllEntries: () =>
        new Map([
          [
            "global-inv",
            {
              content: "v1",
              meta: { id: "global-inv", keywords: [], stages: "*", always: true },
            },
          ],
        ]),
    });
    const before = snapshotGlobalConfig().pipelineVersionHash!;
    // Fragment set 2 (same id, different content)
    mockGetFragmentRegistry.mockReturnValue({
      getAllEntries: () =>
        new Map([
          [
            "global-inv",
            {
              content: "v2",
              meta: { id: "global-inv", keywords: [], stages: "*", always: true },
            },
          ],
        ]),
    });
    const after = snapshotGlobalConfig().pipelineVersionHash!;
    expect(after).not.toBe(before);
  });
});
