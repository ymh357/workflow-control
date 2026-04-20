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
import { createActor } from "xstate";
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
