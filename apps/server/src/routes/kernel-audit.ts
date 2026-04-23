// REST route for per-task hot-update audit trail (P6.3 / D26).
//
// GET /api/kernel/tasks/:taskId/audit
//
// Reads from hot_update_events joined with pipeline_proposals for context.
// hot_update_events has a direct task_id column; each row's status column
// maps to an audit "kind":
//   - 'success'     → migrate
//   - 'rolled_back' → rollback
//   - 'failed'      → migrate_failed
//
// The linked pipeline_proposals row (via proposal_id FK) provides the
// propose/approve/reject lifecycle context (proposal_status field).
//
// Results are ordered chronologically by started_at ASC so callers can
// render a simple timeline without client-side sorting.

import { Hono } from "hono";
import { getKernelNextDb } from "../lib/kernel-next-db.js";

export interface AuditEvent {
  event_id: string;
  kind: "migrate" | "rollback" | "migrate_failed";
  actor: string;
  from_version: string;
  to_version: string;
  timestamp: number;
  finished_at: number | null;
  proposal_id: string | null;
  // Present when proposal_id is non-null and the proposal row exists.
  proposal_status: "pending" | "approved" | "rejected" | null;
  rerun_from_stage: string | null;
  diagnostic?: unknown;
}

export const kernelAuditRoute = new Hono();

kernelAuditRoute.get("/kernel/tasks/:taskId/audit", (c) => {
  const taskId = c.req.param("taskId");
  const rows = getKernelNextDb().prepare(
    `SELECT hue.event_id,
            hue.status,
            hue.actor,
            hue.from_version,
            hue.to_version,
            hue.started_at,
            hue.finished_at,
            hue.proposal_id,
            hue.rerun_from_stage,
            hue.diagnostic_json,
            pp.status AS proposal_status
       FROM hot_update_events hue
       LEFT JOIN pipeline_proposals pp ON pp.proposal_id = hue.proposal_id
      WHERE hue.task_id = ?
      ORDER BY hue.started_at ASC`,
  ).all(taskId) as Array<{
    event_id: string;
    status: "success" | "failed" | "rolled_back";
    actor: string;
    from_version: string;
    to_version: string;
    started_at: number;
    finished_at: number | null;
    proposal_id: string | null;
    rerun_from_stage: string | null;
    diagnostic_json: string | null;
    proposal_status: "pending" | "approved" | "rejected" | null;
  }>;

  const events: AuditEvent[] = rows.map((r) => ({
    event_id: r.event_id,
    kind: statusToKind(r.status),
    actor: r.actor,
    from_version: r.from_version,
    to_version: r.to_version,
    timestamp: r.started_at,
    finished_at: r.finished_at,
    proposal_id: r.proposal_id,
    proposal_status: r.proposal_status,
    rerun_from_stage: r.rerun_from_stage,
    diagnostic: r.diagnostic_json ? safeParse(r.diagnostic_json) : undefined,
  }));

  return c.json({ ok: true, events });
});

function statusToKind(
  status: "success" | "failed" | "rolled_back",
): "migrate" | "rollback" | "migrate_failed" {
  if (status === "success") return "migrate";
  if (status === "rolled_back") return "rollback";
  return "migrate_failed";
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
