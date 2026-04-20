import { describe, it, expect } from "vitest";
import { PipelineIRSchema, WireIRSchema } from "./schema.js";

describe("PipelineIRSchema externalInputs", () => {
  it("accepts externalInputs: []", () => {
    const r = PipelineIRSchema.safeParse({
      name: "t",
      stages: [{ name: "A", type: "agent", inputs: [], outputs: [], config: { promptRef: "p" } }],
      externalInputs: [],
    });
    expect(r.success).toBe(true);
  });

  it("defaults externalInputs to [] when omitted", () => {
    const r = PipelineIRSchema.safeParse({
      name: "t",
      stages: [{ name: "A", type: "agent", inputs: [], outputs: [], config: { promptRef: "p" } }],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.externalInputs).toEqual([]);
  });

  it("accepts externalInputs with typed ports", () => {
    const r = PipelineIRSchema.safeParse({
      name: "t",
      stages: [{ name: "A", type: "agent", inputs: [], outputs: [], config: { promptRef: "p" } }],
      externalInputs: [{ name: "ctx", type: "unknown" }],
    });
    expect(r.success).toBe(true);
  });
});

describe("WireIRSchema from discriminated union", () => {
  it("accepts legacy wire shape {from: {stage, port}} via backward-compat transform", () => {
    const r = WireIRSchema.safeParse({
      from: { stage: "A", port: "x" },
      to: { stage: "B", port: "x" },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.from).toMatchObject({ source: "stage", stage: "A", port: "x" });
    }
  });

  it("accepts explicit source: 'stage'", () => {
    const r = WireIRSchema.safeParse({
      from: { source: "stage", stage: "A", port: "x" },
      to: { stage: "B", port: "x" },
    });
    expect(r.success).toBe(true);
  });

  it("accepts source: 'external'", () => {
    const r = WireIRSchema.safeParse({
      from: { source: "external", port: "ctx" },
      to: { stage: "B", port: "ctx" },
    });
    expect(r.success).toBe(true);
  });
});
