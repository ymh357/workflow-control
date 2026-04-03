import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PipelineConfig, PipelineStageConfig } from "./types.js";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
}));

vi.mock("./schema.js", () => ({
  validatePipelineConfig: vi.fn((raw: unknown) => ({ success: true, data: raw })),
}));

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { deepMergePipeline, clearPipelineCache, loadPipelineConfig, listAvailablePipelines } from "./pipeline.js";

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockReaddirSync = vi.mocked(readdirSync);

describe("deepMergePipeline adversarial", () => {
  it("does not mutate the base object", () => {
    const base: PipelineConfig = {
      name: "base",
      stages: [{ name: "s1", type: "agent", max_turns: 5 } as PipelineStageConfig],
    };
    const baseStageRef = base.stages[0];
    deepMergePipeline(base, {
      stages: [{ name: "s1", type: "agent", max_turns: 20 } as PipelineStageConfig],
    });
    expect((baseStageRef as PipelineStageConfig).max_turns).toBe(5);
    expect(base.name).toBe("base");
  });

  it("handles override with undefined stages (no stage merge)", () => {
    const base: PipelineConfig = {
      name: "base",
      stages: [{ name: "s1", type: "agent" } as PipelineStageConfig],
    };
    const result = deepMergePipeline(base, { description: "added" });
    expect(result.stages).toHaveLength(1);
    expect(result.description).toBe("added");
  });

  it("handles duplicate stage names in override (uses first match)", () => {
    const base: PipelineConfig = {
      name: "base",
      stages: [{ name: "s1", type: "agent", max_turns: 5 } as PipelineStageConfig],
    };
    const result = deepMergePipeline(base, {
      stages: [
        { name: "s1", type: "agent", max_turns: 10 } as PipelineStageConfig,
        { name: "s1", type: "agent", max_turns: 20 } as PipelineStageConfig,
      ],
    });
    // First override match for "s1" wins in the base loop
    const s1 = result.stages.filter((s) => (s as PipelineStageConfig).name === "s1") as PipelineStageConfig[];
    expect(s1[0].max_turns).toBe(10);
    // Second "s1" in override is NOT in usedOverrideNames? Actually it IS because
    // usedOverrideNames.add is called for the first match. The second "s1" in override
    // will be skipped in the append loop because the name is in usedOverrideNames.
    // But wait: only the first s1 match is added. Let me check the logic again.
    // override.stages.find returns first match for "s1", adds it, usedOverrideNames has "s1".
    // In append loop, both override stages have name "s1" which is in usedOverrideNames, so neither appended.
    expect(result.stages).toHaveLength(1);
  });

  it("deep merges nested runtime objects within stages", () => {
    const base: PipelineConfig = {
      name: "base",
      stages: [{
        name: "s1",
        type: "agent",
        runtime: { engine: "llm" as const, system_prompt: "base", writes: ["out1"] },
      } as PipelineStageConfig],
    };
    const result = deepMergePipeline(base, {
      stages: [{
        name: "s1",
        type: "agent",
        runtime: { engine: "llm" as const, system_prompt: "override" },
      } as PipelineStageConfig],
    });
    // deepMergeObjects merges runtime; writes from base is overwritten because
    // override runtime doesn't have writes (the key doesn't exist in override)
    // Actually: deepMergeObjects spreads base first, then iterates override keys.
    // Since override.runtime doesn't have "writes", base.runtime.writes is preserved.
    const stage = result.stages[0] as PipelineStageConfig;
    expect((stage.runtime as any).system_prompt).toBe("override");
    expect((stage.runtime as any).writes).toEqual(["out1"]);
  });

  it("replaces arrays (non-stages) rather than merging", () => {
    const base: PipelineConfig = {
      name: "base",
      stages: [],
      use_cases: ["original"],
    };
    const result = deepMergePipeline(base, { use_cases: ["new1", "new2"] });
    expect(result.use_cases).toEqual(["new1", "new2"]);
  });

  it("handles null values in override", () => {
    const base: PipelineConfig = {
      name: "base",
      description: "has desc",
      stages: [],
    };
    const result = deepMergePipeline(base, { description: undefined });
    // undefined keys are iterated in Object.keys, but value is undefined
    // isPlainObject(undefined) = false, so result[key] = undefined
    expect(result.description).toBeUndefined();
  });
});

describe("loadPipelineConfig adversarial", () => {
  beforeEach(() => {
    clearPipelineCache();
    vi.resetAllMocks();
  });

  afterEach(() => {
    clearPipelineCache();
  });

  it("falls back to legacy single-file path when directory path doesn't exist", () => {
    mockExistsSync.mockImplementation((p: any) => {
      const s = String(p);
      // Directory-based path doesn't exist
      if (s.includes("legacy-pipe") && s.includes("pipeline.yaml")) return false;
      // Legacy path exists
      if (s.endsWith("legacy-pipe.yaml")) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue('name: "legacy"\nstages: []\n');

    const result = loadPipelineConfig("legacy-pipe");
    expect(result).toBeDefined();
    expect(result!.name).toBe("legacy");
  });

  it("caches null for nonexistent pipeline", () => {
    mockExistsSync.mockReturnValue(false);

    const first = loadPipelineConfig("ghost");
    expect(first).toBeNull();

    // Second call should use cache, not hit fs again
    const callsBefore = mockExistsSync.mock.calls.length;
    const second = loadPipelineConfig("ghost");
    expect(second).toBeNull();
    expect(mockExistsSync.mock.calls.length).toBe(callsBefore);
  });

  it("handles YAML that parses to null (empty file returns null as config)", () => {
    mockExistsSync.mockImplementation((p: any) => {
      if (String(p).includes("null-yaml") && String(p).includes("pipeline.yaml")) return true;
      return false;
    });
    // Empty YAML document parses to null
    mockReadFileSync.mockReturnValue("");

    const result = loadPipelineConfig("null-yaml");
    // parseYAML("") returns null, validateAndWarn casts null as PipelineConfig
    // which is still null, so loadPipelineConfig returns null
    expect(result).toBeNull();
  });

  it("handles local override that throws (gracefully skips)", () => {
    let readCount = 0;
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      readCount++;
      if (readCount === 1) return 'name: "base"\nstages: []\n';
      throw new Error("local read failed");
    });

    const result = loadPipelineConfig("with-bad-local");
    // Base should be returned despite local override failing
    expect(result).toBeDefined();
    expect(result!.name).toBe("base");
  });

  it("isolates cache entries for different pipeline names", () => {
    mockExistsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.includes("pipeline.yaml") && (s.includes("pipe-a") || s.includes("pipe-b"))) return true;
      return false;
    });
    let callCount = 0;
    mockReadFileSync.mockImplementation(() => {
      callCount++;
      return `name: "pipe-${callCount}"\nstages: []\n`;
    });

    const a = loadPipelineConfig("pipe-a");
    const b = loadPipelineConfig("pipe-b");
    expect(a!.name).not.toBe(b!.name);
  });
});

describe("listAvailablePipelines adversarial", () => {
  beforeEach(() => {
    clearPipelineCache();
    vi.resetAllMocks();
  });

  it("infers claude engine when no stages have engine set", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      { name: "no-engine", isDirectory: () => true } as any,
    ] as any);
    mockReadFileSync.mockReturnValue('name: "NoEngine"\nstages:\n  - name: s1\n    type: agent\n');

    const result = listAvailablePipelines();
    expect(result[0].engine).toBe("claude");
  });

  it("infers single engine when all stages use same engine", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      { name: "all-gemini", isDirectory: () => true } as any,
    ] as any);
    mockReadFileSync.mockReturnValue(
      'name: "AllGemini"\nstages:\n  - name: s1\n    type: agent\n    engine: gemini\n  - name: s2\n    type: agent\n    engine: gemini\n',
    );

    const result = listAvailablePipelines();
    expect(result[0].engine).toBe("gemini");
  });

  it("omits totalBudget when sum is 0", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      { name: "no-budget", isDirectory: () => true } as any,
    ] as any);
    mockReadFileSync.mockReturnValue('name: "NoBudget"\nstages:\n  - name: s1\n    type: agent\n');

    const result = listAvailablePipelines();
    expect(result[0].totalBudget).toBeUndefined();
  });

  it("uses directory name as fallback when parsed.name is empty", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      { name: "dir-name", isDirectory: () => true } as any,
    ] as any);
    mockReadFileSync.mockReturnValue('name: ""\nstages: []\n');

    const result = listAvailablePipelines();
    // Empty string is falsy, so `parsed.name || entry.name` falls to dir name
    expect(result[0].name).toBe("dir-name");
  });

  it("limits stageSummary to first 6 agent stages", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      { name: "many-stages", isDirectory: () => true } as any,
    ] as any);
    const stages = Array.from({ length: 10 }, (_, i) =>
      `  - name: s${i}\n    type: agent`
    ).join("\n");
    mockReadFileSync.mockReturnValue(`name: "Many"\nstages:\n${stages}\n`);

    const result = listAvailablePipelines();
    const summary = result[0].stageSummary!;
    expect(summary.split(" → ")).toHaveLength(6);
  });

  it("excludes non-agent stages from stageSummary", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      { name: "mixed-types", isDirectory: () => true } as any,
    ] as any);
    mockReadFileSync.mockReturnValue(
      'name: "Mixed"\nstages:\n  - name: analyze\n    type: agent\n  - name: review\n    type: human_confirm\n  - name: deploy\n    type: script\n',
    );

    const result = listAvailablePipelines();
    expect(result[0].stageSummary).toBe("analyze");
  });
});
