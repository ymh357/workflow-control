import { describe, it, expect } from "vitest";
import { canonicalJSON, versionHash } from "./canonical.js";
import type { PipelineIR } from "./schema.js";

const base: PipelineIR = {
  name: "diamond",
  stages: [
    { name: "A", type: "agent", inputs: [], outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
    { name: "B", type: "agent", inputs: [{ name: "x", type: "number" }], outputs: [{ name: "y", type: "string" }], config: { promptRef: "p" } },
  ],
  wires: [{ from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" } }],
};

describe("canonical IR", () => {
  it("produces same hash regardless of stage array order", () => {
    const reordered: PipelineIR = { ...base, stages: [...base.stages].reverse() };
    expect(versionHash(base)).toBe(versionHash(reordered));
  });

  it("produces same hash regardless of port array order", () => {
    const s0 = base.stages[0]!;
    const withExtraOut: PipelineIR = {
      ...base,
      stages: [
        { ...s0, outputs: [{ name: "x", type: "number" }, { name: "z", type: "string" }] },
        base.stages[1]!,
      ],
    };
    const reorderedPorts: PipelineIR = {
      ...base,
      stages: [
        { ...s0, outputs: [{ name: "z", type: "string" }, { name: "x", type: "number" }] },
        base.stages[1]!,
      ],
    };
    expect(versionHash(withExtraOut)).toBe(versionHash(reorderedPorts));
  });

  it("produces different hash when types change", () => {
    const altered: PipelineIR = {
      ...base,
      stages: [
        base.stages[0]!,
        { ...base.stages[1]!, inputs: [{ name: "x", type: "string" /* was number */ }] },
      ],
    };
    expect(versionHash(base)).not.toBe(versionHash(altered));
  });

  it("canonical JSON has sorted keys and deterministic output", () => {
    const j1 = canonicalJSON(base);
    const j2 = canonicalJSON(JSON.parse(JSON.stringify(base)));
    expect(j1).toBe(j2);
    // Keys appear sorted at top level: "name" before "stages" before "wires".
    expect(j1.indexOf('"name"')).toBeLessThan(j1.indexOf('"stages"'));
    expect(j1.indexOf('"stages"')).toBeLessThan(j1.indexOf('"wires"'));
  });

  it("omits undefined optional fields (entry not serialized if absent)", () => {
    const j = canonicalJSON(base);
    expect(j).not.toContain("entry");
  });

  // --- A0.1: wire guard + stage fanout participate in hash ---

  it("wire guard affects versionHash", () => {
    const guarded: PipelineIR = {
      ...base,
      wires: [
        { from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" }, guard: "value > 0" },
      ],
    };
    expect(versionHash(base)).not.toBe(versionHash(guarded));
  });

  it("stage fanout affects versionHash", () => {
    const s1: PipelineIR["stages"][number] = {
      name: "A",
      type: "agent",
      inputs: [{ name: "x", type: "number" }],
      outputs: [{ name: "y", type: "string" }],
      config: { promptRef: "p" },
      fanout: { input: "x" },
    };
    const withFanout: PipelineIR = {
      ...base,
      stages: [s1, base.stages[1]!],
    };
    expect(versionHash(base)).not.toBe(versionHash(withFanout));
  });

  it("absent guard is not serialized (hash stable after undefined-stripping)", () => {
    const j1 = canonicalJSON(base);
    // baseline wire has no guard; canonical JSON should not contain "guard"
    expect(j1).not.toContain("guard");
  });
});

describe("canonical IR backward-compat (externalInputs extension)", () => {
  it("preserves diamondIR versionHash when externalInputs is absent", async () => {
    const { diamondIR } = await import("../generator-mock/mini-generator.js");
    // Baseline captured 2026-04-20 before canonical.ts was touched.
    // If this fails: canonicalizeIR changed the canonical form for
    // legacy fixtures — roll back.
    const BASELINE = "d3c934a0e6778cfdbae40af7a6a33de85103153a74eea234520963fa7637597b";
    expect(versionHash(diamondIR())).toBe(BASELINE);
  });

  it("preserves smokeTestIR versionHash when externalInputs is absent", async () => {
    const { smokeTestIR } = await import("../builtins/smoke-test.js");
    const BASELINE = "2c989597e54f341296edc37b4612a04736112d21a130595d5d96eb7b48be8e07";
    expect(versionHash(smokeTestIR())).toBe(BASELINE);
  });

  it("preserves hash for legacy-shaped wires (no source tag)", () => {
    const withLegacyWire: PipelineIR = {
      ...base,
      wires: [{ from: { stage: "A", port: "x" } as any, to: { stage: "B", port: "x" } }],
    };
    const withExplicitStage: PipelineIR = {
      ...base,
      wires: [{ from: { source: "stage", stage: "A", port: "x" }, to: { stage: "B", port: "x" } }],
    };
    expect(versionHash(withLegacyWire)).toBe(versionHash(withExplicitStage));
  });

  it("produces different hash for external-source wire vs same-shaped stage-source wire", () => {
    const withStage: PipelineIR = {
      ...base,
      wires: [{ from: { source: "stage", stage: "A", port: "x" }, to: { stage: "B", port: "x" } }],
    };
    const withExternal: PipelineIR = {
      name: "diamond",
      stages: [
        { name: "B", type: "agent", inputs: [{ name: "x", type: "number" }], outputs: [{ name: "y", type: "string" }], config: { promptRef: "p" } },
      ],
      externalInputs: [{ name: "x", type: "number" }],
      wires: [{ from: { source: "external", port: "x" }, to: { stage: "B", port: "x" } }],
    };
    expect(versionHash(withStage)).not.toBe(versionHash(withExternal));
  });

  it("externalInputs are sorted by name in canonical form (hash-stable)", () => {
    const irA: PipelineIR = {
      name: "t",
      stages: [{ name: "S", type: "agent", inputs: [], outputs: [], config: { promptRef: "p" } }],
      externalInputs: [{ name: "a", type: "string" }, { name: "b", type: "string" }],
      wires: [],
    };
    const irB: PipelineIR = { ...irA, externalInputs: [...irA.externalInputs!].reverse() };
    expect(versionHash(irA)).toBe(versionHash(irB));
  });

  it("omits externalInputs from canonical form when empty (preserves legacy hash)", () => {
    const withEmpty: PipelineIR = { ...base, externalInputs: [] };
    const withoutField: PipelineIR = { ...base };
    delete (withoutField as any).externalInputs;
    expect(versionHash(withEmpty)).toBe(versionHash(withoutField));
  });
});
