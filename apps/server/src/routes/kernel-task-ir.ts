// REST route for per-task PipelineIR lookup (P7.1 / D21).
//
// GET /api/kernel/tasks/:taskId/ir
//
// Returns the PipelineIR the task is currently running against. The
// dashboard's live DAG view needs the IR to render the graph; reading
// it once on mount avoids threading the whole structure through the
// SSE event stream.
//
// The IR is resolved via stage_attempts → pipeline_versions.ir_json.
// Migrated tasks (hot-update) can have attempts on multiple versions;
// we pick the version_hash of the most recently started attempt so the
// graph reflects the task's current version, not its original one.

import { Hono } from "hono";
import { getKernelNextDb } from "../lib/kernel-next-db.js";

export const kernelTaskIrRoute = new Hono();

kernelTaskIrRoute.get("/kernel/tasks/:taskId/ir", (c) => {
  const taskId = c.req.param("taskId");
  const db = getKernelNextDb();
  // Most-recent-attempt wins: a migrated task's ORDER BY started_at DESC
  // returns its current (post-migration) version_hash, not the original.
  const row = db.prepare(
    `SELECT pv.ir_json, pv.version_hash
       FROM stage_attempts sa
       JOIN pipeline_versions pv ON pv.version_hash = sa.version_hash
      WHERE sa.task_id = ?
      ORDER BY sa.started_at DESC
      LIMIT 1`,
  ).get(taskId) as { ir_json: string; version_hash: string } | undefined;

  if (!row) {
    return c.json({
      ok: false,
      diagnostics: [{
        code: "TASK_NOT_FOUND",
        message: `no stage_attempts found for task '${taskId}'`,
        context: { taskId },
      }],
    }, 404);
  }

  try {
    return c.json({
      ok: true,
      versionHash: row.version_hash,
      ir: JSON.parse(row.ir_json) as unknown,
    });
  } catch {
    return c.json({
      ok: false,
      diagnostics: [{
        code: "IR_PARSE_ERROR",
        message: "stored ir_json is malformed",
        context: { taskId, versionHash: row.version_hash },
      }],
    }, 500);
  }
});
