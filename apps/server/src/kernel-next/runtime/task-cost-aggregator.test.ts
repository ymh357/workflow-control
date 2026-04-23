// P6.1 / D23 — task-cost-aggregator unit tests.
//
// Seeds realistic stage_attempts + agent_execution_details rows (the
// writer populates discrete cost_usd / token_input / token_output
// columns — there is no usage_json in this schema; see sql.ts line 203).
// Tests assert the aggregator sums across all attempts belonging to a
// given taskId and isolates across tasks.

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { computeTaskCost } from "./task-cost-aggregator.js";

interface SeedOpts {
  attemptId: string;
  taskId: string;
  stageName?: string;
  attemptIdx?: number;
  costUsd?: number | null;
  tokenInput?: number | null;
  tokenOutput?: number | null;
}

function seedVersion(db: DatabaseSync): void {
  db.prepare(
    `INSERT OR IGNORE INTO pipeline_versions
       (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
     VALUES ('v1','t',0,NULL,'{}','')`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO prompt_contents (content_hash, content, created_at)
     VALUES ('hash-1', 'prompt body', 0)`,
  ).run();
}

function seedRow(db: DatabaseSync, opts: SeedOpts): void {
  seedVersion(db);
  db.prepare(
    `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status)
     VALUES (?, ?, 'v1', ?, ?, 0, 'success')`,
  ).run(opts.attemptId, opts.taskId, opts.stageName ?? "s", opts.attemptIdx ?? 1);
  db.prepare(
    `INSERT INTO agent_execution_details
       (attempt_id, prompt_ref, prompt_content_hash, prompt_content, model,
        cost_usd, token_input, token_output, started_at, last_heartbeat_at)
     VALUES (?, 'r', 'hash-1', 'p', 'm', ?, ?, ?, 0, 0)`,
  ).run(
    opts.attemptId,
    opts.costUsd ?? null,
    opts.tokenInput ?? null,
    opts.tokenOutput ?? null,
  );
}

describe("task-cost-aggregator: sum across agent_execution_details rows for a task", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
  });

  it("returns zeros for task with no agent execution records", () => {
    const result = computeTaskCost(db, "nonexistent");
    expect(result).toEqual({
      cumulativeUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    });
  });

  it("sums cost_usd across rows for a single task", () => {
    seedRow(db, { attemptId: "a1", taskId: "tk", costUsd: 0.01 });
    seedRow(db, { attemptId: "a2", taskId: "tk", stageName: "s2", costUsd: 0.02 });
    const result = computeTaskCost(db, "tk");
    expect(result.cumulativeUsd).toBeCloseTo(0.03, 6);
  });

  it("sums token_input and token_output across rows", () => {
    seedRow(db, { attemptId: "a1", taskId: "tk", tokenInput: 100, tokenOutput: 50 });
    seedRow(db, {
      attemptId: "a2",
      taskId: "tk",
      stageName: "s2",
      tokenInput: 200,
      tokenOutput: 75,
    });
    const result = computeTaskCost(db, "tk");
    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(125);
  });

  it("treats NULL cost/token columns as zero (partial fills don't throw)", () => {
    seedRow(db, { attemptId: "a1", taskId: "tk", costUsd: null, tokenInput: null, tokenOutput: null });
    seedRow(db, { attemptId: "a2", taskId: "tk", stageName: "s2", costUsd: 0.05, tokenInput: 10, tokenOutput: 5 });
    const result = computeTaskCost(db, "tk");
    expect(result.cumulativeUsd).toBeCloseTo(0.05, 6);
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(5);
    expect(result.cacheReadTokens).toBe(0);
  });

  it("isolates per-taskId (task-a vs task-b)", () => {
    seedRow(db, { attemptId: "a1", taskId: "task-a", costUsd: 0.01, tokenInput: 10, tokenOutput: 2 });
    seedRow(db, { attemptId: "b1", taskId: "task-b", costUsd: 0.99, tokenInput: 999, tokenOutput: 100 });
    const a = computeTaskCost(db, "task-a");
    const b = computeTaskCost(db, "task-b");
    expect(a.cumulativeUsd).toBeCloseTo(0.01, 6);
    expect(a.inputTokens).toBe(10);
    expect(b.cumulativeUsd).toBeCloseTo(0.99, 6);
    expect(b.inputTokens).toBe(999);
  });
});
