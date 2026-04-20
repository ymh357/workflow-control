import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { convertLegacyYaml } from "./legacy-yaml.js";

const PIPELINE_YAML = path.resolve(
  __dirname,
  "../../builtin-pipelines/pipeline-generator/pipeline.yaml",
);

describe("convertLegacyYaml(pipeline-generator.yaml) — Slice A", () => {
  it("converts without fatal diagnostics", () => {
    const yaml = readFileSync(PIPELINE_YAML, "utf8");
    const r = convertLegacyYaml(yaml);
    if (!r.ok) {
      // Surface diagnostics in test output when this fails for diagnosis.
      console.log("diagnostics:", JSON.stringify(r.diagnostics, null, 2));
    }
    expect(r.ok).toBe(true);
  });

  it("produces 6 top-level stages in document order", () => {
    const yaml = readFileSync(PIPELINE_YAML, "utf8");
    const r = convertLegacyYaml(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const names = r.ir.stages.map(s => s.name);
    expect(names).toEqual([
      "analyzing",
      "awaitingConfirm",
      "genSkeleton",
      "genPrompts",
      "refinePrompts",
      "persisting",
    ]);
  });

  it("awaitingConfirm becomes a gate with array approve target (genSkeleton + genPrompts)", () => {
    const yaml = readFileSync(PIPELINE_YAML, "utf8");
    const r = convertLegacyYaml(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const gate = r.ir.stages.find(s => s.name === "awaitingConfirm");
    expect(gate?.type).toBe("gate");
    if (gate?.type !== "gate") return;
    const approve = gate.config.routing.routes.approve;
    expect(approve).toEqual(["genSkeleton", "genPrompts"]);
    expect(gate.config.routing.routes.reject).toBe("analyzing");
  });

  it("persisting.retry is dropped with LEGACY_FIELD_IGNORED (Slice A placeholder)", () => {
    // Slice A drops runtime.retry silently with a warning; Slice C
    // will promote this to real ScriptStage.config.retry extraction.
    const yaml = readFileSync(PIPELINE_YAML, "utf8");
    const r = convertLegacyYaml(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const retryWarnings = r.warnings.filter(
      w => w.code === "LEGACY_FIELD_IGNORED" && w.context?.field === "retry",
    );
    expect(retryWarnings.length).toBeGreaterThan(0);
    // persisting in Slice A should NOT carry config.retry yet.
    const persisting = r.ir.stages.find(s => s.name === "persisting");
    if (persisting?.type === "script") {
      expect(persisting.config.retry).toBeUndefined();
    }
  });

  it("genPrompts.runtime.agents is dropped with LEGACY_FIELD_IGNORED (Slice A placeholder)", () => {
    // Slice A drops runtime.agents silently with a warning; Slice D
    // will promote this to real AgentStage.config.subAgents extraction.
    const yaml = readFileSync(PIPELINE_YAML, "utf8");
    const r = convertLegacyYaml(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const agentsWarnings = r.warnings.filter(
      w => w.code === "LEGACY_FIELD_IGNORED" && w.context?.field === "agents",
    );
    expect(agentsWarnings.length).toBeGreaterThan(0);
  });
});
