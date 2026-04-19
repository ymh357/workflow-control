import { describe, it, expect } from "vitest";
import { buildDag, validateDag } from "./dag.js";
import type { PipelineIR } from "../ir/schema.js";

function diamond(): PipelineIR {
  return {
    name: "diamond",
    stages: [
      { name: "A", type: "agent", inputs: [], outputs: [{ name: "x", type: "number" }], config: {} },
      { name: "B", type: "agent", inputs: [{ name: "x", type: "number" }], outputs: [{ name: "y", type: "string" }], config: {} },
      { name: "C", type: "agent", inputs: [{ name: "x", type: "number" }], outputs: [{ name: "z", type: "string" }], config: {} },
      { name: "D", type: "agent", inputs: [{ name: "b", type: "string" }, { name: "c", type: "string" }], outputs: [], config: {} },
    ],
    wires: [
      { from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" } },
      { from: { stage: "A", port: "x" }, to: { stage: "C", port: "x" } },
      { from: { stage: "B", port: "y" }, to: { stage: "D", port: "b" } },
      { from: { stage: "C", port: "z" }, to: { stage: "D", port: "c" } },
    ],
  };
}

describe("dag validator", () => {
  it("builds topo order for diamond: A first, D last, B/C in between", () => {
    const r = buildDag(diamond());
    expect("cycle" in r).toBe(false);
    if ("cycle" in r) return;
    expect(r.topoOrder[0]).toBe("A");
    expect(r.topoOrder[r.topoOrder.length - 1]).toBe("D");
    expect(r.topoOrder.slice(1, 3).sort()).toEqual(["B", "C"]);
  });

  it("upstream/downstream maps are correct for diamond", () => {
    const r = buildDag(diamond());
    if ("cycle" in r) throw new Error("unexpected cycle");
    expect([...r.upstream.get("B")!]).toEqual(["A"]);
    expect([...r.upstream.get("D")!].sort()).toEqual(["B", "C"]);
    expect([...r.downstream.get("A")!].sort()).toEqual(["B", "C"]);
    expect([...r.downstream.get("D")!]).toEqual([]);
  });

  it("detects a simple 2-stage cycle", () => {
    const ir: PipelineIR = {
      name: "bad",
      stages: [
        { name: "A", type: "agent", inputs: [{ name: "i", type: "number" }], outputs: [{ name: "o", type: "number" }], config: {} },
        { name: "B", type: "agent", inputs: [{ name: "i", type: "number" }], outputs: [{ name: "o", type: "number" }], config: {} },
      ],
      wires: [
        { from: { stage: "A", port: "o" }, to: { stage: "B", port: "i" } },
        { from: { stage: "B", port: "o" }, to: { stage: "A", port: "i" } },
      ],
    };
    const r = validateDag(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics[0]!.code).toBe("DAG_HAS_CYCLE");
      const cyc = r.diagnostics[0]!.context!.cycle as string[];
      expect(cyc.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("detects a self-wire as a length-1 cycle", () => {
    const ir: PipelineIR = {
      name: "self",
      stages: [{
        name: "A",
        type: "agent",
        inputs: [{ name: "i", type: "number" }],
        outputs: [{ name: "o", type: "number" }],
        config: {},
      }],
      wires: [{ from: { stage: "A", port: "o" }, to: { stage: "A", port: "i" } }],
    };
    const r = validateDag(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics[0]!.code).toBe("DAG_HAS_CYCLE");
      expect((r.diagnostics[0]!.context!.cycle as string[])[0]).toBe("A");
    }
  });

  it("accepts a single-stage pipeline with no wires", () => {
    const ir: PipelineIR = {
      name: "solo",
      stages: [{ name: "only", type: "agent", inputs: [], outputs: [], config: {} }],
      wires: [],
    };
    expect(validateDag(ir)).toEqual({ ok: true });
  });
});
