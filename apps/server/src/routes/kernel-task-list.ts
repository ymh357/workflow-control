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

// Bug 64 fix (c12+ review): secret_pending added to the union — the
// kernel emits it but the list page TaskStatus type used to omit it,
// silently producing undefined entries in dashboard counts.
const querySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
  status: z.enum([
    "running", "gated", "secret_pending",
    "completed", "failed", "cancelled", "orphaned",
  ]).optional(),
});

interface TaskListRow {
  taskId: string;
  pipelineName: string | null;
  versionHash: string;
  status: "running" | "gated" | "secret_pending" | "completed" | "failed" | "cancelled" | "orphaned";
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

  // Bug 48 fix (c12+ review): pre-fix SELECTed `limit * 2` raw rows
  // and post-filtered by status, silently truncating results when the
  // status filter was restrictive. Now: when no status filter, LIMIT
  // applies directly. With a status filter we still over-fetch a bit
  // (because the filter combines task_finals + gate_queue + latest
  // attempt status, none of which are in this aggregate query) — but
  // we drop the * 2 and instead set LIMIT = max(limit * 5, 1000) when
  // a status filter is active. This cap is large enough to find the
  // requested rows in any realistic dev DB while still bounded.
  const fetchLimit = statusFilter
    ? Math.max(limit * 5, 1000)
    : limit;
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
  ).all(fetchLimit) as Array<{
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

  // Bug 64 fix (c12+ review): surface secret_pending state in the list.
  // Pre-fix the kernel emitted secret_pending via getTaskStatus but the
  // list page status enum omitted it, so dashboard rows showed
  // "orphaned" or "running" for paused tasks needing a secret.
  const pendingSecretGates = db.prepare(
    `SELECT task_id, stage_name FROM secret_gate_queue WHERE resolved_at IS NULL`,
  ).all() as Array<{ task_id: string; stage_name: string }>;
  const secretPendingByTask = new Map<string, { stage_name: string }>();
  for (const g of pendingSecretGates) secretPendingByTask.set(g.task_id, g);

  // Bug 8 fix (c12+ review): pre-fix `GROUP BY task_id HAVING MAX(started_at)`
  // was a no-op truthiness check — MAX(started_at) is always positive — and
  // the version_hash returned alongside was non-deterministic (SQLite
  // picks an arbitrary row from each group). Migrated tasks (multiple
  // version_hashes per task_id) showed a random pipeline name on the
  // task list. Now uses the same correlated-subquery pattern that
  // latestAttemptByTask below uses, picking the version_hash of the
  // attempt with the actual latest started_at.
  const attemptVersionRows = db.prepare(
    `SELECT sa1.task_id, sa1.version_hash
       FROM stage_attempts sa1
      WHERE sa1.started_at = (
        SELECT MAX(sa2.started_at)
          FROM stage_attempts sa2
         WHERE sa2.task_id = sa1.task_id
      )`,
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
    const secretPending = secretPendingByTask.get(row.task_id);
    const final = finalByTask.get(row.task_id);
    const latest = latestStageByTask.get(row.task_id);

    // Status resolution mirrors KernelService.getTaskStatus precedence:
    //   secret_pending > gated > final > running > orphaned
    // secret_pending wins above gated because a secret-paused task
    // requires a secret-provide that's not interchangeable with a
    // gate-answer; surfacing the more specific state first is more
    // actionable.
    //
    // gated wins over final because a task_finals row with a lingering
    // unanswered gate shouldn't happen in practice (runner finalises
    // all gates before writing task_finals); we prefer the more
    // actionable status when the two disagree.
    //
    // Bug 18 (c12+ review) is filed against KernelService.cancelTask
    // not closing pending gate / secret-gate rows on cancel — that fix
    // is in a different file. Here we compensate by treating a final
    // task with status='cancelled' AND a pending gate / secret-gate as
    // 'cancelled' (the cancel terminal state is authoritative once
    // task_finals records it).
    let status: TaskListRow["status"];
    if (final?.final_state === "cancelled") status = "cancelled";
    else if (secretPending) status = "secret_pending";
    else if (pending) status = "gated";
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
          : status === "secret_pending"
            ? secretPending?.stage_name ?? null
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
