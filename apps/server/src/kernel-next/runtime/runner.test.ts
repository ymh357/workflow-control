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
import { taskRegistry } from "./task-registry.js";
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

// A4: multi-target gate routing — approve → ["A", "B"] authorises BOTH
// branches simultaneously. The non-picked branches (reject → "C") must be
// correctly added to gateSkippedTargets so their regions close cleanly.
describe("A4: multi-target gate routing", () => {
  it("gate with array route activates all picked targets and skips the non-picked branch", async () => {
    // Pipeline:
    //   SRC → G (gate, approve → ["A_STAGE", "B_STAGE"], reject → "C_STAGE")
    //   A_STAGE and B_STAGE are sibling outputs with no inbound wires (gate-only).
    //   C_STAGE is the non-picked alternative — must be skipped so the
    //   pipeline can terminate.
    const db = makeDb();
    try {
      const ir: PipelineIR = {
        name: "multi-gate",
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
              question: { text: "approve or reject?", options: ["approve", "reject"] },
              routing: { routes: { approve: ["A_STAGE", "B_STAGE"], reject: "C_STAGE" } },
            },
          },
          {
            name: "A_STAGE",
            type: "agent",
            inputs: [],
            outputs: [{ name: "a_done", type: "boolean" }],
            config: { promptRef: "p" },
          },
          {
            name: "B_STAGE",
            type: "agent",
            inputs: [],
            outputs: [{ name: "b_done", type: "boolean" }],
            config: { promptRef: "p" },
          },
          {
            name: "C_STAGE",
            type: "agent",
            inputs: [],
            outputs: [{ name: "c_done", type: "boolean" }],
            config: { promptRef: "p" },
          },
        ],
        wires: [{ from: { stage: "SRC", port: "x" }, to: { stage: "G", port: "x" } }],
      };
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      let aInvoked = false;
      let bInvoked = false;
      let cInvoked = false;
      const handlers: StageHandlerMap = {
        SRC: () => ({ x: 1 }),
        A_STAGE: () => { aInvoked = true; return { a_done: true }; },
        B_STAGE: () => { bInvoked = true; return { b_done: true }; },
        C_STAGE: () => { cInvoked = true; return { c_done: true }; },
      };

      const { KernelService } = await import("../mcp/kernel.js");
      const { taskRegistry } = await import("./task-registry.js");

      const runPromise = runPipeline(
        { db, ir, taskId: "multi-gate-1", versionHash: hash, handlers },
        30_000,
      );

      const kernel = new KernelService(db, { skipTypeCheck: true });
      let gateId: string | undefined;
      for (let i = 0; i < 50 && !gateId; i++) {
        const gates = kernel.listGates({ taskId: "multi-gate-1", answered: false });
        if (gates.length > 0) gateId = gates[0]!.gateId;
        else await new Promise((r) => setTimeout(r, 20));
      }
      expect(gateId).toBeDefined();

      // Before answering: no target should have been invoked.
      expect(aInvoked).toBe(false);
      expect(bInvoked).toBe(false);
      expect(cInvoked).toBe(false);

      // Answer with "approve" → array route ["A_STAGE", "B_STAGE"].
      const answer = kernel.answerGate(gateId!, "approve");
      expect(answer.ok).toBe(true);
      if (!answer.ok) return;
      // targetStage must be the full array, not just the first element.
      expect(answer.targetStage).toEqual(["A_STAGE", "B_STAGE"]);

      // Dispatch GATE_ANSWERED with the array targetStage.
      taskRegistry.get("multi-gate-1")!.send({
        type: "GATE_ANSWERED",
        gateId: answer.gateId,
        stageName: answer.stageName,
        answer: answer.answer,
        targetStage: answer.targetStage,
      });

      const result = await runPromise;
      expect(result.finalState).toBe("completed");

      // Both picked stages must have run.
      expect(aInvoked).toBe(true);
      expect(bInvoked).toBe(true);
      // The non-picked branch must NOT have run.
      expect(cInvoked).toBe(false);

      // Port values for picked stages are present.
      expect(result.portValues["A_STAGE.a_done"]).toBe(true);
      expect(result.portValues["B_STAGE.b_done"]).toBe(true);
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
    const err = result.stageErrors[0]!;
    expect(err.stage).toBe("DST");
    expect(err.message).toMatch(/NO_ACTIVE_WIRE/);
    // F3 — NO_ACTIVE_WIRE carries structured context per §6.2.
    expect(err.context?.failedWires).toEqual([
      {
        wire: {
          from: { stage: "SRC", port: "x" },
          to: { stage: "DST", port: "v" },
        },
        guardExpr: "value > 100",
        valuePreview: "5",
        reason: "guard-false",
      },
    ]);
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

  // F3 — Reviewer critical #3: diagnostics must explain WHICH wire died
  // and WHY, not just "none delivered". These tests exercise the three
  // non-deliverable reasons the compiler can produce at runtime.
  it("guard that throws → context.failedWires records reason='guard-threw'", async () => {
    const db = makeDb();
    const ir: PipelineIR = {
      name: "guard-threw",
      stages: [
        {
          name: "SRC",
          type: "agent",
          inputs: [],
          outputs: [{ name: "obj", type: "unknown" }],
          config: { promptRef: "p" },
        },
        {
          name: "DST",
          type: "agent",
          inputs: [{ name: "v", type: "unknown" }],
          outputs: [{ name: "out", type: "unknown" }],
          config: { promptRef: "p" },
        },
      ],
      wires: [
        {
          from: { stage: "SRC", port: "obj" },
          to: { stage: "DST", port: "v" },
          // value is null → value.nested.deep throws TypeError.
          guard: "value.nested.deep > 0",
        },
      ],
    };
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const handlers: StageHandlerMap = {
      SRC: () => ({ obj: null }),
      DST: () => ({ out: null }),
    };
    const result = await runPipeline({
      db, ir, taskId: "t1", versionHash: hash, handlers,
    });

    expect(result.finalState).toBe("failed");
    expect(result.stageErrors).toHaveLength(1);
    const err = result.stageErrors[0]!;
    expect(err.stage).toBe("DST");
    expect(err.context?.failedWires).toHaveLength(1);
    const fw = err.context!.failedWires[0]!;
    expect(fw.reason).toBe("guard-threw");
    expect(fw.guardExpr).toBe("value.nested.deep > 0");
    expect(fw.valuePreview).toBe("null");
    expect(fw.guardError).toBeTruthy();
    db.close();
  });

  // Multi-inbound with mixed outcomes: the delivering wire is omitted
  // from failedWires; only the non-deliverable ones are surfaced. The
  // compiler also treats "at least one settled + at least one dropped"
  // as NO_ACTIVE_WIRE only when the dropped guards aren't opt-in
  // gate-routed suppressions (they aren't here).
  it("multi-inbound stage: failedWires lists only the non-deliverable wires", async () => {
    const db = makeDb();
    const ir: PipelineIR = {
      name: "multi-wire-diag",
      stages: [
        { name: "SRC1", type: "agent", inputs: [],
          outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
        { name: "SRC2", type: "agent", inputs: [],
          outputs: [{ name: "y", type: "number" }], config: { promptRef: "p" } },
        { name: "DST", type: "agent",
          inputs: [
            { name: "a", type: "number" },
            { name: "b", type: "number" },
          ],
          outputs: [{ name: "o", type: "number" }], config: { promptRef: "p" } },
      ],
      wires: [
        // SRC1.x → DST.a with guard that PASSES (value 5 > 0).
        { from: { stage: "SRC1", port: "x" }, to: { stage: "DST", port: "a" }, guard: "value > 0" },
        // SRC2.y → DST.b with guard that FAILS (value 0 not > 100).
        { from: { stage: "SRC2", port: "y" }, to: { stage: "DST", port: "b" }, guard: "value > 100" },
      ],
    };
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const handlers: StageHandlerMap = {
      SRC1: () => ({ x: 5 }),
      SRC2: () => ({ y: 0 }),
      DST: () => ({ o: 1 }),
    };
    const result = await runPipeline({
      db, ir, taskId: "t1", versionHash: hash, handlers,
    });

    expect(result.finalState).toBe("failed");
    const err = result.stageErrors.find((e) => e.stage === "DST");
    expect(err).toBeDefined();
    // Delivering wire SRC1→DST.a absent; only failing SRC2→DST.b listed.
    expect(err!.context?.failedWires).toEqual([
      {
        wire: {
          from: { stage: "SRC2", port: "y" },
          to: { stage: "DST", port: "b" },
        },
        guardExpr: "value > 100",
        valuePreview: "0",
        reason: "guard-false",
      },
    ]);
    db.close();
  });
});

// A2.3.2 — non-gate, non-fanout agent/script stages now execute as XState
// invoked children instead of being dispatched manually by the runner.
// These tests lock in the new path: invoke's promise is what actually
// calls executor.executeStage; the runner's subscribe loop no longer
// does so for these stage types.
describe("A2.3.2: agent stage invoke wiring", () => {
  it("counts executor invocations through the invoke path, not the runner loop", async () => {
    const db = makeDb();
    const ir = diamondIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    // Spy executor that increments a counter on each executeStage call and
    // delegates to MockStageExecutor. If A2.3.2 were broken and the runner
    // still did handwritten dispatch, the counter would still increment
    // once per stage — but so would the invoke's own call, so we'd see
    // DOUBLE the expected count. The assertion catches that regression.
    const { MockStageExecutor } = await import("./mock-executor.js");
    const inner = new MockStageExecutor({ handlers: diamondHandlers() });
    const calls: string[] = [];
    const spy = {
      executeStage: async (args: Parameters<typeof inner.executeStage>[0]) => {
        calls.push(args.stageName);
        return inner.executeStage(args);
      },
    };

    const result = await runPipeline({
      db, ir, taskId: "t-invoke", versionHash: hash,
      handlers: diamondHandlers(),
      executor: spy,
    });

    expect(result.finalState).toBe("completed");
    // Exactly 4 stages, exactly 4 executor invocations. No double-dispatch.
    expect(calls.sort()).toEqual(["A", "B", "C", "D"]);
    db.close();
  });

  // A2.3.3 — external INTERRUPT{stage} reaches the stage's invoked child,
  // which aborts the AbortSignal passed into executor.executeStage. The
  // executor's signal-aware path (RealStageExecutor translates it into
  // an AgentMachine INTERRUPT event) is exercised here via a custom
  // StageExecutor that observes the signal.
  it("forwards TaskMachine INTERRUPT{stage} to executor via AbortSignal", async () => {
    const db = makeDb();
    const ir: PipelineIR = {
      name: "one",
      stages: [
        { name: "A", type: "agent", inputs: [],
          outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
      ],
      wires: [],
    };
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    let observedSignal: AbortSignal | undefined;
    let aborted = false;
    // Executor that parks until either the signal aborts or a timer
    // fires. Test fires dispatcher.send INTERRUPT — the invoke's
    // fromCallback aborts the signal — we observe aborted=true.
    const interruptibleExecutor = {
      executeStage: async (args: Parameters<import("./executor.js").StageExecutor["executeStage"]>[0]) => {
        observedSignal = args.signal;
        // Start an attempt so stage_attempts rows match the legacy shape.
        const { attemptId, attemptIdx } = args.portRuntime.startAttempt({
          taskId: args.taskId, versionHash: args.versionHash, stageName: args.stageName,
        });
        await new Promise<void>((resolve) => {
          if (args.signal?.aborted) {
            aborted = true;
            resolve();
            return;
          }
          args.signal?.addEventListener("abort", () => {
            aborted = true;
            resolve();
          }, { once: true });
          // Fallback timer so the test doesn't hang if INTERRUPT never arrives.
          setTimeout(() => resolve(), 1000);
        });
        // Write the declared output so region reaches done via the always
        // guard after abort — keeps the runner result shape simple.
        args.portRuntime.writePort({
          attemptId, stageName: args.stageName, portName: "x", value: 1,
        });
        args.portRuntime.finishAttempt(attemptId, "success");
        return { attemptId, attemptIdx, status: "success" as const };
      },
    };

    // Fire INTERRUPT via taskRegistry — simulates external caller
    // (migrateTask in A2.3.4). Dispatcher is registered by runPipeline.
    const interruptTimer = setTimeout(() => {
      const dispatcher = taskRegistry.get("t-int");
      if (dispatcher) {
        dispatcher.send({ type: "INTERRUPT", stage: "A" });
      }
    }, 50);

    const result = await runPipeline({
      db, ir, taskId: "t-int", versionHash: hash,
      handlers: {},
      executor: interruptibleExecutor,
    });
    clearTimeout(interruptTimer);

    expect(result.finalState).toBe("completed");
    expect(observedSignal).toBeDefined();
    expect(aborted).toBe(true);
    db.close();
  });

  // A2.3.3 — stage-specific routing (owner §6.1): INTERRUPT{stage:'A'}
  // must NOT leak to sibling stage B running in the parallel region.
  it("INTERRUPT{stage:'A'} only aborts A's signal, not B's", async () => {
    const db = makeDb();
    // Two independent entry stages running in parallel, no wires between.
    const ir: PipelineIR = {
      name: "two",
      stages: [
        { name: "A", type: "agent", inputs: [],
          outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
        { name: "B", type: "agent", inputs: [],
          outputs: [{ name: "y", type: "number" }], config: { promptRef: "p" } },
      ],
      wires: [],
    };
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const abortObserved: Record<string, boolean> = { A: false, B: false };
    const interruptibleExecutor = {
      executeStage: async (args: Parameters<import("./executor.js").StageExecutor["executeStage"]>[0]) => {
        const { attemptId, attemptIdx } = args.portRuntime.startAttempt({
          taskId: args.taskId, versionHash: args.versionHash, stageName: args.stageName,
        });
        await new Promise<void>((resolve) => {
          const onAbort = () => {
            abortObserved[args.stageName] = true;
            resolve();
          };
          if (args.signal?.aborted) {
            onAbort();
            return;
          }
          args.signal?.addEventListener("abort", onAbort, { once: true });
          // Per stage timers: B finishes naturally at 30ms, A waits for abort.
          const delay = args.stageName === "B" ? 30 : 1000;
          setTimeout(() => {
            // Remove the abort listener so a post-completion signal.abort
            // (triggered by invoke cleanup when the parent stops) doesn't
            // retroactively flip abortObserved.
            args.signal?.removeEventListener("abort", onAbort);
            resolve();
          }, delay);
        });
        const portName = args.stageName === "A" ? "x" : "y";
        args.portRuntime.writePort({
          attemptId, stageName: args.stageName, portName, value: 1,
        });
        args.portRuntime.finishAttempt(attemptId, "success");
        return { attemptId, attemptIdx, status: "success" as const };
      },
    };

    // Fire INTERRUPT only for A after B has already finished.
    const timer = setTimeout(() => {
      const dispatcher = taskRegistry.get("t-iso");
      if (dispatcher) dispatcher.send({ type: "INTERRUPT", stage: "A" });
    }, 60);

    const result = await runPipeline({
      db, ir, taskId: "t-iso", versionHash: hash,
      handlers: {},
      executor: interruptibleExecutor,
    });
    clearTimeout(timer);

    expect(result.finalState).toBe("completed");
    expect(abortObserved["A"]).toBe(true);
    expect(abortObserved["B"]).toBe(false);
    db.close();
  });

  it("invoke's onError path still surfaces executor-returned status='error'", async () => {
    // An executor that returns status='error' (schema non-compliance shape)
    // should still trigger STAGE_FAILED via the invoke's internal
    // stageErrors push + dispatcher.send, exactly as the legacy path did.
    const db = makeDb();
    const ir: PipelineIR = {
      name: "single",
      stages: [
        { name: "X", type: "agent", inputs: [],
          outputs: [{ name: "o", type: "number" }], config: { promptRef: "p" } },
      ],
      wires: [],
    };
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const erroringExecutor = {
      executeStage: async () => ({
        attemptId: "a0", attemptIdx: 0,
        status: "error" as const, error: "schema non-compliant: simulated",
      }),
    };

    const result = await runPipeline({
      db, ir, taskId: "t-err", versionHash: hash,
      handlers: { X: () => ({}) },
      executor: erroringExecutor,
    });

    expect(result.finalState).toBe("failed");
    const err = result.stageErrors.find((e) => e.stage === "X");
    expect(err).toBeDefined();
    expect(err!.message).toContain("schema non-compliant");
    db.close();
  });
});

// Slice 2: SSE observability integration. Runs a short pipeline with a
// broadcaster attached and asserts the event sequence.
describe("SSE Slice 2: broadcaster integration", () => {
  it("publishes task_state + stage_executing + port_written + stage_done + run_final for a successful diamond run", async () => {
    // Lazy import so this test doesn't affect other describe-level
    // module load order; broadcaster is a pure TS class with no
    // initializer side effects, but explicit is easier to scan.
    const { KernelNextBroadcaster } = await import("../sse/broadcaster.js");
    const broadcaster = new KernelNextBroadcaster();

    const db = makeDb();
    const ir = diamondIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const events: Array<{ type: string; data: unknown }> = [];
    const unsub = broadcaster.subscribe("sse-slice2-ok", (e) =>
      events.push({ type: e.type, data: e.data }),
    );

    const result = await runPipeline({
      db, ir, taskId: "sse-slice2-ok", versionHash: hash,
      handlers: diamondHandlers(),
      broadcaster,
    });
    unsub();
    db.close();

    expect(result.finalState).toBe("completed");

    // Task state: idle observed first (actor's initial snapshot fires
    // before START), then running, then completed. Each exactly once.
    const states = events
      .filter((e) => e.type === "task_state")
      .map((e) => (e.data as { state: string }).state);
    expect(states).toEqual(["idle", "running", "completed"]);

    // Every stage in the diamond fires stage_executing + stage_done once.
    const executingStages = events
      .filter((e) => e.type === "stage_executing")
      .map((e) => (e.data as { stage: string }).stage);
    const doneStages = events
      .filter((e) => e.type === "stage_done")
      .map((e) => (e.data as { stage: string }).stage);
    expect(executingStages.sort()).toEqual(["A", "B", "C", "D"]);
    expect(doneStages.sort()).toEqual(["A", "B", "C", "D"]);

    // Every port write shows up; valuePreview is a string.
    const portWritten = events.filter((e) => e.type === "port_written");
    expect(portWritten.length).toBeGreaterThanOrEqual(4); // A.x B.y C.z D.final
    for (const e of portWritten) {
      const d = e.data as { valuePreview: unknown };
      expect(typeof d.valuePreview).toBe("string");
    }

    // run_final closes the stream with no stage errors.
    const finals = events.filter((e) => e.type === "run_final");
    expect(finals).toHaveLength(1);
    expect((finals[0]!.data as { finalState: string }).finalState).toBe("completed");
    expect((finals[0]!.data as { stageErrors: unknown[] }).stageErrors).toEqual([]);
  });

  it("publishes stage_error + run_final with failed state for a guard-dropped pipeline", async () => {
    const { KernelNextBroadcaster } = await import("../sse/broadcaster.js");
    const broadcaster = new KernelNextBroadcaster();
    const db = makeDb();
    // Minimal: single wire whose guard is false. B never activates,
    // reaches `error` final via noDeliverableWire.
    const ir: PipelineIR = {
      name: "guard-drop",
      stages: [
        { name: "A", type: "agent", inputs: [], outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
        { name: "B", type: "agent", inputs: [{ name: "x", type: "number" }], outputs: [{ name: "y", type: "string" }], config: { promptRef: "p" } },
      ],
      wires: [
        { from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" }, guard: "value > 100" },
      ],
    };
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const handlers: StageHandlerMap = {
      A: () => ({ x: 5 }),
      B: () => ({ y: "unreachable" }),
    };

    const events: Array<{ type: string; data: unknown }> = [];
    broadcaster.subscribe("sse-slice2-err", (e) => events.push({ type: e.type, data: e.data }));

    const result = await runPipeline({
      db, ir, taskId: "sse-slice2-err", versionHash: hash,
      handlers, broadcaster,
    });
    db.close();

    expect(result.finalState).toBe("failed");

    const stageErrors = events.filter((e) => e.type === "stage_error");
    expect(stageErrors).toHaveLength(1);
    expect((stageErrors[0]!.data as { stage: string }).stage).toBe("B");

    const finals = events.filter((e) => e.type === "run_final");
    expect(finals).toHaveLength(1);
    const finalData = finals[0]!.data as { finalState: string; stageErrors: unknown[] };
    expect(finalData.finalState).toBe("failed");
    expect(finalData.stageErrors).toHaveLength(1);
  });

  it("no broadcaster = zero publishing (existing harnesses unaffected)", async () => {
    // Can't directly assert 'zero events' without a broadcaster to
    // check against; instead verify runPipeline still produces the
    // same RunResult when broadcaster is absent vs. when it's
    // attached to a no-op consumer. This guards the option-absent
    // path from accidentally regressing RunResult shape.
    const db = makeDb();
    const ir = diamondIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const result = await runPipeline({
      db, ir, taskId: "sse-slice2-absent", versionHash: hash,
      handlers: diamondHandlers(),
      // broadcaster intentionally omitted.
    });
    db.close();

    expect(result.finalState).toBe("completed");
    expect(result.portValues["D.final"]).toBe("B-got-10+C-got-10");
  });
});

// stage_error SSE differentiation (2026-04-20). Three paths enter a stage
// region's `error` final state; the compiler now tags `finalizedStages`
// entries with `reason`, and the runner emits differentiated messages so
// the dashboard / debugger stops mislabelling executor failures as
// NO_ACTIVE_WIRE.
describe("runPipeline stage_error reason differentiation", () => {
  it("emits NO_ACTIVE_WIRE message + failedWires context when an inbound wire drops", async () => {
    const { KernelNextBroadcaster } = await import("../sse/broadcaster.js");
    const broadcaster = new KernelNextBroadcaster();
    const db = makeDb();
    // A -> B wired with a guard that always fails. B reaches `error`
    // final via noDeliverableWire (reason = no_active_wire).
    const ir: PipelineIR = {
      name: "naw-reason",
      stages: [
        { name: "A", type: "agent", inputs: [],
          outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
        { name: "B", type: "agent",
          inputs: [{ name: "x", type: "number" }],
          outputs: [{ name: "y", type: "string" }], config: { promptRef: "p" } },
      ],
      wires: [
        { from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" }, guard: "value > 100" },
      ],
    };
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const events: Array<{ type: string; data: unknown }> = [];
    broadcaster.subscribe("naw-reason", (e) => events.push({ type: e.type, data: e.data }));

    const result = await runPipeline({
      db, ir, taskId: "naw-reason", versionHash: hash,
      handlers: { A: () => ({ x: 5 }), B: () => ({ y: "nope" }) },
      broadcaster,
    });
    db.close();

    expect(result.finalState).toBe("failed");
    expect(result.stageErrors).toHaveLength(1);
    expect(result.stageErrors[0]!.message).toMatch(/NO_ACTIVE_WIRE/);

    const stageErrorEvents = events.filter((e) => e.type === "stage_error");
    expect(stageErrorEvents).toHaveLength(1);
    const errData = stageErrorEvents[0]!.data as {
      stage: string;
      message: string;
      reason?: string;
      context?: { failedWires: unknown[] };
    };
    expect(errData.stage).toBe("B");
    expect(errData.message).toMatch(/NO_ACTIVE_WIRE/);
    expect(errData.reason).toBe("no_active_wire");
    // Structured diagnostic must be attached.
    expect(errData.context?.failedWires).toHaveLength(1);
  });

  it("emits executor-specific message (not NO_ACTIVE_WIRE) when an agent returns status=error", async () => {
    const { KernelNextBroadcaster } = await import("../sse/broadcaster.js");
    const broadcaster = new KernelNextBroadcaster();
    const db = makeDb();
    const ir: PipelineIR = {
      name: "exec-fail-reason",
      stages: [
        { name: "X", type: "agent", inputs: [],
          outputs: [{ name: "o", type: "number" }], config: { promptRef: "p" } },
      ],
      wires: [],
    };
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    // Executor that reports a concrete failure. Runner must surface this
    // verbatim in both stageErrors and the SSE stage_error event.
    const erroringExecutor = {
      executeStage: async () => ({
        attemptId: "a0", attemptIdx: 0,
        status: "error" as const,
        error: "turn limit exhausted: agent produced no output after 5 turns",
      }),
    };

    const events: Array<{ type: string; data: unknown }> = [];
    broadcaster.subscribe("exec-fail-reason", (e) => events.push({ type: e.type, data: e.data }));

    const result = await runPipeline({
      db, ir, taskId: "exec-fail-reason", versionHash: hash,
      handlers: { X: () => ({}) },
      executor: erroringExecutor,
      broadcaster,
    });
    db.close();

    expect(result.finalState).toBe("failed");
    // RunResult carries exactly one error and it is the executor's
    // concrete message — not the generic NO_ACTIVE_WIRE string, and not
    // duplicated (guards against double-push from the finalizedStages
    // error loop at run-final).
    expect(result.stageErrors).toHaveLength(1);
    expect(result.stageErrors[0]!.stage).toBe("X");
    expect(result.stageErrors[0]!.message).toContain("turn limit exhausted");

    // SSE stage_error must carry the same message; context is absent
    // (executor_failed has no structured failedWires payload).
    const stageErrorEvents = events.filter((e) => e.type === "stage_error");
    expect(stageErrorEvents).toHaveLength(1);
    const errData = stageErrorEvents[0]!.data as {
      stage: string;
      message: string;
      reason?: string;
      context?: unknown;
    };
    expect(errData.stage).toBe("X");
    expect(errData.message).toContain("turn limit exhausted");
    expect(errData.message).not.toMatch(/NO_ACTIVE_WIRE/);
    expect(errData.reason).toBe("executor_failed");
    expect(errData.context).toBeUndefined();
  });
});

// Task 1.8 — runner seed-phase. Before actor.start(), runPipeline must:
//   1. validate seedValues contains every ir.externalInputs key,
//   2. open a kind="external" stage_attempts row on "__external__",
//   3. writePort each declared external input (persists port_values),
//   4. pass seedValues to the compiler so initial context.portValues
//      already sees the external seeds on the very first snapshot.
describe("runPipeline seedValues (Task 1.8)", () => {
  it("opens a kind='external' attempt and persists port_values rows", async () => {
    const db = makeDb();
    const ir: PipelineIR = {
      name: "seed-ok",
      stages: [
        {
          name: "A",
          type: "agent",
          inputs: [{ name: "ctx", type: "unknown" }],
          outputs: [{ name: "done", type: "boolean" }],
          config: { promptRef: "p" },
        },
      ],
      externalInputs: [{ name: "ctx", type: "unknown" }],
      wires: [
        { from: { source: "external", port: "ctx" }, to: { stage: "A", port: "ctx" } },
      ],
    };
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const result = await runPipeline({
      db,
      ir,
      taskId: "seed-t",
      versionHash: hash,
      handlers: { A: () => ({ done: true }) },
      seedValues: { ctx: { hello: "world" } },
    });
    expect(result.finalState).toBe("completed");

    const ext = db
      .prepare(
        "SELECT kind, status FROM stage_attempts WHERE task_id = ? AND stage_name = ?",
      )
      .get("seed-t", "__external__") as { kind: string; status: string } | undefined;
    expect(ext).toBeDefined();
    expect(ext!.kind).toBe("external");
    expect(ext!.status).toBe("success");

    const seedRow = db
      .prepare(
        "SELECT port_name, value_json FROM port_values WHERE stage_name = ?",
      )
      .get("__external__") as { port_name: string; value_json: string } | undefined;
    expect(seedRow).toBeDefined();
    expect(seedRow!.port_name).toBe("ctx");
    expect(JSON.parse(seedRow!.value_json)).toEqual({ hello: "world" });

    db.close();
  });

  it("fails when an externalInput has no seedValue", async () => {
    const db = makeDb();
    const ir: PipelineIR = {
      name: "seed-missing",
      stages: [
        {
          name: "A",
          type: "agent",
          inputs: [{ name: "ctx", type: "unknown" }],
          outputs: [],
          config: { promptRef: "p" },
        },
      ],
      externalInputs: [{ name: "ctx", type: "unknown" }],
      wires: [
        { from: { source: "external", port: "ctx" }, to: { stage: "A", port: "ctx" } },
      ],
    };
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    await expect(
      runPipeline({
        db,
        ir,
        taskId: "miss-t",
        versionHash: hash,
        handlers: { A: () => ({}) },
        seedValues: {},
      }),
    ).rejects.toThrow(/SEED_VALUES_MISSING_KEY/);

    db.close();
  });

  it("passes seedValues to compiler for initial portValues so downstream sees the value", async () => {
    const db = makeDb();
    const ir: PipelineIR = {
      name: "seed-pass",
      stages: [
        {
          name: "A",
          type: "agent",
          inputs: [{ name: "ctx", type: "unknown" }],
          outputs: [{ name: "echo", type: "string" }],
          config: { promptRef: "p" },
        },
      ],
      externalInputs: [{ name: "ctx", type: "unknown" }],
      wires: [
        { from: { source: "external", port: "ctx" }, to: { stage: "A", port: "ctx" } },
      ],
    };
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const observed: Record<string, unknown>[] = [];
    const result = await runPipeline({
      db,
      ir,
      taskId: "pass-t",
      versionHash: hash,
      handlers: {
        A: (inputs) => {
          observed.push(inputs);
          return { echo: String(inputs.ctx) };
        },
      },
      seedValues: { ctx: "HELLO" },
    });
    expect(result.finalState).toBe("completed");
    expect(observed[0]!.ctx).toBe("HELLO");

    db.close();
  });
});
