import { describe, it, expect } from "vitest";
import { loadLegacyPipelineIR, LegacyPipelineLoadError } from "./load-legacy-pipeline.js";

describe("loadLegacyPipelineIR", () => {
  it("loads pipeline-generator YAML into IR", () => {
    const result = loadLegacyPipelineIR("pipeline-generator");
    expect(result.ir.stages.length).toBeGreaterThan(0);
    expect(result.promptRoot).toMatch(/pipeline-generator\/prompts$/);
    expect(result.yamlFilePath).toMatch(/pipeline-generator\/pipeline\.yaml$/);
  });

  it("returns warnings array", () => {
    const result = loadLegacyPipelineIR("pipeline-generator");
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it("throws LegacyPipelineLoadError with diagnostics for nonexistent pipeline", () => {
    expect(() => loadLegacyPipelineIR("does-not-exist-xyz")).toThrow(LegacyPipelineLoadError);
  });
});
