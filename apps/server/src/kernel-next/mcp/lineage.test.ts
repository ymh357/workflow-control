import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { versionHash } from "../ir/canonical.js";
import { runPipeline } from "../runtime/runner.js";
import { queryLineage, diffRuns } from "./lineage.js";
import { diamondIR } from "../generator-mock/mini-generator.js";
import type { StageHandlerMap } from "../runtime/mock-executor.js";

function handlersV1(): StageHandlerMap {
  return {
    A: () => ({ x: 10 }),
    B: (i) => ({ y: `v1-${i.x as number}` }),
    C: (i) => ({ z: `v1-${i.x as number}` }),
    D: (i) => ({ final: `${i.b}+${i.c}` }),
  };
}

function handlersV2(): StageHandlerMap {
  return {
    A: () => ({ x: 99 }),   // differ from v1
    B: (i) => ({ y: `v1-${i.x as number}` }),
    C: (i) => ({ z: `v2-different-${i.x as number}` }), // differ from v1
    D: (i) => ({ final: `${i.b}+${i.c}` }),
  };
}

describe("queryLineage", () => {
  it("returns latest write + downstream reads", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const ir = diamondIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    await runPipeline({
      db, ir, taskId: "t1", versionHash: hash, handlers: handlersV1(),
    });

    const report = queryLineage(db, { stage: "A", port: "x", taskId: "t1" });
    expect(report.latestWrite).not.toBeNull();
    expect(report.latestWrite!.attemptIdx).toBe(1);
    expect(report.latestWrite!.valuePreview).toBe("10");
    expect(report.latestWrite!.truncated).toBe(false);

    // Downstream: B and C both read *some* input in task t1. Upper-bound
    // impl returns all 'in' reads; verify B.x and C.x show up.
    const readerPorts = report.downstream
      .filter((d) => d.taskId === "t1")
      .map((d) => `${d.stageName}.${d.portName}`);
    expect(readerPorts).toContain("B.x");
    expect(readerPorts).toContain("C.x");
    db.close();
  });

  it("returns null latestWrite for a port that was never written", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const report = queryLineage(db, { stage: "ghost", port: "p" });
    expect(report.latestWrite).toBeNull();
    expect(report.downstream).toEqual([]);
    db.close();
  });

  it("truncates valuePreview when value exceeds 200 bytes", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const ir = diamondIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const bigHandlers: StageHandlerMap = {
      ...handlersV1(),
      A: () => ({ x: 10 }),
      B: () => ({ y: "x".repeat(500) }),
      C: () => ({ z: "" }),
      D: () => ({ final: "" }),
    };
    await runPipeline({
      db, ir, taskId: "t1", versionHash: hash, handlers: bigHandlers,
    });

    const report = queryLineage(db, { stage: "B", port: "y", taskId: "t1" });
    expect(report.latestWrite!.truncated).toBe(true);
    expect(report.latestWrite!.valuePreview.length).toBe(200);
    expect(report.latestWrite!.totalBytes).toBeGreaterThan(200);
    db.close();
  });
});

describe("diffRuns", () => {
  it("reports outputsEqual/Differ accurately across two runs", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const ir = diamondIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    await runPipeline({ db, ir, taskId: "tA", versionHash: hash, handlers: handlersV1() });
    await runPipeline({ db, ir, taskId: "tB", versionHash: hash, handlers: handlersV2() });

    const report = diffRuns(db, "tA", "tB");
    expect(report.versionHashA).toBe(hash);
    expect(report.versionHashB).toBe(hash);

    const stageMap = new Map(report.stageComparison.map((s) => [s.stage, s]));
    // A: different (10 vs 99)
    expect(stageMap.get("A")!.outputsDiffer).toEqual(["x"]);
    expect(stageMap.get("A")!.outputsEqual).toBe(false);
    // B: same on both sides (`v1-${x}` which happens to be v1-10 vs v1-99)
    // so values differ.
    expect(stageMap.get("B")!.outputsDiffer).toEqual(["y"]);
    // C: differ
    expect(stageMap.get("C")!.outputsDiffer).toEqual(["z"]);
    // D: differ (because b and c differ)
    expect(stageMap.get("D")!.outputsDiffer).toEqual(["final"]);
    db.close();
  });

  it("handles stages present only in one run", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const ir = diamondIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    // Run only on taskA; compare with an empty taskB.
    await runPipeline({
      db, ir, taskId: "tA", versionHash: hash, handlers: handlersV1(),
    });

    const report = diffRuns(db, "tA", "tEmpty");
    // All stages have attemptIdxA set but attemptIdxB null.
    for (const s of report.stageComparison) {
      expect(s.attemptIdxB).toBeNull();
      expect(s.attemptIdxA).not.toBeNull();
    }
    db.close();
  });
});

describe("A5: lineage in parallel + fanout scenarios", () => {
  // Diamond exercises a parallel fan-out: A -> {B, C} both read A.x.
  // Assert queryLineage stays correct when two parallel readers consume
  // the same port — each reader shows up once; A.x has a single write.
  it("parallel readers: queryLineage reports B.x AND C.x as distinct downstream reads", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const ir = diamondIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    await runPipeline({
      db, ir, taskId: "par", versionHash: hash, handlers: handlersV1(),
    });

    const wiredInputs = ir.wires
      .filter((w) => w.from.source !== "external" && w.from.stage === "A" && w.from.port === "x")
      .map((w) => ({ stage: w.to.stage, port: w.to.port }));
    const report = queryLineage(db, {
      stage: "A", port: "x", taskId: "par", wiredInputs,
    });

    expect(report.latestWrite?.attemptIdx).toBe(1);
    const bxReads = report.downstream.filter((d) => `${d.stageName}.${d.portName}` === "B.x");
    const cxReads = report.downstream.filter((d) => `${d.stageName}.${d.portName}` === "C.x");
    expect(bxReads).toHaveLength(1);
    expect(cxReads).toHaveLength(1);
    expect(bxReads[0]!.attemptId).not.toBe(cxReads[0]!.attemptId);
    db.close();
  });

  // Fanout: SRC.items -> F (fanout) -> SUM.
  // Each element gets its own attempt + port_values row. queryLineage
  // on F.doubled surfaces the LATEST element's write; per-element
  // lineage is recoverable by scanning port_values grouped by attempt_id.
  it("fanout: per-element attempts each leave their own lineage rows", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const ir = {
      name: "fanout-lineage",
      stages: [
        { name: "SRC", type: "agent" as const, inputs: [],
          outputs: [{ name: "items", type: "number[]" }], config: { promptRef: "p" } },
        { name: "F", type: "agent" as const,
          fanout: { input: "item" },
          inputs: [{ name: "item", type: "number" }],
          outputs: [{ name: "doubled", type: "number" }],
          config: { promptRef: "p" } },
        { name: "SUM", type: "agent" as const,
          inputs: [{ name: "xs", type: "number[]" }],
          outputs: [{ name: "total", type: "number" }],
          config: { promptRef: "p" } },
      ],
      wires: [
        { from: { stage: "SRC", port: "items" }, to: { stage: "F", port: "item" } },
        { from: { stage: "F", port: "doubled" }, to: { stage: "SUM", port: "xs" } },
      ],
    };
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const handlers: StageHandlerMap = {
      SRC: () => ({ items: [1, 2, 3] }),
      F: (i) => ({ doubled: (i.item as number) * 2 }),
      SUM: (i) => ({ total: (i.xs as number[]).reduce((a, b) => a + b, 0) }),
    };
    await runPipeline({
      db, ir, taskId: "fo", versionHash: hash, handlers,
    });

    // 3 per-element attempts (attempt_idx 1..3, each with a scalar
    // doubled value) + 1 aggregate attempt (attempt_idx 4, holding the
    // T[] array). The aggregate row is what read_port / query_lineage
    // return for the "current value" of F.doubled.
    const fWrites = db.prepare(
      `SELECT pv.value_json, sa.attempt_idx
       FROM port_values pv JOIN stage_attempts sa ON sa.attempt_id = pv.attempt_id
       WHERE pv.stage_name = 'F' AND pv.port_name = 'doubled' AND pv.direction = 'out'
         AND sa.task_id = 'fo'
       ORDER BY sa.attempt_idx ASC`,
    ).all() as Array<{ value_json: string; attempt_idx: number }>;
    expect(fWrites.map((r) => r.attempt_idx)).toEqual([1, 2, 3, 4]);
    expect(fWrites.slice(0, 3).map((r) => JSON.parse(r.value_json))).toEqual([2, 4, 6]);
    expect(JSON.parse(fWrites[3]!.value_json)).toEqual([2, 4, 6]);

    // queryLineage's latestWrite must surface the aggregate array, not
    // any individual element — external observers need the same value
    // that downstream stages consumed.
    const report = queryLineage(db, { stage: "F", port: "doubled", taskId: "fo" });
    expect(report.latestWrite).not.toBeNull();
    expect(report.latestWrite!.attemptIdx).toBe(4);
    expect(JSON.parse(report.latestWrite!.valuePreview)).toEqual([2, 4, 6]);

    const sumReads = db.prepare(
      `SELECT pv.value_json FROM port_values pv
       JOIN stage_attempts sa ON sa.attempt_id = pv.attempt_id
       WHERE pv.stage_name = 'SUM' AND pv.port_name = 'xs' AND pv.direction = 'in'
         AND sa.task_id = 'fo'`,
    ).all() as Array<{ value_json: string }>;
    expect(sumReads).toHaveLength(1);
    expect(JSON.parse(sumReads[0]!.value_json)).toEqual([2, 4, 6]);
    db.close();
  });

  // Parallel consumers of a fanout output each receive the aggregated array
  // at their own attempt — lineage keeps the reads independent.
  it("parallel consumers of a fanout output both read the aggregated array", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const ir = {
      name: "fanout-par-cons",
      stages: [
        { name: "SRC", type: "agent" as const, inputs: [],
          outputs: [{ name: "items", type: "number[]" }], config: { promptRef: "p" } },
        { name: "F", type: "agent" as const,
          fanout: { input: "item" },
          inputs: [{ name: "item", type: "number" }],
          outputs: [{ name: "doubled", type: "number" }],
          config: { promptRef: "p" } },
        { name: "MIN", type: "agent" as const,
          inputs: [{ name: "xs", type: "number[]" }],
          outputs: [{ name: "m", type: "number" }],
          config: { promptRef: "p" } },
        { name: "MAX", type: "agent" as const,
          inputs: [{ name: "xs", type: "number[]" }],
          outputs: [{ name: "m", type: "number" }],
          config: { promptRef: "p" } },
      ],
      wires: [
        { from: { stage: "SRC", port: "items" }, to: { stage: "F", port: "item" } },
        { from: { stage: "F", port: "doubled" }, to: { stage: "MIN", port: "xs" } },
        { from: { stage: "F", port: "doubled" }, to: { stage: "MAX", port: "xs" } },
      ],
    };
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const handlers: StageHandlerMap = {
      SRC: () => ({ items: [5, 2, 8] }),
      F: (i) => ({ doubled: (i.item as number) * 2 }),
      MIN: (i) => ({ m: Math.min(...(i.xs as number[])) }),
      MAX: (i) => ({ m: Math.max(...(i.xs as number[])) }),
    };
    const result = await runPipeline({
      db, ir, taskId: "pfc", versionHash: hash, handlers,
    });
    expect(result.portValues["MIN.m"]).toBe(4);
    expect(result.portValues["MAX.m"]).toBe(16);

    const reads = db.prepare(
      `SELECT pv.stage_name, pv.value_json FROM port_values pv
       JOIN stage_attempts sa ON sa.attempt_id = pv.attempt_id
       WHERE pv.port_name = 'xs' AND pv.direction = 'in'
         AND sa.task_id = 'pfc'
       ORDER BY pv.stage_name`,
    ).all() as Array<{ stage_name: string; value_json: string }>;
    expect(reads).toHaveLength(2);
    expect(JSON.parse(reads[0]!.value_json)).toEqual([10, 4, 16]);
    expect(JSON.parse(reads[1]!.value_json)).toEqual([10, 4, 16]);
    db.close();
  });
});
