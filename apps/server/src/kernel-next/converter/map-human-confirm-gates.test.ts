import { describe, it, expect } from "vitest";
import { mapHumanConfirmGates } from "./map-human-confirm-gates.js";

describe("mapHumanConfirmGates", () => {
  it("maps human_confirm with on_reject_to to gate shape with single approve target", () => {
    const flat = [
      { name: "A", type: "agent" },
      { name: "gate1", type: "human_confirm", runtime: { on_reject_to: "A" } },
      { name: "B", type: "agent" },
    ];
    const r = mapHumanConfirmGates(flat as any, new Map());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const gate = r.stages.find((s: any) => s.name === "gate1");
    expect(gate!.type).toBe("gate");
    expect((gate as any).config.routing.routes).toEqual({ approve: "B", reject: "A" });
  });

  it("emits array approve target when following stage is first of a parallel block", () => {
    const flat = [
      { name: "A", type: "agent" },
      { name: "gate1", type: "human_confirm", runtime: { on_reject_to: "A" } },
      { name: "B1", type: "agent" },
      { name: "B2", type: "agent" },
    ];
    // Map is keyed by first-inner-stage-name → all members of that block.
    const blockMembers = new Map([["B1", ["B1", "B2"]]]);
    const r = mapHumanConfirmGates(flat as any, blockMembers);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const gate = r.stages.find((s: any) => s.name === "gate1");
    expect((gate as any).config.routing.routes.approve).toEqual(["B1", "B2"]);
  });

  it("rejects human_confirm at the end of the flat array", () => {
    const flat = [
      { name: "A", type: "agent" },
      { name: "gate1", type: "human_confirm", runtime: { on_reject_to: "A" } },
    ];
    const r = mapHumanConfirmGates(flat as any, new Map());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("HUMAN_CONFIRM_AT_END");
  });

  it("rejects human_confirm without on_reject_to", () => {
    const flat = [
      { name: "gate1", type: "human_confirm" },
      { name: "B", type: "agent" },
    ];
    const r = mapHumanConfirmGates(flat as any, new Map());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("HUMAN_CONFIRM_NO_REJECT_TARGET");
  });

  it("passes through non-human_confirm stages unchanged", () => {
    const flat = [
      { name: "A", type: "agent", foo: 1 },
      { name: "B", type: "script", bar: 2 },
    ];
    const r = mapHumanConfirmGates(flat as any, new Map());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stages).toEqual(flat);
  });

  it("synthesizes a predecessor signal wire so the gate waits for its preceding stage", () => {
    const flat = [
      { name: "A", type: "agent" },
      { name: "gate1", type: "human_confirm", runtime: { on_reject_to: "A" } },
      { name: "B", type: "agent" },
    ];
    const r = mapHumanConfirmGates(flat as any, new Map());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Gate gets a synthetic input port.
    const gate = r.stages.find((s: any) => s.name === "gate1") as any;
    expect(gate.inputs).toBeDefined();
    expect(gate.inputs.length).toBe(1);
    expect(gate.inputs[0].name).toBe("__gate_signal");
    // A synthesized wire is surfaced for the legacy-yaml assembler.
    expect(r.predecessorWires).toBeDefined();
    expect(r.predecessorWires!).toHaveLength(1);
    const w = r.predecessorWires![0]!;
    expect(w.from.stage).toBe("A");
    expect(w.to).toEqual({ stage: "gate1", port: "__gate_signal" });
  });

  it("no predecessor wire when the gate is the first flat stage (edge case)", () => {
    const flat = [
      { name: "gate1", type: "human_confirm", runtime: { on_reject_to: "B" } },
      { name: "B", type: "agent" },
    ];
    const r = mapHumanConfirmGates(flat as any, new Map());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.predecessorWires ?? []).toHaveLength(0);
  });
});
