import { describe, it, expect } from "vitest";
import { AgentStageSchema, GateRoutingSchema, PipelineIRSchema, ScriptStageSchema, WireIRSchema } from "./schema.js";

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

describe("GateRoutingSchema", () => {
  it("accepts single-string route targets (backwards compatible)", () => {
    const parsed = GateRoutingSchema.parse({ routes: { approve: "B", reject: "C" } });
    expect(parsed.routes.approve).toBe("B");
    expect(parsed.routes.reject).toBe("C");
  });

  it("accepts string-array route targets", () => {
    const parsed = GateRoutingSchema.parse({
      routes: { approve: ["X", "Y"], reject: "Z" },
    });
    expect(parsed.routes.approve).toEqual(["X", "Y"]);
    expect(parsed.routes.reject).toBe("Z");
  });

  it("rejects empty route-target array", () => {
    expect(() => GateRoutingSchema.parse({ routes: { x: [] } })).toThrow();
  });

  it("rejects empty string route target", () => {
    expect(() => GateRoutingSchema.parse({ routes: { x: "" } })).toThrow();
  });
});

describe("ScriptStage.config.retry", () => {
  it("accepts a valid retry spec", () => {
    const parsed = ScriptStageSchema.shape.config.parse({
      moduleId: "m",
      retry: { maxRetries: 2, backToStage: "A" },
    });
    expect(parsed.retry).toEqual({ maxRetries: 2, backToStage: "A" });
  });

  it("treats retry as optional (script without retry is valid)", () => {
    const parsed = ScriptStageSchema.shape.config.parse({ moduleId: "m" });
    expect(parsed.retry).toBeUndefined();
  });

  it("rejects maxRetries < 1", () => {
    expect(() =>
      ScriptStageSchema.shape.config.parse({
        moduleId: "m",
        retry: { maxRetries: 0, backToStage: "A" },
      }),
    ).toThrow();
  });

  it("rejects maxRetries > 10", () => {
    expect(() =>
      ScriptStageSchema.shape.config.parse({
        moduleId: "m",
        retry: { maxRetries: 11, backToStage: "A" },
      }),
    ).toThrow();
  });

  it("rejects non-identifier backToStage", () => {
    expect(() =>
      ScriptStageSchema.shape.config.parse({
        moduleId: "m",
        retry: { maxRetries: 1, backToStage: "" },
      }),
    ).toThrow();
  });
});

describe("AgentStage.config.subAgents", () => {
  it("accepts a valid subAgent array", () => {
    const parsed = AgentStageSchema.shape.config.parse({
      promptRef: "p",
      subAgents: [{
        name: "writer",
        description: "Writes prompts",
        prompt: "You are a writer",
        tools: ["Read", "Write"],
        model: "sonnet",
        maxTurns: 20,
      }],
    });
    expect(parsed.subAgents).toHaveLength(1);
    expect(parsed.subAgents![0]!.name).toBe("writer");
  });

  it("treats subAgents as optional (agent without subAgents is valid)", () => {
    const parsed = AgentStageSchema.shape.config.parse({ promptRef: "p" });
    expect(parsed.subAgents).toBeUndefined();
  });

  it("rejects a subAgent missing description", () => {
    expect(() =>
      AgentStageSchema.shape.config.parse({
        promptRef: "p",
        subAgents: [{ name: "w", prompt: "x", description: "" }],
      }),
    ).toThrow();
  });

  it("rejects a subAgent missing prompt", () => {
    expect(() =>
      AgentStageSchema.shape.config.parse({
        promptRef: "p",
        subAgents: [{ name: "w", description: "x", prompt: "" }],
      }),
    ).toThrow();
  });

  it("rejects non-identifier subAgent name", () => {
    expect(() =>
      AgentStageSchema.shape.config.parse({
        promptRef: "p",
        subAgents: [{ name: "has spaces", description: "d", prompt: "p" }],
      }),
    ).toThrow();
  });

  it("rejects invalid model literal", () => {
    expect(() =>
      AgentStageSchema.shape.config.parse({
        promptRef: "p",
        subAgents: [{ name: "w", description: "d", prompt: "p", model: "gpt-4" as any }],
      }),
    ).toThrow();
  });

  it("rejects maxTurns <= 0", () => {
    expect(() =>
      AgentStageSchema.shape.config.parse({
        promptRef: "p",
        subAgents: [{ name: "w", description: "d", prompt: "p", maxTurns: 0 }],
      }),
    ).toThrow();
  });
});
