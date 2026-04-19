import { describe, it, expect } from "vitest";
import { applyPatch, PatchApplyError } from "./patch.js";
import type { PipelineIR, IRPatch } from "../ir/schema.js";

function base(): PipelineIR {
  return {
    name: "t",
    stages: [
      { name: "A", type: "agent", inputs: [], outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
      { name: "B", type: "agent", inputs: [{ name: "x", type: "number" }], outputs: [], config: { promptRef: "p" } },
    ],
    wires: [{ from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" } }],
  };
}

describe("applyPatch", () => {
  it("add_stage appends a new stage", () => {
    const p: IRPatch = { ops: [
      { op: "add_stage", stage: { name: "C", type: "agent", inputs: [], outputs: [], config: { promptRef: "p" } } },
    ]};
    const out = applyPatch(base(), p);
    expect(out.stages.map((s) => s.name)).toEqual(["A", "B", "C"]);
  });

  it("add_stage rejects duplicate name", () => {
    const p: IRPatch = { ops: [
      { op: "add_stage", stage: { name: "A", type: "agent", inputs: [], outputs: [], config: { promptRef: "p" } } },
    ]};
    expect(() => applyPatch(base(), p)).toThrow(PatchApplyError);
  });

  it("remove_stage cascades to wires", () => {
    const p: IRPatch = { ops: [{ op: "remove_stage", stageName: "A" }] };
    const out = applyPatch(base(), p);
    expect(out.stages.map((s) => s.name)).toEqual(["B"]);
    expect(out.wires).toEqual([]);
  });

  it("remove_stage rejects nonexistent stage", () => {
    const p: IRPatch = { ops: [{ op: "remove_stage", stageName: "Z" }] };
    expect(() => applyPatch(base(), p)).toThrow(PatchApplyError);
  });

  it("add_wire appends; duplicate rejected", () => {
    const ir = base();
    ir.stages.push({ name: "C", type: "agent", inputs: [{ name: "x", type: "number" }], outputs: [], config: { promptRef: "p" } });
    const p: IRPatch = { ops: [
      { op: "add_wire", wire: { from: { stage: "A", port: "x" }, to: { stage: "C", port: "x" } } },
    ]};
    const out = applyPatch(ir, p);
    expect(out.wires).toHaveLength(2);

    // Duplicate detection.
    const p2: IRPatch = { ops: [
      { op: "add_wire", wire: { from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" } } },
    ]};
    expect(() => applyPatch(ir, p2)).toThrow(PatchApplyError);
  });

  it("remove_wire removes matching wire", () => {
    const p: IRPatch = { ops: [
      { op: "remove_wire", wire: { from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" } } },
    ]};
    const out = applyPatch(base(), p);
    expect(out.wires).toEqual([]);
  });

  it("update_port_type mutates the specified port", () => {
    const p: IRPatch = { ops: [
      { op: "update_port_type", stage: "A", port: "x", direction: "out", newType: "string" },
    ]};
    const out = applyPatch(base(), p);
    expect(out.stages[0]!.outputs[0]!.type).toBe("string");
    // B's input type untouched — validator/tsc will catch mismatch.
    expect(out.stages[1]!.inputs[0]!.type).toBe("number");
  });

  it("update_stage_config merges into existing config", () => {
    const p: IRPatch = { ops: [
      { op: "update_stage_config", stage: "A", configPatch: { promptRef: "new prompt" } },
    ]};
    const out = applyPatch(base(), p);
    const a = out.stages[0]!;
    if (a.type !== "agent") throw new Error("expected agent stage");
    expect(a.config.promptRef).toBe("new prompt");
  });

  it("update_stage_config rejects keys not allowed for the target stage variant", () => {
    // agent stage; `moduleId` is a script-only field.
    const p: IRPatch = { ops: [
      { op: "update_stage_config", stage: "A", configPatch: { moduleId: "x" } },
    ]};
    expect(() => applyPatch(base(), p)).toThrow(PatchApplyError);
  });

  it("ops apply in order: add_stage then add_wire in same patch", () => {
    const p: IRPatch = { ops: [
      { op: "add_stage", stage: {
        name: "C", type: "agent",
        inputs: [{ name: "x", type: "number" }], outputs: [], config: { promptRef: "p" },
      } },
      { op: "add_wire", wire: { from: { stage: "A", port: "x" }, to: { stage: "C", port: "x" } } },
    ]};
    const out = applyPatch(base(), p);
    expect(out.stages.map((s) => s.name)).toEqual(["A", "B", "C"]);
    expect(out.wires).toHaveLength(2);
  });

  it("applyPatch is non-destructive (base IR unchanged)", () => {
    const input = base();
    const snapshot = JSON.stringify(input);
    applyPatch(input, { ops: [{ op: "remove_stage", stageName: "A" }] });
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
