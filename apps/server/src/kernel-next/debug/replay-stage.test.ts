import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { versionHash } from "../ir/canonical.js";
import { MockStageExecutor } from "../runtime/mock-executor.js";
import { replayStage } from "./replay-stage.js";
import type { PipelineIR } from "../ir/schema.js";

function mkDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

function linearIR(): PipelineIR {
  return {
    name: "linear",
    stages: [
      {
        name: "A", type: "agent",
        inputs: [],
        outputs: [{ name: "x", type: "number" }],
        config: { promptRef: "p" },
      },
      {
        name: "B", type: "agent",
        inputs: [{ name: "x", type: "number" }],
        outputs: [{ name: "y", type: "string" }],
        config: { promptRef: "p" },
      },
    ],
    wires: [{ from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" } }],
  };
}

function seedRegularAttempt(
  db: DatabaseSync,
  args: {
    taskId: string;
    versionHashStr: string;
    stageName: string;
    attemptIdx: number;
    inputs?: Record<string, unknown>;
    outputs?: Record<string, unknown>;
  },
): string {
  const attemptId = `att-${args.stageName}-${args.attemptIdx}`;
  db.prepare(
    `INSERT INTO stage_attempts
     (attempt_id, task_id, version_hash, stage_name, attempt_idx,
      started_at, status, kind)
     VALUES (?, ?, ?, ?, ?, ?, 'success', 'regular')`,
  ).run(attemptId, args.taskId, args.versionHashStr, args.stageName, args.attemptIdx, Date.now());
  if (args.inputs) {
    for (const [name, value] of Object.entries(args.inputs)) {
      db.prepare(
        `INSERT INTO port_values
         (value_id, attempt_id, stage_name, port_name, direction, value_json, written_at)
         VALUES (?, ?, ?, ?, 'in', ?, ?)`,
      ).run(`pv-in-${attemptId}-${name}`, attemptId, args.stageName, name, JSON.stringify(value), Date.now());
    }
  }
  if (args.outputs) {
    for (const [name, value] of Object.entries(args.outputs)) {
      db.prepare(
        `INSERT INTO port_values
         (value_id, attempt_id, stage_name, port_name, direction, value_json, written_at)
         VALUES (?, ?, ?, ?, 'out', ?, ?)`,
      ).run(`pv-out-${attemptId}-${name}`, attemptId, args.stageName, name, JSON.stringify(value), Date.now());
    }
  }
  return attemptId;
}

describe("replayStage — preflight failures", () => {
  let db: DatabaseSync;
  beforeEach(() => { db = mkDb(); });

  it("returns SOURCE_ATTEMPT_NOT_FOUND for unknown attempt", async () => {
    const r = await replayStage({
      db,
      sourceAttemptId: "missing",
      executor: new MockStageExecutor({ handlers: {} }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("SOURCE_ATTEMPT_NOT_FOUND");
  });

  it("refuses to replay external-seed attempt (not a real stage body)", async () => {
    const ir = linearIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx,
        started_at, status, kind)
       VALUES ('ext-1', 't', ?, '__external__', 1, ?, 'success', 'external')`,
    ).run(vh, Date.now());
    const r = await replayStage({
      db,
      sourceAttemptId: "ext-1",
      executor: new MockStageExecutor({ handlers: {} }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("SOURCE_STAGE_NOT_REPLAYABLE");
    expect(r.message).toContain("external");
  });

  it("returns SOURCE_IR_MISSING when version_hash was pruned", async () => {
    // Insert a lone stage_attempts row pointing at a version_hash that
    // does not exist in pipeline_versions.
    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx,
        started_at, status, kind)
       VALUES ('stray', 't', 'orphan-hash', 'X', 1, ?, 'success', 'regular')`,
    ).run(Date.now());
    const r = await replayStage({
      db,
      sourceAttemptId: "stray",
      executor: new MockStageExecutor({ handlers: {} }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("SOURCE_IR_MISSING");
  });

  it("returns SOURCE_STAGE_MISSING when stage_name has been removed in current IR", async () => {
    const ir = linearIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx,
        started_at, status, kind)
       VALUES ('gone', 't', ?, 'DELETED_STAGE', 1, ?, 'success', 'regular')`,
    ).run(vh, Date.now());
    const r = await replayStage({
      db,
      sourceAttemptId: "gone",
      executor: new MockStageExecutor({ handlers: {} }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("SOURCE_STAGE_MISSING");
  });
});

describe("replayStage — happy path", () => {
  let db: DatabaseSync;
  beforeEach(() => { db = mkDb(); });

  it("creates a new attempt with kind='replay' + replayed_from_attempt_id", async () => {
    const ir = linearIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    const sourceId = seedRegularAttempt(db, {
      taskId: "t1",
      versionHashStr: vh,
      stageName: "B",
      attemptIdx: 1,
      inputs: { x: 42 },
      outputs: { y: "B-got-42" },
    });

    const executor = new MockStageExecutor({
      handlers: {
        B: (inputs) => ({ y: `replay-got-${(inputs as { x: number }).x}` }),
      },
    });

    const r = await replayStage({
      db,
      sourceAttemptId: sourceId,
      executor,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("success");
    expect(r.newAttemptId).not.toBe(sourceId);
    expect(r.writes).toEqual([{ port: "y", value: "replay-got-42" }]);

    const row = db.prepare(
      `SELECT kind, replayed_from_attempt_id FROM stage_attempts WHERE attempt_id = ?`,
    ).get(r.newAttemptId) as { kind: string; replayed_from_attempt_id: string };
    expect(row.kind).toBe("replay");
    expect(row.replayed_from_attempt_id).toBe(sourceId);
  });

  it("reconstructs inputs from source attempt's lineage reads", async () => {
    const ir = linearIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    const sourceId = seedRegularAttempt(db, {
      taskId: "t1",
      versionHashStr: vh,
      stageName: "B",
      attemptIdx: 1,
      inputs: { x: 7 },
    });

    let observedInput: number | undefined;
    const executor = new MockStageExecutor({
      handlers: {
        B: (inputs) => {
          observedInput = (inputs as { x: number }).x;
          return { y: "done" };
        },
      },
    });

    const r = await replayStage({
      db,
      sourceAttemptId: sourceId,
      executor,
    });
    expect(r.ok).toBe(true);
    expect(observedInput).toBe(7);
  });

  it("portValuesOverride takes precedence over reconstructed inputs", async () => {
    const ir = linearIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    const sourceId = seedRegularAttempt(db, {
      taskId: "t1",
      versionHashStr: vh,
      stageName: "B",
      attemptIdx: 1,
      inputs: { x: 999 },
    });

    let observedInput: number | undefined;
    const executor = new MockStageExecutor({
      handlers: {
        B: (inputs) => {
          observedInput = (inputs as { x: number }).x;
          return { y: "done" };
        },
      },
    });

    const r = await replayStage({
      db,
      sourceAttemptId: sourceId,
      executor,
      // Override: feed it x=3 instead of the reconstructed 999.
      portValuesOverride: { "A.x": 3 },
    });
    expect(r.ok).toBe(true);
    expect(observedInput).toBe(3);
  });

  it("does not mutate the source attempt's row or port_values", async () => {
    const ir = linearIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    const sourceId = seedRegularAttempt(db, {
      taskId: "t1",
      versionHashStr: vh,
      stageName: "B",
      attemptIdx: 1,
      inputs: { x: 5 },
      outputs: { y: "source-output" },
    });

    const before = {
      row: db.prepare(`SELECT * FROM stage_attempts WHERE attempt_id = ?`).get(sourceId),
      writes: db.prepare(
        `SELECT port_name, value_json FROM port_values
         WHERE attempt_id = ? AND direction = 'out'`,
      ).all(sourceId),
    };

    const executor = new MockStageExecutor({
      handlers: { B: () => ({ y: "new-output" }) },
    });
    await replayStage({ db, sourceAttemptId: sourceId, executor });

    const after = {
      row: db.prepare(`SELECT * FROM stage_attempts WHERE attempt_id = ?`).get(sourceId),
      writes: db.prepare(
        `SELECT port_name, value_json FROM port_values
         WHERE attempt_id = ? AND direction = 'out'`,
      ).all(sourceId),
    };
    expect(after.row).toEqual(before.row);
    expect(after.writes).toEqual(before.writes);
  });

  it("attempt_idx of replay is greater than source's", async () => {
    const ir = linearIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    const sourceId = seedRegularAttempt(db, {
      taskId: "t1",
      versionHashStr: vh,
      stageName: "B",
      attemptIdx: 3,
      inputs: { x: 1 },
    });
    const executor = new MockStageExecutor({
      handlers: { B: () => ({ y: "done" }) },
    });
    const r = await replayStage({ db, sourceAttemptId: sourceId, executor });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.newAttemptIdx).toBeGreaterThan(3);
  });
});

describe("replayStage — executor failure surfaces", () => {
  let db: DatabaseSync;
  beforeEach(() => { db = mkDb(); });

  it("executor throwing surfaces as EXECUTOR_THREW", async () => {
    const ir = linearIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    const sourceId = seedRegularAttempt(db, {
      taskId: "t1",
      versionHashStr: vh,
      stageName: "B",
      attemptIdx: 1,
      inputs: { x: 1 },
    });
    const broken = {
      executeStage: async () => { throw new Error("boom"); },
    };
    const r = await replayStage({
      db,
      sourceAttemptId: sourceId,
      executor: broken,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("EXECUTOR_THREW");
    expect(r.message).toContain("boom");
  });

  it("executor returning status='error' is surfaced as ok=true with status='error'", async () => {
    const ir = linearIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    const sourceId = seedRegularAttempt(db, {
      taskId: "t1",
      versionHashStr: vh,
      stageName: "B",
      attemptIdx: 1,
      inputs: { x: 1 },
    });
    const executor = new MockStageExecutor({
      handlers: {
        B: () => {
          throw new Error("handler chose to fail");
        },
      },
    });
    const r = await replayStage({ db, sourceAttemptId: sourceId, executor });
    // MockStageExecutor catches handler errors and writes status='error'
    // on the attempt. replayStage returns ok=true with that status.
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("error");
  });
});
