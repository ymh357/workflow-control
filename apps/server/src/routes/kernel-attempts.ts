// REST route for per-task stage_attempts history (P6.2 / D24).
//
// GET /api/kernel/tasks/:taskId/attempts
//
// Returns the chronological stage_attempts history for a task, with
// duration_ms computed from ended_at - started_at (null for in-flight
// attempts where ended_at IS NULL). Used by the dashboard to render the
// Duration column + the per-stage expandable "all attempts" row.
//
// Shape is intentionally flat: one row per attempt_id, sorted by
// started_at ASC. Callers that want "latest attempt per (stage, task)"
// can reduce client-side — the route stays stateless.

import { Hono } from "hono";
import { getKernelNextDb } from "../lib/kernel-next-db.js";

export interface AttemptRow {
  attempt_id: string;
  stage_name: string;
  attempt_idx: number;
  status: string;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  // Bug 14 (dogfood 2026-05-02): pre-fix the attempts API didn't
  // surface `kind` or `fanout_element_idx`, so the dashboard
  // (and remote callers) couldn't tell a fanout_element row apart
  // from a regular row, nor identify which element index it
  // represented. Both fields exist on stage_attempts and are
  // populated correctly; this just exposes them.
  kind: string;
  fanout_element_idx: number | null;
}

export const kernelAttemptsRoute = new Hono();

kernelAttemptsRoute.get("/kernel/tasks/:taskId/attempts", (c) => {
  const taskId = c.req.param("taskId");
  const rows = getKernelNextDb().prepare(
    `SELECT attempt_id, stage_name, attempt_idx, status, started_at, ended_at,
            kind, fanout_element_idx
       FROM stage_attempts
      WHERE task_id = ?
      ORDER BY started_at ASC`,
  ).all(taskId) as Array<{
    attempt_id: string;
    stage_name: string;
    attempt_idx: number;
    status: string;
    started_at: number;
    ended_at: number | null;
    kind: string;
    fanout_element_idx: number | null;
  }>;
  const attempts: AttemptRow[] = rows.map((r) => ({
    ...r,
    duration_ms: r.ended_at !== null ? r.ended_at - r.started_at : null,
  }));
  return c.json({ ok: true, attempts });
});
