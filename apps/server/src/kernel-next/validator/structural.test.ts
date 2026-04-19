import { describe, it, expect } from "vitest";
import { validateStructural } from "./structural.js";
import type { PipelineIR } from "../ir/schema.js";

function base(): PipelineIR {
  return {
    name: "t",
    stages: [
      { name: "A", type: "agent", inputs: [], outputs: [{ name: "x", type: "number" }], config: {} },
      { name: "B", type: "agent", inputs: [{ name: "x", type: "number" }], outputs: [], config: {} },
    ],
    wires: [{ from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" } }],
  };
}

describe("structural validator", () => {
  it("accepts a valid diamond-like IR", () => {
    expect(validateStructural(base())).toEqual({ ok: true });
  });

  it("rejects duplicate stage names", () => {
    const ir = base();
    ir.stages.push({ ...ir.stages[0]! });
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]!.code).toBe("DUPLICATE_STAGE_NAME");
  });

  it("rejects duplicate input port names within a stage", () => {
    const ir = base();
    ir.stages[1]!.inputs.push({ name: "x", type: "string" });
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics.some((d) => d.code === "DUPLICATE_PORT_NAME")).toBe(true);
  });

  it("rejects duplicate output port names within a stage", () => {
    const ir = base();
    ir.stages[0]!.outputs.push({ name: "x", type: "string" });
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics.some((d) => d.code === "DUPLICATE_PORT_NAME")).toBe(true);
  });

  it("rejects wire pointing to nonexistent source port", () => {
    const ir = base();
    ir.wires[0]!.from.port = "ghost";
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]!.code).toBe("WIRE_SOURCE_PORT_MISSING");
  });

  it("rejects wire pointing to nonexistent target port", () => {
    const ir = base();
    ir.wires[0]!.to.port = "ghost";
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]!.code).toBe("WIRE_TARGET_PORT_MISSING");
  });

  it("rejects wire whose source is an input port", () => {
    // wire from B.x (input) -> A.x is bogus
    const ir = base();
    ir.wires = [{ from: { stage: "B", port: "x" }, to: { stage: "A", port: "x" } }];
    // First give A an input so the target exists but still flags source direction.
    ir.stages[0]!.inputs.push({ name: "x", type: "number" });
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.diagnostics.map((d) => d.code);
      expect(codes).toContain("WIRE_SOURCE_DIRECTION_WRONG");
    }
  });

  it("rejects wire whose target is an output port", () => {
    const ir = base();
    // add z output on B so target resolves
    ir.stages[1]!.outputs.push({ name: "z", type: "string" });
    ir.wires = [{ from: { stage: "A", port: "x" }, to: { stage: "B", port: "z" } }];
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.diagnostics.map((d) => d.code);
      expect(codes).toContain("WIRE_TARGET_DIRECTION_WRONG");
    }
  });

  it("rejects two wires driving the same input port", () => {
    const ir = base();
    ir.stages.push({
      name: "C",
      type: "agent",
      inputs: [],
      outputs: [{ name: "x", type: "number" }],
      config: {},
    });
    // Both A.x and C.x drive B.x — conflict.
    ir.wires.push({ from: { stage: "C", port: "x" }, to: { stage: "B", port: "x" } });
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.diagnostics.map((d) => d.code);
      expect(codes).toContain("WIRE_TARGET_ALREADY_DRIVEN");
    }
  });

  it("rejects entry pointing to missing stage", () => {
    const ir = base();
    ir.entry = "ZZZ";
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]!.code).toBe("ENTRY_STAGE_MISSING");
  });

  it("accumulates multiple diagnostics in one pass", () => {
    const ir = base();
    ir.stages.push({ ...ir.stages[0]! });                          // duplicate stage
    ir.wires[0]!.from.port = "ghost";                              // missing source
    ir.wires.push({ from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" } }); // double-drive B.x
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = new Set(r.diagnostics.map((d) => d.code));
      expect(codes).toContain("DUPLICATE_STAGE_NAME");
      expect(codes).toContain("WIRE_SOURCE_PORT_MISSING");
      expect(codes).toContain("WIRE_TARGET_ALREADY_DRIVEN");
    }
  });
});
