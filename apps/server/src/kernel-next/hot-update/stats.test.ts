import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { computeHotUpdateStats } from "./stats.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

function seedVersion(db: DatabaseSync, hash: string, name: string): void {
  db.prepare(
    `INSERT INTO pipeline_versions (version_hash, pipeline_name, ir_json, ts_source, created_at)
     VALUES (?, ?, '{}', '', ?)`,
  ).run(hash, name, Date.now());
}

function seedEvent(
  db: DatabaseSync,
  eventId: string,
  taskId: string,
  fromV: string,
  toV: string,
  status: "success" | "failed" | "rolled_back",
  actor: string,
  startedAt: number,
): void {
  db.prepare(
    `INSERT INTO hot_update_events
     (event_id, task_id, from_version, to_version, actor, proposal_id,
      rerun_from_stage, status, started_at, finished_at, diagnostic_json)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL)`,
  ).run(eventId, taskId, fromV, toV, actor, status, startedAt, startedAt + 10);
}

describe("computeHotUpdateStats", () => {
  it("empty DB → all zeros", () => {
    const db = makeDb();
    const r = computeHotUpdateStats(db, {});
    expect(r.totalMigrations).toBe(0);
    expect(r.successCount).toBe(0);
    expect(r.failedCount).toBe(0);
    expect(r.rolledBackCount).toBe(0);
    expect(r.successRate).toBe(0);
    expect(r.rollbackRate).toBe(0);
    expect(r.byPipelineName).toEqual({});
    expect(r.byActor).toEqual({});
    expect(r.topChurnPipelines).toEqual([]);
    db.close();
  });

  it("aggregates status counts", () => {
    const db = makeDb();
    seedVersion(db, "vA", "pipeA");
    seedEvent(db, "e1", "t1", "vA", "vA", "success", "ai", 100);
    seedEvent(db, "e2", "t1", "vA", "vA", "success", "ai", 200);
    seedEvent(db, "e3", "t1", "vA", "vA", "failed", "ai", 300);
    seedEvent(db, "e4", "t1", "vA", "vA", "rolled_back", "user", 400);
    const r = computeHotUpdateStats(db, {});
    expect(r.totalMigrations).toBe(4);
    expect(r.successCount).toBe(2);
    expect(r.failedCount).toBe(1);
    expect(r.rolledBackCount).toBe(1);
    expect(r.successRate).toBe(0.5);
    expect(r.rollbackRate).toBe(0.25);
    db.close();
  });

  it("groups byPipelineName via JOIN on to_version", () => {
    const db = makeDb();
    seedVersion(db, "vA", "pipeA");
    seedVersion(db, "vB", "pipeB");
    seedEvent(db, "e1", "t1", "vA", "vA", "success", "ai", 100);
    seedEvent(db, "e2", "t1", "vA", "vB", "success", "ai", 200);
    seedEvent(db, "e3", "t2", "vB", "vB", "failed", "ai", 300);
    const r = computeHotUpdateStats(db, {});
    expect(r.byPipelineName["pipeA"]).toEqual({
      total: 1, success: 1, failed: 0, rolled_back: 0,
    });
    expect(r.byPipelineName["pipeB"]).toEqual({
      total: 2, success: 1, failed: 1, rolled_back: 0,
    });
    db.close();
  });

  it("groups byActor", () => {
    const db = makeDb();
    seedVersion(db, "vA", "pipeA");
    seedEvent(db, "e1", "t1", "vA", "vA", "success", "ai", 100);
    seedEvent(db, "e2", "t1", "vA", "vA", "success", "user", 200);
    seedEvent(db, "e3", "t1", "vA", "vA", "failed", "ai", 300);
    const r = computeHotUpdateStats(db, {});
    expect(r.byActor).toEqual({ ai: 2, user: 1 });
    db.close();
  });

  it("topChurnPipelines sorted by total desc, rates per pipeline", () => {
    const db = makeDb();
    seedVersion(db, "vA", "pipeA");
    seedVersion(db, "vB", "pipeB");
    seedVersion(db, "vC", "pipeC");
    seedEvent(db, "a1", "t1", "vA", "vA", "success", "ai", 100);
    seedEvent(db, "a2", "t1", "vA", "vA", "success", "ai", 200);
    seedEvent(db, "a3", "t1", "vA", "vA", "failed", "ai", 300);
    seedEvent(db, "b1", "t1", "vB", "vB", "success", "ai", 400);
    seedEvent(db, "b2", "t1", "vB", "vB", "rolled_back", "user", 500);
    seedEvent(db, "c1", "t1", "vC", "vC", "success", "ai", 600);

    const r = computeHotUpdateStats(db, {});
    expect(r.topChurnPipelines[0]!.pipelineName).toBe("pipeA");
    expect(r.topChurnPipelines[0]!.total).toBe(3);
    expect(r.topChurnPipelines[1]!.pipelineName).toBe("pipeB");
    expect(r.topChurnPipelines[1]!.total).toBe(2);
    expect(r.topChurnPipelines[2]!.pipelineName).toBe("pipeC");
    expect(r.topChurnPipelines[0]!.successRate).toBeCloseTo(2 / 3, 5);
    expect(r.topChurnPipelines[1]!.rollbackRate).toBe(0.5);
    db.close();
  });

  it("applies taskId filter", () => {
    const db = makeDb();
    seedVersion(db, "vA", "pipeA");
    seedEvent(db, "e1", "t1", "vA", "vA", "success", "ai", 100);
    seedEvent(db, "e2", "t2", "vA", "vA", "failed", "ai", 200);
    const r = computeHotUpdateStats(db, { taskId: "t1" });
    expect(r.totalMigrations).toBe(1);
    expect(r.successCount).toBe(1);
    expect(r.failedCount).toBe(0);
    db.close();
  });

  it("applies pipelineName filter (via JOIN on to_version)", () => {
    const db = makeDb();
    seedVersion(db, "vA", "pipeA");
    seedVersion(db, "vB", "pipeB");
    seedEvent(db, "e1", "t1", "vA", "vA", "success", "ai", 100);
    seedEvent(db, "e2", "t2", "vB", "vB", "success", "ai", 200);
    const r = computeHotUpdateStats(db, { pipelineName: "pipeA" });
    expect(r.totalMigrations).toBe(1);
    db.close();
  });

  it("applies sinceMs / untilMs time window", () => {
    const db = makeDb();
    seedVersion(db, "vA", "pipeA");
    seedEvent(db, "e1", "t1", "vA", "vA", "success", "ai", 100);
    seedEvent(db, "e2", "t1", "vA", "vA", "success", "ai", 500);
    seedEvent(db, "e3", "t1", "vA", "vA", "success", "ai", 1000);
    const r = computeHotUpdateStats(db, { sinceMs: 200, untilMs: 800 });
    expect(r.totalMigrations).toBe(1);
    db.close();
  });

  it("applies actor filter", () => {
    const db = makeDb();
    seedVersion(db, "vA", "pipeA");
    seedEvent(db, "e1", "t1", "vA", "vA", "success", "ai", 100);
    seedEvent(db, "e2", "t1", "vA", "vA", "success", "user", 200);
    const r = computeHotUpdateStats(db, { actor: "user" });
    expect(r.totalMigrations).toBe(1);
    expect(r.byActor).toEqual({ user: 1 });
    db.close();
  });
});
