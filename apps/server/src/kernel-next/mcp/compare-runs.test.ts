import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPromptContent } from "../ir/sql.js";
import { compareRuns } from "./compare-runs.js";

function mkDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

function seedVersion(db: DatabaseSync, hash: string): void {
  db.prepare(
    `INSERT INTO pipeline_versions
     (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
     VALUES (?, 'p', 0, NULL, '{}', '')`,
  ).run(hash);
}

interface SeedAttemptArgs {
  db: DatabaseSync;
  attemptId: string;
  taskId: string;
  versionHash: string;
  stageName: string;
  attemptIdx: number;
  status?: "success" | "error" | "running";
  kind?: "regular" | "fanout_element" | "fanout_aggregate";
  aed?: {
    promptHash: string;
    costUsd?: number | null;
    tokenInput?: number | null;
    tokenOutput?: number | null;
    durationMs?: number | null;
    terminationReason?: "natural_completion" | "interrupted" | "error" | "superseded" | null;
    toolCalls?: Array<{ name: string }>;
    compactEvents?: number; // just the count; the actual structure is irrelevant to the diff
  };
}

function seedAttempt(a: SeedAttemptArgs): void {
  const status = a.status ?? "success";
  const kind = a.kind ?? "regular";
  // B17 full — fanout_element rows need non-NULL fanout_element_idx
  // (schema CHECK). Derive from attemptIdx as a deterministic stand-in;
  // this test fixture doesn't care about the actual value, only presence.
  const fanoutIdx = kind === "fanout_element" ? a.attemptIdx : null;
  a.db.prepare(
    `INSERT INTO stage_attempts
     (attempt_id, task_id, version_hash, stage_name, attempt_idx, status,
      started_at, kind, fanout_element_idx)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(a.attemptId, a.taskId, a.versionHash, a.stageName,
    a.attemptIdx, status, 1000, kind, fanoutIdx);

  if (a.aed) {
    insertPromptContent(a.db, a.aed.promptHash, "prompt " + a.aed.promptHash);
    a.db.prepare(
      `INSERT INTO agent_execution_details
       (attempt_id, prompt_ref, prompt_content_hash, prompt_content, model,
        tool_calls_json, compact_events_json,
        cost_usd, token_input, token_output, duration_ms,
        started_at, last_heartbeat_at, ended_at, termination_reason)
       VALUES (?, 'p', ?, 'x', 'm', ?, ?, ?, ?, ?, ?, 1000, 1000, ?, ?)`,
    ).run(
      a.attemptId,
      a.aed.promptHash,
      JSON.stringify((a.aed.toolCalls ?? []).map((t) => ({ id: "x", name: t.name, input: {}, result: null, isError: false, tokenIn: null, tokenOut: null, durationMs: null, startedAt: "t", finishedAt: null }))),
      JSON.stringify(Array.from({ length: a.aed.compactEvents ?? 0 }).map(() => ({ trigger: "auto", preTokens: 0, startedAt: "t", endedAt: "t" }))),
      a.aed.costUsd ?? null,
      a.aed.tokenInput ?? null,
      a.aed.tokenOutput ?? null,
      a.aed.durationMs ?? null,
      a.aed.durationMs !== undefined && a.aed.durationMs !== null ? 1000 + a.aed.durationMs : null,
      a.aed.terminationReason ?? null,
    );
  }
}

describe("compareRuns", () => {
  it("returns empty stageComparison when both tasks have no attempts", () => {
    const db = mkDb();
    const r = compareRuns(db, "a", "b");
    expect(r.taskA).toBe("a");
    expect(r.taskB).toBe("b");
    expect(r.stageComparison).toEqual([]);
    expect(r.versionHashA).toBeNull();
    expect(r.versionHashB).toBeNull();
    db.close();
  });

  it("reports versionHash for each task based on earliest attempt", () => {
    const db = mkDb();
    seedVersion(db, "vA");
    seedVersion(db, "vB");
    seedAttempt({ db, attemptId: "a1", taskId: "A", versionHash: "vA", stageName: "S", attemptIdx: 1 });
    seedAttempt({ db, attemptId: "b1", taskId: "B", versionHash: "vB", stageName: "S", attemptIdx: 1 });
    const r = compareRuns(db, "A", "B");
    expect(r.versionHashA).toBe("vA");
    expect(r.versionHashB).toBe("vB");
    db.close();
  });

  it("compares cost / token / duration deltas per stage (A - B)", () => {
    const db = mkDb();
    seedVersion(db, "v");
    seedAttempt({
      db, attemptId: "a1", taskId: "A", versionHash: "v",
      stageName: "S", attemptIdx: 1,
      aed: {
        promptHash: "h1", costUsd: 0.05, tokenInput: 1000, tokenOutput: 500,
        durationMs: 2000, terminationReason: "natural_completion",
      },
    });
    seedAttempt({
      db, attemptId: "b1", taskId: "B", versionHash: "v",
      stageName: "S", attemptIdx: 1,
      aed: {
        promptHash: "h1", costUsd: 0.03, tokenInput: 800, tokenOutput: 400,
        durationMs: 1500, terminationReason: "natural_completion",
      },
    });
    const r = compareRuns(db, "A", "B");
    expect(r.stageComparison.length).toBe(1);
    const s = r.stageComparison[0]!;
    expect(s.stage).toBe("S");
    expect(s.costDeltaUsd).toBeCloseTo(0.02, 6);
    expect(s.tokenInputDelta).toBe(200);
    expect(s.tokenOutputDelta).toBe(100);
    expect(s.durationDeltaMs).toBe(500);
    expect(s.promptContentHashEqual).toBe(true);
    expect(r.totals.costDeltaUsd).toBeCloseTo(0.02, 6);
  });

  it("detects prompt_content_hash differences (prompt was edited between runs)", () => {
    const db = mkDb();
    seedVersion(db, "v");
    seedAttempt({
      db, attemptId: "a1", taskId: "A", versionHash: "v",
      stageName: "S", attemptIdx: 1,
      aed: { promptHash: "h-old", costUsd: 0.01 },
    });
    seedAttempt({
      db, attemptId: "b1", taskId: "B", versionHash: "v",
      stageName: "S", attemptIdx: 1,
      aed: { promptHash: "h-new", costUsd: 0.01 },
    });
    const r = compareRuns(db, "A", "B");
    expect(r.stageComparison[0]!.promptContentHashEqual).toBe(false);
  });

  it("reports tool name set differences (toolNamesOnlyInA / onlyInB)", () => {
    const db = mkDb();
    seedVersion(db, "v");
    seedAttempt({
      db, attemptId: "a1", taskId: "A", versionHash: "v",
      stageName: "S", attemptIdx: 1,
      aed: { promptHash: "h", toolCalls: [{ name: "read_port" }, { name: "write_port" }] },
    });
    seedAttempt({
      db, attemptId: "b1", taskId: "B", versionHash: "v",
      stageName: "S", attemptIdx: 1,
      aed: { promptHash: "h", toolCalls: [{ name: "write_port" }, { name: "query_lineage" }] },
    });
    const r = compareRuns(db, "A", "B");
    const s = r.stageComparison[0]!;
    expect(s.toolNamesOnlyInA).toEqual(["read_port"]);
    expect(s.toolNamesOnlyInB).toEqual(["query_lineage"]);
    expect(s.toolCallCountA).toBe(2);
    expect(s.toolCallCountB).toBe(2);
  });

  it("reports stages only in one side (stagesOnlyInA / stagesOnlyInB in totals)", () => {
    const db = mkDb();
    seedVersion(db, "v");
    seedAttempt({ db, attemptId: "a1", taskId: "A", versionHash: "v", stageName: "S1", attemptIdx: 1 });
    seedAttempt({ db, attemptId: "a2", taskId: "A", versionHash: "v", stageName: "S2", attemptIdx: 1 });
    seedAttempt({ db, attemptId: "b1", taskId: "B", versionHash: "v", stageName: "S1", attemptIdx: 1 });
    seedAttempt({ db, attemptId: "b3", taskId: "B", versionHash: "v", stageName: "S3", attemptIdx: 1 });
    const r = compareRuns(db, "A", "B");
    expect(r.totals.stagesOnlyInA).toEqual(["S2"]);
    expect(r.totals.stagesOnlyInB).toEqual(["S3"]);
    const stages = r.stageComparison.map((s) => s.stage);
    expect(stages).toEqual(["S1", "S2", "S3"]);
  });

  it("picks the LATEST attempt_idx per (task, stage) for comparison", () => {
    const db = mkDb();
    seedVersion(db, "v");
    // A has two attempts on stage S — earlier errored, later succeeded.
    seedAttempt({
      db, attemptId: "a-err", taskId: "A", versionHash: "v",
      stageName: "S", attemptIdx: 1, status: "error",
      aed: { promptHash: "h", costUsd: 0.5 },
    });
    seedAttempt({
      db, attemptId: "a-ok", taskId: "A", versionHash: "v",
      stageName: "S", attemptIdx: 2, status: "success",
      aed: { promptHash: "h", costUsd: 0.01 },
    });
    seedAttempt({
      db, attemptId: "b1", taskId: "B", versionHash: "v",
      stageName: "S", attemptIdx: 1, status: "success",
      aed: { promptHash: "h", costUsd: 0.02 },
    });
    const r = compareRuns(db, "A", "B");
    const s = r.stageComparison[0]!;
    expect(s.attemptIdxA).toBe(2);
    expect(s.attemptIdxB).toBe(1);
    expect(s.costDeltaUsd).toBeCloseTo(-0.01, 6);
  });

  it("excludes fanout_element attempts (per-element detail is noise at this level)", () => {
    const db = mkDb();
    seedVersion(db, "v");
    seedAttempt({
      db, attemptId: "aAgg", taskId: "A", versionHash: "v",
      stageName: "S", attemptIdx: 11,
      kind: "fanout_aggregate",
      aed: { promptHash: "h", costUsd: 0.1 },
    });
    for (let i = 1; i <= 10; i++) {
      seedAttempt({
        db, attemptId: `aEl${i}`, taskId: "A", versionHash: "v",
        stageName: "S", attemptIdx: i,
        kind: "fanout_element",
        aed: { promptHash: "h", costUsd: 0.001 },
      });
    }
    seedAttempt({
      db, attemptId: "bAgg", taskId: "B", versionHash: "v",
      stageName: "S", attemptIdx: 1,
      kind: "fanout_aggregate",
      aed: { promptHash: "h", costUsd: 0.08 },
    });
    const r = compareRuns(db, "A", "B");
    const s = r.stageComparison[0]!;
    // compare_runs compares the aggregate attempts — delta = 0.1 - 0.08
    expect(s.attemptIdxA).toBe(11);
    expect(s.attemptIdxB).toBe(1);
    expect(s.costDeltaUsd).toBeCloseTo(0.02, 6);
  });

  it("handles script stages (no agent_execution_details) — fields default to null", () => {
    const db = mkDb();
    seedVersion(db, "v");
    seedAttempt({
      db, attemptId: "a-script", taskId: "A", versionHash: "v",
      stageName: "S", attemptIdx: 1,
      // no aed — pure script stage
    });
    seedAttempt({
      db, attemptId: "b-script", taskId: "B", versionHash: "v",
      stageName: "S", attemptIdx: 1,
    });
    const r = compareRuns(db, "A", "B");
    const s = r.stageComparison[0]!;
    expect(s.costDeltaUsd).toBeNull();
    expect(s.tokenInputDelta).toBeNull();
    expect(s.toolCallCountA).toBeNull();
    expect(s.toolCallCountB).toBeNull();
    expect(s.promptContentHashEqual).toBeNull();
  });

  it("compact_events counts are surfaced per side", () => {
    const db = mkDb();
    seedVersion(db, "v");
    seedAttempt({
      db, attemptId: "a1", taskId: "A", versionHash: "v",
      stageName: "S", attemptIdx: 1,
      aed: { promptHash: "h", compactEvents: 3 },
    });
    seedAttempt({
      db, attemptId: "b1", taskId: "B", versionHash: "v",
      stageName: "S", attemptIdx: 1,
      aed: { promptHash: "h", compactEvents: 1 },
    });
    const r = compareRuns(db, "A", "B");
    const s = r.stageComparison[0]!;
    expect(s.compactEventsCountA).toBe(3);
    expect(s.compactEventsCountB).toBe(1);
  });

  it("termination_reason mismatch is reported even when costs are close", () => {
    const db = mkDb();
    seedVersion(db, "v");
    seedAttempt({
      db, attemptId: "a1", taskId: "A", versionHash: "v",
      stageName: "S", attemptIdx: 1, status: "success",
      aed: { promptHash: "h", costUsd: 0.02, terminationReason: "natural_completion" },
    });
    seedAttempt({
      db, attemptId: "b1", taskId: "B", versionHash: "v",
      stageName: "S", attemptIdx: 1, status: "error",
      aed: { promptHash: "h", costUsd: 0.02, terminationReason: "error" },
    });
    const r = compareRuns(db, "A", "B");
    const s = r.stageComparison[0]!;
    expect(s.terminationReasonA).toBe("natural_completion");
    expect(s.terminationReasonB).toBe("error");
  });
});
