import { describe, it, expect } from "vitest";
import { computePipelineDiff } from "./diff.js";
import type { PipelineIR } from "../ir/schema.js";

function agentStage(name: string, promptRef = "p-" + name): PipelineIR["stages"][number] {
  return {
    name,
    type: "agent",
    config: { promptRef },
    inputs: [],
    outputs: [{ name: "out", type: "string" }],
  };
}

function irWith(stages: PipelineIR["stages"], wires: PipelineIR["wires"] = []): PipelineIR {
  return { name: "test", stages, wires };
}

describe("computePipelineDiff", () => {
  it("empty patch produces empty diff", () => {
    const ir = irWith([agentStage("a")]);
    const d = computePipelineDiff(ir, ir);
    expect(d.stages.added).toEqual([]);
    expect(d.stages.removed).toEqual([]);
    expect(d.stages.modified).toEqual([]);
    expect(d.wires.added).toEqual([]);
    expect(d.wires.removed).toEqual([]);
    expect(d.categoryUnion).toEqual([]);
  });

  it("detects added stage", () => {
    const base = irWith([agentStage("a")]);
    const proposed = irWith([agentStage("a"), agentStage("b")]);
    const d = computePipelineDiff(base, proposed);
    expect(d.stages.added).toHaveLength(1);
    expect(d.stages.added[0]!.name).toBe("b");
    expect(d.categoryUnion).toContain("structural");
  });

  it("detects removed stage", () => {
    const base = irWith([agentStage("a"), agentStage("b")]);
    const proposed = irWith([agentStage("a")]);
    const d = computePipelineDiff(base, proposed);
    expect(d.stages.removed).toHaveLength(1);
    expect(d.stages.removed[0]!.name).toBe("b");
    expect(d.categoryUnion).toContain("structural");
  });

  it("detects promptOnly modification", () => {
    const base = irWith([agentStage("a", "p-old")]);
    const proposed = irWith([agentStage("a", "p-new")]);
    const d = computePipelineDiff(base, proposed);
    expect(d.stages.modified).toHaveLength(1);
    const m = d.stages.modified[0]!;
    expect(m.changes.promptRef).toEqual({ before: "p-old", after: "p-new" });
    expect(m.category).toBe("promptOnly");
    expect(d.categoryUnion).toEqual(["promptOnly"]);
  });

  it("detects input port added — structural (conservative)", () => {
    const base = irWith([agentStage("a")]);
    const changed = { ...agentStage("a") };
    changed.inputs = [{ name: "x", type: "string" }];
    const proposed = irWith([changed]);
    const d = computePipelineDiff(base, proposed);
    expect(d.stages.modified).toHaveLength(1);
    expect(d.stages.modified[0]!.changes.inputs?.added).toHaveLength(1);
    expect(d.stages.modified[0]!.category).toBe("structural");
  });

  it("detects output port type change", () => {
    const base = irWith([agentStage("a")]);
    const changed = { ...agentStage("a") };
    changed.outputs = [{ name: "out", type: "number" }];
    const proposed = irWith([changed]);
    const d = computePipelineDiff(base, proposed);
    expect(d.stages.modified[0]!.changes.outputs?.typeChanged).toEqual([
      { port: "out", beforeType: "string", afterType: "number" },
    ]);
    expect(d.stages.modified[0]!.category).toBe("structural");
  });

  it("detects added wire", () => {
    const base = irWith([agentStage("a"), agentStage("b")]);
    const proposed = irWith([agentStage("a"), agentStage("b")], [
      { from: { source: "stage", stage: "a", port: "out" }, to: { stage: "b", port: "out" } },
    ]);
    const d = computePipelineDiff(base, proposed);
    expect(d.wires.added).toHaveLength(1);
    expect(d.wires.removed).toHaveLength(0);
    expect(d.categoryUnion).toContain("structural");
  });

  it("detects removed wire", () => {
    const base = irWith([agentStage("a"), agentStage("b")], [
      { from: { source: "stage", stage: "a", port: "out" }, to: { stage: "b", port: "out" } },
    ]);
    const proposed = irWith([agentStage("a"), agentStage("b")]);
    const d = computePipelineDiff(base, proposed);
    expect(d.wires.removed).toHaveLength(1);
  });

  it("detects gate routing change", () => {
    const gateBase: PipelineIR["stages"][number] = {
      name: "g",
      type: "gate",
      config: {
        question: { text: "proceed?" },
        routing: { routes: { yes: "a", no: "b" } },
      },
      inputs: [],
      outputs: [],
    };
    const gateProposed: PipelineIR["stages"][number] = {
      ...gateBase,
      config: {
        ...gateBase.config,
        routing: { routes: { yes: "a", no: "c" } },
      },
    };
    const base = irWith([gateBase, agentStage("a"), agentStage("b"), agentStage("c")]);
    const proposed = irWith([gateProposed, agentStage("a"), agentStage("b"), agentStage("c")]);
    const d = computePipelineDiff(base, proposed);
    expect(d.routing.gateRoutingChanged).toHaveLength(1);
    expect(d.stages.modified[0]!.category).toBe("structural");
  });
});
