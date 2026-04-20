import { describe, it, expect } from "vitest";
import { mapStagesToIR } from "./map-stages.js";
import type { PortIR } from "../ir/schema.js";
import type { EntryDescriptor } from "./map-store-schema.js";

describe("mapStagesToIR", () => {
  const stageOutputs = new Map<string, PortIR[]>([
    ["greet", [{ name: "subject", type: "string" }, { name: "note", type: "string" }]],
    ["echoBack", [{ name: "message", type: "string" }]],
  ]);
  const entryDirectory = new Map<string, EntryDescriptor>([
    ["greeting", { producerStage: "greet", fields: [{ name: "subject", type: "string" }, { name: "note", type: "string" }] }],
  ]);

  it("maps type: agent with reads → inputs", () => {
    const legacy: Parameters<typeof mapStagesToIR>[0] = {
      stages: [
        { name: "greet", type: "agent", runtime: { engine: "llm", system_prompt: "greet", reads: {} } },
        { name: "echoBack", type: "agent", runtime: { engine: "llm", system_prompt: "echo-back", reads: { greeting: "greeting" } } },
      ],
    };
    const r = mapStagesToIR(legacy, stageOutputs, entryDirectory, new Set());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stages).toHaveLength(2);
      const echoBack = r.stages.find((s) => s.name === "echoBack")!;
      expect(echoBack.type).toBe("agent");
      expect(echoBack.inputs.map((p) => p.name).sort()).toEqual(["note", "subject"]);
      if (echoBack.type === "agent") {
        expect(echoBack.config.promptRef).toBe("system/echo-back");
      }
    }
  });

  it("emits LEGACY_FIELD_IGNORED warnings for effort/max_turns/max_budget_usd/thinking", () => {
    const legacy = {
      stages: [{
        name: "s", type: "agent",
        runtime: { engine: "llm", system_prompt: "p", reads: {} },
        effort: "high", max_turns: 10, max_budget_usd: 2, thinking: { type: "enabled" },
      }],
    };
    const r = mapStagesToIR(legacy, new Map([["s", []]]), new Map(), new Set());
    expect(r.ok).toBe(true);
    if (r.ok) {
      const ignored = r.warnings.filter((w) => w.code === "LEGACY_FIELD_IGNORED").map((w) => w.context?.field);
      expect(ignored).toContain("effort");
      expect(ignored).toContain("max_turns");
      expect(ignored).toContain("max_budget_usd");
      expect(ignored).toContain("thinking");
    }
  });

  it("accepts gate stages (post-mapHumanConfirmGates shape) and lifts config verbatim", () => {
    const legacy = {
      stages: [
        { name: "G", type: "gate",
          config: { question: { text: "?" }, routing: { routes: { yes: "A" } } } },
        { name: "A", type: "agent", runtime: { reads: {} } },
      ],
    };
    const r = mapStagesToIR(legacy as Parameters<typeof mapStagesToIR>[0],
                           new Map([["A", []]]), new Map(), new Set());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const gate = r.stages.find(s => s.name === "G")!;
    expect(gate.type).toBe("gate");
    if (gate.type === "gate") {
      expect(gate.config.routing.routes).toEqual({ yes: "A" });
      expect(gate.config.question.text).toBe("?");
    }
  });

  it("maps script stage with script_id → moduleId", () => {
    const legacy = {
      stages: [{ name: "s", type: "script", runtime: { engine: "script", script_id: "persist", reads: {} } }],
    };
    const r = mapStagesToIR(legacy, new Map([["s", []]]), new Map(), new Set());
    expect(r.ok).toBe(true);
    if (r.ok && r.stages[0]!.type === "script") {
      expect(r.stages[0]!.config.moduleId).toBe("persist");
    }
  });

  it("extracts runtime.agents into AgentStage.config.subAgents", () => {
    const legacy = {
      stages: [{
        name: "A", type: "agent",
        runtime: {
          engine: "llm", system_prompt: "p", reads: {},
          agents: {
            writer: {
              description: "Writes prompts",
              prompt: "You are a writer",
              tools: ["Read", "Write"],
              model: "sonnet",
              maxTurns: 20,
            },
          },
        },
      }],
    };
    const r = mapStagesToIR(legacy, new Map([["A", []]]), new Map(), new Set());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = r.stages[0]!;
    expect(a.type).toBe("agent");
    if (a.type !== "agent") return;
    expect(a.config.subAgents).toHaveLength(1);
    expect(a.config.subAgents![0]).toMatchObject({
      name: "writer",
      description: "Writes prompts",
      prompt: "You are a writer",
      tools: ["Read", "Write"],
      model: "sonnet",
      maxTurns: 20,
    });
  });

  it("extracts minimal subAgent with only description + prompt", () => {
    const legacy = {
      stages: [{
        name: "A", type: "agent",
        runtime: {
          engine: "llm", system_prompt: "p", reads: {},
          agents: { minimal: { description: "d", prompt: "p" } },
        },
      }],
    };
    const r = mapStagesToIR(legacy, new Map([["A", []]]), new Map(), new Set());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = r.stages[0]!;
    if (a.type !== "agent") return;
    expect(a.config.subAgents).toEqual([
      { name: "minimal", description: "d", prompt: "p" },
    ]);
  });

  it("emits SUB_AGENT_INVALID when agents is not an object (e.g. array)", () => {
    const legacy = {
      stages: [{
        name: "A", type: "agent",
        runtime: { engine: "llm", system_prompt: "p", reads: {}, agents: ["x"] },
      }],
    };
    const r = mapStagesToIR(legacy as any, new Map(), new Map(), new Set());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("SUB_AGENT_INVALID");
  });

  it("emits SUB_AGENT_INVALID when a sub-agent lacks description", () => {
    const legacy = {
      stages: [{
        name: "A", type: "agent",
        runtime: {
          engine: "llm", system_prompt: "p", reads: {},
          agents: { bad: { prompt: "x" } },
        },
      }],
    };
    const r = mapStagesToIR(legacy, new Map([["A", []]]), new Map(), new Set());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("SUB_AGENT_INVALID");
  });

  it("emits SUB_AGENT_INVALID when a sub-agent lacks prompt", () => {
    const legacy = {
      stages: [{
        name: "A", type: "agent",
        runtime: {
          engine: "llm", system_prompt: "p", reads: {},
          agents: { bad: { description: "x" } },
        },
      }],
    };
    const r = mapStagesToIR(legacy, new Map([["A", []]]), new Map(), new Set());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("SUB_AGENT_INVALID");
  });

  it("does not populate subAgents when runtime.agents is absent", () => {
    const legacy = {
      stages: [{
        name: "A", type: "agent",
        runtime: { engine: "llm", system_prompt: "p", reads: {} },
      }],
    };
    const r = mapStagesToIR(legacy, new Map([["A", []]]), new Map(), new Set());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = r.stages[0]!;
    if (a.type !== "agent") return;
    expect(a.config.subAgents).toBeUndefined();
  });

  it("emits LEGACY_FIELD_IGNORED for runtime.retry (Slice A placeholder; Slice C extracts)", () => {
    const legacy = {
      stages: [
        { name: "P", type: "script",
          runtime: { engine: "script", script_id: "m", reads: {},
                     retry: { max_retries: 1, back_to: "A" } } },
        { name: "A", type: "agent", runtime: { engine: "llm", system_prompt: "p", reads: {} } },
      ],
    };
    const r = mapStagesToIR(legacy, new Map([["P", []], ["A", []]]), new Map(), new Set());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.some(w =>
      w.code === "LEGACY_FIELD_IGNORED" && w.context?.field === "retry"
    )).toBe(true);
  });

  it("derives inputs from each reads-target entry's fields", () => {
    const legacy = {
      stages: [{
        name: "echoBack", type: "agent",
        runtime: { engine: "llm", system_prompt: "echo", reads: { greeting: "greeting" } },
      }],
    };
    const r = mapStagesToIR(legacy, stageOutputs, entryDirectory, new Set());
    expect(r.ok).toBe(true);
    if (r.ok) {
      const inputNames = r.stages[0]!.inputs.map((p) => p.name).sort();
      expect(inputNames).toEqual(["note", "subject"]);
    }
  });

  it("derives inputs from injected_context reads as type unknown", () => {
    const legacy = {
      stages: [{
        name: "collector", type: "agent",
        runtime: { engine: "llm", system_prompt: "collect", reads: { cfg: "pipelineConfig" } },
      }],
    };
    const externalKeys = new Set(["pipelineConfig"]);
    const r = mapStagesToIR(legacy, new Map([["collector", []]]), new Map(), externalKeys);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stages[0]!.inputs).toEqual([{ name: "pipelineConfig", type: "unknown" }]);
    }
  });

  it("fails with STAGE_READS_UNKNOWN_KEY for reads pointing at nothing", () => {
    const legacy = {
      stages: [{
        name: "s", type: "agent",
        runtime: { engine: "llm", system_prompt: "p", reads: { x: "ghost" } },
      }],
    };
    const r = mapStagesToIR(legacy, new Map([["s", []]]), new Map(), new Set());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]!.code).toBe("STAGE_READS_UNKNOWN_KEY");
  });
});
