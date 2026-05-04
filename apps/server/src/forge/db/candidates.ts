import type { DatabaseSync } from "node:sqlite";
import type { PipelineCandidate, DryRunStatus } from "../types.js";

export interface InsertCandidateArgs {
  candidateId: string;
  clusterId: string;
  irJson: string;
  promptsJson: string;
  synthTaskId: string | null;
  generatedAt: number;
}

export function insertCandidate(db: DatabaseSync, args: InsertCandidateArgs): void {
  db.prepare(
    `INSERT INTO pipeline_candidates
       (candidate_id, cluster_id, ir_json, prompts_json, dry_run_status, synth_task_id, generated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(args.candidateId, args.clusterId, args.irJson, args.promptsJson, args.synthTaskId, args.generatedAt);
}

function rowToCandidate(r: Record<string, unknown>): PipelineCandidate {
  return {
    candidateId: r.candidate_id as string,
    clusterId: r.cluster_id as string,
    irJson: r.ir_json as string,
    promptsJson: r.prompts_json as string,
    dryRunStatus: r.dry_run_status as DryRunStatus,
    dryRunDiagnosticsJson: (r.dry_run_diagnostics_json as string | null) ?? null,
    synthTaskId: (r.synth_task_id as string | null) ?? null,
    generatedAt: r.generated_at as number,
    adoptedVersionHash: (r.adopted_version_hash as string | null) ?? null,
    adoptedAt: (r.adopted_at as number | null) ?? null,
    dismissedAt: (r.dismissed_at as number | null) ?? null,
    dismissedReason: (r.dismissed_reason as string | null) ?? null,
  };
}

export function getCandidate(db: DatabaseSync, candidateId: string): PipelineCandidate | null {
  const r = db.prepare(`SELECT * FROM pipeline_candidates WHERE candidate_id = ?`).get(candidateId) as
    Record<string, unknown> | undefined;
  return r ? rowToCandidate(r) : null;
}

export function listPendingCandidates(db: DatabaseSync, limit = 50): PipelineCandidate[] {
  const rows = db.prepare(
    `SELECT * FROM pipeline_candidates
     WHERE adopted_at IS NULL AND dismissed_at IS NULL
     ORDER BY generated_at DESC LIMIT ?`,
  ).all(limit) as Array<Record<string, unknown>>;
  return rows.map(rowToCandidate);
}

export function listCandidatesForCluster(db: DatabaseSync, clusterId: string): PipelineCandidate[] {
  const rows = db.prepare(
    `SELECT * FROM pipeline_candidates WHERE cluster_id = ? ORDER BY generated_at DESC`,
  ).all(clusterId) as Array<Record<string, unknown>>;
  return rows.map(rowToCandidate);
}

export function setCandidateDryRun(
  db: DatabaseSync,
  candidateId: string,
  status: DryRunStatus,
  diagnosticsJson: string | null,
): void {
  db.prepare(
    `UPDATE pipeline_candidates
        SET dry_run_status = ?, dry_run_diagnostics_json = ?
      WHERE candidate_id = ?`,
  ).run(status, diagnosticsJson, candidateId);
}

export function markCandidateAdopted(
  db: DatabaseSync,
  candidateId: string,
  versionHash: string,
): void {
  db.prepare(
    `UPDATE pipeline_candidates
        SET adopted_version_hash = ?, adopted_at = ?
      WHERE candidate_id = ?`,
  ).run(versionHash, Date.now(), candidateId);
}

export function markCandidateDismissed(
  db: DatabaseSync,
  candidateId: string,
  reason: string,
): void {
  db.prepare(
    `UPDATE pipeline_candidates
        SET dismissed_at = ?, dismissed_reason = ?
      WHERE candidate_id = ?`,
  ).run(Date.now(), reason, candidateId);
}
