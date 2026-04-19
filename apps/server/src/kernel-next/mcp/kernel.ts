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

// Gate lifecycle (§3.3 / §8.1). createGate is called by the runner when
// a gate-type stage enters its executing substate; answerGate is called
// via MCP answer_gate or REST when an answer arrives.

export interface GateRow {
  gateId: string;
  taskId: string;
  stageName: string;
  attemptId: string;
  question: { text: string; options?: string[] };
  answer: string | null;
  answeredAt: number | null;
  createdAt: number;
}

export type AnswerGateResult =
  | { ok: true; gateId: string; taskId: string; stageName: string; targetStage: string; answer: string }
  | { ok: false; diagnostics: Diagnostic[] };

export type TaskStatus = "not_found" | "running" | "gated" | "completed" | "failed";

export interface PendingGate {
  gateId: string;
  stageName: string;
  question: { text: string; options?: string[] };
  createdAt: number;
}

export type TaskStatusReport =
  | { ok: true; status: "not_found"; taskId: string }
  | { ok: true; status: "running" | "completed" | "failed"; taskId: string }
  | { ok: true; status: "gated"; taskId: string; pending: PendingGate[] };

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
   * Create a gate queue entry. Called by the runner when a gate-type stage
   * enters its executing substate. The `question` is taken verbatim from
   * the stage's IR config; callers should not mutate it.
   */
  createGate(args: {
    taskId: string;
    stageName: string;
    attemptId: string;
    question: { text: string; options?: string[] };
  }): { gateId: string } {
    const gateId = randomUUID();
    this.db.prepare(
      `INSERT INTO gate_queue
       (gate_id, task_id, stage_name, attempt_id, question_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      gateId,
      args.taskId,
      args.stageName,
      args.attemptId,
      JSON.stringify(args.question),
      Date.now(),
    );
    return { gateId };
  }

  /**
   * List gates. Filters:
   *   - taskId: narrow to a single task
   *   - answered: true -> only answered, false -> only pending, omit -> both
   * Ordered newest-first.
   */
  listGates(filter: { taskId?: string; answered?: boolean } = {}): GateRow[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.taskId !== undefined) {
      clauses.push("task_id = ?");
      params.push(filter.taskId);
    }
    if (filter.answered === true) {
      clauses.push("answered_at IS NOT NULL");
    } else if (filter.answered === false) {
      clauses.push("answered_at IS NULL");
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(
      `SELECT gate_id, task_id, stage_name, attempt_id, question_json,
              answer, answered_at, created_at
       FROM gate_queue ${where}
       ORDER BY created_at DESC`,
    ).all(...params) as Array<{
      gate_id: string;
      task_id: string;
      stage_name: string;
      attempt_id: string;
      question_json: string;
      answer: string | null;
      answered_at: number | null;
      created_at: number;
    }>;
    return rows.map((r) => ({
      gateId: r.gate_id,
      taskId: r.task_id,
      stageName: r.stage_name,
      attemptId: r.attempt_id,
      question: JSON.parse(r.question_json) as { text: string; options?: string[] },
      answer: r.answer,
      answeredAt: r.answered_at,
      createdAt: r.created_at,
    }));
  }

  /**
   * Answer an open gate. Validates:
   *   - gate exists (GATE_NOT_FOUND)
   *   - not already answered (GATE_ALREADY_ANSWERED)
   *   - answer is accepted by the stage's routing table (GATE_ANSWER_INVALID)
   * On success, writes answer + answered_at and returns the target stage
   * name that the runner should advance to.
   *
   * Resolving the target stage requires loading the IR for the version the
   * gate's attempt is bound to. If the version is missing (shouldn't happen
   * in practice — FK prevents orphan attempts), a GATE_ANSWER_INVALID is
   * raised so the error surfaces on the caller.
   */
  answerGate(gateId: string, answer: string): AnswerGateResult {
    const row = this.db.prepare(
      `SELECT gate_id, task_id, stage_name, attempt_id, question_json,
              answered_at
       FROM gate_queue WHERE gate_id = ?`,
    ).get(gateId) as
      | {
          gate_id: string;
          task_id: string;
          stage_name: string;
          attempt_id: string;
          question_json: string;
          answered_at: number | null;
        }
      | undefined;
    if (!row) {
      return {
        ok: false,
        diagnostics: [{
          code: "GATE_NOT_FOUND",
          message: `gateId '${gateId}' not found`,
          context: { gateId },
        }],
      };
    }
    if (row.answered_at !== null) {
      return {
        ok: false,
        diagnostics: [{
          code: "GATE_ALREADY_ANSWERED",
          message: `gate '${gateId}' is already answered`,
          context: { gateId, answeredAt: row.answered_at },
        }],
      };
    }

    // Resolve routing via the attempt's pipeline version.
    const attemptRow = this.db.prepare(
      `SELECT version_hash FROM stage_attempts WHERE attempt_id = ?`,
    ).get(row.attempt_id) as { version_hash: string } | undefined;
    if (!attemptRow) {
      return {
        ok: false,
        diagnostics: [{
          code: "GATE_ANSWER_INVALID",
          message: `gate '${gateId}' references attempt '${row.attempt_id}' which no longer exists`,
          context: { gateId, attemptId: row.attempt_id },
        }],
      };
    }
    const ir = getPipelineIR(this.db, attemptRow.version_hash);
    if (!ir) {
      return {
        ok: false,
        diagnostics: [{
          code: "GATE_ANSWER_INVALID",
          message: `pipeline version '${attemptRow.version_hash}' not found for gate '${gateId}'`,
          context: { gateId, versionHash: attemptRow.version_hash },
        }],
      };
    }
    const stage = ir.stages.find((s) => s.name === row.stage_name);
    if (!stage || stage.type !== "gate") {
      return {
        ok: false,
        diagnostics: [{
          code: "GATE_ANSWER_INVALID",
          message: `stage '${row.stage_name}' is not a gate in version '${attemptRow.version_hash}'`,
          context: { gateId, stageName: row.stage_name },
        }],
      };
    }
    const routes = stage.config.routing.routes;
    const targetStage = routes[answer] ?? routes["_default"];
    if (targetStage === undefined) {
      return {
        ok: false,
        diagnostics: [{
          code: "GATE_ANSWER_INVALID",
          message:
            `answer '${answer}' is not in gate '${row.stage_name}' routing table ` +
            `and no '_default' route is declared`,
          context: {
            gateId,
            stageName: row.stage_name,
            answer,
            allowedAnswers: Object.keys(routes),
          },
        }],
      };
    }

    // Atomic answer write + concurrent-answer defense. Both updates live
    // in a single transaction so the gate row and the attempt row stay
    // consistent — if the gate was resolved concurrently the UPDATE
    // returns changes=0 and we roll back the attempt finalization.
    const now = Date.now();
    this.db.exec("BEGIN");
    let gateChanges: number;
    try {
      const res = this.db.prepare(
        `UPDATE gate_queue
         SET answer = ?, answered_at = ?
         WHERE gate_id = ? AND answered_at IS NULL`,
      ).run(answer, now, gateId);
      gateChanges = res.changes as number;
      if (gateChanges > 0) {
        // Finalize the stage_attempt that was opened when the gate entered
        // `executing`. Gate answering is the attempt's natural completion.
        this.db.prepare(
          `UPDATE stage_attempts SET ended_at = ?, status = 'success'
           WHERE attempt_id = ?`,
        ).run(now, row.attempt_id);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    if (gateChanges === 0) {
      return {
        ok: false,
        diagnostics: [{
          code: "GATE_ALREADY_ANSWERED",
          message: `gate '${gateId}' was answered concurrently`,
          context: { gateId },
        }],
      };
    }

    return {
      ok: true,
      gateId,
      taskId: row.task_id,
      stageName: row.stage_name,
      targetStage,
      answer,
    };
  }

  /**
   * Aggregate task status from stage_attempts + gate_queue. Kernel-next
   * has no `tasks` table — a task exists iff it has at least one row in
   * stage_attempts (keyed by taskId). Priority order when multiple
   * signals are present:
   *
   *   1. unanswered gate_queue row exists  → 'gated' (+ pending questions)
   *   2. any stage_attempt has status 'error' (latest per stage_name)
   *                                        → 'failed'
   *   3. any stage_attempt has status 'running'
   *                                        → 'running'
   *   4. every stage_attempt is 'success' (or 'superseded')
   *                                        → 'completed'
   *   5. no rows for this taskId           → 'not_found'
   *
   * Rationale: 'gated' trumps 'running'/'error' because the gate stage's
   * attempt is kept in status 'running' while it waits, and an error on
   * a sibling stage is still useful to see — but the caller needs to
   * know the gate needs answering first (that is §3.3's primary
   * observation path).
   */
  getTaskStatus(taskId: string): TaskStatusReport {
    const attempts = this.db.prepare(
      `SELECT stage_name, attempt_idx, status FROM stage_attempts
       WHERE task_id = ?`,
    ).all(taskId) as Array<{ stage_name: string; attempt_idx: number; status: string }>;

    if (attempts.length === 0) {
      return { ok: true, status: "not_found", taskId };
    }

    const pendingGates = this.listGates({ taskId, answered: false });
    if (pendingGates.length > 0) {
      return {
        ok: true,
        status: "gated",
        taskId,
        pending: pendingGates.map((g) => ({
          gateId: g.gateId,
          stageName: g.stageName,
          question: g.question,
          createdAt: g.createdAt,
        })),
      };
    }

    // Latest attempt per stage_name decides per-stage verdict.
    const latestByStage = new Map<string, { attempt_idx: number; status: string }>();
    for (const a of attempts) {
      const cur = latestByStage.get(a.stage_name);
      if (!cur || a.attempt_idx > cur.attempt_idx) {
        latestByStage.set(a.stage_name, { attempt_idx: a.attempt_idx, status: a.status });
      }
    }
    const statuses = Array.from(latestByStage.values()).map((v) => v.status);
    if (statuses.some((s) => s === "error")) {
      return { ok: true, status: "failed", taskId };
    }
    if (statuses.some((s) => s === "running")) {
      return { ok: true, status: "running", taskId };
    }
    return { ok: true, status: "completed", taskId };
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
