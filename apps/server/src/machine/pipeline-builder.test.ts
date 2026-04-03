import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../lib/config-loader.js", () => ({
  getNestedValue: vi.fn(),
  loadSystemSettings: vi.fn(() => ({})),
  isParallelGroup: (entry: any) => entry && typeof entry === "object" && "parallel" in entry,
  flattenStages: (entries: any[]) => {
    const result: any[] = [];
    for (const e of entries) {
      if (e && typeof e === "object" && "parallel" in e) {
        result.push(...e.parallel.stages);
      } else {
        result.push(e);
      }
    }
    return result;
  },
}));
vi.mock("./state-builders.js", () => ({
  buildAgentState: vi.fn(() => ({ type: "agent-state" })),
  buildScriptState: vi.fn(() => ({ type: "script-state" })),
  buildHumanGateState: vi.fn(() => ({ type: "human-gate-state" })),
  buildParallelGroupState: vi.fn(() => ({ type: "parallel-state" })),
  buildConditionState: vi.fn(() => ({ type: "condition-state" })),
  buildPipelineCallState: vi.fn(() => ({ type: "pipeline-call-state" })),
  buildForeachState: vi.fn(() => ({ type: "foreach-state" })),
}));

import { buildPipelineStates, derivePipelineLists } from "./pipeline-builder.js";
import type { PipelineConfig } from "../lib/config-loader.js";

function makePipeline(stages: PipelineConfig["stages"], overrides?: Partial<PipelineConfig>): PipelineConfig {
  return { name: "test-pipeline", stages, ...overrides };
}

describe("buildPipelineStates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds states for a single agent stage", () => {
    const pipeline = makePipeline([
      { name: "analyze", type: "agent", runtime: { engine: "llm", system_prompt: "do stuff" } },
    ]);
    const states = buildPipelineStates(pipeline);
    expect(states).toHaveProperty("analyze");
    expect(states.analyze).toEqual({ type: "agent-state" });
  });

  it("builds states for a single script stage", () => {
    const pipeline = makePipeline([
      { name: "setup", type: "script", runtime: { engine: "script", script_id: "init" } },
    ]);
    const states = buildPipelineStates(pipeline);
    expect(states).toHaveProperty("setup");
    expect(states.setup).toEqual({ type: "script-state" });
  });

  it("builds states for a human_confirm stage", () => {
    const pipeline = makePipeline([
      { name: "work", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      { name: "approval", type: "human_confirm", runtime: { engine: "human_gate" } },
    ]);
    const states = buildPipelineStates(pipeline);
    expect(states).toHaveProperty("approval");
    expect(states.approval).toEqual({ type: "human-gate-state" });
  });

  it("builds multiple stages in order with correct next targets", async () => {
    const { buildAgentState, buildScriptState, buildHumanGateState } = await import("./state-builders.js");
    const pipeline = makePipeline([
      { name: "init", type: "script", runtime: { engine: "script", script_id: "s1" } },
      { name: "work", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      { name: "gate", type: "human_confirm", runtime: { engine: "human_gate" } },
    ]);
    buildPipelineStates(pipeline);

    // init -> next is "work"
    expect(buildScriptState).toHaveBeenCalledWith("work", "error", expect.objectContaining({ name: "init" }), expect.objectContaining({ childToGroup: expect.any(Map) }));
    // work -> next is "gate"
    expect(buildAgentState).toHaveBeenCalledWith("gate", "init", expect.objectContaining({ name: "work" }), expect.objectContaining({ childToGroup: expect.any(Map) }));
    // gate -> next is "completed"
    expect(buildHumanGateState).toHaveBeenCalledWith("completed", "work", expect.objectContaining({ name: "gate" }), expect.any(Map));
  });

  it("last stage targets 'completed'", async () => {
    const { buildAgentState } = await import("./state-builders.js");
    const pipeline = makePipeline([
      { name: "only", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
    ]);
    buildPipelineStates(pipeline);
    expect(buildAgentState).toHaveBeenCalledWith("completed", "error", expect.anything(), expect.objectContaining({ childToGroup: expect.any(Map) }));
  });

  it("prevAgentTarget skips human_confirm stages", async () => {
    const { buildAgentState } = await import("./state-builders.js");
    const pipeline = makePipeline([
      { name: "code", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      { name: "gate", type: "human_confirm", runtime: { engine: "human_gate" } },
      { name: "review", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
    ]);
    buildPipelineStates(pipeline);
    // review's prevAgentState should be "code" (skipping the human_confirm "gate")
    const reviewCall = (buildAgentState as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[2] as { name: string }).name === "review"
    );
    expect(reviewCall![1]).toBe("code");
  });

  it("inherits pipeline-level default_execution_mode for agent stages", async () => {
    const { buildAgentState } = await import("./state-builders.js");
    const pipeline = makePipeline(
      [{ name: "work", type: "agent", runtime: { engine: "llm", system_prompt: "x" } }],
      { default_execution_mode: "edge" },
    );
    buildPipelineStates(pipeline);
    const stageArg = (buildAgentState as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(stageArg.execution_mode).toBe("edge");
  });

  it("does not inherit default_execution_mode for non-agent stages", () => {
    const pipeline = makePipeline(
      [{ name: "s1", type: "script", runtime: { engine: "script", script_id: "x" } }],
      { default_execution_mode: "edge" },
    );
    // script with edge execution_mode should fail validation
    // but since the stage has no execution_mode set and it's not agent, it won't inherit
    const states = buildPipelineStates(pipeline);
    expect(states).toHaveProperty("s1");
  });

  it("does not override explicit stage execution_mode with pipeline default", async () => {
    const { buildAgentState } = await import("./state-builders.js");
    const pipeline = makePipeline(
      [{ name: "work", type: "agent", execution_mode: "auto", runtime: { engine: "llm", system_prompt: "x" } }],
      { default_execution_mode: "edge" },
    );
    buildPipelineStates(pipeline);
    const stageArg = (buildAgentState as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(stageArg.execution_mode).toBe("auto");
  });

  // --- Validation errors ---

  it("throws on invalid on_approve_to reference", () => {
    const pipeline = makePipeline([
      { name: "gate", type: "human_confirm", runtime: { engine: "human_gate", on_approve_to: "nonexistent" } },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/on_approve_to references non-existent state "nonexistent"/);
  });

  it("throws on invalid on_reject_to reference", () => {
    const pipeline = makePipeline([
      { name: "gate", type: "human_confirm", runtime: { engine: "human_gate", on_reject_to: "nowhere" } },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/on_reject_to references non-existent state "nowhere"/);
  });

  it("throws on invalid retry.back_to reference", () => {
    const pipeline = makePipeline([
      { name: "review", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "ghost" } } },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/retry.back_to references non-existent state "ghost"/);
  });

  it("allows references to built-in states (completed, error, blocked)", () => {
    const pipeline = makePipeline([
      { name: "work", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      { name: "gate", type: "human_confirm", runtime: { engine: "human_gate", on_approve_to: "completed", on_reject_to: "error" } },
    ]);
    expect(() => buildPipelineStates(pipeline)).not.toThrow();
  });

  it("allows references to other stage names", () => {
    const pipeline = makePipeline([
      { name: "code", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      { name: "review", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "code" } } },
    ]);
    expect(() => buildPipelineStates(pipeline)).not.toThrow();
  });

  it("throws when execution_mode is set on non-agent stage", () => {
    const pipeline = makePipeline([
      { name: "s1", type: "script", execution_mode: "edge" as any, runtime: { engine: "script", script_id: "x" } },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/execution_mode "edge" but is type "script"/);
  });

  it("throws when no builder is found for unknown engine", () => {
    const pipeline = makePipeline([
      { name: "mystery", type: "agent", runtime: { engine: "unknown" as any, system_prompt: "x" } },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/no builder found for type "agent"/);
  });

  it("aggregates multiple validation errors into one throw", () => {
    const pipeline = makePipeline([
      { name: "g1", type: "human_confirm", runtime: { engine: "human_gate", on_approve_to: "nope1" } },
      { name: "g2", type: "human_confirm", runtime: { engine: "human_gate", on_reject_to: "nope2" } },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/Pipeline validation failed/);
    try {
      buildPipelineStates(pipeline);
    } catch (e: any) {
      expect(e.message).toContain("nope1");
      expect(e.message).toContain("nope2");
    }
  });
});

describe("derivePipelineLists", () => {
  it("classifies agent stages as retryable and resumable", () => {
    const pipeline = makePipeline([
      { name: "code", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
    ]);
    const { retryable, resumable } = derivePipelineLists(pipeline);
    expect(retryable).toContain("code");
    expect(resumable).toContain("code");
  });

  it("classifies script stages as retryable and resumable", () => {
    const pipeline = makePipeline([
      { name: "setup", type: "script", runtime: { engine: "script", script_id: "x" } },
    ]);
    const { retryable, resumable } = derivePipelineLists(pipeline);
    expect(retryable).toContain("setup");
    expect(resumable).toContain("setup");
  });

  it("classifies human_confirm stages as resumable only (not retryable)", () => {
    const pipeline = makePipeline([
      { name: "gate", type: "human_confirm", runtime: { engine: "human_gate" } },
    ]);
    const { retryable, resumable } = derivePipelineLists(pipeline);
    expect(retryable).not.toContain("gate");
    expect(resumable).toContain("gate");
  });

  it("handles mixed pipeline with all stage types", () => {
    const pipeline = makePipeline([
      { name: "init", type: "script", runtime: { engine: "script", script_id: "s" } },
      { name: "code", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      { name: "gate", type: "human_confirm", runtime: { engine: "human_gate" } },
      { name: "review", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
    ]);
    const { retryable, resumable } = derivePipelineLists(pipeline);
    expect(retryable).toEqual(["init", "code", "review"]);
    expect(resumable).toEqual(["init", "code", "gate", "review"]);
  });

  it("returns empty lists for empty pipeline", () => {
    const pipeline = makePipeline([]);
    const { retryable, resumable } = derivePipelineLists(pipeline);
    expect(retryable).toEqual([]);
    expect(resumable).toEqual([]);
  });

  it("includes parallel group name and children in retryable/resumable", () => {
    const pipeline = makePipeline([
      {
        parallel: {
          name: "par1",
          stages: [
            { name: "a1", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
            { name: "a2", type: "agent", runtime: { engine: "llm", system_prompt: "y" } },
          ],
        },
      } as any,
    ]);
    const { retryable, resumable } = derivePipelineLists(pipeline);
    expect(retryable).toContain("par1");
    expect(retryable).toContain("a1");
    expect(retryable).toContain("a2");
    expect(resumable).toContain("par1");
    expect(resumable).toContain("a1");
    expect(resumable).toContain("a2");
  });

  it("does not include human_confirm children in retryable from parallel group", () => {
    // Note: human_confirm inside parallel group is rejected by validation,
    // but derivePipelineLists itself only includes agent/script children.
    const pipeline = makePipeline([
      {
        parallel: {
          name: "par1",
          stages: [
            { name: "a1", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
            { name: "hc", type: "human_confirm", runtime: { engine: "human_gate" } },
          ],
        },
      } as any,
    ]);
    const { retryable, resumable } = derivePipelineLists(pipeline);
    expect(retryable).toContain("par1");
    expect(retryable).toContain("a1");
    expect(retryable).not.toContain("hc");
    expect(resumable).not.toContain("hc");
  });
});

describe("buildPipelineStates — new stage types", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds states for a condition stage", () => {
    const pipeline = makePipeline([
      { name: "work", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      {
        name: "route",
        type: "condition",
        runtime: {
          engine: "condition",
          branches: [
            { when: "store.score > 80", to: "work" },
            { default: true, to: "completed" },
          ],
        },
      },
    ]);
    const states = buildPipelineStates(pipeline);
    expect(states).toHaveProperty("route");
    expect(states.route).toEqual({ type: "condition-state" });
  });

  it("builds states for a pipeline call stage", () => {
    const pipeline = makePipeline([
      {
        name: "sub-call",
        type: "pipeline",
        runtime: { engine: "pipeline", pipeline_name: "child-pipeline" },
      },
    ]);
    const states = buildPipelineStates(pipeline);
    expect(states).toHaveProperty("sub-call");
    expect(states["sub-call"]).toEqual({ type: "pipeline-call-state" });
  });

  it("builds states for a foreach stage", () => {
    const pipeline = makePipeline([
      {
        name: "iterate",
        type: "foreach",
        runtime: { engine: "foreach", items: "store.list", item_var: "item", pipeline_name: "child" },
      },
    ]);
    const states = buildPipelineStates(pipeline);
    expect(states).toHaveProperty("iterate");
    expect(states.iterate).toEqual({ type: "foreach-state" });
  });

  it("throws when condition has no default branch", () => {
    const pipeline = makePipeline([
      {
        name: "route",
        type: "condition",
        runtime: {
          engine: "condition",
          branches: [
            { when: "store.x == true", to: "completed" },
            { when: "store.x == false", to: "error" },
          ],
        },
      },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/condition must have exactly 1 default branch/);
  });

  it("throws when condition has no non-default branch", () => {
    const pipeline = makePipeline([
      {
        name: "route",
        type: "condition",
        runtime: {
          engine: "condition",
          branches: [
            { default: true, to: "completed" },
            { default: true, to: "error" },
          ],
        },
      },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/at least 1 non-default branch/);
  });

  it("throws when condition branch.to references non-existent state", () => {
    const pipeline = makePipeline([
      {
        name: "route",
        type: "condition",
        runtime: {
          engine: "condition",
          branches: [
            { when: "store.x == true", to: "ghost" },
            { default: true, to: "completed" },
          ],
        },
      },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/branch\.to "ghost" references non-existent state/);
  });

  it("throws when pipeline stage has no pipeline_name", () => {
    const pipeline = makePipeline([
      { name: "sub", type: "pipeline", runtime: { engine: "pipeline" } as any },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/pipeline stage must have runtime.pipeline_name/);
  });

  it("throws when foreach stage has no items", () => {
    const pipeline = makePipeline([
      { name: "loop", type: "foreach", runtime: { engine: "foreach", pipeline_name: "x", item_var: "item" } as any },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/foreach stage must have runtime.items/);
  });

  it("prevAgentTarget skips condition/pipeline/foreach stages", async () => {
    const { buildAgentState } = await import("./state-builders.js");
    const pipeline = makePipeline([
      { name: "code", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      {
        name: "route",
        type: "condition",
        runtime: { engine: "condition", branches: [{ when: "store.x", to: "review" }, { default: true, to: "review" }] },
      },
      { name: "review", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
    ]);
    buildPipelineStates(pipeline);
    const reviewCall = (buildAgentState as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[2] as { name: string }).name === "review"
    );
    // review's prevAgentTarget should be "code" (skipping "route" condition)
    expect(reviewCall![1]).toBe("code");
  });
});

describe("derivePipelineLists — new stage types", () => {
  it("classifies pipeline stages as retryable and resumable", () => {
    const pipeline = makePipeline([
      { name: "sub", type: "pipeline", runtime: { engine: "pipeline", pipeline_name: "child" } },
    ]);
    const { retryable, resumable } = derivePipelineLists(pipeline);
    expect(retryable).toContain("sub");
    expect(resumable).toContain("sub");
  });

  it("classifies foreach stages as retryable and resumable", () => {
    const pipeline = makePipeline([
      { name: "loop", type: "foreach", runtime: { engine: "foreach", items: "store.list", item_var: "item", pipeline_name: "child" } },
    ]);
    const { retryable, resumable } = derivePipelineLists(pipeline);
    expect(retryable).toContain("loop");
    expect(resumable).toContain("loop");
  });

  it("does not classify condition stages as retryable or resumable", () => {
    const pipeline = makePipeline([
      {
        name: "route",
        type: "condition",
        runtime: { engine: "condition", branches: [{ when: "store.x", to: "completed" }, { default: true, to: "error" }] },
      },
    ]);
    const { retryable, resumable } = derivePipelineLists(pipeline);
    expect(retryable).not.toContain("route");
    expect(resumable).not.toContain("route");
  });
});

describe("buildPipelineStates — condition convergence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("condition branch targets get nextTarget overridden to convergence point", async () => {
    const { buildAgentState } = await import("./state-builders.js");
    const pipeline = makePipeline([
      { name: "analyze", type: "agent", runtime: { engine: "llm", system_prompt: "x", writes: ["analysis"] } },
      {
        name: "route", type: "condition",
        runtime: { engine: "condition", branches: [{ when: "store.analysis.passed == true", to: "fast-track" }, { default: true, to: "fallback" }] },
      },
      { name: "fast-track", type: "agent", runtime: { engine: "llm", system_prompt: "fast" } },
      { name: "fallback", type: "agent", runtime: { engine: "llm", system_prompt: "fall" } },
      { name: "final", type: "agent", runtime: { engine: "llm", system_prompt: "fin" } },
    ]);
    buildPipelineStates(pipeline);

    // fast-track and fallback should both have nextTarget = "final" (convergence point)
    const fastTrackCall = (buildAgentState as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[2] as { name: string }).name === "fast-track"
    );
    const fallbackCall = (buildAgentState as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[2] as { name: string }).name === "fallback"
    );
    expect(fastTrackCall![0]).toBe("final");
    expect(fallbackCall![0]).toBe("final");
  });

  it("two conditions in series both converge correctly", async () => {
    const { buildAgentState } = await import("./state-builders.js");
    const pipeline = makePipeline([
      {
        name: "cond1", type: "condition",
        runtime: { engine: "condition", branches: [{ when: "store.a == true", to: "branchA" }, { default: true, to: "branchB" }] },
      },
      { name: "branchA", type: "agent", runtime: { engine: "llm", system_prompt: "a" } },
      { name: "branchB", type: "agent", runtime: { engine: "llm", system_prompt: "b" } },
      {
        name: "cond2", type: "condition",
        runtime: { engine: "condition", branches: [{ when: "store.x == true", to: "branchX" }, { default: true, to: "branchY" }] },
      },
      { name: "branchX", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      { name: "branchY", type: "agent", runtime: { engine: "llm", system_prompt: "y" } },
      { name: "end", type: "agent", runtime: { engine: "llm", system_prompt: "end" } },
    ]);
    buildPipelineStates(pipeline);

    // cond1's branches A,B should converge to cond2
    const branchACall = (buildAgentState as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[2] as { name: string }).name === "branchA"
    );
    const branchBCall = (buildAgentState as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[2] as { name: string }).name === "branchB"
    );
    expect(branchACall![0]).toBe("cond2");
    expect(branchBCall![0]).toBe("cond2");

    // cond2's branches X,Y should converge to "end"
    const branchXCall = (buildAgentState as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[2] as { name: string }).name === "branchX"
    );
    const branchYCall = (buildAgentState as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[2] as { name: string }).name === "branchY"
    );
    expect(branchXCall![0]).toBe("end");
    expect(branchYCall![0]).toBe("end");
  });

  it("branch target that back-jumps to before condition does not participate in convergence", async () => {
    const { buildAgentState } = await import("./state-builders.js");
    const pipeline = makePipeline([
      { name: "start", type: "agent", runtime: { engine: "llm", system_prompt: "s" } },
      {
        name: "cond", type: "condition",
        runtime: { engine: "condition", branches: [
          { when: "store.retry == true", to: "start" }, // back-jump
          { default: true, to: "forward" },
        ] },
      },
      { name: "forward", type: "agent", runtime: { engine: "llm", system_prompt: "f" } },
      { name: "end", type: "agent", runtime: { engine: "llm", system_prompt: "e" } },
    ]);
    buildPipelineStates(pipeline);

    // "start" should NOT be overridden — its nextTarget should remain "cond" (linear next)
    const startCall = (buildAgentState as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[2] as { name: string }).name === "start"
    );
    expect(startCall![0]).toBe("cond");

    // "forward" is the only downstream target, convergence point = "end"
    const forwardCall = (buildAgentState as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[2] as { name: string }).name === "forward"
    );
    expect(forwardCall![0]).toBe("end");
  });

  it("all branch targets pointing to completed/error produce no convergence override", async () => {
    const { buildConditionState } = await import("./state-builders.js");
    const pipeline = makePipeline([
      { name: "work", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      {
        name: "cond", type: "condition",
        runtime: { engine: "condition", branches: [
          { when: "store.ok == true", to: "completed" },
          { default: true, to: "error" },
        ] },
      },
    ]);
    buildPipelineStates(pipeline);

    // Condition itself should be built; no convergence overrides to check
    expect(buildConditionState).toHaveBeenCalled();
  });

  it("explicit converge_to overrides non-default branch target to converge_to stage", async () => {
    const { buildAgentState } = await import("./state-builders.js");
    // Simulates web3-tech-research pattern: optional competitorBenchmark + required outputPlanning
    const pipeline = makePipeline([
      { name: "analyze", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      {
        name: "route", type: "condition",
        runtime: {
          engine: "condition",
          converge_to: "outputPlanning",
          branches: [
            { when: "store.hasCompetitors == true", to: "competitorBenchmark" },
            { default: true, to: "outputPlanning" },
          ],
        },
      },
      { name: "competitorBenchmark", type: "agent", runtime: { engine: "llm", system_prompt: "bench" } },
      { name: "outputPlanning", type: "agent", runtime: { engine: "llm", system_prompt: "plan" } },
      { name: "gate", type: "human_confirm", runtime: { engine: "human_gate" } },
    ]);
    buildPipelineStates(pipeline);

    // competitorBenchmark should converge to outputPlanning (not skip to gate)
    const benchmarkCall = (buildAgentState as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[2] as { name: string }).name === "competitorBenchmark"
    );
    expect(benchmarkCall![0]).toBe("outputPlanning");

    // outputPlanning is the converge_to target itself — should keep linear next (gate)
    const planningCall = (buildAgentState as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[2] as { name: string }).name === "outputPlanning"
    );
    expect(planningCall![0]).toBe("gate");
  });

  it("explicit converge_to does not affect branches without contiguous targets", async () => {
    const { buildAgentState } = await import("./state-builders.js");
    const pipeline = makePipeline([
      {
        name: "route", type: "condition",
        runtime: {
          engine: "condition",
          converge_to: "shared",
          branches: [
            { when: "store.x == true", to: "shared" },
            { default: true, to: "shared" },
          ],
        },
      },
      { name: "shared", type: "agent", runtime: { engine: "llm", system_prompt: "s" } },
    ]);
    buildPipelineStates(pipeline);

    // "shared" is the converge_to target — should keep linear next (completed)
    const sharedCall = (buildAgentState as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[2] as { name: string }).name === "shared"
    );
    expect(sharedCall![0]).toBe("completed");
  });

  it("throws on invalid converge_to reference", () => {
    const pipeline = makePipeline([
      {
        name: "route", type: "condition",
        runtime: {
          engine: "condition",
          converge_to: "nonexistent",
          branches: [
            { when: "store.x == true", to: "completed" },
            { default: true, to: "completed" },
          ],
        },
      },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/converge_to "nonexistent" references non-existent state/);
  });
});

describe("buildPipelineStates — parallel groups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds states for a parallel group", () => {
    const pipeline = makePipeline([
      {
        parallel: {
          name: "par1",
          stages: [
            { name: "a1", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
            { name: "a2", type: "agent", runtime: { engine: "llm", system_prompt: "y" } },
          ],
        },
      } as any,
    ]);
    const states = buildPipelineStates(pipeline);
    expect(states).toHaveProperty("par1");
    expect(states.par1).toEqual({ type: "parallel-state" });
  });

  it("parallel group targets next stage correctly", async () => {
    const { buildParallelGroupState } = await import("./state-builders.js");
    const pipeline = makePipeline([
      {
        parallel: {
          name: "par1",
          stages: [
            { name: "a1", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
            { name: "a2", type: "agent", runtime: { engine: "llm", system_prompt: "y" } },
          ],
        },
      } as any,
      { name: "final", type: "agent", runtime: { engine: "llm", system_prompt: "z" } },
    ]);
    buildPipelineStates(pipeline);
    expect(buildParallelGroupState).toHaveBeenCalledWith(
      expect.objectContaining({ name: "par1" }),
      "final",
      "error",
    );
  });

  it("rejects human_confirm inside parallel group", () => {
    const pipeline = makePipeline([
      {
        parallel: {
          name: "par1",
          stages: [
            { name: "a1", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
            { name: "hc", type: "human_confirm", runtime: { engine: "human_gate" } },
          ],
        },
      } as any,
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow("human_confirm stages are not allowed inside parallel groups");
  });

  it("rejects overlapping writes keys in parallel group", () => {
    const pipeline = makePipeline([
      {
        parallel: {
          name: "par1",
          stages: [
            { name: "a1", type: "agent", runtime: { engine: "llm", system_prompt: "x", writes: ["shared_key"] } },
            { name: "a2", type: "agent", runtime: { engine: "llm", system_prompt: "y", writes: ["shared_key"] } },
          ],
        },
      } as any,
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/write key "shared_key" overlaps/);
  });

  it("validates child stage builder exists in parallel group", () => {
    const pipeline = makePipeline([
      {
        parallel: {
          name: "par1",
          stages: [
            { name: "bad", type: "agent", runtime: { engine: "unknown" as any, system_prompt: "x" } },
          ],
        },
      } as any,
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/no builder found/);
  });

  it("validates child stage retry.back_to references in parallel group", () => {
    const pipeline = makePipeline([
      {
        parallel: {
          name: "par1",
          stages: [
            { name: "a1", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "ghost" } } },
          ],
        },
      } as any,
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/retry.back_to references non-existent state "ghost"/);
  });

  it("inherits default_execution_mode for child agent stages in parallel group", async () => {
    const { buildParallelGroupState } = await import("./state-builders.js");
    const pipeline = makePipeline(
      [
        {
          parallel: {
            name: "par1",
            stages: [
              { name: "a1", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
              { name: "s1", type: "script", runtime: { engine: "script", script_id: "init" } },
            ],
          },
        } as any,
      ],
      { default_execution_mode: "edge" },
    );
    buildPipelineStates(pipeline);
    // The parallel group config passed to buildParallelGroupState should have
    // the child agent stage's execution_mode set to "edge"
    const groupArg = (buildParallelGroupState as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const agentChild = groupArg.stages.find((s: any) => s.name === "a1");
    const scriptChild = groupArg.stages.find((s: any) => s.name === "s1");
    expect(agentChild.execution_mode).toBe("edge");
    // Script stages should not inherit execution_mode
    expect(scriptChild.execution_mode).toBeUndefined();
  });
});
