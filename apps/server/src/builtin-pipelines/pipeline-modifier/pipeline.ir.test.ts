import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("pipeline-modifier IR", () => {
  const irPath = join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "pipeline.ir.json");
  const ir = JSON.parse(readFileSync(irPath, "utf8")) as {
    name: string;
    externalInputs: Array<{ name: string; type: string }>;
    stages: Array<{ name: string; type: string }>;
    wires: Array<unknown>;
  };

  it("has the correct top-level name", () => {
    expect(ir.name).toBe("pipeline-modifier");
  });

  it("declares the three required externalInputs", () => {
    const names = ir.externalInputs.map((p) => p.name);
    expect(names).toContain("targetPipelineName");
    expect(names).toContain("modificationGoal");
    expect(names).toContain("failureContext");
  });

  it("has 6 stages in the documented order", () => {
    const stageNames = ir.stages.map((s) => s.name);
    expect(stageNames).toEqual([
      "loadCurrent",
      "analyzeGap",
      "awaitingConfirm",
      "genPatch",
      "validatePatch",
      "applying",
    ]);
  });

  it("loadCurrent and analyzeGap and genPatch and applying are agent stages", () => {
    const byName = Object.fromEntries(ir.stages.map((s) => [s.name, s]));
    expect(byName.loadCurrent.type).toBe("agent");
    expect(byName.analyzeGap.type).toBe("agent");
    expect(byName.genPatch.type).toBe("agent");
    expect(byName.applying.type).toBe("agent");
  });

  it("awaitingConfirm is a gate stage", () => {
    const gate = ir.stages.find((s) => s.name === "awaitingConfirm");
    expect(gate?.type).toBe("gate");
  });

  it("validatePatch is a registry-script stage bound to validate_patch_vs_intent (Bug 8b kernel guard)", () => {
    const stage = ir.stages.find((s) => s.name === "validatePatch") as
      | { type: string; config: { source: string; moduleId: string } }
      | undefined;
    expect(stage).toBeDefined();
    expect(stage!.type).toBe("script");
    expect(stage!.config.source).toBe("registry");
    expect(stage!.config.moduleId).toBe("validate_patch_vs_intent");
  });

  it("submits successfully via KernelService", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { initKernelNextSchema } = await import("../../kernel-next/ir/sql.js");
    const { KernelService } = await import("../../kernel-next/mcp/kernel.js");
    const { loadBuiltinPipelineIR } = await import("../../kernel-next/runtime/load-builtin-pipeline.js");

    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const loaded = loadBuiltinPipelineIR("pipeline-modifier");
    const svc = new KernelService(db, { skipTypeCheck: true });
    const res = await svc.submit(loaded.ir, { prompts: loaded.prompts });
    expect(res.ok).toBe(true);
  });
});
