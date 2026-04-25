import { describe, it, expect } from "vitest";
import { canonicalJSON, canonicalizeIR, versionHash } from "./canonical.js";
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

  it("explicit fanout.concurrency value affects versionHash", () => {
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
    const withConcurrency: PipelineIR = {
      ...base,
      stages: [
        {
          ...s1,
          fanout: { input: "x", concurrency: 5 },
        },
        base.stages[1]!,
      ],
    };
    expect(versionHash(withFanout)).not.toBe(versionHash(withConcurrency));
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
    // Baseline re-baselined 2026-04-25 Task 2: session_mode now participates in canonical form.
    // Previous baseline: d3c934a0e6778cfdbae40af7a6a33de85103153a74eea234520963fa7637597b
    const BASELINE = "587070ebbd0d735e076c680a5eeb289d1abf3b055a554c750e429bda3e84c125";
    expect(versionHash(diamondIR())).toBe(BASELINE);
  });

  it("smokeTestIR versionHash stays canonical across serialization (re-baselined 2026-04-25 Task 2)", async () => {
    const { smokeTestIR } = await import("../builtins/smoke-test.js");
    // Task 2: session_mode now participates in canonical form.
    // Previous baseline: bb6511f796ede71a3b131b1eb7ed5d6e913b4963fdf822d8f3c004fcbbd9038e
    // If this fails without a deliberate IR change, canonicalizeIR may have
    // drifted; roll back the canonical change or update the baseline explicitly.
    const BASELINE = "c9f051f1774171291161d9c8a041cf6c537dc33cac4b8e3cbf59654f6d1bee4f";
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

describe("canonicalizeIR ScriptStage retry", () => {
  it("omits retry from canonical when absent (baseline hashes stay stable)", () => {
    const ir: PipelineIR = {
      name: "no-retry",
      externalInputs: [],
      stages: [{
        name: "S", type: "script", inputs: [], outputs: [],
        config: { source: "registry", moduleId: "m" },
      }],
      wires: [],
    };
    const canon = canonicalJSON(ir);
    expect(canon).not.toContain('"retry"');
  });

  it("serializes retry alphabetically when present", () => {
    const ir: PipelineIR = {
      name: "with-retry",
      externalInputs: [],
      stages: [
        { name: "S", type: "script", inputs: [], outputs: [],
          config: { source: "registry", moduleId: "m", retry: { maxRetries: 2, backToStage: "T" } } },
        { name: "T", type: "agent", inputs: [], outputs: [{ name: "x", type: "number" }],
          config: { promptRef: "p" } },
      ],
      wires: [],
    };
    const canon = canonicalJSON(ir);
    // Alphabetical key order within the retry object: backToStage before maxRetries.
    expect(canon).toContain('"retry":{"backToStage":"T","maxRetries":2}');
  });
});

describe("canonicalizeIR AgentStage subAgents", () => {
  it("omits subAgents from canonical when absent (baseline hashes stay stable)", () => {
    const ir: PipelineIR = {
      name: "no-sub",
      externalInputs: [],
      stages: [{
        name: "A", type: "agent", inputs: [], outputs: [],
        config: { promptRef: "p" },
      }],
      wires: [],
    };
    const canon = canonicalJSON(ir);
    expect(canon).not.toContain('"subAgents"');
  });

  it("sorts subAgents by name alphabetically (permutation-equivalent hashes)", () => {
    const makeIR = (order: string[]): PipelineIR => ({
      name: "with-sub",
      externalInputs: [],
      stages: [{
        name: "A", type: "agent", inputs: [], outputs: [],
        config: {
          promptRef: "p",
          subAgents: order.map(n => ({ name: n, description: "d", prompt: "p" })),
        },
      }],
      wires: [],
    });
    const canonZA = canonicalJSON(makeIR(["zeta", "alpha"]));
    const canonAZ = canonicalJSON(makeIR(["alpha", "zeta"]));
    expect(canonZA).toBe(canonAZ);
    // Alphabetical order: alpha appears before zeta in canonical string.
    expect(canonAZ.indexOf("alpha")).toBeLessThan(canonAZ.indexOf("zeta"));
  });

  it("serializes each sub-agent with alphabetical key order", () => {
    const ir: PipelineIR = {
      name: "ordered",
      externalInputs: [],
      stages: [{
        name: "A", type: "agent", inputs: [], outputs: [],
        config: {
          promptRef: "p",
          subAgents: [{
            name: "writer", description: "d", prompt: "sp",
            tools: ["Read"], model: "sonnet", maxTurns: 10,
          }],
        },
      }],
      wires: [],
    };
    const canon = canonicalJSON(ir);
    // Keys inside a sub-agent should appear in alphabetical order:
    // description, maxTurns, model, name, prompt, tools
    const subCanon = canon.substring(canon.indexOf('"subAgents"'));
    expect(subCanon.indexOf('"description"')).toBeLessThan(subCanon.indexOf('"maxTurns"'));
    expect(subCanon.indexOf('"maxTurns"')).toBeLessThan(subCanon.indexOf('"model"'));
    expect(subCanon.indexOf('"model"')).toBeLessThan(subCanon.indexOf('"name"'));
    expect(subCanon.indexOf('"name"')).toBeLessThan(subCanon.indexOf('"prompt"'));
    expect(subCanon.indexOf('"prompt"')).toBeLessThan(subCanon.indexOf('"tools"'));
  });
});

describe("canonicalizeIR gate routing widening", () => {
  it("preserves single-string route targets in canonical (hash stable vs pre-widening)", () => {
    // Build an IR with a single-stage gate route; assert the canonical
    // JSON for the gate stage contains "approve":"B" and NOT
    // "approve":["B"].
    const ir: PipelineIR = {
      name: "single-route",
      stages: [
        { name: "G", type: "gate", inputs: [], outputs: [],
          config: {
            question: { text: "?" },
            routing: { routes: { approve: "B", reject: "C" } },
          } },
        { name: "B", type: "agent", inputs: [], outputs: [],
          config: { promptRef: "p" } },
        { name: "C", type: "agent", inputs: [], outputs: [],
          config: { promptRef: "p" } },
      ],
      wires: [],
      externalInputs: [],
    };
    const canon = canonicalJSON(ir);
    expect(canon).toContain('"approve":"B"');
    expect(canon).not.toContain('"approve":["B"]');
    expect(canon).toContain('"reject":"C"');
  });

  it("sorts array route targets alphabetically in canonical (permutation-equivalent hashes)", () => {
    const makeIR = (approveArr: string[]): PipelineIR => ({
      name: "array-route",
      stages: [
        { name: "G", type: "gate", inputs: [], outputs: [],
          config: {
            question: { text: "?" },
            routing: { routes: { approve: approveArr, reject: "Z" } },
          } },
        { name: "X", type: "agent", inputs: [], outputs: [], config: { promptRef: "p" } },
        { name: "Y", type: "agent", inputs: [], outputs: [], config: { promptRef: "p" } },
        { name: "Z", type: "agent", inputs: [], outputs: [], config: { promptRef: "p" } },
      ],
      wires: [],
      externalInputs: [],
    });
    const canonYX = canonicalJSON(makeIR(["Y", "X"]));
    const canonXY = canonicalJSON(makeIR(["X", "Y"]));
    expect(canonYX).toBe(canonXY);
    expect(canonXY).toContain('"approve":["X","Y"]');
  });
});

describe("canonical: cross_segment_resume_from", () => {
  it("absent → byte-identical to a pre-pivot agent stage canonical form", () => {
    const without = canonicalizeIR({
      name: "p",
      stages: [
        { name: "a", type: "agent", inputs: [], outputs: [],
          config: { promptRef: "p" } },
      ],
      wires: [],
    });
    // Snapshot the canonical without the new field; nothing should
    // mention cross_segment_resume_from at all.
    expect(JSON.stringify(without)).not.toContain("cross_segment_resume_from");
  });

  it("present → field appears in canonical form and shifts hash", () => {
    const without = canonicalizeIR({
      name: "p",
      stages: [
        { name: "a", type: "agent", inputs: [], outputs: [],
          config: { promptRef: "p" } },
        { name: "b", type: "agent", inputs: [], outputs: [],
          config: { promptRef: "p" } },
      ],
      wires: [],
    });
    const withField = canonicalizeIR({
      name: "p",
      stages: [
        { name: "a", type: "agent", inputs: [], outputs: [],
          config: { promptRef: "p" } },
        { name: "b", type: "agent", inputs: [], outputs: [],
          config: { promptRef: "p", cross_segment_resume_from: "a" } },
      ],
      wires: [],
    });
    expect(JSON.stringify(withField)).toContain("cross_segment_resume_from");
    expect(JSON.stringify(withField)).not.toBe(JSON.stringify(without));
  });
});

describe("canonical: session_mode in version_hash", () => {
  const base: PipelineIR = {
    name: "p",
    stages: [{
      name: "s1",
      type: "agent",
      inputs: [],
      outputs: [],
      config: { promptRef: "p/r" },
    }],
    wires: [],
  };

  it("differs when session_mode differs", () => {
    const multi = versionHash({ ...base, session_mode: "multi" });
    const single = versionHash({ ...base, session_mode: "single" });
    expect(multi).not.toBe(single);
  });

  it("includes session_mode in canonical output", () => {
    const out = canonicalJSON({ ...base, session_mode: "single" });
    expect(out).toContain("session_mode");
    expect(out).toContain("single");
  });

  it("defaults to 'multi' when absent (hash-stable for pre-Task-1 IRs)", () => {
    const explicit = versionHash({ ...base, session_mode: "multi" });
    const absent = versionHash({ ...base });
    expect(explicit).toBe(absent);
  });
});
