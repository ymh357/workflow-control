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
