// End-to-end M3 tests: compiler + port-runtime + mock-executor + runner.
//
// Covers design doc §8.2:
//   - #3 run diamond (A -> {B, C parallel} -> D)
//   - #4 lineage query (upstream / downstream discoverable via port_values)
//   - #7 retry / multi-attempt (attempt_idx increments, latest-vs-first)

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { versionHash } from "../ir/canonical.js";
import { runPipeline } from "./runner.js";
import { readLatestPort, PortRuntime } from "./port-runtime.js";
import type { PipelineIR } from "../ir/schema.js";
import type { StageHandlerMap } from "./mock-executor.js";

function diamondIR(): PipelineIR {
  return {
    name: "diamond",
    stages: [
      { name: "A", type: "agent", inputs: [],
        outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
      { name: "B", type: "agent",
        inputs: [{ name: "x", type: "number" }],
        outputs: [{ name: "y", type: "string" }], config: { promptRef: "p" } },
      { name: "C", type: "agent",
        inputs: [{ name: "x", type: "number" }],
        outputs: [{ name: "z", type: "string" }], config: { promptRef: "p" } },
      { name: "D", type: "agent",
        inputs: [{ name: "b", type: "string" }, { name: "c", type: "string" }],
        outputs: [{ name: "final", type: "string" }], config: { promptRef: "p" } },
    ],
    wires: [
      { from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" } },
      { from: { stage: "A", port: "x" }, to: { stage: "C", port: "x" } },
      { from: { stage: "B", port: "y" }, to: { stage: "D", port: "b" } },
      { from: { stage: "C", port: "z" }, to: { stage: "D", port: "c" } },
    ],
  };
}

function diamondHandlers(): StageHandlerMap {
  return {
    A: () => ({ x: 10 }),
    B: (inputs) => ({ y: `B-got-${inputs.x as number}` }),
    C: (inputs) => ({ z: `C-got-${inputs.x as number}` }),
    D: (inputs) => ({ final: `${inputs.b as string}+${inputs.c as string}` }),
  };
}

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

describe("M3: end-to-end diamond pipeline run", () => {
  it("runs A -> {B,C} -> D and produces the expected final port value", async () => {
    const db = makeDb();
    const ir = diamondIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const result = await runPipeline({
      db, ir, taskId: "t1", versionHash: hash, handlers: diamondHandlers(),
    });

    expect(result.finalState).toBe("completed");
    expect(result.portValues["A.x"]).toBe(10);
    expect(result.portValues["B.y"]).toBe("B-got-10");
    expect(result.portValues["C.z"]).toBe("C-got-10");
    expect(result.portValues["D.final"]).toBe("B-got-10+C-got-10");

    // Execution order: A before B/C before D.
    const idx = (s: string) => result.log.indexOf(`${s}:executing`);
    expect(idx("A")).toBeLessThan(idx("B"));
    expect(idx("A")).toBeLessThan(idx("C"));
    expect(idx("B")).toBeLessThan(idx("D"));
    expect(idx("C")).toBeLessThan(idx("D"));
    db.close();
  });

  it("records lineage rows for all reads + writes", async () => {
    const db = makeDb();
    const ir = diamondIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    await runPipeline({
      db, ir, taskId: "t1", versionHash: hash, handlers: diamondHandlers(),
    });

    const outs = db.prepare(
      `SELECT stage_name, port_name FROM port_values WHERE direction = 'out' ORDER BY stage_name`,
    ).all() as Array<{ stage_name: string; port_name: string }>;
    expect(outs).toEqual([
      { stage_name: "A", port_name: "x" },
      { stage_name: "B", port_name: "y" },
      { stage_name: "C", port_name: "z" },
      { stage_name: "D", port_name: "final" },
    ]);

    const ins = db.prepare(
      `SELECT stage_name, port_name FROM port_values WHERE direction = 'in' ORDER BY stage_name, port_name`,
    ).all() as Array<{ stage_name: string; port_name: string }>;
    expect(ins).toEqual([
      { stage_name: "B", port_name: "x" },
      { stage_name: "C", port_name: "x" },
      { stage_name: "D", port_name: "b" },
      { stage_name: "D", port_name: "c" },
    ]);

    db.close();
  });

  it("query_lineage-ish: readLatestPort returns the most recent write", async () => {
    const db = makeDb();
    const ir = diamondIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    await runPipeline({
      db, ir, taskId: "t1", versionHash: hash, handlers: diamondHandlers(),
    });

    const latest = readLatestPort(db, "A", "x");
    expect(latest?.value).toBe(10);
    expect(latest?.attemptIdx).toBe(1);
    db.close();
  });

  it("retry / multi-attempt: attempt_idx increments, latest is returned", () => {
    // We exercise PortRuntime directly to simulate a stage that fails once
    // then succeeds on retry. (Integration with retry triggered by XState is
    // a phase-2 concern; for M3 we just prove the data model supports it.)
    const db = makeDb();
    const ir = diamondIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const dispatcher = { send: () => {} };
    const rt = new PortRuntime(db, dispatcher);

    const a1 = rt.startAttempt({ taskId: "t2", versionHash: hash, stageName: "A" });
    expect(a1.attemptIdx).toBe(1);
    rt.finishAttempt(a1.attemptId, "error", "simulated failure");

    const a2 = rt.startAttempt({ taskId: "t2", versionHash: hash, stageName: "A" });
    expect(a2.attemptIdx).toBe(2);
    rt.writePort({ attemptId: a2.attemptId, stageName: "A", portName: "x", value: 42 });
    rt.finishAttempt(a2.attemptId, "success");

    // Latest write for A.x, scoped to task t2 -> value 42 (from attempt 2)
    const latest = readLatestPort(db, "A", "x", "t2");
    expect(latest?.value).toBe(42);
    expect(latest?.attemptIdx).toBe(2);

    // Attempt history verifiable via stage_attempts table
    const attempts = db.prepare(
      `SELECT attempt_idx, status FROM stage_attempts WHERE task_id = ? AND stage_name = ? ORDER BY attempt_idx`,
    ).all("t2", "A");
    expect(attempts).toEqual([
      { attempt_idx: 1, status: "error" },
      { attempt_idx: 2, status: "success" },
    ]);

    db.close();
  });

  it("handler throws -> attempt status='error', STAGE_FAILED dispatched, machine ends in failed", async () => {
    const db = makeDb();
    const ir: PipelineIR = {
      name: "fail-only",
      stages: [
        { name: "A", type: "agent", inputs: [],
          outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
      ],
      wires: [],
    };
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const handlers: StageHandlerMap = {
      A: () => { throw new Error("boom"); },
    };

    const result = await runPipeline({
      db, ir, taskId: "t3", versionHash: hash, handlers,
    });

    // XState parallel onDone fires even when a region ends in its `error`
    // final — so the XState value transitions to 'completed'. Runner
    // covers this by post-checking stage_attempts for status='error' and
    // promoting finalState to 'failed' (see runner.ts).
    expect(result.finalState).toBe("failed");

    const row = db.prepare(
      `SELECT status FROM stage_attempts WHERE task_id = ?`,
    ).get("t3") as { status: string };
    expect(row.status).toBe("error");

    db.close();
  });
});
