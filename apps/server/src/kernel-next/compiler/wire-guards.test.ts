// A3.1 — wire guard compile + runtime behavior (design doc §6.2).
//
// Uses the same pattern as ir-to-machine.test.ts: raw XState actor,
// no DB, no runner. Asserts that the machine:
//   - activates downstream when every inbound wire (incl. guarded) delivers
//   - leaves downstream in waiting when a guard blocks delivery
//   - enters the stage's `error` substate when no wire can deliver
//     (NO_ACTIVE_WIRE — all source ports settled, at least one dropped)

import { describe, it, expect } from "vitest";
import { createActor } from "xstate";
import { compileIRToMachine } from "./ir-to-machine.js";
import type { PipelineIR } from "../ir/schema.js";

function readRunning(
  snap: ReturnType<ReturnType<typeof createActor>["getSnapshot"]>,
): Record<string, string> | undefined {
  const value = snap.value as unknown;
  if (typeof value === "object" && value !== null && "running" in value) {
    return (value as { running: Record<string, string> }).running;
  }
  return undefined;
}


// SRC --complexity:number--> B.inp  guarded on value > 8
// SRC (no output to B yet) stays in waiting;
// when SRC writes complexity=9, guard passes, B activates.
const simpleGuardIR: PipelineIR = {
  name: "guard-simple",
  stages: [
    {
      name: "SRC",
      type: "agent",
      inputs: [],
      outputs: [{ name: "complexity", type: "number" }],
      config: { promptRef: "p" },
    },
    {
      name: "B",
      type: "agent",
      inputs: [{ name: "inp", type: "number" }],
      outputs: [{ name: "out", type: "string" }],
      config: { promptRef: "p" },
    },
  ],
  wires: [
    {
      from: { stage: "SRC", port: "complexity" },
      to: { stage: "B", port: "inp" },
      guard: "value > 8",
    },
  ],
};

describe("wire guards — activation", () => {
  it("guard passes → downstream activates", () => {
    const { machine } = compileIRToMachine(simpleGuardIR, { taskId: "t1" });
    const a = createActor(machine);
    a.start();
    a.send({ type: "START" });
    // Before port written: B waiting.
    expect(readRunning(a.getSnapshot())?.B).toBe("waiting");
    a.send({ type: "PORT_WRITTEN", key: "SRC.complexity", value: 9 });
    expect(readRunning(a.getSnapshot())?.B).toBe("executing");
  });

  it("guard fails → downstream enters error (NO_ACTIVE_WIRE)", () => {
    // Use the region's log to assert B entered `error` — parallel.onDone
    // fires synchronously after all children finalize, so getSnapshot()
    // never returns a "B is in error" frame directly. The per-region
    // `entry: log += <name>:error` is the stable signal.
    const { machine } = compileIRToMachine(simpleGuardIR, { taskId: "t1" });
    const a = createActor(machine);
    a.start();
    a.send({ type: "START" });
    a.send({ type: "PORT_WRITTEN", key: "SRC.complexity", value: 3 });
    const log = (a.getSnapshot().context as { log: string[] }).log;
    expect(log).toContain("B:error");
    // And B did NOT execute — executing entry would have logged "B:executing".
    expect(log).not.toContain("B:executing");
  });
});

describe("wire guards — multi-inbound stage (fan-in)", () => {
  // SRC1.x → TGT.p1 (no guard)
  // SRC2.x → TGT.p2 (guard: value > 0)
  // Both sources must settle; both guards must pass.
  const fanIR: PipelineIR = {
    name: "guard-fanin",
    stages: [
      {
        name: "SRC1",
        type: "agent",
        inputs: [],
        outputs: [{ name: "x", type: "number" }],
        config: { promptRef: "p" },
      },
      {
        name: "SRC2",
        type: "agent",
        inputs: [],
        outputs: [{ name: "x", type: "number" }],
        config: { promptRef: "p" },
      },
      {
        name: "TGT",
        type: "agent",
        inputs: [
          { name: "p1", type: "number" },
          { name: "p2", type: "number" },
        ],
        outputs: [{ name: "o", type: "number" }],
        config: { promptRef: "p" },
      },
    ],
    wires: [
      { from: { stage: "SRC1", port: "x" }, to: { stage: "TGT", port: "p1" } },
      {
        from: { stage: "SRC2", port: "x" },
        to: { stage: "TGT", port: "p2" },
        guard: "value > 0",
      },
    ],
  };

  it("both deliver → TGT activates", () => {
    const { machine } = compileIRToMachine(fanIR, { taskId: "t1" });
    const a = createActor(machine);
    a.start();
    a.send({ type: "START" });
    a.send({ type: "PORT_WRITTEN", key: "SRC1.x", value: 5 });
    expect(readRunning(a.getSnapshot())?.TGT).toBe("waiting");
    a.send({ type: "PORT_WRITTEN", key: "SRC2.x", value: 1 });
    expect(readRunning(a.getSnapshot())?.TGT).toBe("executing");
  });

  it("one wire's guard fails after all sources settle → TGT enters error", () => {
    const { machine } = compileIRToMachine(fanIR, { taskId: "t1" });
    const a = createActor(machine);
    a.start();
    a.send({ type: "START" });
    a.send({ type: "PORT_WRITTEN", key: "SRC1.x", value: 5 });
    a.send({ type: "PORT_WRITTEN", key: "SRC2.x", value: -1 });
    const log = (a.getSnapshot().context as { log: string[] }).log;
    expect(log).toContain("TGT:error");
    expect(log).not.toContain("TGT:executing");
  });
});

describe("wire guards — backward compat", () => {
  // Unguarded wires behave exactly like pre-A3.1: every inbound wire's
  // source must be written to activate the downstream. No regressions
  // for existing pipelines.
  const plainIR: PipelineIR = {
    name: "plain",
    stages: [
      {
        name: "SRC",
        type: "agent",
        inputs: [],
        outputs: [{ name: "x", type: "number" }],
        config: { promptRef: "p" },
      },
      {
        name: "TGT",
        type: "agent",
        inputs: [{ name: "p", type: "number" }],
        outputs: [{ name: "o", type: "number" }],
        config: { promptRef: "p" },
      },
    ],
    wires: [{ from: { stage: "SRC", port: "x" }, to: { stage: "TGT", port: "p" } }],
  };

  it("TGT waits until SRC writes (no guard, no early-fail)", () => {
    const { machine } = compileIRToMachine(plainIR, { taskId: "t1" });
    const a = createActor(machine);
    a.start();
    a.send({ type: "START" });
    expect(readRunning(a.getSnapshot())?.TGT).toBe("waiting");
    a.send({ type: "PORT_WRITTEN", key: "SRC.x", value: 0 }); // 0 is falsy but no guard
    expect(readRunning(a.getSnapshot())?.TGT).toBe("executing");
  });
});
