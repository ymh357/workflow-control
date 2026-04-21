import { describe, it, expect } from "vitest";
import { mapReadsToWires } from "./map-wires.js";
import type { EntryDescriptor } from "./map-store-schema.js";

describe("mapReadsToWires", () => {
  const entryDirectory = new Map<string, EntryDescriptor>([
    ["greeting", {
      producerStage: "greet",
      fields: [{ name: "subject", type: "string" }, { name: "note", type: "string" }],
    }],
  ]);

  it("produces one wire per entry field when reads references a store_schema key", () => {
    const legacy: Parameters<typeof mapReadsToWires>[0] = {
      stages: [
        { name: "greet", type: "agent", runtime: { reads: {} } },
        { name: "echoBack", type: "agent", runtime: { reads: { g: "greeting" } } },
      ],
    };
    const r = mapReadsToWires(legacy, entryDirectory, new Set());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.wires).toHaveLength(2);
      const names = r.wires.map((w) => `${w.to.stage}.${w.to.port}`).sort();
      expect(names).toEqual(["echoBack.note", "echoBack.subject"]);
      for (const w of r.wires) {
        expect(w.from.source).toBe("stage");
        if (w.from.source === "stage") expect(w.from.stage).toBe("greet");
      }
    }
  });

  it("produces one external wire per injected_context read (to.port = localKey)", () => {
    const legacy = {
      stages: [{ name: "collector", type: "agent", runtime: { reads: { cfg: "pipelineConfig" } } }],
    };
    const externalKeys = new Set(["pipelineConfig"]);
    const r = mapReadsToWires(legacy, new Map(), externalKeys);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.wires).toHaveLength(1);
      const w = r.wires[0]!;
      expect(w.from).toEqual({ source: "external", port: "pipelineConfig" });
      expect(w.to).toEqual({ stage: "collector", port: "cfg" });
    }
  });

  it("dotted-field read: to.port = localKey, preserving source field name on from.port", () => {
    const entryDirectoryWithDotted = new Map<string, EntryDescriptor>([
      ["pipelineDesign", {
        producerStage: "analyzing",
        fields: [
          { name: "stageContracts", type: "Record<string, unknown>[]" },
          { name: "pipelineName", type: "string" },
        ],
      }],
      ["pipelineDesign.stageContracts", {
        producerStage: "analyzing",
        fields: [{ name: "stageContracts", type: "Record<string, unknown>[]" }],
      }],
    ]);
    const legacy: Parameters<typeof mapReadsToWires>[0] = {
      stages: [
        { name: "analyzing", type: "agent", runtime: { reads: {} } },
        {
          name: "genSkeleton",
          type: "agent",
          runtime: { reads: { contracts: "pipelineDesign.stageContracts" } },
        },
      ],
    };
    const r = mapReadsToWires(legacy, entryDirectoryWithDotted, new Set());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.wires).toHaveLength(1);
      const w = r.wires[0]!;
      expect(w.from).toEqual({ source: "stage", stage: "analyzing", port: "stageContracts" });
      expect(w.to).toEqual({ stage: "genSkeleton", port: "contracts" });
    }
  });

  it("fails with STAGE_READS_UNKNOWN_KEY when reads target is unresolved", () => {
    const legacy = {
      stages: [{ name: "s", type: "agent", runtime: { reads: { x: "ghost" } } }],
    };
    const r = mapReadsToWires(legacy, new Map(), new Set());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]!.code).toBe("STAGE_READS_UNKNOWN_KEY");
  });

  it("emits no wires for a stage with empty reads", () => {
    const legacy = {
      stages: [{ name: "s", type: "agent", runtime: { reads: {} } }],
    };
    const r = mapReadsToWires(legacy, new Map(), new Set());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.wires).toEqual([]);
  });

  it("skips non-agent non-script stages (no wires generated)", () => {
    const legacy = {
      stages: [
        { name: "gate", type: "human_confirm" },
        { name: "A", type: "agent", runtime: { reads: {} } },
      ],
    };
    const r = mapReadsToWires(legacy as any, new Map(), new Set());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.wires).toEqual([]);
  });
});
