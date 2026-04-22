// Opt-in smoke test for createClaudeSdkPatchSynthesizer against the
// real Claude Agent SDK. Verifies end-to-end that the SYSTEM_PROMPT +
// parser contract holds under a real model response, not just our
// hand-crafted fake streams.
//
// Default-skipped so CI never burns Anthropic credits. Opt in by
// setting RUN_REAL_SDK=1 in the env. Subscription-based auth (Claude
// Code CLI login) is the expected path per the project's
// single-user stance; ANTHROPIC_API_KEY is an alternative.
//
// Why loose assertions: real-model output is non-deterministic. We
// verify only the invariants the parser MUST uphold:
//   - synth.synthesize() never throws
//   - its return is either null OR a well-formed IRPatch
//   - if non-null: exactly one op, op.op='update_stage_config',
//     stage matches target, configPatch keys ⊆ {promptRef, subAgents}
//
// Compliance rate / patch quality measurement is NOT this test's job.
// It's a canary that surface contracts still match, across model /
// SDK version upgrades.

import { describe, it, expect } from "vitest";
import { createClaudeSdkPatchSynthesizer } from "./claude-sdk-patch-synthesizer.js";
import type { FixSuggestion } from "./propose-pipeline-fix.js";
import type { PipelineIR } from "../ir/schema.js";

const RUN_REAL =
  process.env.RUN_REAL_SDK === "1" ||
  Boolean(process.env.ANTHROPIC_API_KEY);

const SAFE_KEYS = new Set(["promptRef", "subAgents"]);

function simpleIR(): PipelineIR {
  return {
    name: "smoke",
    stages: [
      {
        name: "B",
        type: "agent",
        inputs: [{ name: "x", type: "string" }],
        outputs: [{ name: "y", type: "string" }],
        config: { promptRef: "p-b" },
      },
    ],
    wires: [],
  };
}

function errorStatusSuggestion(): FixSuggestion {
  return {
    kind: "error_status",
    targetStage: "B",
    severity: "error",
    description:
      "Stage 'B' ended with status='error'. The agent tried to transform the input string but its output did not match the declared 'string' schema; the termination_reason was 'natural_completion' but the last tool call returned an unparsed JSON blob.",
    rationale:
      "The prompt probably under-specifies the output contract. Consider sharpening the prompt to explicitly state 'return exactly one string in the y port' or adding a sub-agent dedicated to verifying the output shape before finishing.",
  };
}

function unrelatedSuggestion(): FixSuggestion {
  // A hint that carries no actionable signal — the synth should tend
  // toward NO_PATCH for this one, though the model is free to still
  // propose something. Either outcome is acceptable; we only verify
  // the output is well-formed.
  return {
    kind: "superseded",
    targetStage: "B",
    severity: "info",
    description:
      "Stage 'B' has a superseded attempt — the real outcome is on a later attempt_idx.",
    rationale:
      "Superseded attempts are artefacts of retries or hot-update supersedence; not defects.",
  };
}

describe("claude-sdk-patch-synthesizer smoke (opt-in)", () => {
  it.skipIf(!RUN_REAL)(
    "synthesises a well-formed or null patch for an error_status suggestion",
    { timeout: 120_000 },
    async () => {
      const synth = createClaudeSdkPatchSynthesizer({
        model: "claude-haiku-4-5",
        maxTurns: 2,
      });
      const patch = await synth.synthesize({
        suggestion: errorStatusSuggestion(),
        ir: simpleIR(),
      });
      // Null is acceptable (NO_PATCH).
      if (patch === null) return;
      // Non-null: every invariant enforced by the parser should hold.
      expect(Array.isArray(patch.ops)).toBe(true);
      expect(patch.ops.length).toBe(1);
      const op = patch.ops[0]!;
      expect(op.op).toBe("update_stage_config");
      if (op.op !== "update_stage_config") throw new Error("unreachable");
      expect(op.stage).toBe("B");
      const cp = op.configPatch as Record<string, unknown>;
      for (const k of Object.keys(cp)) {
        expect(SAFE_KEYS.has(k)).toBe(true);
      }
      if (typeof cp.promptRef !== "undefined") {
        expect(typeof cp.promptRef).toBe("string");
      }
      if (typeof cp.subAgents !== "undefined") {
        expect(Array.isArray(cp.subAgents)).toBe(true);
      }
    },
  );

  it.skipIf(!RUN_REAL)(
    "synthesises a well-formed or null patch for a non-actionable suggestion",
    { timeout: 120_000 },
    async () => {
      const synth = createClaudeSdkPatchSynthesizer({
        model: "claude-haiku-4-5",
        maxTurns: 2,
      });
      const patch = await synth.synthesize({
        suggestion: unrelatedSuggestion(),
        ir: simpleIR(),
      });
      if (patch === null) return;
      // Same invariants apply. Model is allowed to still propose
      // something; our job is only to guarantee shape.
      expect(patch.ops.length).toBe(1);
      const op = patch.ops[0]!;
      if (op.op !== "update_stage_config") throw new Error("unreachable");
      expect(op.stage).toBe("B");
      for (const k of Object.keys(op.configPatch as Record<string, unknown>)) {
        expect(SAFE_KEYS.has(k)).toBe(true);
      }
    },
  );
});
