import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../../kernel-next/ir/sql.js";
import { KernelService } from "../../kernel-next/mcp/kernel.js";
import { loadBuiltinPipelineIR } from "../../kernel-next/runtime/load-builtin-pipeline.js";

describe("forge-distill builtin", () => {
  it("loads, validates, and submits cleanly", async () => {
    const loaded = loadBuiltinPipelineIR("forge-distill");
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const r = await svc.submit(loaded.ir, { prompts: loaded.prompts });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.versionHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("has a single distill stage with the expected ports", () => {
    const { ir } = loadBuiltinPipelineIR("forge-distill");
    expect(ir.stages).toHaveLength(1);
    const s = ir.stages[0]!;
    expect(s.name).toBe("distill");
    expect(s.type).toBe("agent");
    expect(s.outputs.find((p) => p.name === "episodes_json")).toBeDefined();
  });

  it("session_mode is single", () => {
    const { ir } = loadBuiltinPipelineIR("forge-distill");
    expect(ir.session_mode).toBe("single");
  });

  it("has the system/distill prompt loaded", () => {
    const { prompts } = loadBuiltinPipelineIR("forge-distill");
    expect(prompts["system/distill"]).toBeDefined();
    expect(prompts["system/distill"]!.length).toBeGreaterThan(500);
  });
});
