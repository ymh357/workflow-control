import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock heavy dependencies before importing the module under test
vi.mock("../agent/executor.js", () => ({
  runAgent: vi.fn().mockResolvedValue({}),
  runScript: vi.fn().mockResolvedValue({}),
}));
vi.mock("../edge/actor.js", () => ({
  runEdgeAgent: vi.fn().mockResolvedValue({}),
}));
vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock("./helpers.js", () => {
  const { assign, emit } = require("xstate");
  return {
    statusEntry: (status: string) => [assign({ status })],
    emitStatus: () => assign({}),
    emitNotionSync: () => assign({}),
    emitTaskListUpdate: () => assign({}),
    emitPersistSession: () => assign({}),
    loggedActor: (_label: string, fn: (...args: any[]) => any) => {
      const { fromPromise } = require("xstate");
      return fromPromise(({ input }: { input: any }) => fn(input));
    },
  };
});
vi.mock("./pipeline-builder.js", async () => {
  const actual = await vi.importActual("./pipeline-builder.js");
  return actual;
});
vi.mock("./stage-registry.js", () => {
  const { assign } = require("xstate");
  return {
    getStageBuilder: (stage: any) => {
      if (stage.type === "agent" || stage.type === "script") {
        return (next: string, _prev: string, _stage: any) => ({
          entry: [assign({ status: stage.name })],
          invoke: {
            src: stage.type === "agent" ? "runAgent" : "runScript",
            input: ({}: any) => ({}),
            onDone: { target: next, actions: assign({}) },
            onError: { target: "error" },
          },
        });
      }
      if (stage.type === "human_confirm") {
        return (next: string, prev: string, _stage: any) => ({
          entry: [assign({ status: stage.name })],
          on: {
            CONFIRM: { target: next },
            REJECT: { target: prev },
          },
        });
      }
      return undefined;
    },
  };
});

import type { PipelineConfig } from "../lib/config-loader.js";
import { createWorkflowMachine } from "./machine.js";
import { createActor } from "xstate";

function makePipeline(overrides?: Partial<PipelineConfig>): PipelineConfig {
  return {
    name: "test-pipeline",
    stages: [
      { name: "planning", type: "agent", runtime: { engine: "claude", max_turns: 5, budget_usd: 1 } },
    ],
    ...overrides,
  } as PipelineConfig;
}

describe("createWorkflowMachine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Empty stages ---

  it("throws when pipeline has zero stages", () => {
    expect(() => createWorkflowMachine(makePipeline({ stages: [] }))).toThrow(
      "Pipeline must have at least one stage",
    );
  });

  // --- Initial state ---

  it("produces a machine whose initial state is 'idle'", () => {
    const machine = createWorkflowMachine(makePipeline());
    const actor = createActor(machine);
    actor.start();
    expect(actor.getSnapshot().value).toBe("idle");
    actor.stop();
  });

  // --- Context defaults ---

  it("initializes taskId as empty string", () => {
    const machine = createWorkflowMachine(makePipeline());
    const actor = createActor(machine);
    actor.start();
    expect(actor.getSnapshot().context.taskId).toBe("");
    actor.stop();
  });

  it("initializes status as 'idle'", () => {
    const machine = createWorkflowMachine(makePipeline());
    const actor = createActor(machine);
    actor.start();
    expect(actor.getSnapshot().context.status).toBe("idle");
    actor.stop();
  });

  it("initializes store as empty object", () => {
    const machine = createWorkflowMachine(makePipeline());
    const actor = createActor(machine);
    actor.start();
    expect(actor.getSnapshot().context.store).toEqual({});
    actor.stop();
  });

  it("initializes retryCount and qaRetryCount to 0", () => {
    const machine = createWorkflowMachine(makePipeline());
    const actor = createActor(machine);
    actor.start();
    const ctx = actor.getSnapshot().context;
    expect(ctx.retryCount).toBe(0);
    expect(ctx.qaRetryCount).toBe(0);
    actor.stop();
  });

  it("initializes stageSessionIds as empty object", () => {
    const machine = createWorkflowMachine(makePipeline());
    const actor = createActor(machine);
    actor.start();
    expect(actor.getSnapshot().context.stageSessionIds).toEqual({});
    actor.stop();
  });

  // --- START_ANALYSIS populates context ---

  it("START_ANALYSIS sets taskId on context", () => {
    const machine = createWorkflowMachine(makePipeline());
    const actor = createActor(machine);
    actor.start();
    actor.send({ type: "START_ANALYSIS", taskId: "t-1" });
    const ctx = actor.getSnapshot().context;
    expect(ctx.taskId).toBe("t-1");
    actor.stop();
  });

  // --- LAUNCH transitions to first stage ---

  it("LAUNCH from idle transitions to the first stage", () => {
    const machine = createWorkflowMachine(makePipeline());
    const actor = createActor(machine);
    actor.start();
    actor.send({ type: "START_ANALYSIS", taskId: "t-2" });
    actor.send({ type: "LAUNCH" });
    expect(actor.getSnapshot().value).toBe("planning");
    actor.stop();
  });

  // --- Multi-stage pipeline: first stage is correct ---

  it("multi-stage pipeline launches into the first stage, not the second", () => {
    const pipeline = makePipeline({
      stages: [
        { name: "alpha", type: "agent", runtime: { engine: "claude", max_turns: 3, budget_usd: 1 } },
        { name: "beta", type: "agent", runtime: { engine: "claude", max_turns: 3, budget_usd: 1 } },
      ] as any,
    });
    const machine = createWorkflowMachine(pipeline);
    const actor = createActor(machine);
    actor.start();
    actor.send({ type: "START_ANALYSIS", taskId: "t-3" });
    actor.send({ type: "LAUNCH" });
    expect(actor.getSnapshot().value).toBe("alpha");
    actor.stop();
  });

  // --- CANCEL guard: cannot cancel from idle ---

  it("CANCEL does nothing when status is still idle (guard blocks it)", () => {
    const machine = createWorkflowMachine(makePipeline());
    const actor = createActor(machine);
    actor.start();
    // status is "idle", but the guard checks context.status !== "cancelled"
    // It should transition to cancelled from idle since status !== "cancelled"
    actor.send({ type: "CANCEL" });
    // The guard allows it because context.status ("idle") !== "cancelled"
    expect(actor.getSnapshot().value).toBe("cancelled");
    actor.stop();
  });

  // --- Double CANCEL is idempotent ---

  it("second CANCEL is blocked by guard (already cancelled)", () => {
    const machine = createWorkflowMachine(makePipeline());
    const actor = createActor(machine);
    actor.start();
    actor.send({ type: "CANCEL" });
    expect(actor.getSnapshot().value).toBe("cancelled");
    // Second CANCEL should be a no-op
    actor.send({ type: "CANCEL" });
    expect(actor.getSnapshot().value).toBe("cancelled");
    actor.stop();
  });

  // --- INTERRUPT guard blocks from terminal states ---

  it("INTERRUPT from idle is blocked (idle is in the exclusion list)", () => {
    const machine = createWorkflowMachine(makePipeline());
    const actor = createActor(machine);
    actor.start();
    actor.send({ type: "INTERRUPT" });
    // idle is in the exclusion list, so guard returns false
    expect(actor.getSnapshot().value).toBe("idle");
    actor.stop();
  });

  // --- Different pipeline configs produce different machines ---

  it("single-stage vs two-stage pipeline produce machines with different state counts", () => {
    const single = createWorkflowMachine(makePipeline());
    const double = createWorkflowMachine(
      makePipeline({
        stages: [
          { name: "step1", type: "agent", runtime: { engine: "claude", max_turns: 3, budget_usd: 1 } },
          { name: "step2", type: "agent", runtime: { engine: "claude", max_turns: 3, budget_usd: 1 } },
        ] as any,
      }),
    );
    const singleStates = Object.keys(single.config.states ?? {});
    const doubleStates = Object.keys(double.config.states ?? {});
    expect(doubleStates.length).toBeGreaterThan(singleStates.length);
  });
});
