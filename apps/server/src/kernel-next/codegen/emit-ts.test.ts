import { describe, it, expect } from "vitest";
import { emitPipelineModule } from "./emit-ts.js";
import type { PipelineIR } from "../ir/schema.js";

function diamondIR(): PipelineIR {
  return {
    name: "diamond",
    stages: [
      { name: "A", type: "agent", inputs: [], outputs: [{ name: "x", type: "number" }], config: {} },
      { name: "B", type: "agent",
        inputs: [{ name: "x", type: "number" }],
        outputs: [{ name: "y", type: "string" }],
        config: {} },
      { name: "C", type: "agent",
        inputs: [{ name: "x", type: "number" }],
        outputs: [{ name: "z", type: "string" }],
        config: {} },
      { name: "D", type: "agent",
        inputs: [{ name: "b", type: "string" }, { name: "c", type: "string" }],
        outputs: [],
        config: {} },
    ],
    wires: [
      { from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" } },
      { from: { stage: "A", port: "x" }, to: { stage: "C", port: "x" } },
      { from: { stage: "B", port: "y" }, to: { stage: "D", port: "b" } },
      { from: { stage: "C", port: "z" }, to: { stage: "D", port: "c" } },
    ],
  };
}

describe("emit-ts codegen", () => {
  it("emits a namespace per stage with Inputs/Outputs interfaces", () => {
    const { source } = emitPipelineModule(diamondIR());
    expect(source).toContain("export namespace Stages");
    expect(source).toContain("export namespace A");
    expect(source).toContain("export namespace B");
    expect(source).toMatch(/export namespace A \{\s+export interface Inputs \{\}/);
    expect(source).toContain("export interface Outputs {");
    expect(source).toMatch(/x: number;/);
  });

  it("emits one __wire__ dummy assignment per wire", () => {
    const { source } = emitPipelineModule(diamondIR());
    const matches = source.match(/export const __wire__/g) ?? [];
    expect(matches.length).toBe(4);
    expect(source).toContain("__wire__A_x__TO__B_x");
    expect(source).toContain("__wire__A_x__TO__C_x");
    expect(source).toContain("__wire__B_y__TO__D_b");
    expect(source).toContain("__wire__C_z__TO__D_c");
  });

  it("wire assertion direction: target Input type = source Output type", () => {
    const { source } = emitPipelineModule(diamondIR());
    // Expected shape:
    //   export const __wire__A_x__TO__B_x: Stages.B.Inputs["x"] =
    //     null as unknown as Stages.A.Outputs["x"];
    expect(source).toContain(`export const __wire__A_x__TO__B_x: Stages.B.Inputs["x"] =`);
    expect(source).toContain(`null as unknown as Stages.A.Outputs["x"];`);
  });

  it("wire map contains one entry per wire with from/to metadata", () => {
    const { wireByIdentifier, wireByLine } = emitPipelineModule(diamondIR());
    expect(wireByIdentifier.size).toBe(4);
    const ab = wireByIdentifier.get("__wire__A_x__TO__B_x");
    expect(ab?.fromStage).toBe("A");
    expect(ab?.fromPort).toBe("x");
    expect(ab?.toStage).toBe("B");
    expect(ab?.toPort).toBe("x");
    expect(ab?.fromType).toBe("number");
    expect(ab?.toType).toBe("number");
    // Line-indexed map has at least as many entries as wires
    // (we index both declaration and assignment lines).
    expect(wireByLine.size).toBeGreaterThanOrEqual(4);
  });

  it("emits empty Inputs/Outputs blocks when stage has no ports", () => {
    const ir: PipelineIR = {
      name: "solo",
      stages: [{ name: "only", type: "agent", inputs: [], outputs: [], config: {} }],
      wires: [],
    };
    const { source } = emitPipelineModule(ir);
    expect(source).toContain("export interface Inputs {}");
    expect(source).toContain("export interface Outputs {}");
    // No wire assertions present.
    expect(source).not.toContain("__wire__");
  });

  it("preserves complex TS type expressions verbatim", () => {
    const ir: PipelineIR = {
      name: "complex",
      stages: [
        { name: "A", type: "agent",
          inputs: [],
          outputs: [{ name: "items", type: "Array<{ id: string; v: number }>" }],
          config: {} },
        { name: "B", type: "agent",
          inputs: [{ name: "items", type: "ReadonlyArray<{ id: string; v: number }>" }],
          outputs: [],
          config: {} },
      ],
      wires: [{ from: { stage: "A", port: "items" }, to: { stage: "B", port: "items" } }],
    };
    const { source } = emitPipelineModule(ir);
    expect(source).toContain("items: Array<{ id: string; v: number }>");
    expect(source).toContain("items: ReadonlyArray<{ id: string; v: number }>");
  });
});
