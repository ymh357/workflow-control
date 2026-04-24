// GET /api/kernel/tasks — list known tasks with enough metadata for a
// dashboard overview: who (pipeline name), when (started/ended), status
// resolution order (gated > final > running > orphaned), current stage
// for in-flight tasks, and aggregate cost. The frontend sorts newest
// first; the route does the same so SSR parity is cheap.
//
// This is a read-only aggregation route. It does not replicate the
// full MCP `get_task_status` detail — the dashboard opens per-task
// pages for that. The purpose here is strictly "give me the table".

import { Hono } from "hono";
import { z } from "zod";
import { getKernelNextDb } from "../lib/kernel-next-db.js";

export const kernelTaskListRoute = new Hono();

const querySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
  status: z.enum(["running", "gated", "completed", "failed", "cancelled", "orphaned"]).optional(),
});

interface TaskListRow {
  taskId: string;
  pipelineName: string | null;
  versionHash: string;
  status: "running" | "gated" | "completed" | "failed" | "cancelled" | "orphaned";
  currentStage: string | null;
  gateId: string | null;
  gateStage: string | null;
  startedAt: number;
  endedAt: number | null;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  attemptCount: number;
}

kernelTaskListRoute.get("/kernel/tasks", (c) => {
  const parsed = querySchema.safeParse({
    limit: c.req.query("limit"),
    status: c.req.query("status"),
  });
  if (!parsed.success) {
    return c.json({
      ok: false,
      diagnostics: parsed.error.issues.map((i) => ({
        code: "ZOD_PARSE_ERROR",
        message: `${i.path.join(".") || "<root>"}: ${i.message}`,
      })),
    }, 400);
  }
  const { limit = 100, status: statusFilter } = parsed.data;
  const db = getKernelNextDb();

  // Base: distinct task_id with earliest started_at (its "start") and
  // latest ended_at (its "last activity"). Pipeline name + version hash
  // pulled from pipeline_versions via the first attempt's version_hash.
  const rows = db.prepare(
    `SELECT
        sa.task_id,
        MIN(sa.started_at) AS started_at,
        MAX(COALESCE(sa.ended_at, sa.started_at)) AS last_activity_at,
        COUNT(*) AS attempt_count
     FROM stage_attempts sa
     GROUP BY sa.task_id
     ORDER BY started_at DESC
     LIMIT ?`,
  ).all(limit * 2) as Array<{
    task_id: string;
    started_at: number;
    last_activity_at: number;
    attempt_count: number;
  }>;

  const finals = db.prepare(
    `SELECT task_id, version_hash, final_state, ended_at FROM task_finals`,
  ).all() as Array<{
    task_id: string;
    version_hash: string;
    final_state: "completed" | "failed" | "cancelled";
    ended_at: number;
  }>;
  const finalByTask = new Map<string, typeof finals[number]>();
  for (const f of finals) finalByTask.set(f.task_id, f);

  // Pending gates: the task is "gated" iff any gate_queue row is open.
  const pendingGates = db.prepare(
    `SELECT task_id, gate_id, stage_name FROM gate_queue WHERE answered_at IS NULL`,
  ).all() as Array<{ task_id: string; gate_id: string; stage_name: string }>;
  const pendingByTask = new Map<string, typeof pendingGates[number]>();
  for (const g of pendingGates) pendingByTask.set(g.task_id, g);

  // Version → pipeline_name lookup. For tasks we don't have a
  // task_finals row, reach for the latest attempt's version_hash.
  const attemptVersionRows = db.prepare(
    `SELECT task_id, version_hash FROM stage_attempts
     GROUP BY task_id HAVING MAX(started_at)`,
  ).all() as Array<{ task_id: string; version_hash: string }>;
  const versionByTask = new Map<string, string>();
  for (const r of attemptVersionRows) versionByTask.set(r.task_id, r.version_hash);

  const pipelineNameByVersion = new Map<string, string>();
  const versionHashes = new Set<string>();
  for (const v of versionByTask.values()) versionHashes.add(v);
  for (const f of finals) versionHashes.add(f.version_hash);
  if (versionHashes.size > 0) {
    const placeholders = [...versionHashes].map(() => "?").join(",");
    const pvRows = db.prepare(
      `SELECT version_hash, pipeline_name FROM pipeline_versions
       WHERE version_hash IN (${placeholders})`,
    ).all(...versionHashes) as Array<{ version_hash: string; pipeline_name: string }>;
    for (const r of pvRows) pipelineNameByVersion.set(r.version_hash, r.pipeline_name);
  }

  // Latest non-terminal stage name. Picked in the order stages ran for
  // running tasks. For gated tasks we use the pending gate's stage.
  const latestAttemptByTask = db.prepare(
    `SELECT task_id, stage_name, status, started_at
     FROM stage_attempts sa1
     WHERE started_at = (
       SELECT MAX(started_at) FROM stage_attempts sa2
       WHERE sa2.task_id = sa1.task_id
     )`,
  ).all() as Array<{ task_id: string; stage_name: string; status: string; started_at: number }>;
  const latestStageByTask = new Map<string, { stage: string; status: string }>();
  for (const r of latestAttemptByTask) {
    latestStageByTask.set(r.task_id, { stage: r.stage_name, status: r.status });
  }

  // Cost / token aggregation per task via agent_execution_details. Skips
  // attempts with no agent record (script stages, external sentinel).
  const costRows = db.prepare(
    `SELECT sa.task_id,
            COALESCE(SUM(aed.cost_usd), 0) AS total_cost,
            COALESCE(SUM(aed.token_input), 0) AS total_input,
            COALESCE(SUM(aed.token_output), 0) AS total_output
     FROM stage_attempts sa
     LEFT JOIN agent_execution_details aed ON aed.attempt_id = sa.attempt_id
     GROUP BY sa.task_id`,
  ).all() as Array<{
    task_id: string;
    total_cost: number | null;
    total_input: number | null;
    total_output: number | null;
  }>;
  const costByTask = new Map<string, typeof costRows[number]>();
  for (const r of costRows) costByTask.set(r.task_id, r);

  const result: TaskListRow[] = [];
  for (const row of rows) {
    const pending = pendingByTask.get(row.task_id);
    const final = finalByTask.get(row.task_id);
    const latest = latestStageByTask.get(row.task_id);

    // Status resolution (mirrors KernelService.getTaskStatus):
    //   gated > final > running > orphaned
    // Caveat: "gated" wins even if task_finals exists — a task_finals
    // row with a lingering unanswered gate shouldn't happen in practice
    // (runner finalises all gates before writing task_finals), but we
    // prefer the more actionable status when the two disagree.
    let status: TaskListRow["status"];
    if (pending) status = "gated";
    else if (final) status = final.final_state;
    else if (latest?.status === "running") status = "running";
    else status = "orphaned";

    const versionHash = final?.version_hash ?? versionByTask.get(row.task_id) ?? "";
    const pipelineName = pipelineNameByVersion.get(versionHash) ?? null;

    const cost = costByTask.get(row.task_id);

    const entry: TaskListRow = {
      taskId: row.task_id,
      pipelineName,
      versionHash,
      status,
      currentStage:
        status === "gated"
          ? pending?.stage_name ?? null
          : status === "running"
            ? latest?.stage ?? null
            : null,
      gateId: pending?.gate_id ?? null,
      gateStage: pending?.stage_name ?? null,
      startedAt: row.started_at,
      endedAt: final?.ended_at ?? null,
      totalCostUsd: cost?.total_cost ?? 0,
      totalInputTokens: cost?.total_input ?? 0,
      totalOutputTokens: cost?.total_output ?? 0,
      attemptCount: row.attempt_count,
    };

    if (statusFilter && entry.status !== statusFilter) continue;
    result.push(entry);
    if (result.length >= limit) break;
  }

  return c.json({ ok: true, tasks: result });
});
