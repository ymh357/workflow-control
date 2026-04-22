// P6-8 regression: the structural validator rejects pipelines with
// no dataflow (no wires, no external inputs, no stage ports) and
// rejects agent/script stages that declare zero ports.
//
// Observed from real Phase 6 run #4: pipeline-generator's persist
// stage stripped every stage's inputs[]/outputs[]/externalInputs
// before calling submit_pipeline. Validator accepted it, runner
// ran the empty-shell to completion in 0ms without executing
// anything, and the resulting pipeline_version was useless.

import { describe, it, expect } from "vitest";
import { validateStructural } from "./structural.js";
import type { PipelineIR } from "../ir/schema.js";

describe("P6-8: empty-dataflow + nontrivial-stage-no-ports rejection", () => {
  it("EMPTY_DATAFLOW rejects a pipeline with no wires, no externals, no ports anywhere", () => {
    const ir: PipelineIR = {
      name: "empty-shell",
      stages: [
        {
          name: "s1", type: "agent",
          inputs: [], outputs: [],
          config: { promptRef: "p" },
        },
        {
          name: "s2", type: "agent",
          inputs: [], outputs: [],
          config: { promptRef: "p" },
        },
      ],
      wires: [],
    };
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.diagnostics.map((d) => d.code);
      expect(codes).toContain("EMPTY_DATAFLOW");
    }
  });

  it("partial shell (externals present but all stage ports stripped) does NOT trip EMPTY_DATAFLOW — caller must still produce usable I/O", () => {
    // This is a deliberate carve-out: we only reject the fully-empty
    // case observed in P6-8. Partial strip is harder to catch without
    // false positives (gate-only fixtures, single-input pipelines that
    // produce side effects, etc.) so we leave it to downstream behavior.
    const ir: PipelineIR = {
      name: "partial-shell",
      externalInputs: [{ name: "ext", type: "string" }],
      stages: [
        {
          name: "s1", type: "agent",
          inputs: [], outputs: [],
          config: { promptRef: "p" },
        },
      ],
      wires: [],
    };
    const r = validateStructural(ir);
    // Not ok — but only because of WIRE_EXTERNAL_SOURCE_PORT_MISSING-
    // equivalent: there's an external input declared but nothing reads
    // it. Validator should NOT also fire EMPTY_DATAFLOW.
    if (!r.ok) {
      expect(r.diagnostics.map((d) => d.code)).not.toContain("EMPTY_DATAFLOW");
    }
  });

  it("gate stages with no ports are legal (their routing drives control flow)", () => {
    const ir: PipelineIR = {
      name: "gate-only",
      externalInputs: [{ name: "signal", type: "string" }],
      stages: [
        {
          name: "s1", type: "agent",
          inputs: [{ name: "signal", type: "string" }],
          outputs: [{ name: "v", type: "string" }],
          config: { promptRef: "p" },
        },
        {
          name: "g1", type: "gate",
          inputs: [{ name: "__gate_signal", type: "unknown" }],
          outputs: [],
          config: {
            question: { text: "ok?" },
            routing: { routes: { approve: "done", reject: "s1" } },
          },
        },
        {
          name: "done", type: "agent",
          inputs: [{ name: "ack", type: "string" }],
          outputs: [{ name: "final", type: "string" }],
          config: { promptRef: "p" },
        },
      ],
      wires: [
        { from: { source: "external", port: "signal" }, to: { stage: "s1", port: "signal" } },
        { from: { stage: "s1", port: "v" }, to: { stage: "g1", port: "__gate_signal" } },
        { from: { stage: "s1", port: "v" }, to: { stage: "done", port: "ack" } },
      ],
    };
    const r = validateStructural(ir);
    // Gate has outputs:[] by design — must not trip NONTRIVIAL_STAGE_NO_PORTS.
    expect(r.ok).toBe(true);
  });

  it("passes the smoke-test fixture (linear two-stage wired pipeline)", () => {
    const ir: PipelineIR = {
      name: "smoke",
      stages: [
        {
          name: "a", type: "agent",
          inputs: [],
          outputs: [{ name: "v", type: "string" }],
          config: { promptRef: "p" },
        },
        {
          name: "b", type: "agent",
          inputs: [{ name: "v", type: "string" }],
          outputs: [{ name: "out", type: "string" }],
          config: { promptRef: "p" },
        },
      ],
      wires: [
        { from: { stage: "a", port: "v" }, to: { stage: "b", port: "v" } },
      ],
    };
    const r = validateStructural(ir);
    expect(r.ok).toBe(true);
  });
});
