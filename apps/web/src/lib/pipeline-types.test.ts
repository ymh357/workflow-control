import { describe, it, expect } from "vitest";
import { isPipelineParallelGroup, flattenPipelineStages } from "./pipeline-types";
import type { PipelineStageEntry, PipelineStageSchema, ParallelGroupSchema } from "./pipeline-types";

const stage = (name: string): PipelineStageSchema => ({
  name,
  type: "agent",
});

const parallelGroup = (name: string, stages: PipelineStageSchema[]): ParallelGroupSchema => ({
  parallel: { name, stages },
});

// ── isPipelineParallelGroup ──

describe("isPipelineParallelGroup", () => {
  it("returns true for entry with 'parallel' key", () => {
    expect(isPipelineParallelGroup(parallelGroup("pg", []))).toBe(true);
  });

  it("returns false for regular stage entry", () => {
    expect(isPipelineParallelGroup(stage("s1"))).toBe(false);
  });

  it("returns false for stage with unrelated fields", () => {
    const s: any = { name: "x", type: "script", runtime: {} };
    expect(isPipelineParallelGroup(s)).toBe(false);
  });
});

// ── flattenPipelineStages ──

describe("flattenPipelineStages", () => {
  it("empty array returns empty array", () => {
    expect(flattenPipelineStages([])).toEqual([]);
  });

  it("all regular stages — returned as-is in order", () => {
    const entries: PipelineStageEntry[] = [stage("s1"), stage("s2"), stage("s3")];
    const result = flattenPipelineStages(entries);
    expect(result).toHaveLength(3);
    expect(result.map(s => s.name)).toEqual(["s1", "s2", "s3"]);
  });

  it("parallel group is flattened into individual stages", () => {
    const entries: PipelineStageEntry[] = [
      parallelGroup("pg", [stage("p1"), stage("p2")]),
    ];
    const result = flattenPipelineStages(entries);
    expect(result).toHaveLength(2);
    expect(result.map(s => s.name)).toEqual(["p1", "p2"]);
  });

  it("mixed entries — regular then parallel then regular", () => {
    const entries: PipelineStageEntry[] = [
      stage("before"),
      parallelGroup("pg", [stage("p1"), stage("p2")]),
      stage("after"),
    ];
    const result = flattenPipelineStages(entries);
    expect(result.map(s => s.name)).toEqual(["before", "p1", "p2", "after"]);
  });

  it("empty parallel group contributes zero stages", () => {
    const entries: PipelineStageEntry[] = [
      stage("s1"),
      parallelGroup("empty-pg", []),
      stage("s2"),
    ];
    const result = flattenPipelineStages(entries);
    expect(result.map(s => s.name)).toEqual(["s1", "s2"]);
  });

  it("two consecutive parallel groups both flattened", () => {
    const entries: PipelineStageEntry[] = [
      parallelGroup("pg1", [stage("a"), stage("b")]),
      parallelGroup("pg2", [stage("c"), stage("d")]),
    ];
    const result = flattenPipelineStages(entries);
    expect(result.map(s => s.name)).toEqual(["a", "b", "c", "d"]);
  });

  it("nested structure not recursed — parallel.stages are already PipelineStageSchema", () => {
    const nested: PipelineStageEntry[] = [
      parallelGroup("pg", [stage("x")]),
    ];
    const result = flattenPipelineStages(nested);
    expect(result[0].name).toBe("x");
    expect(result[0].type).toBe("agent");
  });
});
