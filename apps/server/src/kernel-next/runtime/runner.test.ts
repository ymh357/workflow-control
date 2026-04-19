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

// A1.1: mixed agent + script pipeline routed through CompositeStageExecutor.
// Agent stages run via MockStageExecutor (handler map, the existing test
// surface); script stages run via the real ScriptStageExecutor backed by a
// TrivialScriptModuleResolver. Composite binds them together.
describe("A1.1: CompositeStageExecutor routes mixed agent + script pipeline", () => {
  it("runs an agent stage upstream of a script stage and reaches completed", async () => {
    const db = makeDb();
    try {
      const ir: PipelineIR = {
        name: "mixed",
        stages: [
          {
            name: "A",
            type: "agent",
            inputs: [],
            outputs: [{ name: "x", type: "number" }],
            config: { promptRef: "p" },
          },
          {
            name: "S",
            type: "script",
            inputs: [{ name: "x", type: "number" }],
            outputs: [{ name: "y", type: "number" }],
            config: { moduleId: "double" },
          },
        ],
        wires: [{ from: { stage: "A", port: "x" }, to: { stage: "S", port: "x" } }],
      };

      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      // Late-bind to avoid circular imports in the header.
      const { MockStageExecutor } = await import("./mock-executor.js");
      const { ScriptStageExecutor } = await import("./script-executor.js");
      const { TrivialScriptModuleResolver } = await import("./script-module-resolver.js");
      const { CompositeStageExecutor } = await import("./composite-executor.js");

      const handlers: StageHandlerMap = {
        A: () => ({ x: 21 }),
      };
      const resolver = new TrivialScriptModuleResolver({
        modules: {
          double: { run: (inputs) => ({ y: (inputs.x as number) * 2 }) },
        },
      });

      const composite = new CompositeStageExecutor({
        agent: new MockStageExecutor({ handlers }),
        script: new ScriptStageExecutor({ resolver }),
      });

      const result = await runPipeline({
        db,
        ir,
        taskId: "mix-1",
        versionHash: hash,
        handlers,
        executor: composite,
      });

      expect(result.finalState).toBe("completed");
      expect(result.portValues).toMatchObject({ "A.x": 21, "S.y": 42 });

      // Attempts: one per stage, both success.
      const rows = db.prepare(
        `SELECT stage_name, status FROM stage_attempts WHERE task_id = ? ORDER BY stage_name`,
      ).all("mix-1") as Array<{ stage_name: string; status: string }>;
      expect(rows).toEqual([
        { stage_name: "A", status: "success" },
        { stage_name: "S", status: "success" },
      ]);

      // readLatestPort + PortRuntime basic sanity
      void readLatestPort;
      void PortRuntime;
    } finally {
      db.close();
    }
  });

  // A1.2b.2 end-to-end: a pipeline containing a gate stage pauses until
  // answerGate is called externally, which fires GATE_ANSWERED and lets
  // the gate transition to `done` so the pipeline can complete.
  //
  // A3.2 update: gate routing targets are now exclusively activated by
  // GATE_ANSWERED + inbound delivery (authorization + delivery). The
  // previous self-referential hack (routing -> SRC) no longer works
  // because SRC becomes gate-routed and waits for its own authorization
  // — a trivial deadlock. This test uses a forward target stage that is
  // never activated on the "yes" path's alternate (we only send one
  // answer); the test asserts the gate itself resolves and the pipeline
  // terminates.
  it("gate pauses the pipeline; external answerGate resolves via GATE_ANSWERED and pipeline completes", async () => {
    const db = makeDb();
    try {
      const ir: PipelineIR = {
        name: "gated",
        stages: [
          {
            name: "SRC",
            type: "agent",
            inputs: [],
            outputs: [{ name: "x", type: "number" }],
            config: { promptRef: "p" },
          },
          {
            name: "G",
            type: "gate",
            inputs: [{ name: "x", type: "number" }],
            outputs: [],
            config: {
              question: { text: "continue?", options: ["yes"] },
              // routing points at AFTER — a dedicated "post-gate" stage
              // with no inbound wires. It activates iff gate answer ==
              // "yes" (and has no inbound to wait for).
              routing: { routes: { yes: "AFTER" } },
            },
          },
          {
            name: "AFTER",
            type: "agent",
            inputs: [],
            outputs: [{ name: "done", type: "boolean" }],
            config: { promptRef: "p" },
          },
        ],
        wires: [{ from: { stage: "SRC", port: "x" }, to: { stage: "G", port: "x" } }],
      };
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      const handlers: StageHandlerMap = {
        SRC: () => ({ x: 42 }),
        AFTER: () => ({ done: true }),
      };

      const { KernelService } = await import("../mcp/kernel.js");
      const { taskRegistry } = await import("./task-registry.js");

      // runPipeline will block until gate is answered. Fire the answer
      // after a short delay while polling for the gate_queue row.
      const runPromise = runPipeline(
        { db, ir, taskId: "gate-1", versionHash: hash, handlers },
        30_000,
      );

      const kernel = new KernelService(db, { skipTypeCheck: true });
      let gateId: string | undefined;
      for (let i = 0; i < 50 && !gateId; i++) {
        const gates = kernel.listGates({ taskId: "gate-1", answered: false });
        if (gates.length > 0) gateId = gates[0]!.gateId;
        else await new Promise((r) => setTimeout(r, 20));
      }
      expect(gateId).toBeDefined();

      // Taskregistry should have the dispatcher registered while the
      // machine is still running (mid-gate).
      expect(taskRegistry.get("gate-1")).toBeDefined();

      const answer = kernel.answerGate(gateId!, "yes");
      expect(answer.ok).toBe(true);
      if (!answer.ok) return;
      expect(answer.taskId).toBe("gate-1");
      expect(answer.stageName).toBe("G");

      // Simulate what the MCP / REST handler does: dispatch via registry.
      const dispatcher = taskRegistry.get("gate-1");
      expect(dispatcher).toBeDefined();
      dispatcher!.send({
        type: "GATE_ANSWERED",
        gateId: answer.gateId,
        stageName: answer.stageName,
        answer: answer.answer,
        targetStage: answer.targetStage,
      });

      const result = await runPromise;
      expect(result.finalState).toBe("completed");

      // After run ends, dispatcher should be unregistered.
      expect(taskRegistry.get("gate-1")).toBeUndefined();

      // gate_queue row is answered.
      const answered = kernel.listGates({ taskId: "gate-1", answered: true });
      expect(answered.map((g) => g.gateId)).toEqual([gateId]);
    } finally {
      db.close();
    }
  });

  it("surfaces a script-stage error on the runner result when script module throws", async () => {
    const db = makeDb();
    try {
      const ir: PipelineIR = {
        name: "mixed-fail",
        stages: [
          {
            name: "S",
            type: "script",
            inputs: [],
            outputs: [{ name: "y", type: "number" }],
            config: { moduleId: "boom" },
          },
        ],
        wires: [],
      };
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      const { ScriptStageExecutor } = await import("./script-executor.js");
      const { TrivialScriptModuleResolver } = await import("./script-module-resolver.js");
      const { CompositeStageExecutor } = await import("./composite-executor.js");

      const resolver = new TrivialScriptModuleResolver({
        modules: { boom: { run: () => { throw new Error("kaboom"); } } },
      });
      const composite = new CompositeStageExecutor({
        script: new ScriptStageExecutor({ resolver }),
      });

      const result = await runPipeline({
        db,
        ir,
        taskId: "mix-fail",
        versionHash: hash,
        handlers: {},
        executor: composite,
      });

      expect(result.finalState).toBe("failed");
      expect(result.stageErrors).toEqual([
        { stage: "S", message: "kaboom" },
      ]);
    } finally {
      db.close();
    }
  });
});

describe("A3.2: gate routing exclusivity", () => {
  it("routing target with no inbound wires activates when gate picks it", async () => {
    // SRC → G (gate). Gate answers 'yes' → TGT_YES. TGT_NO is the
    // alternate branch; it has no wire pressure and no authorization,
    // so it never activates. The pipeline terminates because every
    // region reaches a final state (TGT_NO stays in `waiting` — which
    // means the run CANNOT complete). That's actually the point: once
    // gate routing picks a branch, the other is dead and TGT_NO's
    // region must eventually be closed.
    //
    // For now: use a pipeline where the non-picked branch is absent
    // from the IR entirely (no TGT_NO stage). Exclusivity is then
    // trivially satisfied, and we separately assert TGT_YES activates
    // ONLY after GATE_ANSWERED.
    const db = makeDb();
    try {
      const ir: PipelineIR = {
        name: "gate-excl",
        stages: [
          {
            name: "SRC",
            type: "agent",
            inputs: [],
            outputs: [{ name: "x", type: "number" }],
            config: { promptRef: "p" },
          },
          {
            name: "G",
            type: "gate",
            inputs: [{ name: "x", type: "number" }],
            outputs: [],
            config: {
              question: { text: "go?", options: ["yes"] },
              routing: { routes: { yes: "TGT" } },
            },
          },
          {
            name: "TGT",
            type: "agent",
            inputs: [],
            outputs: [{ name: "ok", type: "boolean" }],
            config: { promptRef: "p" },
          },
        ],
        wires: [{ from: { stage: "SRC", port: "x" }, to: { stage: "G", port: "x" } }],
      };
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      let tgtInvoked = false;
      const handlers: StageHandlerMap = {
        SRC: () => ({ x: 1 }),
        TGT: () => {
          tgtInvoked = true;
          return { ok: true };
        },
      };

      const { KernelService } = await import("../mcp/kernel.js");
      const { taskRegistry } = await import("./task-registry.js");

      const runPromise = runPipeline(
        { db, ir, taskId: "gex-1", versionHash: hash, handlers },
        30_000,
      );

      const kernel = new KernelService(db, { skipTypeCheck: true });
      let gateId: string | undefined;
      for (let i = 0; i < 50 && !gateId; i++) {
        const gates = kernel.listGates({ taskId: "gex-1", answered: false });
        if (gates.length > 0) gateId = gates[0]!.gateId;
        else await new Promise((r) => setTimeout(r, 20));
      }
      expect(gateId).toBeDefined();
      // At this moment, TGT has NOT run — authorization hasn't arrived.
      expect(tgtInvoked).toBe(false);

      const answer = kernel.answerGate(gateId!, "yes");
      expect(answer.ok).toBe(true);
      if (!answer.ok) return;
      taskRegistry.get("gex-1")!.send({
        type: "GATE_ANSWERED",
        gateId: answer.gateId,
        stageName: answer.stageName,
        answer: answer.answer,
        targetStage: answer.targetStage,
      });

      const result = await runPromise;
      expect(result.finalState).toBe("completed");
      expect(tgtInvoked).toBe(true);
      expect(result.portValues["TGT.ok"]).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("A3.1: wire guards + NO_ACTIVE_WIRE", () => {
  it("runPipeline returns failed + stageErrors when all inbound guards drop", async () => {
    const db = makeDb();
    const ir: PipelineIR = {
      name: "guard-fail",
      stages: [
        {
          name: "SRC",
          type: "agent",
          inputs: [],
          outputs: [{ name: "x", type: "number" }],
          config: { promptRef: "p" },
        },
        {
          name: "DST",
          type: "agent",
          inputs: [{ name: "v", type: "number" }],
          outputs: [{ name: "out", type: "number" }],
          config: { promptRef: "p" },
        },
      ],
      wires: [
        {
          from: { stage: "SRC", port: "x" },
          to: { stage: "DST", port: "v" },
          guard: "value > 100",
        },
      ],
    };
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const handlers: StageHandlerMap = {
      SRC: () => ({ x: 5 }),
      // Never invoked — DST should never execute.
      DST: () => ({ out: 999 }),
    };
    const result = await runPipeline({
      db, ir, taskId: "t1", versionHash: hash, handlers,
    });

    expect(result.finalState).toBe("failed");
    expect(result.stageErrors).toHaveLength(1);
    expect(result.stageErrors[0]?.stage).toBe("DST");
    expect(result.stageErrors[0]?.message).toMatch(/NO_ACTIVE_WIRE/);
    db.close();
  });

  it("guard-passing wire activates downstream normally", async () => {
    const db = makeDb();
    const ir: PipelineIR = {
      name: "guard-ok",
      stages: [
        {
          name: "SRC",
          type: "agent",
          inputs: [],
          outputs: [{ name: "x", type: "number" }],
          config: { promptRef: "p" },
        },
        {
          name: "DST",
          type: "agent",
          inputs: [{ name: "v", type: "number" }],
          outputs: [{ name: "out", type: "number" }],
          config: { promptRef: "p" },
        },
      ],
      wires: [
        {
          from: { stage: "SRC", port: "x" },
          to: { stage: "DST", port: "v" },
          guard: "value > 0",
        },
      ],
    };
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const handlers: StageHandlerMap = {
      SRC: () => ({ x: 42 }),
      DST: (inputs) => ({ out: (inputs.v as number) * 2 }),
    };
    const result = await runPipeline({
      db, ir, taskId: "t1", versionHash: hash, handlers,
    });

    expect(result.finalState).toBe("completed");
    expect(result.portValues["DST.out"]).toBe(84);
    db.close();
  });
});
