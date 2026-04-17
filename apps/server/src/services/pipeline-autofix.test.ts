import { describe, it, expect } from "vitest";
import { autofixPipeline } from "./pipeline-autofix.js";

describe("autofixPipeline", () => {
  it("is a no-op on pipelines missing outputs for writes (let validator drive LLM retry)", () => {
    const pipeline = {
      stages: [
        {
          name: "analyze",
          type: "agent" as const,
          runtime: { engine: "llm" as const, system_prompt: "x", writes: ["analysis"], reads: {} },
        },
      ],
    };
    const before = JSON.parse(JSON.stringify(pipeline));
    const fixes = autofixPipeline(pipeline as any);
    expect(fixes).toEqual([]);
    expect(pipeline).toEqual(before);
  });

  it("is a no-op when store_schema is present but reads are empty (let validator report mismatch)", () => {
    const pipeline = {
      store_schema: {
        analysis: { produced_by: "analyze" },
        plan: { produced_by: "planImpl" },
      },
      stages: [
        { name: "analyze", type: "agent" as const, runtime: { engine: "llm" as const, system_prompt: "x", reads: {} } },
        { name: "planImpl", type: "agent" as const, runtime: { engine: "llm" as const, system_prompt: "x", reads: {} } },
      ],
    };
    const before = JSON.parse(JSON.stringify(pipeline));
    const fixes = autofixPipeline(pipeline as any);
    expect(fixes).toEqual([]);
    expect(pipeline).toEqual(before);
  });

  it("does not overwrite existing reads", () => {
    const pipeline = {
      store_schema: {
        analysis: { produced_by: "analyze" },
      },
      stages: [
        { name: "analyze", type: "agent" as const, runtime: { engine: "llm" as const, system_prompt: "x", reads: {} } },
        { name: "impl", type: "agent" as const, runtime: { engine: "llm" as const, system_prompt: "x", reads: { a: "analysis.title" } } },
      ],
    };
    const fixes = autofixPipeline(pipeline as any);
    expect((pipeline.stages[1] as any).runtime.reads).toEqual({ a: "analysis.title" });
    expect(fixes).toEqual([]);
  });

  it("returns empty array for valid pipelines", () => {
    const pipeline = {
      stages: [
        {
          name: "analyze",
          type: "agent" as const,
          runtime: { engine: "llm" as const, system_prompt: "x", writes: ["analysis"], reads: {} },
          outputs: { analysis: { type: "object" as const, fields: [] } },
        },
      ],
    };
    expect(autofixPipeline(pipeline as any)).toEqual([]);
  });

  it("handles empty stages array", () => {
    expect(autofixPipeline({ stages: [] })).toEqual([]);
  });

  it("handles parallel groups without mutation", () => {
    const pipeline = {
      stages: [
        {
          parallel: {
            name: "research",
            stages: [
              { name: "a", type: "agent" as const, runtime: { engine: "llm" as const, system_prompt: "x", writes: ["resultA"], reads: {} } },
              { name: "b", type: "agent" as const, runtime: { engine: "llm" as const, system_prompt: "x", writes: ["resultB"], reads: {} } },
            ],
          },
        },
      ],
    };
    const before = JSON.parse(JSON.stringify(pipeline));
    const fixes = autofixPipeline(pipeline as any);
    expect(fixes).toEqual([]);
    expect(pipeline).toEqual(before);
  });

  it("is idempotent", () => {
    const pipeline = {
      store_schema: { foo: { produced_by: "s" } },
      stages: [
        { name: "s", type: "agent" as const, runtime: { engine: "llm" as const, system_prompt: "x", reads: {} } },
      ],
    };
    expect(autofixPipeline(pipeline as any)).toEqual([]);
    expect(autofixPipeline(pipeline as any)).toEqual([]);
  });
});
