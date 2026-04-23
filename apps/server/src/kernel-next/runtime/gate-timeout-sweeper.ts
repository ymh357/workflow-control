// gate-timeout-sweeper.ts (P5.2 / D6)
//
// Scans gate_queue for unanswered gates whose stage declares a
// `config.timeout_minutes` and whose deadline (created_at + timeout)
// has passed. For each timed-out gate, cancels the owning task via
// KernelService.cancelTask — which writes task_finals(final_state='cancelled'),
// deletes task_env_values, and dispatches INTERRUPT to the live
// dispatcher if any.
//
// Contract:
//   - OPT-IN ONLY. Gates without `timeout_minutes` are never swept.
//   - Already-answered gates (answered_at IS NOT NULL) are skipped.
//   - Already-terminal tasks (task_finals row present) are skipped,
//     preserving the sticky-cancel invariant from P4.3.
//   - Safe to call on an empty database or when no gates are timed out.
//
// Designed to be invoked periodically from the server boot path (see
// apps/server/src/index.ts). One sweep per call — callers schedule the
// cadence (default 60s).

import type { DatabaseSync } from "node:sqlite";
import { KernelService } from "../mcp/kernel.js";
import type { PipelineIR } from "../ir/schema.js";

export interface GateSweepResult {
  swept: number;
  cancelled: Array<{ taskId: string; gateId: string; reason: string }>;
}

interface GateQueueRow {
  gate_id: string;
  task_id: string;
  stage_name: string;
  version_hash: string;
  created_at: number;
}

export function sweepTimedOutGates(db: DatabaseSync): GateSweepResult {
  const now = Date.now();
  const cancelled: GateSweepResult["cancelled"] = [];

  // Join with stage_attempts so we can resolve version_hash (gate_queue
  // itself does not record it). attempt_id is the FK that carries it.
  const rows = db.prepare(
    `SELECT gq.gate_id, gq.task_id, gq.stage_name, gq.created_at,
            sa.version_hash
     FROM gate_queue gq
     INNER JOIN stage_attempts sa ON sa.attempt_id = gq.attempt_id
     WHERE gq.answered_at IS NULL`,
  ).all() as unknown as GateQueueRow[];

  if (rows.length === 0) return { swept: 0, cancelled };

  // Cache IR lookups per version_hash — a single sweep often spans
  // multiple tasks on the same pipeline version.
  const irCache = new Map<string, PipelineIR | null>();
  const loadIR = (hash: string): PipelineIR | null => {
    if (irCache.has(hash)) return irCache.get(hash) ?? null;
    const row = db.prepare(
      `SELECT ir_json FROM pipeline_versions WHERE version_hash = ?`,
    ).get(hash) as { ir_json: string } | undefined;
    const ir = row ? (JSON.parse(row.ir_json) as PipelineIR) : null;
    irCache.set(hash, ir);
    return ir;
  };

  // skipTypeCheck: cancelTask never touches the validator, but KernelService
  // constructor wants the options bag either way. Passing true avoids any
  // accidental tsc invocation path if future code adds one.
  const kernel = new KernelService(db, { skipTypeCheck: true });

  for (const row of rows) {
    // Respect the sticky-cancel contract: if the task already has a
    // task_finals row, don't try to re-cancel it.
    const terminal = db.prepare(
      `SELECT 1 FROM task_finals WHERE task_id = ?`,
    ).get(row.task_id);
    if (terminal) continue;

    const timeoutMin = resolveGateTimeoutMinutes(loadIR(row.version_hash), row.stage_name);
    if (timeoutMin === undefined) continue; // opt-out

    const deadlineAt = row.created_at + timeoutMin * 60_000;
    if (now < deadlineAt) continue;

    const reason = `gate_timeout: ${row.stage_name} exceeded ${timeoutMin} minutes`;
    const result = kernel.cancelTask({
      taskId: row.task_id,
      reason,
      actor: "gate-timeout-sweeper",
    });
    if (result.ok) {
      cancelled.push({ taskId: row.task_id, gateId: row.gate_id, reason });
    }
  }

  return { swept: cancelled.length, cancelled };
}

function resolveGateTimeoutMinutes(ir: PipelineIR | null, stageName: string): number | undefined {
  if (!ir) return undefined;
  const stage = ir.stages.find((s) => s.name === stageName && s.type === "gate");
  if (!stage || stage.type !== "gate") return undefined;
  return stage.config.timeout_minutes;
}
