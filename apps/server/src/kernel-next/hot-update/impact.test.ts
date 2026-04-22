import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { computeImpact } from "./impact.js";
import type { PipelineIR } from "../ir/schema.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

function seedVersion(db: DatabaseSync, hash: string, ir: PipelineIR): void {
  // Canonical insertion path — persists pipeline_versions + stages + ports +
  // wires in a single transaction (see ir/sql.ts §4.1). computeImpact reads
  // from pipeline_versions.ir_json, so this is sufficient.
  insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "// ts" });
}

function seedAttempt(
  db: DatabaseSync,
  taskId: string,
  versionHash: string,
  stageName: string,
  status: "running" | "success" | "error" | "superseded",
): string {
  const attemptId = randomUUID();
  db.prepare(
    `INSERT INTO stage_attempts
     (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status, kind)
     VALUES (?, ?, ?, ?, 1, ?, ?, 'regular')`,
  ).run(attemptId, taskId, versionHash, stageName, Date.now(), status);
  return attemptId;
}

function seedPortValue(
  db: DatabaseSync,
  attemptId: string,
  stage: string,
  port: string,
  direction: "in" | "out",
  value: unknown,
): void {
  db.prepare(
    `INSERT INTO port_values
     (value_id, attempt_id, stage_name, port_name, direction, value_json, written_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    attemptId,
    stage,
    port,
    direction,
    JSON.stringify(value),
    Date.now(),
  );
}

const baseIR: PipelineIR = {
  name: "p",
  stages: [
    {
      name: "a",
      type: "agent",
      config: { promptRef: "p-a" },
      inputs: [],
      outputs: [{ name: "out", type: "string" }],
    },
    {
      name: "b",
      type: "agent",
      config: { promptRef: "p-b" },
      inputs: [{ name: "x", type: "string" }],
      outputs: [],
    },
  ],
  wires: [
    { from: { source: "stage", stage: "a", port: "out" }, to: { stage: "b", port: "x" } },
  ],
};

describe("computeImpact", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = makeDb();
  });

  it("no active tasks → empty activeTasks", () => {
    seedVersion(db, "v1", baseIR);
    const r = computeImpact(db, "v1", baseIR, null);
    expect(r.activeTasks).toEqual([]);
    expect(r.schemaDriftIssues).toEqual([]);
    expect(r.newSubmissionsOk).toBe(true);
  });

  it("running task on stage not in affectedStages → resumable=true", () => {
    seedVersion(db, "v1", baseIR);
    seedAttempt(db, "t1", "v1", "a", "running");
    const r = computeImpact(db, "v1", baseIR, null);
    expect(r.activeTasks).toHaveLength(1);
    expect(r.activeTasks[0]!.resumable).toBe(true);
  });

  it("running task whose currentStage is removed → resumable=false", () => {
    seedVersion(db, "v1", baseIR);
    seedAttempt(db, "t1", "v1", "a", "running");
    const proposed: PipelineIR = {
      ...baseIR,
      stages: baseIR.stages.filter((s) => s.name !== "a"),
    };
    const r = computeImpact(db, "v1", proposed, null);
    expect(r.activeTasks[0]!.resumable).toBe(false);
    expect(
      r.activeTasks[0]!.blockingReasons.some((m) => m.includes("removed")),
    ).toBe(true);
  });

  it("port_type change on a port with live port_values → schemaDriftIssues", () => {
    seedVersion(db, "v1", baseIR);
    const att = seedAttempt(db, "t1", "v1", "a", "success");
    seedPortValue(db, att, "a", "out", "out", "hello");
    const proposed: PipelineIR = {
      ...baseIR,
      stages: baseIR.stages.map((s) =>
        s.name === "a"
          ? { ...s, outputs: [{ name: "out", type: "number" }] }
          : s,
      ),
    };
    const r = computeImpact(db, "v1", proposed, null);
    expect(r.schemaDriftIssues).toHaveLength(1);
    expect(r.schemaDriftIssues[0]!.kind).toBe("port_type_change_with_live_values");
  });

  it("rerunFrom drives affectedStages via topoDownstream", () => {
    seedVersion(db, "v1", baseIR);
    seedAttempt(db, "t1", "v1", "b", "running");
    const r = computeImpact(db, "v1", baseIR, "a");
    expect(r.activeTasks[0]!.affectedStages.sort()).toEqual(["a", "b"]);
  });
});
