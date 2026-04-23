// REST route for proposal-diff previews (P7.2 / D22).
//
// POST /api/kernel/proposals/:id/preview
//
// Returns both the base and the post-patch IRs for a proposal so the
// dashboard can render a side-by-side DAG comparison before an
// approval decision. No DB writes — this is a pure read that joins
// pipeline_proposals → pipeline_versions twice (base + proposed).
//
// Note on "dry-apply": kernel-next materialises the proposed IR at
// propose-time (see KernelService.propose — the new version is
// inserted into pipeline_versions before the proposal row is written).
// Therefore the projected IR is already persisted; we do NOT need to
// re-run applyPatch against the base. Using the stored proposed
// version is both cheaper and guaranteed to match whatever approve
// would pick up, since approve also references proposed_version.
//
// Error envelope mirrors kernel-proposals.ts:
//   { ok: false, diagnostics: [{ code, message, context? }] }

import { Hono } from "hono";
import { getKernelNextDb } from "../lib/kernel-next-db.js";

export const kernelProposalPreviewRoute = new Hono();

interface ProposalRow {
  base_version: string;
  proposed_version: string | null;
  status: "pending" | "approved" | "rejected";
}

interface VersionRow {
  ir_json: string;
}

kernelProposalPreviewRoute.post("/kernel/proposals/:id/preview", (c) => {
  const id = c.req.param("id");
  const db = getKernelNextDb();

  const proposal = db
    .prepare(
      `SELECT base_version, proposed_version, status
         FROM pipeline_proposals
        WHERE proposal_id = ?`,
    )
    .get(id) as ProposalRow | undefined;

  if (!proposal) {
    return c.json(
      {
        ok: false,
        diagnostics: [{
          code: "PROPOSAL_NOT_FOUND",
          message: `no proposal with id '${id}'`,
          context: { proposalId: id },
        }],
      },
      404,
    );
  }

  if (proposal.proposed_version === null) {
    // Defensive: KernelService.propose always writes proposed_version,
    // but the column is nullable in the schema. Surface the anomaly
    // instead of silently returning baseIr twice (which would look
    // like a no-op patch).
    return c.json(
      {
        ok: false,
        diagnostics: [{
          code: "PROPOSED_VERSION_MISSING",
          message: `proposal '${id}' has no proposed_version`,
          context: { proposalId: id },
        }],
      },
      500,
    );
  }

  const baseRow = db
    .prepare(`SELECT ir_json FROM pipeline_versions WHERE version_hash = ?`)
    .get(proposal.base_version) as VersionRow | undefined;
  const projectedRow = db
    .prepare(`SELECT ir_json FROM pipeline_versions WHERE version_hash = ?`)
    .get(proposal.proposed_version) as VersionRow | undefined;

  if (!baseRow) {
    return c.json(
      {
        ok: false,
        diagnostics: [{
          code: "BASE_VERSION_NOT_FOUND",
          message: `base version '${proposal.base_version}' not found`,
          context: { proposalId: id, baseVersion: proposal.base_version },
        }],
      },
      500,
    );
  }
  if (!projectedRow) {
    return c.json(
      {
        ok: false,
        diagnostics: [{
          code: "PROJECTED_VERSION_NOT_FOUND",
          message: `proposed version '${proposal.proposed_version}' not found`,
          context: { proposalId: id, proposedVersion: proposal.proposed_version },
        }],
      },
      500,
    );
  }

  try {
    const baseIr = JSON.parse(baseRow.ir_json) as unknown;
    const projectedIr = JSON.parse(projectedRow.ir_json) as unknown;
    return c.json({
      ok: true,
      baseVersion: proposal.base_version,
      projectedVersion: proposal.proposed_version,
      status: proposal.status,
      baseIr,
      projectedIr,
    });
  } catch (err) {
    return c.json(
      {
        ok: false,
        diagnostics: [{
          code: "IR_PARSE_ERROR",
          message: err instanceof Error ? err.message : String(err),
          context: { proposalId: id },
        }],
      },
      500,
    );
  }
});
