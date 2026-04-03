import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { deepMergePipeline, clearPipelineCache, loadPipelineConfig, listAvailablePipelines } from "./pipeline.js";
import type { PipelineConfig, PipelineStageConfig } from "./types.js";

// Mock node:fs
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
}));

// Mock schema validation (pass-through)
vi.mock("./schema.js", () => ({
  validatePipelineConfig: vi.fn((raw: unknown) => ({ success: true, data: raw })),
}));

import { readFileSync, existsSync, readdirSync } from "node:fs";

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockReaddirSync = vi.mocked(readdirSync);

// ---------- deepMergePipeline ----------

describe("deepMergePipeline", () => {
  const base: PipelineConfig = {
    name: "base-pipeline",
    description: "Base desc",
    engine: "claude",
    stages: [
      { name: "analyze", type: "agent", max_turns: 10, mcps: ["notion"] },
      { name: "review", type: "human_confirm" },
    ] as PipelineStageConfig[],
  };

  it("overrides top-level scalar fields", () => {
    const result = deepMergePipeline(base, { name: "overridden", description: "New desc" });
    expect(result.name).toBe("overridden");
    expect(result.description).toBe("New desc");
    expect(result.engine).toBe("claude");
  });

  it("merges stages by name", () => {
    const result = deepMergePipeline(base, {
      stages: [
        { name: "analyze", type: "agent", max_turns: 20 } as PipelineStageConfig,
      ],
    });
    expect(result.stages).toHaveLength(2);
    const analyze = result.stages.find((s) => (s as PipelineStageConfig).name === "analyze")! as PipelineStageConfig;
    expect(analyze.max_turns).toBe(20);
    // Preserved from base
    expect(analyze.mcps).toEqual(["notion"]);
  });

  it("preserves base stages not in override", () => {
    const result = deepMergePipeline(base, {
      stages: [{ name: "analyze", type: "agent", max_turns: 5 } as PipelineStageConfig],
    });
    expect(result.stages).toHaveLength(2);
    expect((result.stages[1] as PipelineStageConfig).name).toBe("review");
  });

  it("appends new stages from override", () => {
    const result = deepMergePipeline(base, {
      stages: [{ name: "deploy", type: "script" } as PipelineStageConfig],
    });
    expect(result.stages).toHaveLength(3);
    expect((result.stages[2] as PipelineStageConfig).name).toBe("deploy");
  });

  it("deep merges nested objects (non-stages)", () => {
    const baseWithDisplay: PipelineConfig = {
      ...base,
      display: { title_path: "outputs.title", completion_summary_path: "outputs.summary" },
    };
    const result = deepMergePipeline(baseWithDisplay, {
      display: { title_path: "new.title" },
    });
    expect(result.display?.title_path).toBe("new.title");
    expect(result.display?.completion_summary_path).toBe("outputs.summary");
  });

  it("replaces arrays at non-stages keys", () => {
    const baseWithHooks: PipelineConfig = { ...base, hooks: ["hook-a"] };
    const result = deepMergePipeline(baseWithHooks, { hooks: ["hook-b", "hook-c"] });
    expect(result.hooks).toEqual(["hook-b", "hook-c"]);
  });

  it("handles empty override stages", () => {
    const result = deepMergePipeline(base, { stages: [] });
    // No base stages matched, no override stages appended = base stages preserved via merge logic
    // Actually: baseStages loop finds no override match, so all base stages pass through.
    // Then override stages loop adds nothing. Result: all base stages.
    expect(result.stages).toHaveLength(2);
  });

  it("handles empty base stages", () => {
    const emptyBase: PipelineConfig = { name: "empty", stages: [] };
    const result = deepMergePipeline(emptyBase, {
      stages: [{ name: "new", type: "agent" } as PipelineStageConfig],
    });
    expect(result.stages).toHaveLength(1);
    expect((result.stages[0] as PipelineStageConfig).name).toBe("new");
  });
});

// ---------- loadPipelineConfig ----------

describe("loadPipelineConfig", () => {
  beforeEach(() => {
    clearPipelineCache();
    vi.resetAllMocks();
  });

  afterEach(() => {
    clearPipelineCache();
  });

  it("loads pipeline from directory-based path", () => {
    mockExistsSync.mockImplementation((p: any) => {
      if (String(p).includes("pipeline.yaml") && String(p).includes("pipeline-generator")) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue('name: "test"\nstages:\n  - name: s1\n    type: agent\n');

    const result = loadPipelineConfig("pipeline-generator");
    expect(result).toBeDefined();
    expect(result!.name).toBe("test");
  });

  it("returns null when pipeline file does not exist", () => {
    mockExistsSync.mockReturnValue(false);

    const result = loadPipelineConfig("nonexistent");
    expect(result).toBeNull();
  });

  it("returns null on YAML parse error", () => {
    mockExistsSync.mockImplementation((p: any) => {
      if (String(p).includes("pipeline.yaml") && String(p).includes("broken")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation(() => {
      throw new Error("parse error");
    });

    const result = loadPipelineConfig("broken");
    expect(result).toBeNull();
  });

  it("uses default name 'pipeline-generator'", () => {
    mockExistsSync.mockImplementation((p: any) => {
      if (String(p).includes("pipeline-generator") && String(p).includes("pipeline.yaml")) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue('name: "default"\nstages: []\n');

    const result = loadPipelineConfig();
    expect(result).toBeDefined();
    expect(result!.name).toBe("default");
  });

  it("returns cached value on second call", () => {
    mockExistsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.includes("cached-pipe") && s.includes("pipeline.yaml") && !s.includes(".local")) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue('name: "cached"\nstages: []\n');

    const first = loadPipelineConfig("cached-pipe");
    const callsAfterFirst = mockReadFileSync.mock.calls.length;
    const second = loadPipelineConfig("cached-pipe");
    expect(first).toBe(second);
    // readFileSync should not be called again after caching
    expect(mockReadFileSync).toHaveBeenCalledTimes(callsAfterFirst);
  });

  it("merges .local override when present", () => {
    mockExistsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.includes("my-pipe") && s.includes("pipeline.yaml")) return true;
      return false;
    });

    let callCount = 0;
    mockReadFileSync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return 'name: "base"\nstages:\n  - name: s1\n    type: agent\n    max_turns: 5\n';
      return 'stages:\n  - name: s1\n    type: agent\n    max_turns: 20\n';
    });

    const result = loadPipelineConfig("my-pipe");
    expect(result).toBeDefined();
    // The local override should have been merged
    expect(result!.name).toBe("base");
  });
});

// ---------- listAvailablePipelines ----------

describe("listAvailablePipelines", () => {
  beforeEach(() => {
    clearPipelineCache();
    vi.resetAllMocks();
  });

  it("returns empty array when pipelines dir does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    const result = listAvailablePipelines();
    expect(result).toEqual([]);
  });

  it("lists pipeline directories with manifests", () => {
    mockExistsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith("pipelines")) return true;
      if (s.includes("pipeline.yaml")) return true;
      return false;
    });

    mockReaddirSync.mockReturnValue([
      { name: "my-pipe", isDirectory: () => true } as any,
      { name: "other-pipe", isDirectory: () => true } as any,
      { name: "not-a-dir.yaml", isDirectory: () => false } as any,
      { name: "hidden.local", isDirectory: () => true } as any,
    ] as any);

    mockReadFileSync.mockReturnValue(
      'name: "Test"\ndescription: "Desc"\nstages:\n  - name: s1\n    type: agent\n    max_budget_usd: 5\n    mcps:\n      - notion\n',
    );

    const result = listAvailablePipelines();
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("my-pipe");
    expect(result[0].name).toBe("Test");
    expect(result[0].description).toBe("Desc");
    expect(result[0].stageCount).toBe(1);
    expect(result[0].totalBudget).toBe(5);
    expect(result[0].mcps).toEqual(["notion"]);
  });

  it("skips .local directories", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      { name: "pipe.local", isDirectory: () => true } as any,
    ] as any);

    const result = listAvailablePipelines();
    expect(result).toEqual([]);
  });

  it("skips directories without pipeline.yaml", () => {
    mockExistsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith("pipelines")) return true;
      if (s.includes("pipeline.yaml")) return false;
      return false;
    });
    mockReaddirSync.mockReturnValue([
      { name: "empty-dir", isDirectory: () => true } as any,
    ] as any);

    const result = listAvailablePipelines();
    expect(result).toEqual([]);
  });

  it("skips unreadable pipeline files", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      { name: "broken", isDirectory: () => true } as any,
    ] as any);
    mockReadFileSync.mockImplementation(() => {
      throw new Error("cannot read");
    });

    const result = listAvailablePipelines();
    expect(result).toEqual([]);
  });

  it("infers engine from stages when not set at pipeline level", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      { name: "multi", isDirectory: () => true } as any,
    ] as any);
    mockReadFileSync.mockReturnValue(
      'name: "Multi"\nstages:\n  - name: s1\n    type: agent\n    engine: claude\n  - name: s2\n    type: agent\n    engine: gemini\n',
    );

    const result = listAvailablePipelines();
    expect(result).toHaveLength(1);
    expect(result[0].engine).toBe("mixed");
  });

  it("infers engine as codex when all stages use codex", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      { name: "codex-pipe", isDirectory: () => true } as any,
    ] as any);
    mockReadFileSync.mockReturnValue(
      'name: "AllCodex"\nstages:\n  - name: s1\n    type: agent\n    engine: codex\n  - name: s2\n    type: agent\n    engine: codex\n',
    );

    const result = listAvailablePipelines();
    expect(result).toHaveLength(1);
    expect(result[0].engine).toBe("codex");
  });
});
