// Graceful-shutdown helpers for kernel-next.
//
// reconcileRunningAttempts flips every `status='running'` stage_attempt
// belonging to the listed taskIds to `superseded`, and sets the
// accompanying agent_execution_details row to
// `termination_reason='interrupted'` with `ended_at=now`. Called by the
// SIGTERM/SIGINT handler to leave a clean world state that the next
// boot's orphan reconciler can pick up.

import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "../ir/with-transaction.js";

export function reconcileRunningAttempts(db: DatabaseSync, taskIds: string[]): number {
  if (taskIds.length === 0) return 0;
  const now = Date.now();
  const placeholders = taskIds.map(() => "?").join(",");
  // Collect running attempt_ids before mutation so we can update the
  // agent_execution_details sidecar for the exact same set.
  const runningAttempts = db.prepare(
    `SELECT attempt_id FROM stage_attempts
     WHERE status='running' AND task_id IN (${placeholders})`,
  ).all(...taskIds) as Array<{ attempt_id: string }>;
  if (runningAttempts.length === 0) return 0;
  // Bug B2.#19/#20 (c12+ review Wave 2 T2): the two UPDATEs below
  // were issued without a transaction. If SIGTERM arrived mid-flight
  // and the process died between them, the next boot would see
  // stage_attempts marked 'superseded' but their AED rows still
  // running with ended_at=NULL — an inconsistent reconciliation.
  // Bundle into one transaction so SIGTERM either takes the system
  // to a fully reconciled state or rolls back to "as if shutdown
  // never started" for the next reboot's orphan reconciler.
  return withTransaction(db, () => {
    const updateAttempts = db.prepare(
      `UPDATE stage_attempts SET status='superseded'
       WHERE status='running' AND task_id IN (${placeholders})`,
    );
    const attemptsRes = updateAttempts.run(...taskIds);
    const aedPh = runningAttempts.map(() => "?").join(",");
    db.prepare(
      `UPDATE agent_execution_details
          SET termination_reason='interrupted', ended_at=?
        WHERE attempt_id IN (${aedPh}) AND ended_at IS NULL`,
    ).run(now, ...runningAttempts.map((r) => r.attempt_id));
    return Number(attemptsRes.changes);
  });
}
