// A1.2b.1: compile-time tests for gate machine routing.
//
// These tests drive an XState actor built from a PipelineIR with a gate
// stage, and assert that:
//   - A gate stage does NOT auto-complete despite having zero output ports.
//   - GATE_ANSWERED whose stageName matches the gate resolves it to `done`.
//   - GATE_ANSWERED whose targetStage matches a waiting stage activates
//     that stage out-of-band (bypassing inbound-wire checks).
//   - A GATE_ANSWERED that doesn't match any stage is ignored.
//
// No runner, no DB — pure compiled-machine behavior.

import { describe, it, expect } from "vitest";
import { createActor, fromCallback } from "xstate";
import { compileIRToMachine } from "./ir-to-machine.js";
import type { MachineContext } from "./ir-to-machine.js";
import type { PipelineIR } from "../ir/schema.js";

function readRunningValue(snap: ReturnType<ReturnType<typeof createActor>["getSnapshot"]>): Record<string, string> | undefined {
  const value = snap.value as unknown;
  if (typeof value === "object" && value !== null && "running" in value) {
    return (value as { running: Record<string, string> }).running;
  }
  return undefined;
}

describe("compileIRToMachine — gate routing (A1.2b.1)", () => {
  // Pipeline shape:
  //   SRC --x:number--> G (gate)     G.routing: { yes -> TGT_YES, no -> TGT_NO }
  //   SRC --y:string--> TGT_YES.in
  //   SRC --z:string--> TGT_NO.in
  //
  // Target stages TGT_YES/TGT_NO have their inbound wires in the IR so
  // `allInboundPresent` is not vacuously true, but we send GATE_ANSWERED
  // BEFORE SRC's y/z are written — giving the gate-routing transition
  // the only path that can advance them during the observation window.
  const gateIR: PipelineIR = {
    name: "gate-route",
    stages: [
      {
        name: "SRC",
        type: "agent",
        inputs: [],
        outputs: [
          { name: "x", type: "number" },
          { name: "y", type: "string" },
          { name: "z", type: "string" },
        ],
        config: { promptRef: "p" },
      },
      {
        name: "G",
        type: "gate",
        inputs: [{ name: "x", type: "number" }],
        outputs: [],
        config: {
          question: { text: "continue?", options: ["yes", "no"] },
          routing: { routes: { yes: "TGT_YES", no: "TGT_NO" } },
        },
      },
      {
        name: "TGT_YES",
        type: "agent",
        inputs: [{ name: "in", type: "string" }],
        outputs: [{ name: "out", type: "string" }],
        config: { promptRef: "p" },
      },
      {
        name: "TGT_NO",
        type: "agent",
        inputs: [{ name: "in", type: "string" }],
        outputs: [{ name: "out", type: "string" }],
        config: { promptRef: "p" },
      },
    ],
    wires: [
      { from: { stage: "SRC", port: "x" }, to: { stage: "G", port: "x" } },
      { from: { stage: "SRC", port: "y" }, to: { stage: "TGT_YES", port: "in" } },
      { from: { stage: "SRC", port: "z" }, to: { stage: "TGT_NO", port: "in" } },
    ],
  };

  it("gate stage stays in `executing` after activation (no auto-complete)", () => {
    const { machine } = compileIRToMachine(gateIR, { taskId: "t" });
    const actor = createActor(machine);
    actor.start();
    actor.send({ type: "START" });
    actor.send({ type: "PORT_WRITTEN", key: "SRC.x", value: 1 });
    const snap = actor.getSnapshot();
    const running = readRunningValue(snap);
    expect(running?.G).toBe("executing");
    actor.stop();
  });

  it("GATE_ANSWERED matching the gate's stageName transitions gate to `done`", () => {
    const { machine } = compileIRToMachine(gateIR, { taskId: "t" });
    const actor = createActor(machine);
    actor.start();
    actor.send({ type: "START" });
    actor.send({ type: "PORT_WRITTEN", key: "SRC.x", value: 1 });
    actor.send({
      type: "GATE_ANSWERED",
      gateId: "g1",
      stageName: "G",
      answer: "yes",
      targetStage: "TGT_YES",
    });
    const snap = actor.getSnapshot();
    const running = readRunningValue(snap);
    expect(running?.G).toBe("done");
    actor.stop();
  });

  it("GATE_ANSWERED authorises the target; inbound delivery then activates it", () => {
    // A3.2 semantics: a gate routing target is NOT activated by the gate
    // answer alone — it must also have its inbound wires delivered. This
    // test asserts BOTH halves:
    //   (1) writing SRC.y with no prior GATE_ANSWERED leaves TGT_YES in
    //       waiting (wires alone are not enough);
    //   (2) sending GATE_ANSWERED(targetStage=TGT_YES) then activates it
    //       (the authorization picks it up with already-delivered wires);
    //   (3) TGT_NO, never authorised, stays in waiting.
    const { machine } = compileIRToMachine(gateIR, { taskId: "t" });
    const actor = createActor(machine);
    actor.start();
    actor.send({ type: "START" });
    actor.send({ type: "PORT_WRITTEN", key: "SRC.x", value: 1 });
    actor.send({ type: "PORT_WRITTEN", key: "SRC.y", value: "Y" });
    actor.send({ type: "PORT_WRITTEN", key: "SRC.z", value: "Z" });

    // (1) Both TGT stages still waiting — inbound delivered, but no
    // gate authorization yet.
    const before = readRunningValue(actor.getSnapshot());
    expect(before?.TGT_YES).toBe("waiting");
    expect(before?.TGT_NO).toBe("waiting");

    actor.send({
      type: "GATE_ANSWERED",
      gateId: "g1",
      stageName: "G",
      answer: "yes",
      targetStage: "TGT_YES",
    });

    const after = readRunningValue(actor.getSnapshot());
    // (2) TGT_YES: authorized + inbound delivered → executing.
    // (3) TGT_NO: answered gate's OTHER branch → transitions to `done`
    //     (skipped, never runs). This is the A7 update to A3.2
    //     exclusivity: unpicked branches must close so the parallel
    //     region's onDone can fire.
    expect(after?.TGT_YES).toBe("executing");
    expect(after?.TGT_NO).toBe("done");
    actor.stop();
  });

  it("gate target waits when only inbound delivered (no authorization)", () => {
    // Regression guard for the A3.2 exclusivity invariant: a routing
    // target with all inbound wires delivered but no GATE_ANSWERED must
    // NOT execute.
    const { machine } = compileIRToMachine(gateIR, { taskId: "t" });
    const actor = createActor(machine);
    actor.start();
    actor.send({ type: "START" });
    actor.send({ type: "PORT_WRITTEN", key: "SRC.x", value: 1 });
    actor.send({ type: "PORT_WRITTEN", key: "SRC.y", value: "Y" });
    actor.send({ type: "PORT_WRITTEN", key: "SRC.z", value: "Z" });
    const running = readRunningValue(actor.getSnapshot());
    expect(running?.TGT_YES).toBe("waiting");
    expect(running?.TGT_NO).toBe("waiting");
    actor.stop();
  });

  it("GATE_ANSWERED naming an unknown target is a no-op for all stages", () => {
    const { machine } = compileIRToMachine(gateIR, { taskId: "t" });
    const actor = createActor(machine);
    actor.start();
    actor.send({ type: "START" });
    actor.send({ type: "PORT_WRITTEN", key: "SRC.x", value: 1 });
    actor.send({
      type: "GATE_ANSWERED",
      gateId: "g1",
      stageName: "G",
      answer: "maybe",
      targetStage: "NO_SUCH_STAGE",
    });
    // Gate still done (stageName matched), but neither TGT branch moved.
    const snap = readRunningValue(actor.getSnapshot());
    expect(snap?.G).toBe("done");
    expect(snap?.TGT_YES).toBe("waiting");
    expect(snap?.TGT_NO).toBe("waiting");
    actor.stop();
  });

  it("non-gate stages continue to use PORT_WRITTEN-driven activation", () => {
    // Ensures we haven't broken the primary path by adding the GATE_ANSWERED
    // handler. This re-runs a simple linear scenario.
    const linearIR: PipelineIR = {
      name: "linear",
      stages: [
        { name: "A", type: "agent", inputs: [], outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
        { name: "B", type: "agent", inputs: [{ name: "x", type: "number" }], outputs: [{ name: "y", type: "number" }], config: { promptRef: "p" } },
      ],
      wires: [{ from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" } }],
    };
    const { machine } = compileIRToMachine(linearIR, { taskId: "t" });
    const actor = createActor(machine);
    actor.start();
    actor.send({ type: "START" });
    actor.send({ type: "PORT_WRITTEN", key: "A.x", value: 10 });

    const afterA = readRunningValue(actor.getSnapshot());
    expect(afterA?.B).toBe("executing");

    actor.send({ type: "PORT_WRITTEN", key: "B.y", value: 20 });
    const afterB = actor.getSnapshot();
    // Once every region reaches its final, the parallel `running` emits
    // its own onDone -> top-level `completed`. Either form ("completed"
    // top-level, or running.B === "done" if A isn't done yet) is fine.
    if (afterB.value === "completed") {
      expect(afterB.value).toBe("completed");
    } else {
      expect(readRunningValue(afterB)?.B).toBe("done");
    }
    actor.stop();
  });
});

describe("compileIRToMachine — gate routing upstream exclusion", () => {
  // A gate stage whose routing table names one of its own upstream
  // stages (e.g. on_reject_to → the preceding stage) must NOT mark
  // that upstream as gate-routed. If it did, the upstream would sit
  // in `waiting` forever on the forward pass, stalling the pipeline.
  //
  // Observed in pipeline-generator: `analyzing` feeds `awaitingConfirm`
  // AND is the gate's reject target, which used to prevent analyzing
  // from ever reaching `executing`.
  it("upstream of a gate referenced as a routing target stays non-gate-routed and activates on its inbound", () => {
    const ir: PipelineIR = {
      name: "upstream-exclusion",
      stages: [
        {
          name: "UP",
          type: "agent",
          inputs: [],
          outputs: [{ name: "signal", type: "boolean" }],
          config: { promptRef: "p" },
        },
        {
          name: "G",
          type: "gate",
          inputs: [{ name: "signal", type: "boolean" }],
          outputs: [],
          config: {
            question: { text: "approve?", options: ["approve", "reject"] },
            // reject target points back at UP — rollback semantics.
            routing: { routes: { approve: "FWD", reject: "UP" } },
          },
        },
        {
          name: "FWD",
          type: "agent",
          inputs: [],
          outputs: [{ name: "ok", type: "boolean" }],
          config: { promptRef: "p" },
        },
      ],
      wires: [
        { from: { source: "stage", stage: "UP", port: "signal" }, to: { stage: "G", port: "signal" } },
      ],
    };
    const { machine } = compileIRToMachine(ir, { taskId: "t" });
    const actor = createActor(machine);
    actor.start();
    actor.send({ type: "START" });
    const running = readRunningValue(actor.getSnapshot());
    // UP has no inbound wires and is only the gate's reject target —
    // exclusion rule keeps it out of gateRoutedTargets, so it enters
    // `executing` on START rather than staying in `waiting`.
    expect(running?.UP).toBe("executing");
    // FWD (forward target) is still gate-routed and must wait.
    expect(running?.FWD).toBe("waiting");
    // Gate itself is waiting on its inbound wire from UP.
    expect(running?.G).toBe("waiting");
    actor.stop();
  });

  it("routing target that is NOT an upstream of the gate stays gate-routed", () => {
    // Control case: a downstream/approve target that is not feeding
    // the gate must continue to wait for GATE_ANSWERED.
    const ir: PipelineIR = {
      name: "downstream-still-gate-routed",
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
            question: { text: "ok?", options: ["yes"] },
            routing: { routes: { yes: "TGT" } },
          },
        },
        {
          name: "TGT",
          type: "agent",
          inputs: [],
          outputs: [{ name: "done", type: "boolean" }],
          config: { promptRef: "p" },
        },
      ],
      wires: [
        { from: { source: "stage", stage: "SRC", port: "x" }, to: { stage: "G", port: "x" } },
      ],
    };
    const { machine } = compileIRToMachine(ir, { taskId: "t" });
    const actor = createActor(machine);
    actor.start();
    actor.send({ type: "START" });
    const running = readRunningValue(actor.getSnapshot());
    // SRC has no inbound wires and is not a gate target → executes on START.
    expect(running?.SRC).toBe("executing");
    // TGT is a gate target but not an upstream of the gate → still waits
    // for GATE_ANSWERED.
    expect(running?.TGT).toBe("waiting");
    actor.stop();
  });
});

describe("compileIRToMachine seedValues", () => {
  it("seeds external portValues into initial context", () => {
    const ir: PipelineIR = {
      name: "t",
      stages: [
        { name: "A", type: "agent", inputs: [{ name: "ctx", type: "unknown" }], outputs: [], config: { promptRef: "p" } },
      ],
      externalInputs: [{ name: "ctx", type: "unknown" }],
      wires: [{ from: { source: "external", port: "ctx" }, to: { stage: "A", port: "ctx" } }],
    };
    const { machine } = compileIRToMachine(ir, {
      taskId: "t1",
      seedValues: { ctx: { pipelineConfig: { hello: "world" } } },
    });
    const actor = createActor(machine);
    actor.start();
    const ctx = actor.getSnapshot().context as MachineContext;
    expect(ctx.portValues["__external__.ctx"]).toEqual({ pipelineConfig: { hello: "world" } });
    actor.stop();
  });

  it("leaves portValues empty when seedValues is omitted", () => {
    const ir: PipelineIR = {
      name: "t",
      stages: [
        { name: "A", type: "agent", inputs: [], outputs: [], config: { promptRef: "p" } },
      ],
      wires: [],
    };
    const { machine } = compileIRToMachine(ir, { taskId: "t2" });
    const actor = createActor(machine);
    actor.start();
    const ctx = actor.getSnapshot().context as MachineContext;
    expect(ctx.portValues).toEqual({});
    actor.stop();
  });

  it("ignores seedValues keys not declared in externalInputs", () => {
    // seedValues may carry extras (runner logs a warning but doesn't fail).
    // The compiler silently drops extras — only declared ports land in context.
    const ir: PipelineIR = {
      name: "t",
      stages: [
        { name: "A", type: "agent", inputs: [{ name: "ctx", type: "unknown" }], outputs: [], config: { promptRef: "p" } },
      ],
      externalInputs: [{ name: "ctx", type: "unknown" }],
      wires: [{ from: { source: "external", port: "ctx" }, to: { stage: "A", port: "ctx" } }],
    };
    const { machine } = compileIRToMachine(ir, {
      taskId: "t3",
      seedValues: { ctx: 1, extra: "unused" },
    });
    const actor = createActor(machine);
    actor.start();
    const ctx = actor.getSnapshot().context as MachineContext;
    expect(ctx.portValues).toEqual({ "__external__.ctx": 1 });
    actor.stop();
  });

  it("preserves declaration order of externalInputs in initial portValues iteration", () => {
    const ir: PipelineIR = {
      name: "t",
      stages: [
        { name: "A", type: "agent", inputs: [{ name: "b", type: "unknown" }, { name: "a", type: "unknown" }], outputs: [], config: { promptRef: "p" } },
      ],
      externalInputs: [{ name: "b", type: "unknown" }, { name: "a", type: "unknown" }],
      wires: [
        { from: { source: "external", port: "b" }, to: { stage: "A", port: "b" } },
        { from: { source: "external", port: "a" }, to: { stage: "A", port: "a" } },
      ],
    };
    const { machine } = compileIRToMachine(ir, {
      taskId: "t4",
      seedValues: { a: 10, b: 20 },
    });
    const actor = createActor(machine);
    actor.start();
    const ctx = actor.getSnapshot().context as MachineContext;
    // Both keys present regardless of iteration order
    expect(ctx.portValues["__external__.a"]).toBe(10);
    expect(ctx.portValues["__external__.b"]).toBe(20);
    actor.stop();
  });
});

describe("compileIRToMachine — rejectRollbackMap", () => {
  it("builds rollback entry when gate routes reject to a transitive upstream", () => {
    const ir: PipelineIR = {
      name: "t",
      version: "1.0.0",
      externalInputs: [],
      stages: [
        { name: "A", type: "agent", config: { promptRef: "p", reads: [] }, inputs: [], outputs: [{ name: "out1", type: "unknown" }] } as any,
        { name: "B", type: "agent", config: { promptRef: "p", reads: [] }, inputs: [{ name: "a", type: "unknown" }], outputs: [{ name: "o", type: "unknown" }] } as any,
        { name: "G", type: "gate", config: { routing: { routes: { approve: "C", reject: "A" } } }, inputs: [{ name: "b", type: "unknown" }], outputs: [] } as any,
        { name: "C", type: "agent", config: { promptRef: "p", reads: [] }, inputs: [], outputs: [] } as any,
      ],
      wires: [
        { from: { source: "stage", stage: "A", port: "out1" }, to: { stage: "B", port: "a" } },
        { from: { source: "stage", stage: "B", port: "o" }, to: { stage: "G", port: "b" } },
      ],
    } as unknown as PipelineIR;
    const { rejectRollbackMap } = compileIRToMachine(ir, { taskId: "t1" });
    const entry = rejectRollbackMap.get("G");
    expect(entry).toBeDefined();
    expect(entry!.answer).toBe("reject");
    expect(entry!.targetStage).toBe("A");
    // BFS downstream of A, then include G itself.
    expect(new Set(entry!.affectedStages)).toEqual(new Set(["A", "B", "G"]));
  });

  it("no entry when reject target is not a transitive upstream", () => {
    const ir: PipelineIR = {
      name: "t2",
      version: "1.0.0",
      externalInputs: [],
      stages: [
        { name: "A", type: "agent", config: { promptRef: "p", reads: [] }, inputs: [], outputs: [] } as any,
        { name: "G", type: "gate", config: { routing: { routes: { approve: "C", reject: "X" } } }, inputs: [], outputs: [] } as any,
        { name: "C", type: "agent", config: { promptRef: "p", reads: [] }, inputs: [], outputs: [] } as any,
        { name: "X", type: "agent", config: { promptRef: "p", reads: [] }, inputs: [], outputs: [] } as any,
      ],
      wires: [],
    } as unknown as PipelineIR;
    const { rejectRollbackMap } = compileIRToMachine(ir, { taskId: "t2" });
    expect(rejectRollbackMap.has("G")).toBe(false);
  });

  it("no entry for a gate whose only routes target downstream stages", () => {
    const ir: PipelineIR = {
      name: "t3",
      version: "1.0.0",
      externalInputs: [],
      stages: [
        { name: "A", type: "agent", config: { promptRef: "p", reads: [] }, inputs: [], outputs: [] } as any,
        { name: "G", type: "gate", config: { routing: { routes: { yes: "B", no: "C" } } }, inputs: [], outputs: [] } as any,
        { name: "B", type: "agent", config: { promptRef: "p", reads: [] }, inputs: [], outputs: [] } as any,
        { name: "C", type: "agent", config: { promptRef: "p", reads: [] }, inputs: [], outputs: [] } as any,
      ],
      wires: [
        { from: { source: "stage", stage: "A", port: "o" }, to: { stage: "G", port: "i" } },
      ],
    } as unknown as PipelineIR;
    const { rejectRollbackMap } = compileIRToMachine(ir, { taskId: "t3" });
    expect(rejectRollbackMap.has("G")).toBe(false);
  });
});

// Slice C (Task C1): script stage retry transition.
// These tests exercise only the compiler's emission side — the runner's
// root-level RETRY_TO_STAGE handler (increment + RESET_STAGE) is Task C5.
describe("ScriptStage retry transition", () => {
  it("compiles a ScriptStage without retry without regression", () => {
    // Regression canary: a ScriptStage with no retry spec still compiles
    // and the machine builds. Existing tests cover the error-final path.
    const ir: PipelineIR = {
      name: "no-retry-script",
      externalInputs: [],
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
          outputs: [{ name: "r", type: "boolean" }],
          config: { moduleId: "m" },
        },
      ],
      wires: [
        { from: { source: "stage", stage: "A", port: "x" }, to: { stage: "S", port: "x" } },
      ],
    };
    const { machine } = compileIRToMachine(ir, { taskId: "t1" });
    expect(machine).toBeDefined();
  });

  it("initialises MachineContext.retryCounts as an empty record", () => {
    const ir: PipelineIR = {
      name: "rc-init",
      externalInputs: [],
      stages: [
        {
          name: "A",
          type: "agent",
          inputs: [],
          outputs: [{ name: "x", type: "number" }],
          config: { promptRef: "p" },
        },
      ],
      wires: [],
    };
    const { machine } = compileIRToMachine(ir, { taskId: "t1" });
    const actor = createActor(machine);
    actor.start();
    const snapshot = actor.getSnapshot();
    expect((snapshot.context as MachineContext).retryCounts).toEqual({});
    actor.stop();
  });

  it("waiting region stays in waiting after portValues cleared (guard premise)", async () => {
    // Premise for the retry reset mechanism: `waiting.always` and
    // `waiting.on.PORT_WRITTEN` only advance a region to `executing` when
    // allInboundDelivered returns true. If portValues lacks a required
    // source key, the region stays in `waiting`. This is the invariant
    // that Task C5's portValues-clearing step depends on: once the runner
    // deletes upstream port keys from context.portValues (via assign), the
    // downstream region cannot auto-promote — it must wait for the upstream
    // to re-execute and re-populate those keys.
    //
    // Pipeline: A (agent, no inputs, writes x) -> B (agent, reads x).
    // A has no inbound wires so it starts in `executing` immediately.
    // We verify two halves of B's behaviour:
    //   (1) With A.x absent from portValues, B stays in `waiting`.
    //   (2) After PORT_WRITTEN A.x, B advances to `executing`.
    // Half (1) directly proves that if portValues were cleared (runner C5),
    // a B that had NOT yet advanced past `waiting` would remain in `waiting`.
    // The case "B is already in executing when portValues clear" is outside
    // compiler scope — the runner's C5 handler must also stop the executing
    // invocation; no in-machine event is needed.
    const ir: PipelineIR = {
      name: "reset-via-portvalues",
      externalInputs: [],
      stages: [
        {
          name: "A",
          type: "agent",
          inputs: [],
          outputs: [{ name: "x", type: "number" }],
          config: { promptRef: "p" },
        },
        {
          name: "B",
          type: "agent",
          inputs: [{ name: "x", type: "number" }],
          outputs: [{ name: "y", type: "string" }],
          config: { promptRef: "p" },
        },
      ],
      wires: [
        {
          from: { source: "stage", stage: "A", port: "x" },
          to: { stage: "B", port: "x" },
        },
      ],
    };
    const { machine } = compileIRToMachine(ir, { taskId: "t1" });
    const provided = machine.provide({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      actors: { execute_stage: fromCallback(() => {}) as any },
    });
    const actor = createActor(provided);
    actor.start();
    actor.send({ type: "START" });

    // (1) Before any PORT_WRITTEN: B lacks its required A.x → stays waiting.
    // A has no inbound wires (entry stage) so it advances immediately to
    // executing. That is expected and does not affect the B assertion.
    let snap = actor.getSnapshot();
    expect((snap.value as { running?: Record<string, string> }).running?.A).toBe("executing");
    expect((snap.value as { running?: Record<string, string> }).running?.B).toBe("waiting");

    // (2) Write A.x: allInboundDelivered for B becomes true → B advances.
    actor.send({ type: "PORT_WRITTEN", key: "A.x", value: 10 });
    await new Promise((r) => setTimeout(r, 0));
    snap = actor.getSnapshot();
    expect((snap.value as { running?: Record<string, string> }).running?.B).toBe("executing");

    // This test documents the guard invariant: the machine's `waiting`
    // state only exits when portValues contains every required inbound key.
    // Combined with Task C5's portValues-clearing logic, this guarantees
    // that clearing A.x from portValues (runner-side assign) leaves any
    // B that is still in `waiting` in `waiting`, without requiring any
    // explicit RESET_STAGE machine event.
    actor.stop();
  });

  it("raises RETRY_TO_STAGE on STAGE_FAILED while retryCounts < maxRetries", async () => {
    // Pipeline: A (agent) --x--> S (script, retry maxRetries=2 backToStage=A).
    // When S's executor fails with retryCounts[S]=0, the compiler's retry
    // transition should:
    //   (1) raise a RETRY_TO_STAGE event with the stage + back target,
    //   (2) target S's region back to `waiting` (not `error`).
    const ir: PipelineIR = {
      name: "retry-fire",
      externalInputs: [],
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
          outputs: [{ name: "r", type: "boolean" }],
          config: { moduleId: "m", retry: { maxRetries: 2, backToStage: "A" } },
        },
      ],
      wires: [
        { from: { source: "stage", stage: "A", port: "x" }, to: { stage: "S", port: "x" } },
      ],
    };
    const { machine } = compileIRToMachine(ir, { taskId: "t1" });

    // Capture raised events via XState's inspect hook. The retry
    // transition uses `raise(...)` which surfaces through the inspector
    // as an @xstate.event whose source is the actor's own sessionId.
    // Capture RETRY_TO_STAGE events from the inspector. `raise()` in
    // XState v5 dispatches as an internal microstep rather than a
    // top-level @xstate.event, so we match on both inspector
    // categories (microstep + event) to be robust across versions.
    const raisedEvents: Array<Record<string, unknown>> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inspector = (inspEvent: any) => {
      const ev = inspEvent.event;
      if (!ev || ev.type !== "RETRY_TO_STAGE") return;
      if (
        inspEvent.type === "@xstate.event" ||
        inspEvent.type === "@xstate.microstep"
      ) {
        // Dedupe: the same raised event can surface as both microstep
        // and event on some paths; push only once per identity.
        if (!raisedEvents.some((e) => e === ev)) {
          raisedEvents.push(ev);
        }
      }
    };

    // Provide execute_stage as a no-op callback actor so the invoke
    // doesn't throw "Actor type not found". It never resolves on its
    // own; we drive state transitions entirely via external events.
    const providedMachine = machine.provide({
      actors: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute_stage: fromCallback(() => {}) as any,
      },
    });
    const actor = createActor(providedMachine, { inspect: inspector });
    actor.start();
    actor.send({ type: "START" });

    // Drive A to done by writing its output port; wires deliver to S.
    actor.send({ type: "PORT_WRITTEN", key: "A.x", value: 10 });

    // Microtask tick so waiting.always re-evaluates and S enters executing.
    await new Promise((r) => setTimeout(r, 0));

    // Dispatch STAGE_FAILED for S; retryCounts[S] is still 0 so guard passes.
    actor.send({ type: "STAGE_FAILED", stage: "S", error: "boom" });
    await new Promise((r) => setTimeout(r, 0));

    // Primary assertion: the retry transition fired and raised the
    // correctly-shaped RETRY_TO_STAGE event. Runner's Task C5 is
    // responsible for observing this event and applying the side
    // effects (increment retryCounts, clear downstream portValues,
    // RESET_STAGE) — none of which are in scope for the compiler.
    expect(raisedEvents).toHaveLength(1);
    expect(raisedEvents[0]).toMatchObject({
      type: "RETRY_TO_STAGE",
      failedStageName: "S",
      backToStage: "A",
      reason: "executor_failed",
      retryIdx: 0,
      maxRetries: 2,
      errorMessage: "boom",
    });

    // Secondary assertion: S's region is NOT in `error`. After the
    // retry raise it momentarily enters `waiting`; because portValues
    // still carry A.x the waiting.always guard promotes it straight
    // back to `executing`. That's fine for an isolated compiler test
    // — what matters is that the error-final path was bypassed.
    const snap = actor.getSnapshot();
    const running = (snap.value as { running?: Record<string, string> }).running;
    expect(running?.S).not.toBe("error");

    actor.stop();
  });
});
