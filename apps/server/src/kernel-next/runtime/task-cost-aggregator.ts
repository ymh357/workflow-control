// P6.1 / D23 — task-cost aggregator.
//
// Pure function that sums cost + token counts across all
// agent_execution_details rows belonging to a task. Called from runner
// at stage boundaries to emit a task_cost_update SSE event with the
// live-running total.
//
// Schema note (sql.ts line 203): agent_execution_details stores cost
// and token counts as discrete columns (cost_usd, token_input,
// token_output) — there is no usage_json blob. cache_read token counts
// are not captured in the current writer, so cacheReadTokens is always
// 0 today. The field is present in TaskCostSnapshot so a future writer
// extension does not break the SSE contract.

import type { DatabaseSync } from "node:sqlite";

export interface TaskCostSnapshot {
  cumulativeUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

const ZERO: TaskCostSnapshot = {
  cumulativeUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
};

export function computeTaskCost(db: DatabaseSync, taskId: string): TaskCostSnapshot {
  // Bug 55 (c12+ review): pre-fix this summed across every attempt
  // row regardless of `status`. After a hot-update or retry, the
  // discarded attempts kept their AED rows around (audit trail), so
  // the running cost reported via SSE double-counted across each
  // supersede. Filter to the rows that represent the authoritative
  // execution path: succeeded, errored, currently running, or paused
  // on a secret-gate. Superseded / cancelled attempts are NOT
  // authoritative — their AED rows are kept for forensics but must
  // not contribute to the live cost projection.
  const rows = db
    .prepare(
      `SELECT aed.cost_usd, aed.token_input, aed.token_output
       FROM agent_execution_details aed
       JOIN stage_attempts sa ON sa.attempt_id = aed.attempt_id
       WHERE sa.task_id = ?
         AND sa.status IN ('success', 'error', 'running', 'secret_pending')`,
    )
    .all(taskId) as Array<{
      cost_usd: number | null;
      token_input: number | null;
      token_output: number | null;
    }>;

  if (rows.length === 0) return { ...ZERO };

  let cumulativeUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const row of rows) {
    if (typeof row.cost_usd === "number") cumulativeUsd += row.cost_usd;
    if (typeof row.token_input === "number") inputTokens += row.token_input;
    if (typeof row.token_output === "number") outputTokens += row.token_output;
  }

  return { cumulativeUsd, inputTokens, outputTokens, cacheReadTokens: 0 };
}
