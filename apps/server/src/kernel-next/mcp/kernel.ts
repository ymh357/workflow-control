// KernelService — orchestrates validation pipeline + persistence for
// submit_pipeline / validate_pipeline / propose_pipeline_change /
// approve_proposal / reject_proposal / list_proposals. MCP tool handlers
// and REST routes are thin wrappers over this class.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { PipelineIRSchema } from "../ir/schema.js";
import type {
  PipelineIR, IRPatch, Diagnostic,
} from "../ir/schema.js";
import { validateStructural } from "../validator/structural.js";
import { validateDag } from "../validator/dag.js";
import { validateTypes } from "../validator/types.js";
import { emitPipelineModule } from "../codegen/emit-ts.js";
import { versionHash } from "../ir/canonical.js";
import { insertPipelineVersion, getPipelineIR } from "../ir/sql.js";
import { applyPatch, PatchApplyError } from "./patch.js";

export interface ValidateResponse {
  ok: boolean;
  diagnostics: Diagnostic[];
}

export interface SubmitResponse {
  ok: true;
  versionHash: string;
  tsSource: string;
}

export type SubmitResult = SubmitResponse | {
  ok: false;
  diagnostics: Diagnostic[];
};

export interface ProposeResponse {
  ok: true;
  proposalId: string;
  proposedVersion: string;
  autoApplied: false;
}

export type ProposeResult = ProposeResponse | {
  ok: false;
  diagnostics: Diagnostic[];
};

export type ProposalStatus = "pending" | "approved" | "rejected";

export interface ProposalRow {
  proposalId: string;
  baseVersion: string;
  proposedVersion: string | null;
  actor: string;
  status: ProposalStatus;
  diagnosticJson: string | null;
  createdAt: number;
}

export type ApprovalResult =
  | { ok: true; proposalId: string; status: "approved" | "rejected" }
  | { ok: false; diagnostics: Diagnostic[] };

export interface KernelServiceOptions {
  /** Override tsc binary path for tests. */
  tscPath?: string;
  /** Skip tsc check (tests that only care about structural / DAG). */
  skipTypeCheck?: boolean;
}

export class KernelService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly opts: KernelServiceOptions = {},
  ) {}

  /** Full validation: zod parse + structural + DAG + (optionally) tsc. */
  validate(ir: unknown): ValidateResponse {
    const parsed = PipelineIRSchema.safeParse(ir);
    if (!parsed.success) {
      const issues = parsed.error.issues;
      return {
        ok: false,
        diagnostics: issues.map((issue) => ({
          code: "ZOD_PARSE_ERROR",
          message: `${issue.path.join(".") || "<root>"}: ${issue.message}`,
          context: { path: issue.path, code: issue.code },
        })),
      };
    }
    const pipeline = parsed.data;

    const structural = validateStructural(pipeline);
    if (!structural.ok) {
      return { ok: false, diagnostics: structural.diagnostics };
    }

    const dag = validateDag(pipeline);
    if (!dag.ok) {
      return { ok: false, diagnostics: dag.diagnostics };
    }

    if (!this.opts.skipTypeCheck) {
      const types = validateTypes(pipeline, { tscPath: this.opts.tscPath });
      if (!types.ok) {
        return { ok: false, diagnostics: types.diagnostics };
      }
    }

    return { ok: true, diagnostics: [] };
  }

  /** Validate and, if ok, persist a new pipeline version. */
  submit(ir: unknown, options: { parentHash?: string } = {}): SubmitResult {
    const result = this.validate(ir);
    if (!result.ok) return { ok: false, diagnostics: result.diagnostics };

    const pipeline = PipelineIRSchema.parse(ir);
    const hash = versionHash(pipeline);

    // Dedup: if version already exists, do not re-insert. Return existing.
    if (getPipelineIR(this.db, hash) !== null) {
      const { source } = emitPipelineModule(pipeline);
      return { ok: true, versionHash: hash, tsSource: source };
    }

    const { source } = emitPipelineModule(pipeline);
    insertPipelineVersion(this.db, pipeline, {
      versionHash: hash,
      parentHash: options.parentHash,
      tsSource: source,
    });

    return { ok: true, versionHash: hash, tsSource: source };
  }

  /**
   * Apply a patch to the pipeline at `currentVersion`, validate, persist the
   * new version, and record a pending proposal. Per design §2.6 / §7,
   * proposals are ALWAYS auto-applied=false in spike — they go straight into
   * `pipeline_proposals` with status='pending' for human confirm.
   */
  propose(args: {
    currentVersion: string;
    patch: IRPatch;
    actor: string;
  }): ProposeResult {
    // Optimistic lock check.
    const base = getPipelineIR(this.db, args.currentVersion);
    if (!base) {
      return {
        ok: false,
        diagnostics: [{
          code: "PATCH_APPLY_ERROR",
          message: `currentVersion '${args.currentVersion}' not found`,
          context: { currentVersion: args.currentVersion },
        }],
      };
    }

    let proposedIR: PipelineIR;
    try {
      proposedIR = applyPatch(base, args.patch);
    } catch (err) {
      if (err instanceof PatchApplyError) {
        return {
          ok: false,
          diagnostics: [{
            code: "PATCH_APPLY_ERROR",
            message: err.message,
            context: { op: err.op },
          }],
        };
      }
      throw err;
    }

    const validate = this.validate(proposedIR);
    if (!validate.ok) return { ok: false, diagnostics: validate.diagnostics };

    const proposedHash = versionHash(proposedIR);

    // Persist new version (idempotent) and proposal row.
    if (getPipelineIR(this.db, proposedHash) === null) {
      const { source } = emitPipelineModule(proposedIR);
      insertPipelineVersion(this.db, proposedIR, {
        versionHash: proposedHash,
        parentHash: args.currentVersion,
        tsSource: source,
      });
    }

    const proposalId = randomUUID();
    this.db.prepare(
      `INSERT INTO pipeline_proposals
       (proposal_id, base_version, proposed_version, actor, status, diagnostic_json, created_at)
       VALUES (?, ?, ?, ?, 'pending', NULL, ?)`,
    ).run(proposalId, args.currentVersion, proposedHash, args.actor, Date.now());

    return {
      ok: true,
      proposalId,
      proposedVersion: proposedHash,
      autoApplied: false,
    };
  }

  /**
   * Approve a pending proposal. Spike-scope: only flips `status` to
   * 'approved'. Does NOT migrate running tasks — task migration is a
   * Phase 2 P3+ concern (see kernel-next-design.md §13). Running
   * tasks remain bound to their original `stage_attempts.version_hash`;
   * only new tasks may reference the approved proposedVersion.
   *
   * Legal transition: pending → approved. Already-resolved proposals
   * (approved/rejected) return PROPOSAL_ALREADY_RESOLVED.
   */
  approveProposal(proposalId: string): ApprovalResult {
    return this.resolveProposal(proposalId, "approved");
  }

  /**
   * Reject a pending proposal. Optional `reason` is persisted in
   * `diagnostic_json` for audit.
   *
   * Legal transition: pending → rejected.
   */
  rejectProposal(proposalId: string, reason?: string): ApprovalResult {
    return this.resolveProposal(proposalId, "rejected", reason);
  }

  private resolveProposal(
    proposalId: string,
    target: "approved" | "rejected",
    reason?: string,
  ): ApprovalResult {
    const row = this.db.prepare(
      `SELECT status FROM pipeline_proposals WHERE proposal_id = ?`,
    ).get(proposalId) as { status: string } | undefined;
    if (!row) {
      return {
        ok: false,
        diagnostics: [{
          code: "PROPOSAL_NOT_FOUND",
          message: `proposalId '${proposalId}' not found`,
          context: { proposalId },
        }],
      };
    }
    if (row.status !== "pending") {
      return {
        ok: false,
        diagnostics: [{
          code: "PROPOSAL_ALREADY_RESOLVED",
          message: `proposal '${proposalId}' is already ${row.status}`,
          context: { proposalId, currentStatus: row.status },
        }],
      };
    }

    const diagnostic = target === "rejected" && reason
      ? JSON.stringify({ reason })
      : null;
    // WHERE clause re-checks status='pending' so an interleaved approve
    // between the SELECT above and this UPDATE cannot double-resolve.
    // Inspect `changes` to surface that race as PROPOSAL_ALREADY_RESOLVED
    // instead of a false-success. Today node:sqlite is synchronous so
    // the SELECT-UPDATE pair cannot be preempted within a single
    // KernelService call; this guard is defense for (a) out-of-band
    // writers mutating the row (tests, migration tooling) and (b)
    // future async DB adapters.
    const res = this.db.prepare(
      `UPDATE pipeline_proposals SET status = ?, diagnostic_json = ?
       WHERE proposal_id = ? AND status = 'pending'`,
    ).run(target, diagnostic, proposalId);
    if (res.changes === 0) {
      // The pending row was resolved by a concurrent caller. Read the
      // current status back for the diagnostic context.
      const after = this.db.prepare(
        `SELECT status FROM pipeline_proposals WHERE proposal_id = ?`,
      ).get(proposalId) as { status: string } | undefined;
      return {
        ok: false,
        diagnostics: [{
          code: "PROPOSAL_ALREADY_RESOLVED",
          message: `proposal '${proposalId}' was resolved concurrently`,
          context: { proposalId, currentStatus: after?.status ?? "unknown" },
        }],
      };
    }

    return { ok: true, proposalId, status: target };
  }

  /**
   * List proposals, optionally filtered by status. Ordered newest-first.
   */
  listProposals(filter: { status?: ProposalStatus } = {}): ProposalRow[] {
    const rows = filter.status
      ? this.db.prepare(
          `SELECT proposal_id, base_version, proposed_version, actor, status,
                  diagnostic_json, created_at
           FROM pipeline_proposals WHERE status = ? ORDER BY created_at DESC`,
        ).all(filter.status)
      : this.db.prepare(
          `SELECT proposal_id, base_version, proposed_version, actor, status,
                  diagnostic_json, created_at
           FROM pipeline_proposals ORDER BY created_at DESC`,
        ).all();
    return (rows as Array<{
      proposal_id: string;
      base_version: string;
      proposed_version: string | null;
      actor: string;
      status: string;
      diagnostic_json: string | null;
      created_at: number;
    }>).map((r) => ({
      proposalId: r.proposal_id,
      baseVersion: r.base_version,
      proposedVersion: r.proposed_version,
      actor: r.actor,
      status: r.status as ProposalStatus,
      diagnosticJson: r.diagnostic_json,
      createdAt: r.created_at,
    }));
  }
}
