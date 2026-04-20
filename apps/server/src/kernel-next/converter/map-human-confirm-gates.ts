// Transforms flat-array legacy stages with type "human_confirm" into
// kernel-next gate stages consumable by mapStagesToIR. The approve
// target is the following stage in the flat array; when that stage
// was the first stage of a flattened parallel block, the approve
// target is every stage from the block (so all parallel members get
// authorized simultaneously when a user approves the gate).
// The reject target is runtime.on_reject_to.

import type { ConverterDiagnostic } from "./types.js";

interface LegacyStage {
  name?: string;
  type?: string;
  runtime?: { on_reject_to?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export type MapHumanConfirmResult =
  | { ok: true; stages: LegacyStage[] }
  | { ok: false; diagnostics: ConverterDiagnostic[] };

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

    stages.push({
      name: s.name,
      type: "gate",
      config: {
        question: { text: "Approve this result?" },
        routing: { routes: { approve: approveTarget, reject: rejectTarget } },
      },
    } as LegacyStage);
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, stages };
}
