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
