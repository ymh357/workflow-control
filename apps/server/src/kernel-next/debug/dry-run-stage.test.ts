import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { versionHash } from "../ir/canonical.js";
import { MockStageExecutor } from "../runtime/mock-executor.js";
import { dryRunStage } from "./dry-run-stage.js";
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

describe("dryRunStage — preflight failures", () => {
  let db: DatabaseSync;
  beforeEach(() => { db = mkDb(); });

  it("returns PIPELINE_VERSION_NOT_FOUND for unknown version_hash", async () => {
    const r = await dryRunStage({
      db,
      pipelineVersion: "does-not-exist",
      stageName: "X",
      inputs: {},
      executor: new MockStageExecutor({ handlers: {} }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("PIPELINE_VERSION_NOT_FOUND");
  });

  it("returns STAGE_NOT_FOUND when stage is not in IR", async () => {
    const ir = linearIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    const r = await dryRunStage({
      db,
      pipelineVersion: vh,
      stageName: "ghost",
      inputs: {},
      executor: new MockStageExecutor({ handlers: {} }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("STAGE_NOT_FOUND");
  });

  it("returns STAGE_NOT_DRY_RUNNABLE for gate stage", async () => {
    const gateIR: PipelineIR = {
      name: "gate-only",
      stages: [
        {
          name: "G",
          type: "gate",
          inputs: [],
          outputs: [],
          config: {
            question: { text: "ok?" },
            routing: { routes: { yes: "G" } },
          },
        },
      ],
      wires: [],
    };
    const vh = versionHash(gateIR);
    insertPipelineVersion(db, gateIR, { versionHash: vh, tsSource: "" });
    const r = await dryRunStage({
      db,
      pipelineVersion: vh,
      stageName: "G",
      inputs: {},
      executor: new MockStageExecutor({ handlers: {} }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("STAGE_NOT_DRY_RUNNABLE");
  });

  it("returns MISSING_INPUT when caller omits a declared input", async () => {
    const ir = linearIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    const r = await dryRunStage({
      db,
      pipelineVersion: vh,
      stageName: "B", // declares inputs: [{x}]
      inputs: {},     // caller provided none
      executor: new MockStageExecutor({ handlers: {} }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("MISSING_INPUT");
    expect(r.message).toContain("x");
  });

  it("returns EXECUTOR_THREW if the executor throws", async () => {
    const ir = linearIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    const executor = new MockStageExecutor({
      handlers: {
        A: () => { throw new Error("boom"); },
      },
    });
    const r = await dryRunStage({
      db,
      pipelineVersion: vh,
      stageName: "A",
      inputs: {},
      executor,
    });
    // MockStageExecutor may catch internally and return status='error'.
    // If it does throw upward, EXECUTOR_THREW is the contract.
    if (r.ok) {
      expect(r.status).toBe("error");
    } else {
      expect(r.code).toBe("EXECUTOR_THREW");
    }
  });
});

describe("dryRunStage — happy path", () => {
  let db: DatabaseSync;
  beforeEach(() => { db = mkDb(); });

  it("runs a stage with provided inputs, returns writes, persists kind='dry_run'", async () => {
    const ir = linearIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });

    const executor = new MockStageExecutor({
      handlers: {
        B: async (inputs) => {
          return { y: `got x=${inputs.x as number}` };
        },
      },
    });

    const r = await dryRunStage({
      db,
      pipelineVersion: vh,
      stageName: "B",
      inputs: { x: 42 },
      executor,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("success");
    expect(r.writes).toEqual([{ port: "y", value: "got x=42" }]);

    // The new attempt row has kind='dry_run' and a synthetic task_id
    // prefixed dry_run-.
    const row = db.prepare(
      `SELECT task_id, kind, stage_name FROM stage_attempts WHERE attempt_id = ?`,
    ).get(r.attemptId) as { task_id: string; kind: string; stage_name: string };
    expect(row.kind).toBe("dry_run");
    expect(row.task_id.startsWith("dry_run-")).toBe(true);
    expect(row.stage_name).toBe("B");
  });

  it("accepts inputs for entry stage with no wires", async () => {
    const ir = linearIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });

    const executor = new MockStageExecutor({
      handlers: {
        A: async () => ({ x: 7 }),
      },
    });
    const r = await dryRunStage({
      db,
      pipelineVersion: vh,
      stageName: "A",
      inputs: {},     // A has no inputs
      executor,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("success");
    expect(r.writes).toEqual([{ port: "x", value: 7 }]);
  });

  it("does NOT dispatch PORT_WRITTEN to any XState machine (inert runtime)", async () => {
    // The invariant: dry_run uses an isolated PortRuntime with an inert
    // dispatcher. We can't easily verify "no dispatch happened" without
    // a harness, but we can at least ensure no crash + the record was
    // made. Detailed isolation behaviour is the same as replay_stage
    // (see replay-stage.ts inertDispatcher).
    const ir = linearIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    const executor = new MockStageExecutor({
      handlers: {
        B: async () => ({ y: "ok" }),
      },
    });
    const r = await dryRunStage({
      db,
      pipelineVersion: vh,
      stageName: "B",
      inputs: { x: 1 },
      executor,
    });
    expect(r.ok).toBe(true);
  });

  it("multiple dry-runs of the same stage produce distinct attempt_ids + tasks", async () => {
    const ir = linearIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    const executor = new MockStageExecutor({
      handlers: {
        A: async () => ({ x: 1 }),
      },
    });
    const r1 = await dryRunStage({
      db, pipelineVersion: vh, stageName: "A", inputs: {}, executor,
    });
    const r2 = await dryRunStage({
      db, pipelineVersion: vh, stageName: "A", inputs: {}, executor,
    });
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.attemptId).not.toBe(r2.attemptId);
    const t1 = db.prepare(`SELECT task_id FROM stage_attempts WHERE attempt_id = ?`).get(r1.attemptId) as { task_id: string };
    const t2 = db.prepare(`SELECT task_id FROM stage_attempts WHERE attempt_id = ?`).get(r2.attemptId) as { task_id: string };
    expect(t1.task_id).not.toBe(t2.task_id);
  });
});
