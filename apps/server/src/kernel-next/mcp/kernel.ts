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
import {
  versionHash,
  pipelineVersionHash,
  promptContentHash,
  normalizePromptContent,
} from "../ir/canonical.js";
import {
  insertPipelineVersion,
  getPipelineIR,
  insertPromptContent,
  insertPromptRefs,
} from "../ir/sql.js";
import { applyPatch, PatchApplyError } from "./patch.js";
import { taskRegistry } from "../runtime/task-registry.js";
import { compileIRToMachine } from "../compiler/ir-to-machine.js";
import { dryRunProposal as runDryRun } from "../hot-update/dry-run.js";
import type {
  DryRunResult, PipelineDiff, Impact, SafeRangeVerdict,
} from "../hot-update/types.js";
import {
  executeMigration,
  __resetOrchestratorLocksForTest,
} from "../hot-update/migration-orchestrator.js";

// Stage 5B — per-task migration lock now lives in
// hot-update/migration-orchestrator.ts. The test hooks below forward to
// the orchestrator so existing callers keep compiling.
export function __resetMigrationLocksForTest(): void {
  __resetOrchestratorLocksForTest();
}

/** Stage 5B retired: manual lock seeding is no longer supported — the
 *  orchestrator acquires + releases its own lock inside executeMigration.
 *  Tests that used this helper to simulate concurrent contention should
 *  instead drive concurrent executeMigration calls (see
 *  migration-orchestrator.test.ts "concurrent lock" case). Kept as a
 *  throw so silent reliance surfaces immediately.
 */
export function __acquireMigrationLockForTest(
  _taskId: string,
  _proposalId: string,
): void {
  throw new Error(
    "__acquireMigrationLockForTest retired in Stage 5B — drive concurrent executeMigration calls instead",
  );
}

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
  autoApplied: boolean;
  // Stage 5A additions: dry-run artefacts surfaced to caller.
  diff?: PipelineDiff;
  impact?: Impact;
  safeRange?: SafeRangeVerdict;
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
  // A8 additions (§10.5 step 1 / §10.1). Present on proposals that
  // opted into migration; null/"none" otherwise.
  rerunFrom: string | null;
  migrateRunning: "all" | "none" | string[];
}

export type ApprovalResult =
  | { ok: true; proposalId: string; status: "approved" | "rejected" }
  | { ok: false; diagnostics: Diagnostic[] };

export type MigrateTaskResult =
  | {
      ok: true;
      eventId: string;
      taskId: string;
      fromVersion: string;
      toVersion: string;
      rerunFrom: string | null;
      // Stage names whose existing attempts were marked superseded on
      // the OLD version. The caller is expected to kick off fresh
      // attempts for these on toVersion.
      supersededStages: string[];
    }
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
  | {
      ok: true;
      kind: "answered";
      gateId: string;
      taskId: string;
      stageName: string;
      targetStage: string | string[];
      answer: string;
    }
  | {
      ok: true;
      kind: "rejected";
      gateId: string;
      taskId: string;
      stageName: string;
      targetStage: string;
      answer: string;
      affectedStages: string[];
    }
  | {
      ok: false;
      diagnostics: Diagnostic[];
    };

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
  /**
   * Stage 5B — override the INTERRUPT-wait timeout in migrateTask. Used
   * by live-migration adversarial tests that need a short timeout so
   * they can still assert both the timeout path and the summary-turn
   * success path within vitest's default test timeout. Production
   * callers leave this undefined and the orchestrator's 30_000ms
   * default applies.
   */
  migrationInterruptWaitMsOverride?: number;
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

  /** Validate and, if ok, persist a new pipeline version with its prompts. */
  submit(
    ir: unknown,
    options: { parentHash?: string; prompts?: Record<string, string> } = {},
  ): SubmitResult {
    const result = this.validate(ir);
    if (!result.ok) return { ok: false, diagnostics: result.diagnostics };

    const pipeline = PipelineIRSchema.parse(ir);
    const prompts = options.prompts ?? {};

    // Collect AgentStage promptRefs.
    const agentPromptRefs = new Set<string>();
    for (const s of pipeline.stages) {
      if (s.type === "agent" && s.config.promptRef) {
        agentPromptRefs.add(s.config.promptRef);
      }
    }
    const providedRefs = new Set(Object.keys(prompts));

    const diagnostics: Diagnostic[] = [];
    for (const ref of agentPromptRefs) {
      if (!providedRefs.has(ref)) {
        diagnostics.push({
          code: "PROMPT_REF_MISSING",
          message: `prompt for AgentStage promptRef '${ref}' was not supplied`,
          context: { promptRef: ref },
        });
      }
    }
    for (const ref of providedRefs) {
      if (!agentPromptRefs.has(ref)) {
        // Allow 'system/*' prompts and the well-known 'global-constraints'
        // fragment. Both are pulled in by userland prompt assembly (e.g.
        // claude_md.global) rather than referenced directly by an
        // AgentStage, but must still be stored and version-hashed.
        if (ref.startsWith("system/") || ref === "global-constraints") continue;
        diagnostics.push({
          code: "PROMPT_REF_UNUSED",
          message: `prompt '${ref}' is not referenced by any AgentStage`,
          context: { promptRef: ref },
        });
      }
    }
    for (const [ref, content] of Object.entries(prompts)) {
      if (normalizePromptContent(content).trim().length === 0) {
        diagnostics.push({
          code: "PROMPT_CONTENT_EMPTY",
          message: `prompt '${ref}' has empty content after normalization`,
          context: { promptRef: ref },
        });
      }
    }
    if (diagnostics.length > 0) return { ok: false, diagnostics };

    const hash = pipelineVersionHash({ ir: pipeline, prompts });

    // Dedup: if version already exists, do not re-insert.
    if (getPipelineIR(this.db, hash) !== null) {
      const { source } = emitPipelineModule(pipeline);
      return { ok: true, versionHash: hash, tsSource: source };
    }

    const { source } = emitPipelineModule(pipeline);

    // Persist IR first (insertPipelineVersion runs its own BEGIN/COMMIT
    // for stages/ports/wires), then persist prompt rows. A prompts-insert
    // failure at this point is not recoverable without rewriting
    // insertPipelineVersion to not self-transact; accepting the resulting
    // half-state is acceptable here because (a) INSERT OR IGNORE makes the
    // prompts step retry-safe at the caller level, and (b) the only
    // realistic failure is disk full / schema drift, not business logic.
    insertPipelineVersion(this.db, pipeline, {
      versionHash: hash,
      parentHash: options.parentHash,
      tsSource: source,
    });
    const refsMap: Record<string, string> = {};
    for (const [ref, content] of Object.entries(prompts)) {
      const ch = promptContentHash(content);
      insertPromptContent(this.db, ch, normalizePromptContent(content));
      refsMap[ref] = ch;
    }
    insertPromptRefs(this.db, hash, refsMap);

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
    /**
     * A8 / §10.5 step 1 — the stage to rewind to when this proposal
     * is approved and migrated. Must name a stage that exists in the
     * PROPOSED IR (validated in this method, not at approve time —
     * fails fast rather than silently producing an un-mergeable
     * proposal). null / undefined means "no rewind" (forward-only).
     */
    rerunFrom?: string | null;
    /**
     * A8 / §10.1 — opt-in list of running taskIds to migrate. 'none'
     * (default), 'all', or an explicit taskId array. kernel-next does
     * not migrate running tasks by default; callers must opt in.
     */
    migrateRunningTasks?: "all" | "none" | string[];
    /**
     * Stage 5A — when true, kernel-next will auto-approve the proposal
     * IN THE SAME TRANSACTION iff the dry-run's safeRange.verdict is
     * "safe". When false/undefined, the proposal is always written with
     * status='pending' (legacy behaviour). Structurally-unsafe patches
     * ignore autoApprove and remain pending.
     */
    autoApprove?: boolean;
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

    // A8 step 1 — rerunFrom, if provided, must name a stage that exists
    // in the PROPOSED IR. Otherwise we'd accept a proposal that can
    // never actually migrate anyone.
    if (args.rerunFrom !== undefined && args.rerunFrom !== null) {
      const targetStage = proposedIR.stages.find((s) => s.name === args.rerunFrom);
      if (!targetStage) {
        return {
          ok: false,
          diagnostics: [{
            code: "PATCH_APPLY_ERROR",
            message: `rerunFrom '${args.rerunFrom}' is not a stage in the proposed pipeline`,
            context: { rerunFrom: args.rerunFrom },
          }],
        };
      }
    }

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

    // Stage 5A — re-run the hot-update dry-run to compute diff + impact
    // + safeRange. Dry-run itself is read-only; we feed its artefacts
    // into diagnostic_json for audit and use safeRange.verdict to
    // decide autoApprove eligibility. Failures here shouldn't happen
    // (validation already passed above) but if they do we surface them.
    const dry: DryRunResult = runDryRun(this.db, {
      currentVersion: args.currentVersion,
      patch: args.patch,
      rerunFrom: args.rerunFrom ?? null,
      migrateRunningTasks: args.migrateRunningTasks,
    });
    if (!dry.ok) {
      return { ok: false, diagnostics: dry.diagnostics };
    }

    const proposalId = randomUUID();
    const migrateRunning = args.migrateRunningTasks === undefined
      ? "none"
      : Array.isArray(args.migrateRunningTasks)
        ? JSON.stringify(args.migrateRunningTasks)
        : args.migrateRunningTasks;

    const autoApplied =
      (args.autoApprove ?? false) && dry.safeRange.verdict === "safe";
    const proposalStatus = autoApplied ? "approved" : "pending";

    const diagnosticJson = JSON.stringify({
      __kind: "proposal-success-v1",
      diff: dry.diff,
      impact: dry.impact,
      safeRange: dry.safeRange,
    });

    this.db.prepare(
      `INSERT INTO pipeline_proposals
       (proposal_id, base_version, proposed_version, actor, status,
        diagnostic_json, created_at, rerun_from, migrate_running)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      proposalId,
      args.currentVersion,
      proposedHash,
      args.actor,
      proposalStatus,
      diagnosticJson,
      Date.now(),
      args.rerunFrom ?? null,
      migrateRunning,
    );

    return {
      ok: true,
      proposalId,
      proposedVersion: proposedHash,
      autoApplied,
      diff: dry.diff,
      impact: dry.impact,
      safeRange: dry.safeRange,
    };
  }

  /**
   * Stage 5A — read-only dry run of a proposed patch. Returns diff +
   * impact + safeRange without touching pipeline_proposals or
   * pipeline_versions. Safe to call concurrently; idempotent.
   */
  dryRunProposal(input: {
    currentVersion: string;
    patch: IRPatch;
    rerunFrom?: string | null;
    migrateRunningTasks?: "all" | "none" | string[];
  }): DryRunResult {
    return runDryRun(this.db, input);
  }

  /**
   * Stage 5A — replace a registry pipeline's IR file and register the
   * new version in pipeline_versions. Does NOT touch pipeline_proposals
   * or trigger migration. Used by B2 update_registry_pipeline MCP.
   *
   * Honours REGISTRY_ROOT env var for test isolation; defaults to
   * apps/server/src/builtin-pipelines relative to process.cwd().
   */
  updateRegistryPipeline(input: {
    pipelineName: string;
    newIR: PipelineIR;
    actor: string;
  }): { ok: true; versionHash: string; path: string }
   | { ok: false; diagnostics: Diagnostic[] } {
    const validationResult = this.validate(input.newIR);
    if (!validationResult.ok) {
      return { ok: false, diagnostics: validationResult.diagnostics };
    }
    const parsedIR = PipelineIRSchema.parse(input.newIR);

    const hash = versionHash(parsedIR);

    if (getPipelineIR(this.db, hash) === null) {
      const { source } = emitPipelineModule(parsedIR);
      insertPipelineVersion(this.db, parsedIR, {
        versionHash: hash,
        tsSource: source,
      });
    }

    // File-write side effect. Resolve registry root lazily to honour
    // REGISTRY_ROOT override without complicating happy-path callers.
    // Using require() inside the method keeps ESM-side static analysis
    // clean (node:fs / node:path are CJS-compatible via the built-in
    // shim). REGISTRY_PIPELINE_NOT_FOUND fires when the target dir is
    // absent — callers must create it out-of-band (we don't mkdir for
    // them to avoid accidentally inventing new registry entries).
    const nodeFs = require("node:fs") as typeof import("node:fs");
    const nodePath = require("node:path") as typeof import("node:path");
    const registryRoot = process.env["REGISTRY_ROOT"]
      ?? nodePath.resolve(process.cwd(), "apps/server/src/builtin-pipelines");
    const dirPath = nodePath.join(registryRoot, input.pipelineName);
    if (!nodeFs.existsSync(dirPath)) {
      return {
        ok: false,
        diagnostics: [{
          code: "REGISTRY_PIPELINE_NOT_FOUND",
          message: `registry pipeline '${input.pipelineName}' directory not found at ${dirPath}`,
          context: { pipelineName: input.pipelineName, path: dirPath },
        }],
      };
    }
    const irPath = nodePath.join(dirPath, "pipeline.ir.json");
    nodeFs.writeFileSync(
      irPath,
      JSON.stringify(parsedIR, null, 2) + "\n",
      "utf8",
    );

    return { ok: true, versionHash: hash, path: irPath };
  }

  /**
   * Stage 5A skeleton — writes an audit row to hot_update_events with
   * status='rolled_back'. DOES NOT actually roll back stage_attempts
   * or pipeline state; the real rollback executor lands in Stage 5B.
   *
   * Returns VERSION_NOT_IN_HISTORY when toVersion has never appeared as
   * either from_version or to_version for this taskId.
   */
  rollbackHotUpdate(input: {
    taskId: string;
    toVersion: string;
    actor: string;
  }): { ok: true; eventId: string; diagnostic: string }
   | { ok: false; diagnostics: Diagnostic[] } {
    const history = this.db.prepare(
      `SELECT from_version, to_version FROM hot_update_events
       WHERE task_id = ? ORDER BY started_at DESC`,
    ).all(input.taskId) as Array<{ from_version: string; to_version: string }>;
    const known = new Set<string>();
    for (const row of history) {
      known.add(row.from_version);
      known.add(row.to_version);
    }
    if (!known.has(input.toVersion)) {
      return {
        ok: false,
        diagnostics: [{
          code: "VERSION_NOT_IN_HISTORY",
          message:
            `task '${input.taskId}' has no migration history including version ` +
            `'${input.toVersion}' (known=${Array.from(known).join(", ") || "<empty>"})`,
          context: { taskId: input.taskId, toVersion: input.toVersion },
        }],
      };
    }
    const mostRecent = history[0];
    const currentFromVersion = mostRecent?.to_version ?? input.toVersion;

    const eventId = randomUUID();
    const startedAt = Date.now();
    this.db.prepare(
      `INSERT INTO hot_update_events
       (event_id, task_id, from_version, to_version, actor, proposal_id,
        rerun_from_stage, status, started_at, finished_at, diagnostic_json)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, 'rolled_back', ?, ?, ?)`,
    ).run(
      eventId,
      input.taskId,
      currentFromVersion,
      input.toVersion,
      input.actor,
      startedAt,
      Date.now(),
      JSON.stringify({
        __kind: "rollback-skeleton-v1",
        note: "Stage 5A skeleton — audit only; real state rollback lands in 5B",
      }),
    );
    return {
      ok: true,
      eventId,
      diagnostic: "Stage 5A skeleton — audit row written; real rollback lands in 5B",
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
    // routes values may be string or string[] (multi-target widening, A4).
    // Return the route value verbatim — single string or array — so the
    // machine runtime can authorize ALL targets in a multi-target answer.
    const targetStage: string | string[] | undefined = routes[answer] ?? routes["_default"];
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

    // Determine whether this answer triggers a rollback. compileIRToMachine
    // is called here (not cached) because the IR snapshot is tied to the
    // attempt's version_hash; callers should treat this as a read-only
    // classification, not a side-effectful compile.
    const compiled = compileIRToMachine(ir, { taskId: row.task_id });
    const rollback = compiled.rejectRollbackMap.get(row.stage_name);
    const isReject =
      rollback !== undefined &&
      rollback.answer === answer &&
      typeof targetStage === "string" &&
      targetStage === rollback.targetStage;

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

    if (isReject) {
      return {
        ok: true,
        kind: "rejected",
        gateId,
        taskId: row.task_id,
        stageName: row.stage_name,
        targetStage: rollback!.targetStage,
        answer,
        affectedStages: rollback!.affectedStages,
      };
    }
    return {
      ok: true,
      kind: "answered",
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
                  diagnostic_json, created_at, rerun_from, migrate_running
           FROM pipeline_proposals WHERE status = ? ORDER BY created_at DESC`,
        ).all(filter.status)
      : this.db.prepare(
          `SELECT proposal_id, base_version, proposed_version, actor, status,
                  diagnostic_json, created_at, rerun_from, migrate_running
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
      rerun_from: string | null;
      migrate_running: string | null;
    }>).map((r) => ({
      proposalId: r.proposal_id,
      baseVersion: r.base_version,
      proposedVersion: r.proposed_version,
      actor: r.actor,
      status: r.status as ProposalStatus,
      diagnosticJson: r.diagnostic_json,
      createdAt: r.created_at,
      rerunFrom: r.rerun_from,
      migrateRunning: parseMigrateRunning(r.migrate_running),
    }));
  }

  /**
   * Stage 5B — thin delegator to hot-update/migration-orchestrator. The
   * orchestrator owns the full INTERRUPT + supersede + resume +
   * reverse-supersede pipeline. migrateTask is now async because the
   * resume path awaits the new runner startup via startPipelineRun.
   */
  async migrateTask(
    taskId: string,
    proposalId: string,
  ): Promise<MigrateTaskResult> {
    const outcome = await executeMigration({
      db: this.db,
      taskId,
      proposalId,
      interruptWaitMsOverride: this.opts.migrationInterruptWaitMsOverride,
    });
    if (!outcome.ok) {
      const code: Diagnostic["code"] =
        outcome.code === "MIGRATION_INTERRUPT_TIMEOUT"
          ? "MIGRATION_INTERRUPT_TIMEOUT"
          : outcome.code === "MIGRATION_RESUME_FAILED"
            ? "MIGRATION_RESUME_FAILED"
            : outcome.code === "MIGRATION_IN_PROGRESS"
              ? "MIGRATION_IN_PROGRESS"
              : outcome.code === "PROPOSAL_NOT_FOUND"
                ? "PROPOSAL_NOT_FOUND"
                : outcome.code === "PROPOSAL_ALREADY_RESOLVED"
                  ? "PROPOSAL_ALREADY_RESOLVED"
                  : "PATCH_APPLY_ERROR";
      return {
        ok: false,
        diagnostics: [{
          code,
          message: outcome.message,
          context: outcome.context,
        }],
      };
    }
    return {
      ok: true,
      eventId: outcome.eventId,
      taskId: outcome.taskId,
      fromVersion: outcome.fromVersion,
      toVersion: outcome.toVersion,
      rerunFrom: outcome.resumedFromStage,
      supersededStages: outcome.supersededStages,
    };
  }

}

/**
 * Forward-reachable stages from a root via ir.wires. Includes root.
 */
function computeDownstream(ir: PipelineIR, root: string): Set<string> {
  const reachable = new Set<string>([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const w of ir.wires) {
      // Bridge: Task 1.2 introduced WireSource. External-source wires have
      // no stage-identity upstream so they cannot extend reachability from
      // any stage; treat as a non-reachable origin. Task 1.3+ will branch
      // explicitly on source === "external".
      const fromStage = w.from.source === "external" ? "__external__" : w.from.stage;
      if (reachable.has(fromStage) && !reachable.has(w.to.stage)) {
        reachable.add(w.to.stage);
        changed = true;
      }
    }
  }
  return reachable;
}

function parseMigrateRunning(raw: string | null): "all" | "none" | string[] {
  if (raw === null || raw === "none") return "none";
  if (raw === "all") return "all";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
      return parsed as string[];
    }
  } catch {
    // fall through to 'none' — invalid stored value
  }
  return "none";
}
