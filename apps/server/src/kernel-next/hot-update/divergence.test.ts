import { describe, it, expect } from "vitest";
import { findEarliestDivergence } from "./divergence.js";
import type { PipelineIR } from "../ir/schema.js";

function agentStage(name: string, promptRef = "p-" + name): PipelineIR["stages"][number] {
  return {
    name, type: "agent",
    config: { promptRef },
    inputs: [], outputs: [{ name: "out", type: "string" }],
  };
}

function ir(stages: PipelineIR["stages"], wires: PipelineIR["wires"] = []): PipelineIR {
  return { name: "t", stages, wires };
}

describe("findEarliestDivergence", () => {
  it("identical IRs → null", () => {
    const x = ir([agentStage("a"), agentStage("b")]);
    expect(findEarliestDivergence(x, x)).toBeNull();
  });

  it("modified stage → that stage", () => {
    const base = ir([agentStage("a", "p-old"), agentStage("b")]);
    const prop = ir([agentStage("a", "p-new"), agentStage("b")]);
    expect(findEarliestDivergence(base, prop)).toBe("a");
  });

  it("removed stage → that stage", () => {
    const base = ir([agentStage("a"), agentStage("b"), agentStage("c")]);
    const prop = ir([agentStage("a"), agentStage("c")]);
    expect(findEarliestDivergence(base, prop)).toBe("b");
  });

  it("added stage → that stage (when no earlier diff)", () => {
    const base = ir([agentStage("a"), agentStage("b")]);
    const prop = ir([agentStage("a"), agentStage("b"), agentStage("c")]);
    expect(findEarliestDivergence(base, prop)).toBe("c");
  });

  it("multiple diffs → earliest by topological order", () => {
    const wires: PipelineIR["wires"] = [
      { from: { source: "stage", stage: "a", port: "out" }, to: { stage: "b", port: "out" } },
      { from: { source: "stage", stage: "b", port: "out" }, to: { stage: "c", port: "out" } },
    ];
    const base = ir([agentStage("a", "A"), agentStage("b", "B"), agentStage("c", "C")], wires);
    const prop = ir([agentStage("a", "A2"), agentStage("b", "B2"), agentStage("c", "C2")], wires);
    expect(findEarliestDivergence(base, prop)).toBe("a");
  });

  it("falls back to stages[] order when wires absent", () => {
    const base = ir([agentStage("x"), agentStage("y")]);
    const prop = ir([agentStage("x", "p-changed"), agentStage("y", "p-changed")]);
    expect(findEarliestDivergence(base, prop)).toBe("x");
  });

  it("added + modified: earliest wins topologically", () => {
    const wires: PipelineIR["wires"] = [
      { from: { source: "stage", stage: "a", port: "out" }, to: { stage: "b", port: "out" } },
    ];
    const base = ir([agentStage("a"), agentStage("b")], wires);
    const prop = ir([agentStage("a", "changed"), agentStage("b"), agentStage("c")], wires);
    expect(findEarliestDivergence(base, prop)).toBe("a");
  });
});
