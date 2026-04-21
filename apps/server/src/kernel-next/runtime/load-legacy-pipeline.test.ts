import { describe, it, expect, vi } from "vitest";
import { loadLegacyPipelineIR, LegacyPipelineLoadError } from "./load-legacy-pipeline.js";

describe("loadLegacyPipelineIR", () => {
  it("loads pipeline-generator YAML into IR", () => {
    const result = loadLegacyPipelineIR("pipeline-generator");
    expect(result.ir.stages.length).toBeGreaterThan(0);
    expect(result.promptRoot).toMatch(/pipeline-generator\/prompts$/);
    expect(result.yamlFilePath).toMatch(/pipeline-generator\/pipeline\.yaml$/);
  });

  it("returns warnings array (possibly empty)", () => {
    const result = loadLegacyPipelineIR("pipeline-generator");
    expect(Array.isArray(result.warnings)).toBe(true);
    for (const w of result.warnings) {
      expect(typeof w.code).toBe("string");
    }
  });

  it("throws LegacyPipelineLoadError with diagnostics for nonexistent pipeline", () => {
    expect(() => loadLegacyPipelineIR("does-not-exist-xyz")).toThrow(LegacyPipelineLoadError);
  });
});

describe("loadLegacyPipelineIR — prompt scanning", () => {
  it("returns a prompts map scanned from <pipelineDir>/prompts/**/*.md", () => {
    // smoke-test ships at least one prompt; confirm the map is populated.
    const result = loadLegacyPipelineIR("smoke-test");
    expect(Object.keys(result.prompts).length).toBeGreaterThan(0);
    for (const v of Object.values(result.prompts)) {
      expect(typeof v).toBe("string");
      expect(v.length).toBeGreaterThan(0);
    }
  });

  it("uses /-joined relative paths without .md for nested prompts", () => {
    // pipeline-generator has prompts/system/*.md
    const result = loadLegacyPipelineIR("pipeline-generator");
    const keys = Object.keys(result.prompts);
    for (const k of keys) {
      expect(k).not.toMatch(/\.md$/);
      expect(k).not.toMatch(/\\/);
    }
    expect(keys.some((k) => k.includes("/"))).toBe(true);
  });
});

describe("loadLegacyPipelineIR — conversion failure", () => {
  it("throws LegacyPipelineLoadError with converter diagnostics", async () => {
    vi.resetModules();
    vi.doMock("../converter/legacy-yaml.js", () => ({
      convertLegacyYaml: () => ({
        ok: false,
        diagnostics: [{ code: "LEGACY_SCHEMA_INVALID", message: "bad yaml" }],
      }),
    }));
    const mod = await import("./load-legacy-pipeline.js");
    try {
      mod.loadLegacyPipelineIR("pipeline-generator");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(mod.LegacyPipelineLoadError);
      expect((err as InstanceType<typeof mod.LegacyPipelineLoadError>).diagnostics[0].code).toBe("LEGACY_SCHEMA_INVALID");
    }
    vi.doUnmock("../converter/legacy-yaml.js");
    vi.resetModules();
  });
});
