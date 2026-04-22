import { describe, it, expect } from "vitest";
import { loadBuiltinPipelineIR, BuiltinPipelineLoadError } from "./load-builtin-pipeline.js";

describe("loadBuiltinPipelineIR", () => {
  it("loads smoke-test IR + prompts", () => {
    const r = loadBuiltinPipelineIR("smoke-test");
    expect(r.ir.name).toBeTruthy();
    expect(r.ir.stages.length).toBeGreaterThan(0);
    expect(r.pipelineDir).toMatch(/smoke-test$/);
    expect(r.promptRoot).toMatch(/smoke-test\/prompts$/);
    expect(Object.keys(r.prompts).length).toBeGreaterThan(0);
    expect(r.warnings).toEqual([]);
  });

  it("loads pipeline-generator with nested system/ prompts", () => {
    const r = loadBuiltinPipelineIR("pipeline-generator");
    const keys = Object.keys(r.prompts);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k).not.toMatch(/\.md$/);
      expect(k).not.toMatch(/\\/);
    }
    expect(keys.some((k) => k.includes("/"))).toBe(true);
  });

  it("throws BuiltinPipelineLoadError when pipeline.ir.json is missing", () => {
    expect(() => loadBuiltinPipelineIR("no-such-pipeline-xyz")).toThrow(BuiltinPipelineLoadError);
    try {
      loadBuiltinPipelineIR("no-such-pipeline-xyz");
    } catch (err) {
      const e = err as BuiltinPipelineLoadError;
      expect(e.diagnostics[0]?.code).toBe("IR_READ_FAILED");
    }
  });

  it("loads tech-research-collector", () => {
    const r = loadBuiltinPipelineIR("tech-research-collector");
    expect(r.ir.stages.length).toBeGreaterThan(0);
    expect(Object.keys(r.prompts).length).toBeGreaterThan(0);
  });

  it("loads tech-research-writer", () => {
    const r = loadBuiltinPipelineIR("tech-research-writer");
    expect(r.ir.stages.length).toBeGreaterThan(0);
    expect(Object.keys(r.prompts).length).toBeGreaterThan(0);
  });
});
