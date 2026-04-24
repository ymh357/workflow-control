// Aggregate queries over hot_update_events for Stage 5E B22.
// Pure read — no writes. Consumer: query_hot_update_stats MCP tool.

import type { DatabaseSync } from "node:sqlite";

export interface StatsInput {
  taskId?: string;
  pipelineName?: string;
  sinceMs?: number;
  untilMs?: number;
  actor?: string;
  // P4.1 follow-up: retry_task synthesises a same-version proposal then
  // delegates through executeMigration, so each retry writes a row in
  // hot_update_events. Setting this flag excludes those rows so churn
  // statistics stay proposal-focused. Default false preserves backward
  // compat with callers that intentionally want retries counted.
  excludeRetries?: boolean;
}

export interface PipelineBreakdown {
  total: number;
  success: number;
  failed: number;
  rolled_back: number;
}

export interface ChurnEntry {
  pipelineName: string;
  total: number;
  successRate: number;
  rollbackRate: number;
}

export interface StatsOutput {
  totalMigrations: number;
  successCount: number;
  failedCount: number;
  rolledBackCount: number;
  successRate: number;
  rollbackRate: number;
  byPipelineName: Record<string, PipelineBreakdown>;
  byActor: Record<string, number>;
  topChurnPipelines: ChurnEntry[];
}

const TOP_CHURN_LIMIT = 10;

export function computeHotUpdateStats(
  db: DatabaseSync,
  input: StatsInput,
): StatsOutput {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (input.taskId !== undefined) {
    where.push("hue.task_id = ?");
    params.push(input.taskId);
  }
  if (input.pipelineName !== undefined) {
    where.push("pv.pipeline_name = ?");
    params.push(input.pipelineName);
  }
  if (input.sinceMs !== undefined) {
    where.push("hue.started_at >= ?");
    params.push(input.sinceMs);
  }
  if (input.untilMs !== undefined) {
    where.push("hue.started_at <= ?");
    params.push(input.untilMs);
  }
  if (input.actor !== undefined) {
    where.push("hue.actor = ?");
    params.push(input.actor);
  }
  if (input.excludeRetries === true) {
    // retry_task marks its synthetic proposal with
    // diagnostic_json.__kind = "retry-v1"; filter those out.
    where.push(`(pp.diagnostic_json IS NULL OR pp.diagnostic_json NOT LIKE '%"__kind":"retry-v1"%')`);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `
    SELECT hue.status AS status, hue.actor AS actor, pv.pipeline_name AS pipeline_name
    FROM hot_update_events hue
    LEFT JOIN pipeline_versions pv ON pv.version_hash = hue.to_version
    LEFT JOIN pipeline_proposals pp ON pp.proposal_id = hue.proposal_id
    ${whereSql}
  `;
  const rows = db.prepare(sql).all(...params) as Array<{
    status: "success" | "failed" | "rolled_back";
    actor: string;
    pipeline_name: string | null;
  }>;

  let successCount = 0;
  let failedCount = 0;
  let rolledBackCount = 0;
  const byPipelineName: Record<string, PipelineBreakdown> = {};
  const byActor: Record<string, number> = {};

  for (const row of rows) {
    if (row.status === "success") successCount++;
    else if (row.status === "failed") failedCount++;
    else if (row.status === "rolled_back") rolledBackCount++;

    byActor[row.actor] = (byActor[row.actor] ?? 0) + 1;

    if (row.pipeline_name !== null) {
      const entry = byPipelineName[row.pipeline_name] ??= {
        total: 0, success: 0, failed: 0, rolled_back: 0,
      };
      entry.total++;
      entry[row.status]++;
    }
  }

  const totalMigrations = rows.length;
  const successRate = totalMigrations > 0 ? successCount / totalMigrations : 0;
  const rollbackRate = totalMigrations > 0 ? rolledBackCount / totalMigrations : 0;

  const topChurnPipelines: ChurnEntry[] = Object.entries(byPipelineName)
    .map(([pipelineName, b]) => ({
      pipelineName,
      total: b.total,
      successRate: b.total > 0 ? b.success / b.total : 0,
      rollbackRate: b.total > 0 ? b.rolled_back / b.total : 0,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, TOP_CHURN_LIMIT);

  return {
    totalMigrations,
    successCount,
    failedCount,
    rolledBackCount,
    successRate,
    rollbackRate,
    byPipelineName,
    byActor,
    topChurnPipelines,
  };
}
