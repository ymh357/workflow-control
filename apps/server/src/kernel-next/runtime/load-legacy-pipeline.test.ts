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
