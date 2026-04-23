"use client";

// Proposal diff viewer (P7.2 / D22).
//
// Renders two PipelineGraph instances side-by-side so a reviewer can
// eyeball the structural change a proposal would introduce before
// approving it. Presentational only — the parent page owns the
// base/projected IR pair (typically fetched via
// POST /api/kernel/proposals/:id/preview).

import { PipelineGraph } from "./pipeline-graph";
import type { PipelineIRLike } from "../lib/ir-to-flow";

export interface ProposalDiffProps {
  baseIr: PipelineIRLike;
  projectedIr: PipelineIRLike;
  /** Shared height for both graphs. Defaults to 420 — enough for a
   *  typical 4-8 stage pipeline side-by-side without vertical scroll. */
  height?: number;
}

export function ProposalDiff({ baseIr, projectedIr, height = 420 }: ProposalDiffProps) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <div>
        <h3 className="mb-2 text-sm font-semibold text-slate-700">Base version</h3>
        <PipelineGraph ir={baseIr} height={height} />
      </div>
      <div>
        <h3 className="mb-2 text-sm font-semibold text-slate-700">After proposed patch</h3>
        <PipelineGraph ir={projectedIr} height={height} />
      </div>
    </div>
  );
}
