import { describe, it, expect } from "vitest";
import { canonicalJSON, versionHash } from "./canonical.js";
import type { PipelineIR } from "./schema.js";

const base: PipelineIR = {
  name: "diamond",
  stages: [
    { name: "A", type: "agent", inputs: [], outputs: [{ name: "x", type: "number" }], config: {} },
    { name: "B", type: "agent", inputs: [{ name: "x", type: "number" }], outputs: [{ name: "y", type: "string" }], config: {} },
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
});
