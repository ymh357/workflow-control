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

// ---------------------------------------------------------------------------
// Bug 4: human_confirm as first stage must be rejected
// Before the fix, a human_confirm with no preceding agent/script would silently
// build with prevAgentState = "error", producing a broken feedback loop.
// ---------------------------------------------------------------------------
describe("Bug 4 — human_confirm as first stage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a pipeline with ONLY a human_confirm stage", () => {
    const pipeline = makePipeline([
      { name: "gate", type: "human_confirm", runtime: { engine: "human_gate" } },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(
      /human_confirm gate cannot be the first stage/,
    );
  });

  it("rejects human_confirm as first stage even when followed by an agent", () => {
    const pipeline = makePipeline([
      { name: "gate", type: "human_confirm", runtime: { engine: "human_gate" } },
      { name: "work", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(
      /human_confirm gate cannot be the first stage/,
    );
  });

  it("accepts agent followed by human_confirm (control case)", () => {
    const pipeline = makePipeline([
      { name: "work", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      { name: "gate", type: "human_confirm", runtime: { engine: "human_gate" } },
    ]);
    expect(() => buildPipelineStates(pipeline)).not.toThrow();
  });

  it("accepts script followed by human_confirm", () => {
    const pipeline = makePipeline([
      { name: "setup", type: "script", runtime: { engine: "script", script_id: "s1" } },
      { name: "gate", type: "human_confirm", runtime: { engine: "human_gate" } },
    ]);
    expect(() => buildPipelineStates(pipeline)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Bug 5: back_to cycle detection
// Before the fix, cycles in retry.back_to edges were not detected, potentially
// causing infinite retry loops at runtime (A retries to B, B retries to A).
// ---------------------------------------------------------------------------
describe("Bug 5 — back_to cycle detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects a 2-node cycle: A.back_to = B, B.back_to = A", () => {
    const pipeline = makePipeline([
      { name: "A", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "B" } } },
      { name: "B", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "A" } } },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/Cycle detected in back_to routing/);
  });

  it("detects a 3-node cycle: A -> B -> C -> A", () => {
    const pipeline = makePipeline([
      { name: "A", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "B" } } },
      { name: "B", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "C" } } },
      { name: "C", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "A" } } },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/Cycle detected in back_to routing/);
  });

  it("detects a self-cycle: A.back_to = A", () => {
    const pipeline = makePipeline([
      { name: "A", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "A" } } },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/Cycle detected in back_to routing/);
  });

  it("accepts a single back_to with no cycle: A.back_to = B", () => {
    const pipeline = makePipeline([
      { name: "A", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      { name: "B", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "A" } } },
    ]);
    expect(() => buildPipelineStates(pipeline)).not.toThrow();
  });

  it("accepts independent back_to chains with no cycles", () => {
    const pipeline = makePipeline([
      { name: "A", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      { name: "B", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "A" } } },
      { name: "C", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      { name: "D", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "C" } } },
    ]);
    expect(() => buildPipelineStates(pipeline)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Bug 4 extended — human_confirm positioning
// ---------------------------------------------------------------------------
describe("Bug 4 extended — human_confirm positioning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects two human_confirm stages in a row when first has no agent before it", () => {
    const pipeline = makePipeline([
      { name: "gate1", type: "human_confirm", runtime: { engine: "human_gate" } },
      { name: "gate2", type: "human_confirm", runtime: { engine: "human_gate" } },
    ]);
    // gate1 has no preceding agent/script, so validation fails
    expect(() => buildPipelineStates(pipeline)).toThrow(
      /human_confirm gate cannot be the first stage/,
    );
  });

  it("accepts second human_confirm when preceded by agent then human_confirm", () => {
    const pipeline = makePipeline([
      { name: "work", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      { name: "gate1", type: "human_confirm", runtime: { engine: "human_gate" } },
      { name: "gate2", type: "human_confirm", runtime: { engine: "human_gate" } },
    ]);
    // gate1 looks back and finds "work" (agent), gate2 looks back and finds "work" (agent)
    expect(() => buildPipelineStates(pipeline)).not.toThrow();
  });

  it("accepts human_confirm as second stage when first is script", () => {
    const pipeline = makePipeline([
      { name: "init", type: "script", runtime: { engine: "script", script_id: "s1" } },
      { name: "gate", type: "human_confirm", runtime: { engine: "human_gate" } },
    ]);
    expect(() => buildPipelineStates(pipeline)).not.toThrow();
  });

  it("accepts agent, human_confirm, human_confirm — both pass", () => {
    const pipeline = makePipeline([
      { name: "work", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      { name: "gate1", type: "human_confirm", runtime: { engine: "human_gate" } },
      { name: "gate2", type: "human_confirm", runtime: { engine: "human_gate" } },
    ]);
    // Both gates find "work" as the previous agent/script stage
    const states = buildPipelineStates(pipeline);
    expect(states).toHaveProperty("work");
    expect(states).toHaveProperty("gate1");
    expect(states).toHaveProperty("gate2");
  });
});

// ---------------------------------------------------------------------------
// Bug 5 extended — cycle detection edge cases
// ---------------------------------------------------------------------------
describe("Bug 5 extended — cycle detection edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects a 4-node cycle: A->B->C->D->A", () => {
    const pipeline = makePipeline([
      { name: "A", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "B" } } },
      { name: "B", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "C" } } },
      { name: "C", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "D" } } },
      { name: "D", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "A" } } },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/Cycle detected in back_to routing/);
  });

  it("accepts long chain without cycle: A->B->C->D (D has no back_to)", () => {
    const pipeline = makePipeline([
      { name: "A", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "B" } } },
      { name: "B", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "C" } } },
      { name: "C", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "D" } } },
      { name: "D", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
    ]);
    expect(() => buildPipelineStates(pipeline)).not.toThrow();
  });

  it("accepts back_to pointing to 'completed' (terminal) — no cycle", () => {
    const pipeline = makePipeline([
      { name: "A", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "completed" } } },
    ]);
    expect(() => buildPipelineStates(pipeline)).not.toThrow();
  });

  it("accepts back_to pointing to 'blocked' — no cycle", () => {
    const pipeline = makePipeline([
      { name: "A", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "blocked" } } },
    ]);
    expect(() => buildPipelineStates(pipeline)).not.toThrow();
  });

  it("reports two errors when A.back_to = A and B.back_to = A (two self/cycles)", () => {
    const pipeline = makePipeline([
      { name: "A", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "A" } } },
      { name: "B", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "A" } } },
    ]);
    // A.back_to = A is a self-cycle; B.back_to = A, and A.back_to = A forms A->A cycle
    expect(() => buildPipelineStates(pipeline)).toThrow(/Cycle detected/);
    try {
      buildPipelineStates(pipeline);
    } catch (e: any) {
      // Both cycle paths should be reported
      const matches = e.message.match(/Cycle detected/g);
      expect(matches!.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("only validates stages with back_to; stages without are ignored", () => {
    const pipeline = makePipeline([
      { name: "A", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      { name: "B", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "A" } } },
      { name: "C", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
    ]);
    // B.back_to = A, A has no back_to, no cycle — should pass
    expect(() => buildPipelineStates(pipeline)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Pipeline validation comprehensive
// ---------------------------------------------------------------------------
describe("Pipeline validation comprehensive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty states for an empty pipeline (no stages)", () => {
    const pipeline = makePipeline([]);
    const states = buildPipelineStates(pipeline);
    expect(states).toEqual({});
  });

  it("builds a valid pipeline with a single agent stage targeting 'completed'", () => {
    const pipeline = makePipeline([
      { name: "only", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
    ]);
    const states = buildPipelineStates(pipeline);
    expect(states).toHaveProperty("only");
  });

  it("handles two stages with the same name (last one wins in states map)", () => {
    const pipeline = makePipeline([
      { name: "dup", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      { name: "dup", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
    ]);
    // No explicit collision validation; the second overwrites the first in the states map
    const states = buildPipelineStates(pipeline);
    expect(Object.keys(states).filter(k => k === "dup")).toHaveLength(1);
  });

  it("rejects execution_mode 'edge' on script stage", () => {
    const pipeline = makePipeline([
      { name: "s1", type: "script", runtime: { engine: "script", script_id: "x" }, execution_mode: "edge" as any },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(
      /execution_mode "edge" but is type "script"/,
    );
  });

  it("rejects execution_mode 'edge' on human_confirm stage", () => {
    const pipeline = makePipeline([
      { name: "work", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      { name: "gate", type: "human_confirm", runtime: { engine: "human_gate" }, execution_mode: "edge" as any },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(
      /execution_mode "edge" but is type "human_confirm"/,
    );
  });

  it("allows execution_mode 'auto' on non-agent stage without error", () => {
    const pipeline = makePipeline([
      { name: "s1", type: "script", runtime: { engine: "script", script_id: "x" }, execution_mode: "auto" as any },
    ]);
    // "auto" check: condition is execution_mode && execution_mode !== "auto" && type !== "agent"
    // Since execution_mode is "auto", the second clause is false, so no error
    expect(() => buildPipelineStates(pipeline)).not.toThrow();
  });

  it("accepts on_approve_to referencing a valid stage name", () => {
    const pipeline = makePipeline([
      { name: "work", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      { name: "gate", type: "human_confirm", runtime: { engine: "human_gate", on_approve_to: "work" } },
    ]);
    expect(() => buildPipelineStates(pipeline)).not.toThrow();
  });

  it("rejects on_reject_to referencing a non-existent stage", () => {
    const pipeline = makePipeline([
      { name: "work", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      { name: "gate", type: "human_confirm", runtime: { engine: "human_gate", on_reject_to: "nowhere" } },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(
      /on_reject_to references non-existent state "nowhere"/,
    );
  });

  it("rejects retry.back_to referencing a non-existent stage", () => {
    const pipeline = makePipeline([
      { name: "work", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "ghost" } } },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(
      /retry\.back_to references non-existent state "ghost"/,
    );
  });
});

// ---------------------------------------------------------------------------
// derivePipelineLists
// ---------------------------------------------------------------------------
describe("derivePipelineLists", () => {
  it("returns correct retryable/resumable for mixed pipeline", () => {
    const pipeline = makePipeline([
      { name: "a1", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      { name: "s1", type: "script", runtime: { engine: "script", script_id: "x" } },
      { name: "g1", type: "human_confirm", runtime: { engine: "human_gate" } },
    ]);
    const { retryable, resumable } = derivePipelineLists(pipeline);
    expect(retryable).toEqual(["a1", "s1"]);
    expect(resumable).toEqual(["a1", "s1", "g1"]);
  });

  it("includes agent stages in both retryable and resumable", () => {
    const pipeline = makePipeline([
      { name: "a1", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      { name: "a2", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
    ]);
    const { retryable, resumable } = derivePipelineLists(pipeline);
    expect(retryable).toEqual(["a1", "a2"]);
    expect(resumable).toEqual(["a1", "a2"]);
  });

  it("includes script stages in both retryable and resumable", () => {
    const pipeline = makePipeline([
      { name: "s1", type: "script", runtime: { engine: "script", script_id: "x" } },
      { name: "s2", type: "script", runtime: { engine: "script", script_id: "y" } },
    ]);
    const { retryable, resumable } = derivePipelineLists(pipeline);
    expect(retryable).toEqual(["s1", "s2"]);
    expect(resumable).toEqual(["s1", "s2"]);
  });

  it("includes human_confirm only in resumable, not retryable", () => {
    const pipeline = makePipeline([
      { name: "g1", type: "human_confirm", runtime: { engine: "human_gate" } },
      { name: "g2", type: "human_confirm", runtime: { engine: "human_gate" } },
    ]);
    const { retryable, resumable } = derivePipelineLists(pipeline);
    expect(retryable).toEqual([]);
    expect(resumable).toEqual(["g1", "g2"]);
  });

  it("returns empty lists for an empty pipeline", () => {
    const pipeline = makePipeline([]);
    const { retryable, resumable } = derivePipelineLists(pipeline);
    expect(retryable).toEqual([]);
    expect(resumable).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Parallel group adversarial tests
// ---------------------------------------------------------------------------

describe("parallel group with single child stage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a parallel group with only 1 child stage (min-2 is a schema concern)", () => {
    const pipeline = makePipeline([
      {
        parallel: {
          name: "solo-group",
          stages: [
            { name: "only-child", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
          ],
        },
      } as any,
    ]);
    expect(() => buildPipelineStates(pipeline)).not.toThrow();
    const states = buildPipelineStates(pipeline);
    expect(states).toHaveProperty("solo-group");
    expect(states["solo-group"]).toEqual({ type: "parallel-state" });
  });
});

describe("parallel group as first stage in pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds correctly when a parallel group is the first entry", async () => {
    const { buildParallelGroupState } = await import("./state-builders.js");
    const pipeline = makePipeline([
      {
        parallel: {
          name: "first-group",
          stages: [
            { name: "a", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
            { name: "b", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
          ],
        },
      } as any,
    ]);
    const states = buildPipelineStates(pipeline);
    expect(states).toHaveProperty("first-group");
    // nextStateName should be "completed" since it's the only entry
    // prevAgentState should be "error" since there's no preceding stage
    expect(buildParallelGroupState).toHaveBeenCalledWith(
      expect.objectContaining({ name: "first-group" }),
      "completed",
      "error",
    );
  });

  it("parallel group first, followed by agent — next target is the agent", async () => {
    const { buildParallelGroupState } = await import("./state-builders.js");
    const pipeline = makePipeline([
      {
        parallel: {
          name: "pg",
          stages: [
            { name: "c1", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
            { name: "c2", type: "script", runtime: { engine: "script", script_id: "s1" } },
          ],
        },
      } as any,
      { name: "after", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
    ]);
    buildPipelineStates(pipeline);
    expect(buildParallelGroupState).toHaveBeenCalledWith(
      expect.objectContaining({ name: "pg" }),
      "after",
      "error",
    );
  });
});

describe("parallel group as last stage targets completed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("last parallel group has nextStateName = 'completed'", async () => {
    const { buildParallelGroupState } = await import("./state-builders.js");
    const pipeline = makePipeline([
      { name: "setup", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      {
        parallel: {
          name: "final-group",
          stages: [
            { name: "p1", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
            { name: "p2", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
          ],
        },
      } as any,
    ]);
    buildPipelineStates(pipeline);
    expect(buildParallelGroupState).toHaveBeenCalledWith(
      expect.objectContaining({ name: "final-group" }),
      "completed",
      "setup",
    );
  });
});

describe("parallel group followed by human_confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("human_confirm after parallel group finds the group as prevAgentTarget", async () => {
    const { buildHumanGateState } = await import("./state-builders.js");
    const pipeline = makePipeline([
      {
        parallel: {
          name: "pg",
          stages: [
            { name: "w1", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
            { name: "w2", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
          ],
        },
      } as any,
      { name: "gate", type: "human_confirm", runtime: { engine: "human_gate" } },
    ]);
    expect(() => buildPipelineStates(pipeline)).not.toThrow();
    // The prevAgentTarget for gate should be the parallel group name "pg"
    expect(buildHumanGateState).toHaveBeenCalledWith(
      "completed",
      "pg",
      expect.objectContaining({ name: "gate" }),
      expect.any(Map),
    );
  });

  it("does not reject human_confirm when preceded only by a parallel group", () => {
    const pipeline = makePipeline([
      {
        parallel: {
          name: "pg",
          stages: [
            { name: "w1", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
            { name: "w2", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
          ],
        },
      } as any,
      { name: "gate", type: "human_confirm", runtime: { engine: "human_gate" } },
    ]);
    expect(() => buildPipelineStates(pipeline)).not.toThrow();
  });
});

describe("back_to cycle involving parallel group child stages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects cycle: child A back_to child B, child B back_to child A (same group)", () => {
    const pipeline = makePipeline([
      {
        parallel: {
          name: "pg",
          stages: [
            { name: "A", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "B" } } },
            { name: "B", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "A" } } },
          ],
        },
      } as any,
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/Cycle detected in back_to routing/);
  });

  it("detects self-cycle in parallel group child: A back_to A", () => {
    const pipeline = makePipeline([
      {
        parallel: {
          name: "pg",
          stages: [
            { name: "A", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "A" } } },
            { name: "B", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
          ],
        },
      } as any,
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/Cycle detected in back_to routing/);
  });

  it("accepts non-cyclic back_to within parallel group children", () => {
    const pipeline = makePipeline([
      {
        parallel: {
          name: "pg",
          stages: [
            { name: "A", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
            { name: "B", type: "agent", runtime: { engine: "llm", system_prompt: "x", retry: { back_to: "A" } } },
          ],
        },
      } as any,
    ]);
    expect(() => buildPipelineStates(pipeline)).not.toThrow();
  });
});

describe("mixed pipeline with parallel and sequential stages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds agent -> parallel group -> human_confirm -> agent chain", async () => {
    const { buildAgentState, buildParallelGroupState, buildHumanGateState } = await import("./state-builders.js");
    const pipeline = makePipeline([
      { name: "init", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      {
        parallel: {
          name: "pg",
          stages: [
            { name: "p1", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
            { name: "p2", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
          ],
        },
      } as any,
      { name: "gate", type: "human_confirm", runtime: { engine: "human_gate" } },
      { name: "final", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
    ]);
    const states = buildPipelineStates(pipeline);
    expect(states).toHaveProperty("init");
    expect(states).toHaveProperty("pg");
    expect(states).toHaveProperty("gate");
    expect(states).toHaveProperty("final");

    // init -> pg
    expect(buildAgentState).toHaveBeenCalledWith(
      "pg", "error", expect.objectContaining({ name: "init" }), expect.objectContaining({ childToGroup: expect.any(Map) }),
    );
    // pg -> gate
    expect(buildParallelGroupState).toHaveBeenCalledWith(
      expect.objectContaining({ name: "pg" }), "gate", "init",
    );
    // gate -> final, prevAgentTarget = "pg" (parallel group counts)
    expect(buildHumanGateState).toHaveBeenCalledWith(
      "final", "pg", expect.objectContaining({ name: "gate" }), expect.any(Map),
    );
    // final -> completed, prevAgentTarget = "pg" (human_confirm is skipped)
    expect(buildAgentState).toHaveBeenCalledWith(
      "completed", "pg", expect.objectContaining({ name: "final" }), expect.objectContaining({ childToGroup: expect.any(Map) }),
    );
  });
});

describe("duplicate stage names across parallel group and top-level", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows same name inside group and outside (no explicit collision check)", () => {
    const pipeline = makePipeline([
      { name: "dup", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      {
        parallel: {
          name: "pg",
          stages: [
            { name: "dup", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
            { name: "other", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
          ],
        },
      } as any,
    ]);
    // Builder does not validate name uniqueness across top-level and group children;
    // The parallel group state overwrites via buildParallelGroupState, top-level "dup" is separate
    expect(() => buildPipelineStates(pipeline)).not.toThrow();
    const states = buildPipelineStates(pipeline);
    // Top-level "dup" is built as agent-state, "pg" as parallel-state
    expect(states).toHaveProperty("dup");
    expect(states).toHaveProperty("pg");
  });
});

describe("parallel group child with execution_mode edge on script", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects execution_mode 'edge' on a script child inside a parallel group", () => {
    const pipeline = makePipeline([
      {
        parallel: {
          name: "pg",
          stages: [
            { name: "s1", type: "script", execution_mode: "edge" as any, runtime: { engine: "script", script_id: "x" } },
            { name: "a1", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
          ],
        },
      } as any,
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(
      /execution_mode "edge" but is type "script"/,
    );
  });

  it("accepts execution_mode 'edge' on an agent child inside a parallel group", () => {
    const pipeline = makePipeline([
      {
        parallel: {
          name: "pg",
          stages: [
            { name: "a1", type: "agent", execution_mode: "edge", runtime: { engine: "llm", system_prompt: "x" } },
            { name: "a2", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
          ],
        },
      } as any,
    ]);
    expect(() => buildPipelineStates(pipeline)).not.toThrow();
  });
});

describe("derivePipelineLists with parallel group containing agent and script", () => {
  it("classifies parallel group name as retryable and resumable", () => {
    const pipeline = makePipeline([
      {
        parallel: {
          name: "pg",
          stages: [
            { name: "a1", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
            { name: "s1", type: "script", runtime: { engine: "script", script_id: "x" } },
          ],
        },
      } as any,
    ]);
    const { retryable, resumable } = derivePipelineLists(pipeline);
    expect(retryable).toContain("pg");
    expect(resumable).toContain("pg");
  });

  it("classifies child agent and script stages as retryable and resumable", () => {
    const pipeline = makePipeline([
      {
        parallel: {
          name: "pg",
          stages: [
            { name: "a1", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
            { name: "s1", type: "script", runtime: { engine: "script", script_id: "x" } },
          ],
        },
      } as any,
    ]);
    const { retryable, resumable } = derivePipelineLists(pipeline);
    expect(retryable).toEqual(["pg", "a1", "s1"]);
    expect(resumable).toEqual(["pg", "a1", "s1"]);
  });

  it("handles mixed top-level and parallel group stages", () => {
    const pipeline = makePipeline([
      { name: "init", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      {
        parallel: {
          name: "pg",
          stages: [
            { name: "a1", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
            { name: "s1", type: "script", runtime: { engine: "script", script_id: "x" } },
          ],
        },
      } as any,
      { name: "gate", type: "human_confirm", runtime: { engine: "human_gate" } },
    ]);
    const { retryable, resumable } = derivePipelineLists(pipeline);
    expect(retryable).toEqual(["init", "pg", "a1", "s1"]);
    expect(resumable).toEqual(["init", "pg", "a1", "s1", "gate"]);
  });
});

// ── Condition convergence overlap ──

describe("two conditions with overlapping branch targets", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("does not let second condition override first condition's convergence", async () => {
    const { buildAgentState } = await import("./state-builders.js");
    // cond1 branches to shared and branchB; cond2 branches to shared and branchD
    // "shared" is a target of both conditions — the first condition's override should win
    const pipeline = makePipeline([
      {
        name: "cond1", type: "condition",
        runtime: { engine: "condition", branches: [{ when: "store.a == true", to: "shared" }, { default: true, to: "branchB" }] },
      },
      { name: "shared", type: "agent", runtime: { engine: "llm", system_prompt: "s" } },
      { name: "branchB", type: "agent", runtime: { engine: "llm", system_prompt: "b" } },
      { name: "middle", type: "agent", runtime: { engine: "llm", system_prompt: "m" } },
      {
        name: "cond2", type: "condition",
        runtime: { engine: "condition", branches: [{ when: "store.x == true", to: "shared" }, { default: true, to: "branchD" }] },
      },
      { name: "branchD", type: "agent", runtime: { engine: "llm", system_prompt: "d" } },
      { name: "end", type: "agent", runtime: { engine: "llm", system_prompt: "e" } },
    ]);
    buildPipelineStates(pipeline);

    // cond1: "shared" and "branchB" are contiguous after cond1, convergence point = "middle"
    const sharedCall = (buildAgentState as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[2] as { name: string }).name === "shared"
    );
    const branchBCall = (buildAgentState as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[2] as { name: string }).name === "branchB"
    );
    // shared's nextTarget should be "middle" (from cond1's convergence), not overwritten by cond2
    expect(sharedCall![0]).toBe("middle");
    expect(branchBCall![0]).toBe("middle");

    // cond2: "shared" is NOT contiguous after cond2 (it's before cond2),
    // so only "branchD" participates. branchD convergence = "end"
    const branchDCall = (buildAgentState as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[2] as { name: string }).name === "branchD"
    );
    expect(branchDCall![0]).toBe("end");
  });
});

// ── New stage types: adversarial ──

describe("condition stage adversarial", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("throws when condition has 2 default branches", () => {
    const pipeline = makePipeline([
      {
        name: "r", type: "condition",
        runtime: { engine: "condition", branches: [{ default: true, to: "completed" }, { default: true, to: "error" }] },
      },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/condition must have exactly 1 default branch.*found 2/);
  });

  it("throws when condition has 0 default branches", () => {
    const pipeline = makePipeline([
      {
        name: "r", type: "condition",
        runtime: { engine: "condition", branches: [{ when: "store.x", to: "completed" }, { when: "store.y", to: "error" }] },
      },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/condition must have exactly 1 default branch.*found 0/);
  });

  it("throws when condition has only default branches (no non-default)", () => {
    const pipeline = makePipeline([
      { name: "a", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      {
        name: "r", type: "condition",
        runtime: { engine: "condition", branches: [{ default: true, to: "a" }] },
      },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/at least 1 non-default branch/);
  });

  it("throws when branch.to references non-existent stage", () => {
    const pipeline = makePipeline([
      {
        name: "r", type: "condition",
        runtime: { engine: "condition", branches: [{ when: "store.x", to: "ghost" }, { default: true, to: "completed" }] },
      },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/branch\.to "ghost" references non-existent state/);
  });

  it("allows branch.to referencing built-in states", () => {
    const pipeline = makePipeline([
      { name: "a", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      {
        name: "r", type: "condition",
        runtime: { engine: "condition", branches: [{ when: "store.x", to: "a" }, { default: true, to: "completed" }] },
      },
    ]);
    expect(() => buildPipelineStates(pipeline)).not.toThrow();
  });

  it("condition does not appear in retryable/resumable lists", () => {
    const pipeline = makePipeline([
      { name: "a", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      {
        name: "r", type: "condition",
        runtime: { engine: "condition", branches: [{ when: "store.x", to: "a" }, { default: true, to: "completed" }] },
      },
    ]);
    const { retryable, resumable } = derivePipelineLists(pipeline);
    expect(retryable).not.toContain("r");
    expect(resumable).not.toContain("r");
  });
});

describe("pipeline call stage adversarial", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("throws when pipeline stage has no pipeline_name", () => {
    const pipeline = makePipeline([
      { name: "sub", type: "pipeline", runtime: { engine: "pipeline" } as any },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/pipeline stage must have runtime.pipeline_name/);
  });

  it("throws when pipeline stage has empty pipeline_name", () => {
    const pipeline = makePipeline([
      { name: "sub", type: "pipeline", runtime: { engine: "pipeline", pipeline_name: "" } as any },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/pipeline stage must have runtime.pipeline_name/);
  });

  it("pipeline stage appears in retryable and resumable", () => {
    const pipeline = makePipeline([
      { name: "sub", type: "pipeline", runtime: { engine: "pipeline", pipeline_name: "child" } },
    ]);
    const { retryable, resumable } = derivePipelineLists(pipeline);
    expect(retryable).toContain("sub");
    expect(resumable).toContain("sub");
  });
});

describe("foreach stage adversarial", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("throws when foreach has no items", () => {
    const pipeline = makePipeline([
      { name: "loop", type: "foreach", runtime: { engine: "foreach", item_var: "x", pipeline_name: "c" } as any },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/foreach stage must have runtime.items/);
  });

  it("throws when foreach has no item_var", () => {
    const pipeline = makePipeline([
      { name: "loop", type: "foreach", runtime: { engine: "foreach", items: "store.list", pipeline_name: "c" } as any },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/foreach stage must have runtime.item_var/);
  });

  it("throws when foreach has no pipeline_name", () => {
    const pipeline = makePipeline([
      { name: "loop", type: "foreach", runtime: { engine: "foreach", items: "store.list", item_var: "x" } as any },
    ]);
    expect(() => buildPipelineStates(pipeline)).toThrow(/foreach stage must have runtime.pipeline_name/);
  });

  it("foreach stage appears in retryable and resumable", () => {
    const pipeline = makePipeline([
      { name: "loop", type: "foreach", runtime: { engine: "foreach", items: "store.list", item_var: "x", pipeline_name: "c" } },
    ]);
    const { retryable, resumable } = derivePipelineLists(pipeline);
    expect(retryable).toContain("loop");
    expect(resumable).toContain("loop");
  });

  it("prevAgentTarget skips condition, pipeline, foreach stages", () => {
    const pipeline = makePipeline([
      { name: "code", type: "agent", runtime: { engine: "llm", system_prompt: "x" } },
      { name: "r", type: "condition", runtime: { engine: "condition", branches: [{ when: "store.x", to: "sub" }, { default: true, to: "sub" }] } },
      { name: "sub", type: "pipeline", runtime: { engine: "pipeline", pipeline_name: "c" } },
      { name: "loop", type: "foreach", runtime: { engine: "foreach", items: "store.list", item_var: "x", pipeline_name: "c" } },
      { name: "gate", type: "human_confirm", runtime: { engine: "human_gate" } },
    ]);
    expect(() => buildPipelineStates(pipeline)).not.toThrow();
  });
});
