import { describe, it, expect } from "vitest";
import { autofixPipeline } from "./pipeline-autofix.js";

describe("autofixPipeline", () => {
  it("adds missing outputs entries for writes keys", () => {
    const pipeline = {
      stages: [
        {
          name: "analyze",
          type: "agent",
          runtime: { engine: "llm", writes: ["analysis"], reads: {} },
        },
      ],
    };
    const fixes = autofixPipeline(pipeline);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toContain("missing outputs");
    expect((pipeline.stages[0] as any).outputs.analysis).toBeDefined();
  });

  it("does not add outputs when store_schema is present", () => {
    const pipeline = {
      store_schema: { analysis: { produced_by: "analyze" } },
      stages: [
        {
          name: "analyze",
          type: "agent",
          runtime: { engine: "llm", reads: {} },
        },
      ],
    };
    const fixes = autofixPipeline(pipeline);
    // Should only do reads population, not outputs
    expect(fixes.every((f) => !f.includes("missing outputs"))).toBe(true);
  });

  it("auto-populates reads from store_schema for agent stages with empty reads", () => {
    const pipeline = {
      store_schema: {
        analysis: { produced_by: "analyze" },
        plan: { produced_by: "planImpl" },
      },
      stages: [
        { name: "analyze", type: "agent", runtime: { engine: "llm", reads: {} } },
        { name: "planImpl", type: "agent", runtime: { engine: "llm", reads: {} } },
      ],
    };
    const fixes = autofixPipeline(pipeline);
    // planImpl should now read "analysis" (produced by analyze which comes before it)
    expect((pipeline.stages[1] as any).runtime.reads).toEqual({ analysis: "analysis" });
    // analyze has nothing before it, so no reads populated
    expect((pipeline.stages[0] as any).runtime.reads).toEqual({});
    expect(fixes.some((f) => f.includes("planImpl"))).toBe(true);
  });

  it("does not overwrite existing reads", () => {
    const pipeline = {
      store_schema: {
        analysis: { produced_by: "analyze" },
      },
      stages: [
        { name: "analyze", type: "agent", runtime: { engine: "llm", reads: {} as Record<string, string> } },
        { name: "impl", type: "agent", runtime: { engine: "llm", reads: { a: "analysis.title" } } },
      ],
    };
    const fixes = autofixPipeline(pipeline);
    // impl already has reads, should not be modified
    expect((pipeline.stages[1] as any).runtime.reads).toEqual({ a: "analysis.title" });
    expect(fixes.every((f) => !f.includes('"impl"'))).toBe(true);
  });

  it("returns empty array for valid pipelines", () => {
    const pipeline = {
      stages: [
        {
          name: "analyze",
          type: "agent",
          runtime: { engine: "llm", writes: ["analysis"], reads: {} },
          outputs: { analysis: { type: "object", fields: [] } },
        },
      ],
    };
    expect(autofixPipeline(pipeline)).toEqual([]);
  });

  it("handles empty stages array", () => {
    expect(autofixPipeline({ stages: [] })).toEqual([]);
  });

  it("handles parallel groups", () => {
    const pipeline = {
      stages: [
        {
          parallel: {
            name: "research",
            stages: [
              { name: "a", type: "agent", runtime: { engine: "llm", writes: ["resultA"], reads: {} } },
              { name: "b", type: "agent", runtime: { engine: "llm", writes: ["resultB"], reads: {} } },
            ],
          },
        },
      ],
    };
    const fixes = autofixPipeline(pipeline);
    expect(fixes).toHaveLength(2);
    expect((pipeline.stages[0] as any).parallel.stages[0].outputs.resultA).toBeDefined();
    expect((pipeline.stages[0] as any).parallel.stages[1].outputs.resultB).toBeDefined();
  });
});
