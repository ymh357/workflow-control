// Unit tests for validate_and_repair_ir. Each of the 5 repair functions
// gets dedicated coverage; the top-level wrapper gets a smoke test that
// chains them in order on the most complex realistic case (a fanout +
// dup wire combo seen in the actual 6 dogfood failures).
//
// We construct PipelineIR objects directly rather than via Zod parse —
// the repair script operates on already-typed data (typed via the
// importer's interface contract).

import { describe, it, expect } from "vitest";
import type { PipelineIR } from "../ir/schema.js";
import {
  validateAndRepairIR,
  validate_and_repair_ir,
} from "./validate-and-repair-ir.js";

// Test scaffolding — minimal stage helpers to keep IR fixtures readable.

function agentStage(
  name: string,
  inputs: Array<{ name: string; type: string }>,
  outputs: Array<{ name: string; type: string }>,
  fanoutInput?: string,
): PipelineIR["stages"][number] {
  const s: PipelineIR["stages"][number] = {
    name,
    type: "agent",
    inputs,
    outputs,
    config: { promptRef: name },
  };
  if (fanoutInput) {
    (s as { fanout?: { input: string } }).fanout = { input: fanoutInput };
  }
  return s;
}

function scriptStageRegistry(
  name: string,
  inputs: Array<{ name: string; type: string }>,
  outputs: Array<{ name: string; type: string }>,
  moduleId: string,
): PipelineIR["stages"][number] {
  return {
    name,
    type: "script",
    inputs,
    outputs,
    config: { source: "registry", moduleId },
  };
}

function gateStage(
  name: string,
  inputs: Array<{ name: string; type: string }>,
  routes: Record<string, string>,
): PipelineIR["stages"][number] {
  return {
    name,
    type: "gate",
    inputs,
    outputs: [],
    config: {
      question: { text: `Q: ${name}` },
      routing: { routes },
    },
  };
}

function ir(stages: PipelineIR["stages"], wires: PipelineIR["wires"], extras: Partial<PipelineIR> = {}): PipelineIR {
  return {
    name: "test-pipeline",
    stages,
    wires,
    externalInputs: [],
    session_mode: "multi",
    ...extras,
  };
}

// ---------- Repair 1: dedup wires ----------

describe("validate_and_repair_ir / dedup wires", () => {
  it("removes literally-identical duplicate wires", () => {
    const inputIR = ir(
      [
        agentStage("A", [], [{ name: "out", type: "string" }]),
        agentStage("B", [{ name: "in", type: "string" }], []),
      ],
      [
        { from: { source: "stage", stage: "A", port: "out" }, to: { stage: "B", port: "in" } },
        { from: { source: "stage", stage: "A", port: "out" }, to: { stage: "B", port: "in" } },
        { from: { source: "stage", stage: "A", port: "out" }, to: { stage: "B", port: "in" } },
      ],
    );
    const r = validateAndRepairIR(inputIR);
    expect(r.ir.wires.length).toBe(1);
    expect(r.repairs.some((s) => /removed 2 duplicate/.test(s))).toBe(true);
  });

  it("preserves wires with different guards even if from/to identical", () => {
    const inputIR = ir(
      [
        agentStage("A", [], [{ name: "out", type: "number" }]),
        agentStage("B", [{ name: "in", type: "number" }], []),
      ],
      [
        { from: { source: "stage", stage: "A", port: "out" }, to: { stage: "B", port: "in" }, guard: "value > 0" },
        { from: { source: "stage", stage: "A", port: "out" }, to: { stage: "B", port: "in" }, guard: "value < 0" },
      ],
    );
    const r = validateAndRepairIR(inputIR);
    expect(r.ir.wires.length).toBe(2);
  });

  it("doesn't dedupe when wires differ only by guard presence", () => {
    const inputIR = ir(
      [
        agentStage("A", [], [{ name: "out", type: "number" }]),
        agentStage("B", [{ name: "in", type: "number" }], []),
      ],
      [
        { from: { source: "stage", stage: "A", port: "out" }, to: { stage: "B", port: "in" } },
        { from: { source: "stage", stage: "A", port: "out" }, to: { stage: "B", port: "in" }, guard: "value > 0" },
      ],
    );
    const r = validateAndRepairIR(inputIR);
    expect(r.ir.wires.length).toBe(2);
  });
});

// ---------- Repair 2: port name fuzzy match (target side) ----------

describe("validate_and_repair_ir / port name fuzzy match", () => {
  it("rewrites wire target with suffix-style mismatch (#2 case)", () => {
    // LLM wrote `topicFraming.rejectionFeedback`, real input is
    // `framingRejectionFeedback`.
    const inputIR = ir(
      [
        gateStage("framingGate", [], { reject: "topicFraming" }),
        agentStage("topicFraming", [{ name: "framingRejectionFeedback", type: "string" }], [{ name: "out", type: "string" }]),
      ],
      [
        { from: { source: "stage", stage: "framingGate", port: "__gate_feedback__" }, to: { stage: "topicFraming", port: "rejectionFeedback" } },
      ],
    );
    const r = validateAndRepairIR(inputIR);
    expect(r.ir.wires[0]!.to.port).toBe("framingRejectionFeedback");
    expect(r.repairs.some((s) => /rejectionFeedback.*framingRejectionFeedback/.test(s))).toBe(true);
  });

  it("leaves wire alone when target port already exists", () => {
    const inputIR = ir(
      [
        agentStage("A", [], [{ name: "out", type: "string" }]),
        agentStage("B", [{ name: "in", type: "string" }], []),
      ],
      [{ from: { source: "stage", stage: "A", port: "out" }, to: { stage: "B", port: "in" } }],
    );
    const r = validateAndRepairIR(inputIR);
    expect(r.ir.wires[0]!.to.port).toBe("in");
  });

  it("throws when fuzzy match has multiple candidates", () => {
    // hypothesize-style stage with TWO rejection-feedback ports; LLM wires
    // the bare "rejectionFeedback" — ambiguous.
    const inputIR = ir(
      [
        gateStage("findingsSynthesisGate", [], { reject: "hypothesize" }),
        agentStage(
          "hypothesize",
          [
            { name: "findingsRejectionFeedback", type: "string" },
            { name: "humanRejectionFeedback", type: "string" },
          ],
          [{ name: "out", type: "string" }],
        ),
      ],
      [
        { from: { source: "stage", stage: "findingsSynthesisGate", port: "__gate_feedback__" }, to: { stage: "hypothesize", port: "rejectionFeedback" } },
      ],
    );
    expect(() => validateAndRepairIR(inputIR)).toThrow(
      /ambiguous wire target port/,
    );
  });

  it("leaves wire when no candidate matches (true unrepairable typo)", () => {
    const inputIR = ir(
      [
        agentStage("A", [], [{ name: "out", type: "string" }]),
        agentStage("B", [{ name: "completelyDifferent", type: "string" }], []),
      ],
      [{ from: { source: "stage", stage: "A", port: "out" }, to: { stage: "B", port: "totallyUnrelated" } }],
    );
    const r = validateAndRepairIR(inputIR);
    // Wire passes through unchanged; downstream submit_pipeline emits
    // WIRE_TARGET_PORT_MISSING.
    expect(r.ir.wires[0]!.to.port).toBe("totallyUnrelated");
  });

  // 2026-05-06: symmetric source-side fuzzy match. Historical PG WIRE_*
  // failure cluster (4-29) was the LLM emitting wires like
  // 'tutorialAuthoring.tutorials' as the SOURCE; the existing
  // repairFanoutShape handles this for fanout sources only. The new
  // path covers non-fanout sources (e.g. 'findingsAuthoring.findings'
  // → 'findingsAuthoring.findingsJson' typo).
  it("rewrites wire SOURCE port with substring fuzzy match on a non-fanout stage", () => {
    const inputIR = ir(
      [
        agentStage("findingsAuthoring", [], [{ name: "findingsJson", type: "string" }]),
        agentStage("downstream", [{ name: "in", type: "string" }], []),
      ],
      [
        { from: { source: "stage", stage: "findingsAuthoring", port: "findings" }, to: { stage: "downstream", port: "in" } },
      ],
    );
    const r = validateAndRepairIR(inputIR);
    expect(r.ir.wires[0]!.from.source).toBe("stage");
    if (r.ir.wires[0]!.from.source === "stage") {
      expect(r.ir.wires[0]!.from.port).toBe("findingsJson");
    }
    expect(
      r.repairs.some((s) => /rewrote wire source.*findings.*findingsJson/.test(s)),
    ).toBe(true);
  });

  it("leaves wire alone when source port already exists on the upstream stage", () => {
    const inputIR = ir(
      [
        agentStage("A", [], [{ name: "out", type: "string" }]),
        agentStage("B", [{ name: "in", type: "string" }], []),
      ],
      [{ from: { source: "stage", stage: "A", port: "out" }, to: { stage: "B", port: "in" } }],
    );
    const r = validateAndRepairIR(inputIR);
    if (r.ir.wires[0]!.from.source === "stage") {
      expect(r.ir.wires[0]!.from.port).toBe("out");
    }
  });

  it("throws when source-side fuzzy match has multiple candidates", () => {
    const inputIR = ir(
      [
        agentStage(
          "ambiguousSource",
          [],
          [
            { name: "fooBar", type: "string" },
            { name: "fooBaz", type: "string" },
          ],
        ),
        agentStage("downstream", [{ name: "in", type: "string" }], []),
      ],
      [
        { from: { source: "stage", stage: "ambiguousSource", port: "foo" }, to: { stage: "downstream", port: "in" } },
      ],
    );
    expect(() => validateAndRepairIR(inputIR)).toThrow(
      /ambiguous wire source port/,
    );
  });

  it("does NOT touch source port for fanout stages (those go through repairFanoutShape)", () => {
    // Fanout source with mismatched port is left for the dedicated
    // shape-inference repair, not the symmetric fuzzy repair.
    const inputIR = ir(
      [
        agentStage("upstream", [], [{ name: "items", type: "string[]" }]),
        agentStage(
          "fanoutStage",
          [{ name: "item", type: "string" }],
          [{ name: "result", type: "string" }],
          "item", // declares fanout — fanout source by definition
        ),
        agentStage("downstream", [{ name: "rs", type: "string[]" }], []),
      ],
      [
        { from: { source: "stage", stage: "upstream", port: "items" }, to: { stage: "fanoutStage", port: "item" } },
        { from: { source: "stage", stage: "fanoutStage", port: "results" }, to: { stage: "downstream", port: "rs" } },
      ],
    );
    const r = validateAndRepairIR(inputIR);
    // The non-fanout-source path didn't touch this; repairFanoutShape may.
    // Either way, the new symmetric helper should not have repaired
    // 'fanoutStage.results' via the .from-port fuzzy branch (because we
    // explicitly skip fanout stages in that branch). Confirm by examining
    // the repair messages: any 'rewrote wire source' for fanoutStage
    // must come from repairFanoutShape's pattern label, not the new
    // symmetric repair label "rewrote wire source 'X.Y' -> 'X.Z'".
    const symRepairLabels = r.repairs.filter((s) =>
      s.startsWith("repairPortNameMismatch: rewrote wire source 'fanoutStage."),
    );
    expect(symRepairLabels).toEqual([]);
  });
});

// ---------- Repair 3: fanout-shape (Pattern A: hallucinated source port) ----------

describe("validate_and_repair_ir / fanout shape — hallucinated source port", () => {
  it("rewrites tutorialAuthoring.tutorials -> tutorialAuthoring.markdown for string[] target (#1 case)", () => {
    // LLM hallucinated 'tutorials' aggregate port. Real outputs are
    // slug + markdown. Target wants string[] (markdowns).
    const inputIR = ir(
      [
        agentStage(
          "tutorialAuthoring",
          [{ name: "concept", type: "string" }],
          [
            { name: "slug", type: "string" },
            { name: "markdown", type: "string" },
          ],
          "concept",
        ),
        agentStage(
          "reportJudge",
          [
            { name: "tutorialMarkdowns", type: "string[]" },
            { name: "tutorialSlugs", type: "string[]" },
          ],
          [{ name: "score", type: "number" }],
        ),
      ],
      [
        { from: { source: "stage", stage: "tutorialAuthoring", port: "tutorials" }, to: { stage: "reportJudge", port: "tutorialMarkdowns" } },
      ],
    );
    const r = validateAndRepairIR(inputIR);
    expect(r.ir.wires.length).toBe(1);
    expect(r.ir.wires[0]!.from).toEqual({
      source: "stage",
      stage: "tutorialAuthoring",
      port: "markdown",
    });
    expect(r.repairs.some((s) => /tutorials.*markdown/.test(s))).toBe(true);
  });

  it("uses single object output port when target is Array<{...}>", () => {
    const inputIR = ir(
      [
        agentStage(
          "evidenceGather",
          [{ name: "hypothesis", type: "{ id: string }" }],
          [
            {
              name: "evidence",
              type: "{ hypothesisId: string; verdict: string }",
            },
          ],
          "hypothesis",
        ),
        scriptStageRegistry(
          "sourceClassify",
          [
            {
              name: "evidence",
              type: "Array<{ hypothesisId: string; verdict: string }>",
            },
          ],
          [{ name: "out", type: "string" }],
          "classify_evidence_bundle",
        ),
      ],
      [
        // LLM wrote a non-existent aggregate port name; real port is `evidence`.
        { from: { source: "stage", stage: "evidenceGather", port: "evidenceBundle" }, to: { stage: "sourceClassify", port: "evidence" } },
      ],
    );
    const r = validateAndRepairIR(inputIR);
    expect(r.ir.wires.length).toBe(1);
    expect(r.ir.wires[0]!.from).toEqual({
      source: "stage",
      stage: "evidenceGather",
      port: "evidence",
    });
  });

  it("throws when fanout has multiple object outputs and target wants object array", () => {
    const inputIR = ir(
      [
        agentStage(
          "X",
          [{ name: "in", type: "string" }],
          [
            { name: "obj1", type: "{ a: number }" },
            { name: "obj2", type: "{ b: number }" },
          ],
          "in",
        ),
        agentStage(
          "Y",
          [{ name: "data", type: "Array<{ a: number }>" }],
          [],
        ),
      ],
      [
        { from: { source: "stage", stage: "X", port: "data" }, to: { stage: "Y", port: "data" } },
      ],
    );
    expect(() => validateAndRepairIR(inputIR)).toThrow(/multiple object-shaped output/);
  });

  it("preserves wire when fanout source has no element-port match for scalar array target", () => {
    const inputIR = ir(
      [
        agentStage(
          "X",
          [{ name: "in", type: "string" }],
          [{ name: "obj", type: "{ a: number }" }],
          "in",
        ),
        agentStage("Y", [{ name: "list", type: "string[]" }], []),
      ],
      [
        { from: { source: "stage", stage: "X", port: "totalGarbage" }, to: { stage: "Y", port: "list" } },
      ],
    );
    const r = validateAndRepairIR(inputIR);
    // No match found, wire passes through; submit_pipeline emits the
    // real diagnostic.
    expect(r.ir.wires[0]!.from.source === "stage"
      ? r.ir.wires[0]!.from.port
      : "<external>").toBe("totalGarbage");
  });
});

// ---------- Repair 3 (Pattern B): over-fanned outputs ----------

describe("validate_and_repair_ir / fanout shape — over-fanned outputs (#4a)", () => {
  it("synthesizes single object port and merges 5 wires into 1 when target is Array<{...}>", () => {
    // LLM emitted evidenceGather with 5 element-level outputs and wired
    // ALL FIVE to sourceClassify.evidence. Repair: synthesize an
    // 'evidence' object output port and replace the 5 wires with 1.
    const inputIR = ir(
      [
        agentStage(
          "evidenceGather",
          [{ name: "hypothesis", type: "{ id: string }" }],
          [
            { name: "hypothesisId", type: "string" },
            { name: "verdict", type: "string" },
            { name: "positiveEvidence", type: "Array<{ url: string }>" },
            { name: "negativeEvidence", type: "Array<{ url: string }>" },
            { name: "rawArtifacts", type: "string[]" },
          ],
          "hypothesis",
        ),
        scriptStageRegistry(
          "sourceClassify",
          [
            {
              name: "evidence",
              type: "Array<{ hypothesisId: string; verdict: string; positiveEvidence: Array<{ url: string }>; negativeEvidence: Array<{ url: string }>; rawArtifacts: string[] }>",
            },
          ],
          [{ name: "out", type: "string" }],
          "classify_evidence_bundle",
        ),
      ],
      [
        { from: { source: "stage", stage: "evidenceGather", port: "hypothesisId" }, to: { stage: "sourceClassify", port: "evidence" } },
        { from: { source: "stage", stage: "evidenceGather", port: "verdict" }, to: { stage: "sourceClassify", port: "evidence" } },
        { from: { source: "stage", stage: "evidenceGather", port: "positiveEvidence" }, to: { stage: "sourceClassify", port: "evidence" } },
        { from: { source: "stage", stage: "evidenceGather", port: "negativeEvidence" }, to: { stage: "sourceClassify", port: "evidence" } },
        { from: { source: "stage", stage: "evidenceGather", port: "rawArtifacts" }, to: { stage: "sourceClassify", port: "evidence" } },
      ],
    );
    const r = validateAndRepairIR(inputIR);
    // Should be ONE wire from evidenceGather.evidence (synthesised) to sourceClassify.evidence
    expect(r.ir.wires.length).toBe(1);
    expect(r.ir.wires[0]!.from).toEqual({
      source: "stage",
      stage: "evidenceGather",
      port: "evidence",
    });
    // Stage outputs should now include the synthesized 'evidence' port
    const eg = r.ir.stages.find((s) => s.name === "evidenceGather")!;
    const synthPort = eg.outputs.find((p) => p.name === "evidence");
    expect(synthPort).toBeDefined();
    expect(synthPort!.type).toContain("hypothesisId: string");
    expect(synthPort!.type).toContain("verdict: string");
    expect(r.repairs.some((s) => /synthesised object output port.*evidence/.test(s))).toBe(true);
  });

  it("throws when multiple wires converge on a non-object-array target", () => {
    // 3 fanout outputs wired to a single string input — genuinely malformed.
    const inputIR = ir(
      [
        agentStage(
          "X",
          [{ name: "in", type: "string" }],
          [
            { name: "a", type: "string" },
            { name: "b", type: "string" },
            { name: "c", type: "string" },
          ],
          "in",
        ),
        agentStage("Y", [{ name: "single", type: "string" }], []),
      ],
      [
        { from: { source: "stage", stage: "X", port: "a" }, to: { stage: "Y", port: "single" } },
        { from: { source: "stage", stage: "X", port: "b" }, to: { stage: "Y", port: "single" } },
        { from: { source: "stage", stage: "X", port: "c" }, to: { stage: "Y", port: "single" } },
      ],
    );
    expect(() => validateAndRepairIR(inputIR)).toThrow(/wires from fanout stage/);
  });

  it("doesn't synthesize when only 1 wire exists (no over-fanning)", () => {
    const inputIR = ir(
      [
        agentStage(
          "X",
          [{ name: "in", type: "string" }],
          [{ name: "obj", type: "{ a: number }" }],
          "in",
        ),
        agentStage("Y", [{ name: "data", type: "Array<{ a: number }>" }], []),
      ],
      [
        { from: { source: "stage", stage: "X", port: "obj" }, to: { stage: "Y", port: "data" } },
      ],
    );
    const r = validateAndRepairIR(inputIR);
    // No synthesis; wire passes through unchanged.
    expect(r.ir.wires.length).toBe(1);
    expect(r.ir.stages.find((s) => s.name === "X")!.outputs.length).toBe(1);
  });
});

// ---------- Repair 3.5: backfill missing target input ports ----------

describe("validate_and_repair_ir / backfill missing target input ports", () => {
  it("adds missing input port when wire target is undeclared (gen7 case)", () => {
    // LLM declared topicFraming.inputs = [taskText, audienceHint] but
    // forgot framingRejectionFeedback even though a wire targets it.
    const inputIR = ir(
      [
        gateStage("framingGate", [], { reject: "topicFraming" }),
        agentStage(
          "topicFraming",
          [
            { name: "taskText", type: "string" },
            { name: "audienceHint", type: "string" },
          ],
          [{ name: "investigationType", type: "string" }],
        ),
      ],
      [
        { from: { source: "stage", stage: "framingGate", port: "__gate_feedback__" }, to: { stage: "topicFraming", port: "framingRejectionFeedback" } },
      ],
    );
    const r = validateAndRepairIR(inputIR);
    const tf = r.ir.stages.find((s) => s.name === "topicFraming")!;
    expect(tf.inputs.some((p) => p.name === "framingRejectionFeedback")).toBe(true);
    const port = tf.inputs.find((p) => p.name === "framingRejectionFeedback")!;
    expect(port.type).toBe("string"); // inferred from gate __gate_feedback__
    expect(r.repairs.some((s) => /framingRejectionFeedback.*string/.test(s))).toBe(true);
  });

  it("infers type from upstream output port when wire source is non-gate", () => {
    const inputIR = ir(
      [
        agentStage("A", [], [{ name: "out", type: "Array<{ id: number }>" }]),
        agentStage("B", [], [{ name: "kept", type: "string" }]),
      ],
      [
        { from: { source: "stage", stage: "A", port: "out" }, to: { stage: "B", port: "newPort" } },
      ],
    );
    const r = validateAndRepairIR(inputIR);
    const b = r.ir.stages.find((s) => s.name === "B")!;
    const port = b.inputs.find((p) => p.name === "newPort");
    expect(port?.type).toBe("Array<{ id: number }>");
  });

  it("does not add when fuzzy match (Repair 2) found a candidate already", () => {
    const inputIR = ir(
      [
        gateStage("framingGate", [], { reject: "topicFraming" }),
        agentStage(
          "topicFraming",
          [{ name: "framingRejectionFeedback", type: "string" }], // already declared
          [{ name: "out", type: "string" }],
        ),
      ],
      [
        // wire uses bare 'rejectionFeedback' - Repair 2 fuzzy matches to
        // declared 'framingRejectionFeedback', wire is rewritten before
        // backfill runs.
        { from: { source: "stage", stage: "framingGate", port: "__gate_feedback__" }, to: { stage: "topicFraming", port: "rejectionFeedback" } },
      ],
    );
    const r = validateAndRepairIR(inputIR);
    const tf = r.ir.stages.find((s) => s.name === "topicFraming")!;
    expect(tf.inputs.length).toBe(1); // no new input added
  });
});

// ---------- Repair 5: backfill externalInputs ----------

describe("validate_and_repair_ir / backfill externalInputs (#3)", () => {
  it("adds externalInput when wire references undeclared external port", () => {
    const inputIR = ir(
      [
        agentStage("topicFraming", [{ name: "taskText", type: "string" }], [{ name: "out", type: "string" }]),
      ],
      [
        { from: { source: "external", port: "taskText" }, to: { stage: "topicFraming", port: "taskText" } },
      ],
      { externalInputs: [] },
    );
    const r = validateAndRepairIR(inputIR);
    expect(r.ir.externalInputs).toEqual([
      expect.objectContaining({ name: "taskText", type: "string" }),
    ]);
    expect(r.repairs.some((s) => /backfillExternalInputs.*taskText/.test(s))).toBe(true);
  });

  it("dedupes when same external port is referenced by multiple wires", () => {
    const inputIR = ir(
      [
        agentStage("A", [{ name: "x", type: "string" }], []),
        agentStage("B", [{ name: "x", type: "string" }], []),
      ],
      [
        { from: { source: "external", port: "p" }, to: { stage: "A", port: "x" } },
        { from: { source: "external", port: "p" }, to: { stage: "B", port: "x" } },
      ],
    );
    const r = validateAndRepairIR(inputIR);
    expect(r.ir.externalInputs!.length).toBe(1);
    expect(r.ir.externalInputs![0]!.name).toBe("p");
  });

  it("doesn't add when externalInput already declared", () => {
    const inputIR = ir(
      [
        agentStage("topicFraming", [{ name: "taskText", type: "string" }], [{ name: "out", type: "string" }]),
      ],
      [
        { from: { source: "external", port: "taskText" }, to: { stage: "topicFraming", port: "taskText" } },
      ],
      { externalInputs: [{ name: "taskText", type: "string", description: "Pre-declared" }] },
    );
    const r = validateAndRepairIR(inputIR);
    expect(r.ir.externalInputs!.length).toBe(1);
    expect(r.ir.externalInputs![0]!.description).toBe("Pre-declared");
  });
});

// ---------- Top-level smoke test: combined real-world failure ----------

describe("validate_and_repair_ir / combined real-world failure (smoke)", () => {
  it("repairs a fixture combining over-fan + duplicate wires + missing externalInput", () => {
    const inputIR = ir(
      [
        agentStage("topicFraming", [{ name: "taskText", type: "string" }], [{ name: "framing", type: "{}" }]),
        agentStage(
          "evidenceGather",
          [{ name: "hypothesis", type: "{ id: string }" }],
          [
            { name: "hypothesisId", type: "string" },
            { name: "verdict", type: "string" },
          ],
          "hypothesis",
        ),
        scriptStageRegistry(
          "sourceClassify",
          [
            {
              name: "evidence",
              type: "Array<{ hypothesisId: string; verdict: string }>",
            },
          ],
          [{ name: "out", type: "string" }],
          "classify_evidence_bundle",
        ),
      ],
      [
        // (1) Missing externalInput
        { from: { source: "external", port: "taskText" }, to: { stage: "topicFraming", port: "taskText" } },
        // (2) Over-fan into sourceClassify.evidence
        { from: { source: "stage", stage: "evidenceGather", port: "hypothesisId" }, to: { stage: "sourceClassify", port: "evidence" } },
        { from: { source: "stage", stage: "evidenceGather", port: "verdict" }, to: { stage: "sourceClassify", port: "evidence" } },
        // (3) Duplicate wire
        { from: { source: "stage", stage: "evidenceGather", port: "hypothesisId" }, to: { stage: "sourceClassify", port: "evidence" } },
      ],
      { externalInputs: [] },
    );
    const r = validateAndRepairIR(inputIR);
    // After dedup: 3 unique wires (1 ext + 2 evidence). After over-fan
    // merge: 1 ext + 1 synthesised evidence wire = 2 wires.
    expect(r.ir.wires.length).toBe(2);
    // ExternalInput was backfilled.
    expect(r.ir.externalInputs!.some((p) => p.name === "taskText")).toBe(true);
    // evidenceGather got a synthesized object port.
    const eg = r.ir.stages.find((s) => s.name === "evidenceGather")!;
    expect(eg.outputs.some((p) => p.name === "evidence")).toBe(true);
    // Repair log non-empty.
    expect(r.repairs.length).toBeGreaterThan(0);
  });
});

// ---------- Module-level run() smoke test ----------

describe("validate_and_repair_ir module / run()", () => {
  it("repairs ir + subIrs, returns repairs list", async () => {
    const mainIR: PipelineIR = ir(
      [
        agentStage("A", [], [{ name: "out", type: "string" }]),
        agentStage("B", [{ name: "in", type: "string" }], []),
      ],
      [
        { from: { source: "stage", stage: "A", port: "out" }, to: { stage: "B", port: "in" } },
        { from: { source: "stage", stage: "A", port: "out" }, to: { stage: "B", port: "in" } },
      ],
    );
    const subIR: PipelineIR = ir(
      [
        agentStage("X", [], [{ name: "y", type: "string" }]),
      ],
      [],
    );

    const result = await validate_and_repair_ir.run(
      {
        ir: mainIR,
        subIrs: [subIR],
      },
      {
        taskId: "t",
        stageName: "validateAndRepairIR",
        attemptId: "a",
        attemptIdx: 0,
        moduleId: "validate_and_repair_ir",
        env: {},
      },
    );

    expect((result.ir as PipelineIR).wires.length).toBe(1); // dedup
    expect(Array.isArray(result.subIrs)).toBe(true);
    expect((result.subIrs as PipelineIR[]).length).toBe(1);
    expect(Array.isArray(result.repairs)).toBe(true);
    expect((result.repairs as string[]).length).toBeGreaterThan(0);
  });

  it("throws when ir is missing", async () => {
    await expect(
      validate_and_repair_ir.run(
        { subIrs: [] },
        {
          taskId: "t",
          stageName: "validateAndRepairIR",
          attemptId: "a",
          attemptIdx: 0,
          moduleId: "validate_and_repair_ir",
          env: {},
        },
      ),
    ).rejects.toThrow(/'ir' is required/);
  });
});
