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

  it("fails with UNSUPPORTED_FEATURE for parallel block", () => {
    const legacy = { stages: [{ parallel: { name: "pg", stages: [] } }] };
    const r = mapStagesToIR(legacy as { stages: unknown[] } as Parameters<typeof mapStagesToIR>[0], new Map(), new Map(), new Set());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]!.code).toBe("UNSUPPORTED_FEATURE");
  });

  it("fails with UNSUPPORTED_FEATURE for human_confirm type", () => {
    const legacy = { stages: [{ name: "g", type: "human_confirm" }] };
    const r = mapStagesToIR(legacy as Parameters<typeof mapStagesToIR>[0], new Map(), new Map(), new Set());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]!.code).toBe("UNSUPPORTED_FEATURE");
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

  it("rejects script stage with retry.back_to", () => {
    const legacy = {
      stages: [{ name: "s", type: "script", runtime: { engine: "script", script_id: "x", retry: { back_to: "prev" } } }],
    };
    const r = mapStagesToIR(legacy as Parameters<typeof mapStagesToIR>[0], new Map([["s", []]]), new Map(), new Set());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]!.code).toBe("UNSUPPORTED_FEATURE");
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
