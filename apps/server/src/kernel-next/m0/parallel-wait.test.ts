// M0: XState v5 parallel + event-driven guard re-eval feasibility spike.
//
// Goal: prove that in a parallel machine with N stages, each stage's "waiting"
// substate can correctly block until an external PORT_WRITTEN event makes its
// `allInputsReady` guard return true — and no stage wakes up prematurely.
//
// Model (matches real kernel-next runtime):
//   1. Stage waiting -> ready fires when allInputsReady(ctx, stage) is true.
//   2. Stage ready records a log line and transitions to executing.
//   3. Stage executing does NOT write outputs directly; it emits a
//      STAGE_FINISHED event for test code to observe. The "port-runtime"
//      (in this test: the test itself) then sends PORT_WRITTEN events to
//      populate ctx.portValues. This mirrors the real runtime: executor
//      returns -> port-runtime inserts port_values row -> dispatch
//      PORT_WRITTEN to machine.
//
// If this file passes, §6.1 of docs/kernel-next-design.md is viable and M1
// can start. If this fails, fork to actor-based (see §10 M0 fail branch).

import { describe, it, expect } from "vitest";
import { createMachine, createActor, assign } from "xstate";

interface Ctx {
  portValues: Record<string, unknown>;
  log: string[];
}

type Ev =
  | { type: "START" }
  | { type: "PORT_WRITTEN"; key: string; value: unknown };

const inboundPorts: Record<string, string[]> = {
  A: [],
  B: ["A.x"],
  C: ["A.x"],
  D: ["B.y", "C.z"],
};

function buildStageStates(stage: string) {
  const deps = inboundPorts[stage]!;
  return {
    initial: "waiting",
    states: {
      waiting: {
        on: {
          PORT_WRITTEN: [
            {
              target: "executing",
              guard: ({ context }: { context: Ctx }) =>
                deps.every((k) => k in context.portValues),
            },
          ],
        },
        // Entry: if deps already satisfied (entry stage with no deps, or late
        // stage whose deps happened to be written before entry), advance.
        always: [
          {
            target: "executing",
            guard: ({ context }: { context: Ctx }) =>
              deps.every((k) => k in context.portValues),
          },
        ],
      },
      executing: {
        entry: assign({
          log: ({ context }) => [...context.log, `${stage}:executing`],
        }),
        // Stay here until the test externally sends PORT_WRITTEN for this
        // stage's outputs (which, in the real runtime, would be done by the
        // port-runtime after the executor resolves). When every output port
        // of this stage is present, transition to done.
        always: [
          {
            target: "done",
            guard: ({ context }: { context: Ctx }) =>
              stageOutputPorts[stage]!.every((k) => k in context.portValues),
          },
        ],
        on: {
          PORT_WRITTEN: [
            {
              target: "done",
              guard: ({ context }: { context: Ctx }) =>
                stageOutputPorts[stage]!.every((k) => k in context.portValues),
            },
          ],
        },
      },
      done: { type: "final" },
    },
  } as const;
}

const stageOutputPorts: Record<string, string[]> = {
  A: ["A.x"],
  B: ["B.y"],
  C: ["C.z"],
  D: ["D.final"],
};

const diamond = createMachine({
  id: "diamond",
  types: {} as { context: Ctx; events: Ev },
  context: { portValues: {}, log: [] },
  initial: "idle",
  on: {
    // Root-level PORT_WRITTEN handler updates context; child states still
    // receive the event for their own guard re-eval.
    PORT_WRITTEN: {
      actions: assign({
        portValues: ({ context, event }) => ({
          ...context.portValues,
          [event.key]: event.value,
        }),
      }),
    },
  },
  states: {
    idle: { on: { START: "running" } },
    running: {
      type: "parallel",
      states: {
        A: buildStageStates("A") as never,
        B: buildStageStates("B") as never,
        C: buildStageStates("C") as never,
        D: buildStageStates("D") as never,
      },
      onDone: { target: "completed" },
    },
    completed: { type: "final" },
  },
});

describe("M0: XState parallel + event-driven guard re-eval", () => {
  it("entry stage enters executing; downstream stages wait for PORT_WRITTEN", () => {
    const actor = createActor(diamond);
    actor.start();
    actor.send({ type: "START" });

    // Right after START, A has no inbound deps -> its waiting.always fires
    // immediately -> A.executing. B/C have dep on A.x which is not yet
    // present in portValues -> they stay in waiting. D depends on B.y+C.z,
    // also waiting.
    const s1 = actor.getSnapshot();
    const r1 = (s1.value as { running: Record<string, string> }).running;
    expect(r1.A).toBe("executing");
    expect(r1.B).toBe("waiting");
    expect(r1.C).toBe("waiting");
    expect(r1.D).toBe("waiting");

    // Simulate A's executor finishing: port-runtime writes A.x.
    actor.send({ type: "PORT_WRITTEN", key: "A.x", value: 42 });

    // A should be done (its only output port A.x is now in ctx); B and C
    // should have advanced from waiting to executing (their dep A.x satisfied).
    // D still waiting.
    const s2 = actor.getSnapshot();
    const r2 = (s2.value as { running: Record<string, string> }).running;
    expect(r2.A).toBe("done");
    expect(r2.B).toBe("executing");
    expect(r2.C).toBe("executing");
    expect(r2.D).toBe("waiting");

    // Simulate B finishing.
    actor.send({ type: "PORT_WRITTEN", key: "B.y", value: "from-B" });
    const s3 = actor.getSnapshot();
    const r3 = (s3.value as { running: Record<string, string> }).running;
    expect(r3.B).toBe("done");
    expect(r3.C).toBe("executing"); // C still mid-flight
    expect(r3.D).toBe("waiting");   // D needs C.z too

    // Simulate C finishing.
    actor.send({ type: "PORT_WRITTEN", key: "C.z", value: "from-C" });
    const s4 = actor.getSnapshot();
    const r4 = (s4.value as { running: Record<string, string> } | string).toString
      ? (s4.value as { running: Record<string, string> }).running
      : undefined;
    // Once C is done, D's deps are satisfied, D advances to executing.
    expect(r4?.C).toBe("done");
    expect(r4?.D).toBe("executing");

    // Finish D.
    actor.send({ type: "PORT_WRITTEN", key: "D.final", value: "done" });
    const s5 = actor.getSnapshot();
    // All stages done -> parallel onDone -> completed.
    expect(s5.value).toBe("completed");

    // Execution order: A before B/C before D.
    const idx = (s: string) => s5.context.log.indexOf(`${s}:executing`);
    expect(idx("A")).toBeGreaterThanOrEqual(0);
    expect(idx("A")).toBeLessThan(idx("B"));
    expect(idx("A")).toBeLessThan(idx("C"));
    expect(idx("B")).toBeLessThan(idx("D"));
    expect(idx("C")).toBeLessThan(idx("D"));
  });

  it("PORT_WRITTEN for unrelated port does not wake a waiting stage", () => {
    const actor = createActor(diamond);
    actor.start();
    actor.send({ type: "START" });

    // A is now executing, B/C waiting.
    actor.send({ type: "PORT_WRITTEN", key: "ghost.port", value: "noise" });
    const s = actor.getSnapshot();
    const r = (s.value as { running: Record<string, string> }).running;
    expect(r.A).toBe("executing"); // still executing — A.x not written
    expect(r.B).toBe("waiting");
    expect(r.C).toBe("waiting");
    expect(r.D).toBe("waiting");
  });

  it("partial dep: D waits until both B.y and C.z are present", () => {
    const actor = createActor(diamond);
    actor.start();
    actor.send({ type: "START" });
    actor.send({ type: "PORT_WRITTEN", key: "A.x", value: 1 });
    actor.send({ type: "PORT_WRITTEN", key: "B.y", value: "b" });
    // Only B.y set; D has two deps (B.y, C.z), only one satisfied -> still waiting.
    const s = actor.getSnapshot();
    const r = (s.value as { running: Record<string, string> }).running;
    expect(r.D).toBe("waiting");

    actor.send({ type: "PORT_WRITTEN", key: "C.z", value: "c" });
    const s2 = actor.getSnapshot();
    const r2 = (s2.value as { running: Record<string, string> }).running;
    expect(r2.D).toBe("executing");
  });
});
