// describeLastActiveAttempt: when a runPipeline call exceeds its
// wall-clock budget, the runner now augments the failure detail with
// "Last active stage: <name>; silent for Xs before timeout". The
// helper is pure DB read; we exercise it directly without spinning a
// real run.

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { describeLastActiveAttempt } from "./runner.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
});

function seedAttempt(args: {
  taskId: string;
  stageName: string;
  attemptIdx: number;
  startedAt: number;
  status: string;
  versionHash?: string;
  attemptId?: string;
}): string {
  const versionHash = args.versionHash ?? "v";
  // Need a pipeline_versions row first because stage_attempts has FK.
  db.prepare(
    `INSERT OR IGNORE INTO pipeline_versions (version_hash, pipeline_name, ir_json, ts_source, created_at)
     VALUES (?, 'p', '{}', '', ?)`,
  ).run(versionHash, args.startedAt);
  const attemptId = args.attemptId ?? `a-${args.taskId}-${args.stageName}-${args.attemptIdx}`;
  db.prepare(
    `INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(attemptId, args.taskId, versionHash, args.stageName, args.attemptIdx, args.status, args.startedAt);
  return attemptId;
}

function seedAed(attemptId: string, lastHeartbeatAt: number, startedAt: number): void {
  // prompt_contents row first (FK target).
  db.prepare(
    `INSERT OR IGNORE INTO prompt_contents (content_hash, content, created_at)
     VALUES ('h', 'p', ?)`,
  ).run(startedAt);
  db.prepare(
    `INSERT INTO agent_execution_details (
       attempt_id, prompt_ref, prompt_content_hash, prompt_content, model,
       started_at, last_heartbeat_at
     ) VALUES (?, 'r', 'h', 'p', 'm', ?, ?)`,
  ).run(attemptId, startedAt, lastHeartbeatAt);
}

describe("describeLastActiveAttempt", () => {
  it("returns null for a task with no attempts (e.g. timed out before any stage started)", () => {
    expect(describeLastActiveAttempt(db, "ghost")).toBeNull();
  });

  it("returns the most recent attempt by started_at (not by attempt_idx)", () => {
    seedAttempt({ taskId: "t1", stageName: "a", attemptIdx: 1, startedAt: 1000, status: "success" });
    seedAttempt({ taskId: "t1", stageName: "b", attemptIdx: 2, startedAt: 5000, status: "running" });
    // Out-of-order: stage_a re-attempt later, but stage_b was MORE recent.
    // describeLastActiveAttempt should still pick the absolute latest.
    seedAttempt({ taskId: "t1", stageName: "a", attemptIdx: 3, startedAt: 9000, status: "running" });

    const r = describeLastActiveAttempt(db, "t1");
    expect(r).toEqual({
      stageName: "a",
      attemptIdx: 3,
      silentForMs: null, // no AED row → no heartbeat data
    });
  });

  it("computes silent-for from last_heartbeat_at when AED row exists", () => {
    const startedAt = Date.now() - 60_000;
    const heartbeatAt = Date.now() - 10_000;
    const aid = seedAttempt({
      taskId: "t-silent",
      stageName: "fetchAndParse",
      attemptIdx: 1,
      startedAt,
      status: "running",
    });
    seedAed(aid, heartbeatAt, startedAt);

    const r = describeLastActiveAttempt(db, "t-silent");
    expect(r).not.toBeNull();
    expect(r!.stageName).toBe("fetchAndParse");
    expect(r!.attemptIdx).toBe(1);
    // silent-for ≈ 10s ± a few hundred ms test slop
    expect(r!.silentForMs).not.toBeNull();
    expect(Math.abs((r!.silentForMs as number) - 10_000)).toBeLessThan(2_000);
  });

  it("uses started_at when AED row exists but last_heartbeat_at is the same (no heartbeat ever fired)", () => {
    const startedAt = Date.now() - 30_000;
    const aid = seedAttempt({
      taskId: "t-noheart",
      stageName: "stuck",
      attemptIdx: 1,
      startedAt,
      status: "running",
    });
    // Heartbeat never advanced — AED writer wrote the row at startedAt
    // but the stage hung before any 30s heartbeat tick. silentForMs
    // should reflect time since the only available signal (started_at).
    seedAed(aid, startedAt, startedAt);

    const r = describeLastActiveAttempt(db, "t-noheart");
    expect(r).not.toBeNull();
    // ≈ 30s
    expect(Math.abs((r!.silentForMs as number) - 30_000)).toBeLessThan(2_000);
  });

  it("does not throw when stage_attempts schema query fails (defensive)", () => {
    // Drop the table to force a query error. Helper must swallow.
    db.exec("DROP TABLE stage_attempts");
    expect(describeLastActiveAttempt(db, "t-broken")).toBeNull();
  });
});
