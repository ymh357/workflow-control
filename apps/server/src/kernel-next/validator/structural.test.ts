import { describe, it, expect } from "vitest";
import { validateStructural } from "./structural.js";
import type { PipelineIR } from "../ir/schema.js";

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
      config: { promptRef: "p" },
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

  // --- Stage-type specific rules (A0.1) ---

  it("accepts a pipeline with a gate stage and valid routing", () => {
    const ir: PipelineIR = {
      name: "t",
      stages: [
        { name: "A", type: "agent", inputs: [], outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
        {
          name: "G",
          type: "gate",
          inputs: [{ name: "x", type: "number" }],
          outputs: [],
          config: {
            question: { text: "continue?" },
            routing: { routes: { yes: "A" } },
          },
        },
      ],
      wires: [{ from: { stage: "A", port: "x" }, to: { stage: "G", port: "x" } }],
    };
    expect(validateStructural(ir)).toEqual({ ok: true });
  });

  it("rejects gate routing target that is not a declared stage", () => {
    const ir: PipelineIR = {
      name: "t",
      stages: [
        { name: "A", type: "agent", inputs: [], outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
        {
          name: "G",
          type: "gate",
          inputs: [{ name: "x", type: "number" }],
          outputs: [],
          config: {
            question: { text: "pick" },
            routing: { routes: { yes: "ZZZ" } },
          },
        },
      ],
      wires: [{ from: { stage: "A", port: "x" }, to: { stage: "G", port: "x" } }],
    };
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics.some((d) => d.code === "GATE_ROUTING_TARGET_MISSING")).toBe(true);
    }
  });

  it("rejects a stage whose fanout names a non-existent input port", () => {
    const ir: PipelineIR = {
      name: "t",
      stages: [
        {
          name: "A",
          type: "agent",
          inputs: [{ name: "x", type: "number" }],
          outputs: [],
          config: { promptRef: "p" },
          fanout: { input: "nope" },
        },
      ],
      wires: [],
    };
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics.some((d) => d.code === "FANOUT_INPUT_MISSING")).toBe(true);
    }
  });

  it("accepts a stage with fanout naming an existing input port", () => {
    const ir: PipelineIR = {
      name: "t",
      stages: [
        {
          name: "A",
          type: "agent",
          inputs: [{ name: "item", type: "number" }],
          outputs: [{ name: "out", type: "string" }],
          config: { promptRef: "p" },
          fanout: { input: "item" },
        },
      ],
      wires: [],
    };
    expect(validateStructural(ir)).toEqual({ ok: true });
  });

  // F6 / concern C3 — a stage cannot be a routing target for more than
  // one gate, since the runtime's authorize/skip bookkeeping assumes a
  // single owning gate per target.
  it("rejects a stage routed to by two different gates with GATE_TARGET_SHARED", () => {
    const ir: PipelineIR = {
      name: "t-shared",
      stages: [
        { name: "SRC", type: "agent", inputs: [],
          outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
        { name: "G1", type: "gate",
          inputs: [{ name: "x", type: "number" }], outputs: [],
          config: {
            question: { text: "?", options: ["a", "b"] },
            routing: { routes: { a: "SHARED", b: "OTHER" } },
          } },
        { name: "G2", type: "gate",
          inputs: [{ name: "x", type: "number" }], outputs: [],
          config: {
            question: { text: "?", options: ["c", "d"] },
            routing: { routes: { c: "SHARED", d: "ELSE" } },
          } },
        { name: "SHARED", type: "agent", inputs: [], outputs: [], config: { promptRef: "p" } },
        { name: "OTHER", type: "agent", inputs: [], outputs: [], config: { promptRef: "p" } },
        { name: "ELSE", type: "agent", inputs: [], outputs: [], config: { promptRef: "p" } },
      ],
      wires: [],
    };
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const shared = r.diagnostics.find((d) => d.code === "GATE_TARGET_SHARED");
    expect(shared).toBeDefined();
    expect(shared!.message).toContain("SHARED");
    expect(shared!.context).toMatchObject({ target: "SHARED" });
    const gates = (shared!.context as { gates: string[] }).gates.slice().sort();
    expect(gates).toEqual(["G1", "G2"]);
  });

  // Corner case: one gate routing multiple answers to the same stage is
  // NOT a conflict — it's legitimate ("yes" and "confirm" both advance
  // to SUMMARY). Only cross-gate overlap is rejected.
  it("accepts the same target for multiple answers of a single gate", () => {
    const ir: PipelineIR = {
      name: "t-same-gate",
      stages: [
        { name: "G", type: "gate",
          inputs: [], outputs: [],
          config: {
            question: { text: "?", options: ["yes", "confirm", "no"] },
            routing: { routes: { yes: "OK", confirm: "OK", no: "CANCEL" } },
          } },
        { name: "OK", type: "agent", inputs: [], outputs: [], config: { promptRef: "p" } },
        { name: "CANCEL", type: "agent", inputs: [], outputs: [], config: { promptRef: "p" } },
      ],
      wires: [],
    };
    expect(validateStructural(ir)).toEqual({ ok: true });
  });
});

describe("structural validator — externalInputs", () => {
  function baseWithExt(): PipelineIR {
    return {
      name: "t",
      stages: [
        { name: "A", type: "agent", inputs: [{ name: "ctx", type: "unknown" }], outputs: [], config: { promptRef: "p" } },
      ],
      externalInputs: [{ name: "ctx", type: "unknown" }],
      wires: [{ from: { source: "external", port: "ctx" }, to: { stage: "A", port: "ctx" } }],
    };
  }

  it("accepts a valid external wire", () => {
    expect(validateStructural(baseWithExt())).toEqual({ ok: true });
  });

  it("rejects external wire pointing at an undeclared external port", () => {
    const ir = baseWithExt();
    ir.wires[0]!.from = { source: "external", port: "ghost" };
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics.some((d) => d.code === "WIRE_EXTERNAL_SOURCE_PORT_MISSING")).toBe(true);
  });

  it("rejects duplicate externalInputs name", () => {
    const ir = baseWithExt();
    ir.externalInputs!.push({ name: "ctx", type: "string" });
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics.some((d) => d.code === "DUPLICATE_EXTERNAL_INPUT_NAME")).toBe(true);
  });

  it("rejects external port name colliding with stage name", () => {
    const ir = baseWithExt();
    ir.externalInputs!.push({ name: "A", type: "string" });
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics.some((d) => d.code === "EXTERNAL_INPUT_COLLIDES_WITH_STAGE")).toBe(true);
  });

  it("rejects stage named __external__", () => {
    const ir = baseWithExt();
    ir.stages.push({ name: "__external__", type: "agent", inputs: [], outputs: [], config: { promptRef: "p" } });
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics.some((d) => d.code === "RESERVED_STAGE_NAME")).toBe(true);
  });

  it("rejects externalInputs named __external__", () => {
    const ir = baseWithExt();
    ir.externalInputs!.push({ name: "__external__", type: "string" });
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics.some((d) => d.code === "RESERVED_STAGE_NAME")).toBe(true);
  });
});
