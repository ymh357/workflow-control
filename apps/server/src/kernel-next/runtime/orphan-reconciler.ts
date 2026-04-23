// Orphan-reconciler: startup-time survivor logic.
//
// On boot, scan the kernel-next DB for tasks that have stage attempts
// but no task_finals row. Those are either:
//   - Mid-flight (runner crashed before finalizing) → resume them
//   - Terminal-but-lost-their-finals-write (WAL tailing edge) → synthesize
//     the task_finals row
//   - Unresolvable (IR GC'd) → write task_finals(failed)
//
// The reconciler does not block server startup on SDK calls; it kicks
// resume dispatches as fire-and-forget and returns summary counts.

import type { DatabaseSync } from "node:sqlite";
import type { PipelineIR } from "../ir/schema.js";
import { getPipelineIR } from "../ir/sql.js";
import { reconcileRunningAttempts } from "./graceful-shutdown.js";

export function scanOrphanTaskIds(db: DatabaseSync): string[] {
  const rows = db.prepare(
    `SELECT DISTINCT task_id FROM stage_attempts
      WHERE task_id NOT IN (SELECT task_id FROM task_finals)
      ORDER BY task_id`,
  ).all() as Array<{ task_id: string }>;
  return rows.map((r) => r.task_id);
}

export type OrphanClassification =
  | { kind: "resume"; versionHash: string; resumeFrom: string }
  | { kind: "terminal"; versionHash: string }
  | { kind: "unresolvable"; reason: "no_attempts" | "ir_not_found" };

export function classifyOrphan(
  db: DatabaseSync,
  taskId: string,
): OrphanClassification {
  const latest = db.prepare(
    `SELECT version_hash FROM stage_attempts
      WHERE task_id = ?
      ORDER BY started_at DESC
      LIMIT 1`,
  ).get(taskId) as { version_hash: string } | undefined;
  if (!latest) return { kind: "unresolvable", reason: "no_attempts" };
  const ir = getPipelineIR(db, latest.version_hash);
  if (!ir) return { kind: "unresolvable", reason: "ir_not_found" };

  const successStages = new Set(
    (db.prepare(
      `SELECT DISTINCT stage_name FROM stage_attempts
        WHERE task_id = ? AND status = 'success'`,
    ).all(taskId) as Array<{ stage_name: string }>).map((r) => r.stage_name),
  );
  const order = topologicalStageOrder(ir);
  const firstPending = order.find(
    (name) => !successStages.has(name) && !isSkippable(ir, name),
  );
  if (firstPending === undefined) {
    return { kind: "terminal", versionHash: latest.version_hash };
  }
  return { kind: "resume", versionHash: latest.version_hash, resumeFrom: firstPending };
}

function isSkippable(ir: PipelineIR, name: string): boolean {
  if (name === "__external__") return true;
  const stage = ir.stages.find((s) => s.name === name);
  return stage?.type === "gate";
}

function topologicalStageOrder(ir: PipelineIR): string[] {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const s of ir.stages) {
    inDegree.set(s.name, 0);
    adj.set(s.name, []);
  }
  for (const w of ir.wires) {
    if (!("stage" in w.from)) continue;
    const from = w.from.stage;
    const to = w.to.stage;
    if (!adj.has(from) || !inDegree.has(to)) continue;
    adj.get(from)!.push(to);
    inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
  }
  const queue: string[] = [];
  for (const [n, d] of inDegree) {
    if (d === 0) queue.push(n);
  }
  const out: string[] = [];
  while (queue.length > 0) {
    const n = queue.shift()!;
    out.push(n);
    for (const next of adj.get(n) ?? []) {
      const d = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  return out;
}
