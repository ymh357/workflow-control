// KernelService — orchestrates validation pipeline + persistence for
// submit_pipeline / validate_pipeline / propose_pipeline_change. MCP tool
// handlers are thin wrappers over this class.

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
}
