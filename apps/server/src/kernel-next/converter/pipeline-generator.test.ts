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

  it("awaitingConfirm gate has an inbound wire from analyzing (predecessor signal)", () => {
    const yaml = readFileSync(PIPELINE_YAML, "utf8");
    const r = convertLegacyYaml(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const gate = r.ir.stages.find(s => s.name === "awaitingConfirm");
    expect(gate?.type).toBe("gate");
    if (gate?.type !== "gate") return;
    // Gate receives a synthetic predecessor-signal input port so it
    // does not activate before analyzing completes.
    expect(gate.inputs).toHaveLength(1);
    expect(gate.inputs[0]!.name).toBe("__gate_signal");
    // And a matching wire exists whose source is analyzing.
    const gateWires = r.ir.wires.filter(
      w => w.to.stage === "awaitingConfirm" && w.to.port === "__gate_signal",
    );
    expect(gateWires).toHaveLength(1);
    const w = gateWires[0]!;
    if (w.from.source !== "stage") throw new Error("expected stage source");
    expect(w.from.stage).toBe("analyzing");
  });

  it("persisting.retry extracted with back_to rewritten from block to first inner stage (genSkeleton)", () => {
    const yaml = readFileSync(PIPELINE_YAML, "utf8");
    const r = convertLegacyYaml(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.ir.stages.find(s => s.name === "persisting");
    expect(p?.type).toBe("script");
    if (p?.type !== "script") return;
    // pipeline-generator.yaml has persisting.retry = { max_retries: 1, back_to: generating }
    // rewriteRetryBackTo (Task A7) redirects "generating" (parallel block
    // name) to "genSkeleton" (first inner stage of the unwrapped block).
    expect(p.config.retry).toEqual({ maxRetries: 1, backToStage: "genSkeleton" });
    expect(r.warnings.some(w => w.code === "RETRY_BACK_TO_REDIRECTED")).toBe(true);
  });

  it("genPrompts.runtime.agents extracted into config.subAgents with prompt-writer", () => {
    const yaml = readFileSync(PIPELINE_YAML, "utf8");
    const r = convertLegacyYaml(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const genPrompts = r.ir.stages.find(s => s.name === "genPrompts");
    expect(genPrompts?.type).toBe("agent");
    if (genPrompts?.type !== "agent") return;
    expect(genPrompts.config.subAgents).toBeDefined();
    expect(genPrompts.config.subAgents!.map(sa => sa.name)).toContain("prompt-writer");
    const writer = genPrompts.config.subAgents!.find(sa => sa.name === "prompt-writer")!;
    expect(writer.tools).toEqual(["Read", "Write"]);
    expect(writer.model).toBe("sonnet");
    expect(writer.maxTurns).toBe(20);
  });
});
