// Transforms flat-array legacy stages with type "human_confirm" into
// kernel-next gate stages consumable by mapStagesToIR. The approve
// target is the following stage in the flat array; when that stage
// was the first stage of a flattened parallel block, the approve
// target is every stage from the block (so all parallel members get
// authorized simultaneously when a user approves the gate).
// The reject target is runtime.on_reject_to.
//
// Predecessor dependency: kernel-next activates a stage as soon as
// every inbound wire has delivered. A human_confirm gate that has
// zero inbound wires would therefore activate immediately on pipeline
// start, ahead of the stage the user is supposed to be reviewing.
// To preserve the legacy linear semantics, we synthesize a
// `__gate_signal` input on each gate and return a wire list that
// connects the immediately-preceding stage's first output port to it.
// When the gate is the first stage in the flat array (edge case), no
// wire is synthesized.

import type { ConverterDiagnostic } from "./types.js";

interface LegacyStage {
  name?: string;
  type?: string;
  runtime?: { on_reject_to?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export interface SynthPredecessorWire {
  from: { stage: string };           // predecessor stage name
  to: { stage: string; port: string }; // gate stage + synthetic input
}

export type MapHumanConfirmResult =
  | { ok: true; stages: LegacyStage[]; predecessorWires?: SynthPredecessorWire[] }
  | { ok: false; diagnostics: ConverterDiagnostic[] };

// Synthetic port name added to every gate so it can receive a
// predecessor-delivery signal. Double underscore matches the
// convention used for __external__ source markers.
const GATE_SIGNAL_PORT = "__gate_signal";

export function mapHumanConfirmGates(
  flat: LegacyStage[],
  // Keyed by first-inner-stage-name of each flattened parallel block →
  // the full ordered list of members of that block. The caller (e.g.
  // the converter pipeline in legacy-yaml.ts) remaps from
  // unwrapParallelBlocks.blockMembers (keyed by block name) before
  // handing us this map. Empty map when no parallel blocks exist.
  parallelBlockMembers: Map<string, string[]>,
): MapHumanConfirmResult {
  const diagnostics: ConverterDiagnostic[] = [];
  const stages: LegacyStage[] = [];
  const predecessorWires: SynthPredecessorWire[] = [];

  for (let i = 0; i < flat.length; i++) {
    const s = flat[i]!;
    if (s.type !== "human_confirm") {
      stages.push(s);
      continue;
    }

    const rejectTarget = s.runtime?.on_reject_to;
    if (typeof rejectTarget !== "string" || rejectTarget.length === 0) {
      diagnostics.push({
        code: "HUMAN_CONFIRM_NO_REJECT_TARGET",
        message: `stage '${s.name}' is human_confirm but lacks runtime.on_reject_to`,
        context: { stage: s.name },
      });
      continue;
    }

    const next = flat[i + 1];
    if (!next || typeof next.name !== "string") {
      diagnostics.push({
        code: "HUMAN_CONFIRM_AT_END",
        message: `stage '${s.name}' is human_confirm at the end of the pipeline — nothing to approve into`,
        context: { stage: s.name },
      });
      continue;
    }

    const members = parallelBlockMembers.get(next.name);
    const approveTarget: string | string[] =
      members && members.length > 1 ? members : next.name;

    const gateName = s.name!;
    stages.push({
      name: gateName,
      type: "gate",
      // Synthetic input port. The legacy-yaml assembler wires it to
      // the predecessor's first output port so the gate waits for
      // that stage to complete before activating.
      inputs: [{ name: GATE_SIGNAL_PORT, type: "unknown" }],
      config: {
        question: { text: "Approve this result?" },
        routing: { routes: { approve: approveTarget, reject: rejectTarget } },
      },
    } as LegacyStage);

    // Record a predecessor wire when there is an immediate predecessor
    // in the flat array. mapHumanConfirmGates runs after
    // unwrapParallelBlocks, so flat[i - 1] is the last member of the
    // previous parallel block (if it was a parallel) or the previous
    // non-parallel stage — in either case, a stage whose completion
    // should precede the gate.
    const prev = flat[i - 1];
    if (prev && typeof prev.name === "string" &&
        (prev.type === "agent" || prev.type === "script")) {
      predecessorWires.push({
        from: { stage: prev.name },
        to: { stage: gateName, port: GATE_SIGNAL_PORT },
      });
    }
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, stages, predecessorWires };
}
