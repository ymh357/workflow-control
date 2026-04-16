import { describe, it, expect } from "vitest";
import { validatePipelineConfig } from "../lib/config/schema.js";
import { buildPipelineStates } from "../machine/pipeline-builder.js";

describe("Single-session pipeline integration", () => {
  it("validates and builds a single-session pipeline", () => {
    const pipeline = {
      name: "Test Single Session",
      session_mode: "single",
      engine: "claude",
      stages: [
        {
          name: "analyze",
          type: "agent",
          runtime: { engine: "llm", system_prompt: "analyze", writes: ["analysis"] },
        },
        {
          name: "implement",
          type: "agent",
          runtime: {
            engine: "llm",
            system_prompt: "implement",
            writes: ["result"],
            reads: { analysis: "analysis" },
          },
        },
      ],
    };

    // Schema validation passes
    const validation = validatePipelineConfig(pipeline);
    expect(validation.success).toBe(true);

    // Pipeline states build without error
    const states = buildPipelineStates(pipeline as any);
    expect(states).toHaveProperty("analyze");
    expect(states).toHaveProperty("implement");
  });

  it("builds single-session parallel group as single invoke", () => {
    const pipeline = {
      name: "Test Parallel",
      session_mode: "single",
      engine: "claude",
      stages: [
        {
          parallel: {
            name: "gather",
            stages: [
              { name: "taskA", type: "agent", runtime: { engine: "llm", system_prompt: "do A", writes: ["a"] } },
              { name: "taskB", type: "agent", runtime: { engine: "llm", system_prompt: "do B", writes: ["b"] } },
            ],
          },
        },
        {
          name: "combine",
          type: "agent",
          runtime: { engine: "llm", system_prompt: "combine", writes: ["combined"], reads: { a: "a", b: "b" } },
        },
      ],
    };

    const states = buildPipelineStates(pipeline as any);
    expect(states).toHaveProperty("gather");
    // In single-session mode, parallel group is NOT type: "parallel"
    expect((states.gather as any).type).not.toBe("parallel");
    // It should have an invoke
    expect((states.gather as any).invoke).toBeDefined();
    expect((states.gather as any).invoke.src).toBe("runAgentSingleSession");
  });

  it("multi-session pipeline is unchanged", () => {
    const pipeline = {
      name: "Test Multi",
      stages: [
        { name: "s1", type: "agent", runtime: { engine: "llm", system_prompt: "test", writes: ["out"] } },
      ],
    };

    const states = buildPipelineStates(pipeline as any);
    expect(states).toHaveProperty("s1");
    // Default (no session_mode) should use runAgent, not runAgentSingleSession
    const invokedSrc = (states.s1 as any).invoke.src;
    expect(invokedSrc).not.toBe("runAgentSingleSession");
  });
});
