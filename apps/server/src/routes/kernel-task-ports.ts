// GET /api/kernel/tasks/:taskId/ports — return every persisted
// port_values row belonging to a task's stage_attempts. The dashboard
// task-detail page hydrates its "Recent port writes" + seed inputs
// sections from this so historical tasks aren't blank (SSE only
// replays within a ring buffer; restart / cold open has empty stream).
//
// Read-only. Values are truncated to a 2 kB preview so large agent
// outputs don't bloat the initial page render; callers that need full
// values call read_port via MCP.

import { Hono } from "hono";
import { getKernelNextDb } from "../lib/kernel-next-db.js";

export const kernelTaskPortsRoute = new Hono();

const PREVIEW_LIMIT = 2048;

interface PortRow {
  stage: string;
  port: string;
  direction: "in" | "out";
  valuePreview: string;
  truncated: boolean;
  writtenAt: number;
  attemptId: string;
}

kernelTaskPortsRoute.get("/kernel/tasks/:taskId/ports", (c) => {
  const taskId = c.req.param("taskId");
  const db = getKernelNextDb();

  const rows = db.prepare(
    `SELECT pv.stage_name, pv.port_name, pv.direction, pv.value_json, pv.written_at, pv.attempt_id
     FROM port_values pv
     INNER JOIN stage_attempts sa ON sa.attempt_id = pv.attempt_id
     WHERE sa.task_id = ?
     ORDER BY pv.written_at ASC, pv.stage_name ASC, pv.port_name ASC`,
  ).all(taskId) as Array<{
    stage_name: string;
    port_name: string;
    direction: string;
    value_json: string;
    written_at: number;
    attempt_id: string;
  }>;

  const ports: PortRow[] = rows.map((r) => {
    const raw = r.value_json;
    const truncated = raw.length > PREVIEW_LIMIT;
    return {
      stage: r.stage_name,
      port: r.port_name,
      direction: (r.direction === "in" ? "in" : "out") as "in" | "out",
      valuePreview: truncated ? raw.slice(0, PREVIEW_LIMIT) : raw,
      truncated,
      writtenAt: r.written_at,
      attemptId: r.attempt_id,
    };
  });

  return c.json({ ok: true, ports });
});
