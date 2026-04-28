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
    externalInputs: [{ name: "topic", type: "string" }],
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

  // Finding 16 regression coverage: ALLOWED_CONFIG_KEYS now matches
  // the schema for agent (subAgents, mcpServers) and gate
  // (timeout_minutes). Tests verify each newly-permitted key is
  // accepted and a representative non-permitted key still rejects.
  it("update_stage_config (agent) accepts mcpServers", () => {
    const p: IRPatch = { ops: [
      { op: "update_stage_config", stage: "A", configPatch: {
        mcpServers: [{ name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], envKeys: ["GITHUB_TOKEN"] }],
      } },
    ]};
    const out = applyPatch(base(), p);
    const a = out.stages[0]!;
    if (a.type !== "agent") throw new Error("expected agent stage");
    expect(a.config.mcpServers).toEqual([
      { name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], envKeys: ["GITHUB_TOKEN"] },
    ]);
    // promptRef preserved (merge, not replace).
    expect(a.config.promptRef).toBe("p");
  });

  it("update_stage_config (agent) accepts subAgents", () => {
    const p: IRPatch = { ops: [
      { op: "update_stage_config", stage: "A", configPatch: {
        subAgents: [{ name: "helper", description: "h", prompt: "you help" }],
      } },
    ]};
    const out = applyPatch(base(), p);
    const a = out.stages[0]!;
    if (a.type !== "agent") throw new Error("expected agent stage");
    expect(a.config.subAgents).toEqual([
      { name: "helper", description: "h", prompt: "you help" },
    ]);
  });

  it("update_stage_config (gate) accepts timeout_minutes", () => {
    const ir: PipelineIR = {
      name: "t",
      stages: [
        { name: "G", type: "gate", inputs: [], outputs: [],
          config: { question: { text: "ok?" }, routing: { routes: { approve: "X", _default: "X" } } } },
        { name: "X", type: "agent", inputs: [], outputs: [], config: { promptRef: "p" } },
      ],
      wires: [],
    };
    const p: IRPatch = { ops: [
      { op: "update_stage_config", stage: "G", configPatch: { timeout_minutes: 60 } },
    ]};
    const out = applyPatch(ir, p);
    const g = out.stages[0]!;
    if (g.type !== "gate") throw new Error("expected gate stage");
    expect(g.config.timeout_minutes).toBe(60);
    expect(g.config.question).toEqual({ text: "ok?" });
  });

  it("update_stage_config (agent) accepts cross_segment_resume_from", () => {
    const p: IRPatch = { ops: [
      { op: "update_stage_config", stage: "A", configPatch: { cross_segment_resume_from: "B" } },
    ]};
    const out = applyPatch(base(), p);
    const a = out.stages[0]!;
    if (a.type !== "agent") throw new Error("expected agent stage");
    expect(a.config.cross_segment_resume_from).toBe("B");
    // promptRef preserved (merge, not replace).
    expect(a.config.promptRef).toBe("p");
  });

  // 2026-04-28: Bug 8a from dogfood. pipeline-modifier needs to add a new
  // external input when it adds a stage that consumes a new external port.
  // Previously unrepresentable in the patch DSL — agent invented the op name
  // and zod rejected it; modifier silently submitted ops:[] with verdict
  // "safe", masking the failure.
  it("add_external_input appends a new port", () => {
    const p: IRPatch = { ops: [
      { op: "add_external_input", port: { name: "newInput", type: "string", description: "added by patch" } },
    ]};
    const out = applyPatch(base(), p);
    expect(out.externalInputs?.map((e) => e.name)).toEqual(["topic", "newInput"]);
    expect(out.externalInputs?.[1]?.description).toBe("added by patch");
  });

  it("add_external_input rejects duplicate name", () => {
    const p: IRPatch = { ops: [
      { op: "add_external_input", port: { name: "topic", type: "string" } },
    ]};
    expect(() => applyPatch(base(), p)).toThrow(PatchApplyError);
  });

  it("add_external_input works on an IR with no externalInputs (defaulted to [])", () => {
    const ir = base();
    delete ir.externalInputs;
    const p: IRPatch = { ops: [
      { op: "add_external_input", port: { name: "x", type: "number" } },
    ]};
    const out = applyPatch(ir, p);
    expect(out.externalInputs).toEqual([{ name: "x", type: "number" }]);
  });

  it("remove_external_input removes by name", () => {
    const p: IRPatch = { ops: [
      { op: "remove_external_input", name: "topic" },
    ]};
    const out = applyPatch(base(), p);
    expect(out.externalInputs).toEqual([]);
  });

  it("remove_external_input rejects nonexistent name", () => {
    const p: IRPatch = { ops: [
      { op: "remove_external_input", name: "nope" },
    ]};
    expect(() => applyPatch(base(), p)).toThrow(PatchApplyError);
  });
});
