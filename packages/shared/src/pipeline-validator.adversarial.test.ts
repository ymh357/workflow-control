import { describe, it, expect } from "vitest";
import { validatePipelineLogic } from "./pipeline-validator";

// Helper to make a minimal valid agent stage
function makeStage(name: string, writes: string[] = [], reads: Record<string, string> = {}) {
  return {
    name,
    type: "agent" as const,
    runtime: { engine: "llm", system_prompt: name, writes, reads: Object.keys(reads).length ? reads : undefined },
  };
}

describe("validatePipelineLogic — adversarial scenarios", () => {
  // 1. Empty stages array
  it("handles empty stages array without crashing", () => {
    const issues = validatePipelineLogic([]);
    expect(issues).toEqual([]);
  });

  // 2. Stages with empty writes array
  it("handles writes: [] without reporting errors", () => {
    const stages = [makeStage("analyze", [])];
    const issues = validatePipelineLogic(stages);
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  // 3. Stage name with special characters (spaces, unicode, slashes)
  it("handles stage names with unicode characters without crashing", () => {
    const stages = [
      { name: "阶段一", type: "agent" as const, runtime: { engine: "llm", system_prompt: "s", writes: ["data"] } },
      { name: "stage/two", type: "agent" as const, runtime: { engine: "llm", system_prompt: "s2", writes: [] } },
    ];
    expect(() => validatePipelineLogic(stages)).not.toThrow();
  });

  // 4. Circular routing reference (A back_to B, B back_to A)
  it("does not infinite loop on circular retry.back_to references", () => {
    const stages = [
      {
        name: "stage-a",
        type: "agent" as const,
        runtime: { engine: "llm", system_prompt: "a", writes: ["x"], retry: { back_to: "stage-b" } },
      },
      {
        name: "stage-b",
        type: "agent" as const,
        runtime: { engine: "llm", system_prompt: "b", writes: ["y"], retry: { back_to: "stage-a" } },
      },
    ];
    // Should not throw or hang — both stages exist so no error is reported for routing
    const issues = validatePipelineLogic(stages);
    expect(issues).toBeDefined();
    expect(issues.filter((i) => i.field === "retry")).toHaveLength(0);
  });

  // 5. Very large stages array (1000 stages)
  it("handles 1000 stages without excessive time or crash", () => {
    const stages = Array.from({ length: 1000 }, (_, i) =>
      makeStage(`stage-${i}`, [`write-${i}`])
    );
    const start = Date.now();
    const issues = validatePipelineLogic(stages);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000); // should complete in under 5 seconds
    expect(issues).toBeDefined();
  });

  // 6. Stage with very long name (1000 chars)
  it("handles very long stage names without crashing", () => {
    const longName = "a".repeat(1000);
    const stages = [makeStage(longName, ["result"])];
    expect(() => validatePipelineLogic(stages)).not.toThrow();
  });

  // 7. promptKeys as empty Set vs undefined
  it("empty promptKeys Set reports error for missing prompts", () => {
    const stages = [makeStage("analyze", [])];
    const issuesWithEmpty = validatePipelineLogic(stages, new Set<string>());
    const issuesWithUndefined = validatePipelineLogic(stages, undefined);
    // With empty set: prompt not found → error
    expect(issuesWithEmpty.some((i) => i.field === "system_prompt")).toBe(true);
    // With undefined: no prompt check → no error
    expect(issuesWithUndefined.filter((i) => i.field === "system_prompt")).toHaveLength(0);
  });

  // 8. Parallel group nested inside another parallel group (not spec'd but should not crash)
  it("handles nested parallel structure without crashing", () => {
    const outerParallel = {
      parallel: {
        name: "outer",
        stages: [
          { name: "child-a", type: "agent" as const },
          { name: "child-b", type: "agent" as const },
        ],
      },
    };
    expect(() => validatePipelineLogic([outerParallel])).not.toThrow();
  });

  // 9. Stage reads referencing its own write key
  it("does not report error when stage reads a key written by an earlier stage", () => {
    const stages = [
      makeStage("producer", ["data"]),
      makeStage("consumer", [], { myData: "data.field" }),
    ];
    const issues = validatePipelineLogic(stages);
    expect(issues.filter((i) => i.field === "reads" && i.severity === "error")).toHaveLength(0);
  });

  // 10. Routing target that references a stage in a parallel group
  it("accepts on_reject_to that targets a stage name in a parallel group", () => {
    const stages = [
      {
        name: "gate",
        type: "human_confirm" as const,
        runtime: {
          engine: "human_gate" as const,
          on_reject_to: "child-a",
        },
      },
      {
        parallel: {
          name: "parallel-work",
          stages: [
            { name: "child-a", type: "agent" as const },
            { name: "child-b", type: "agent" as const },
          ],
        },
      },
    ];
    const issues = validatePipelineLogic(stages);
    // child-a is in allStageNames, so routing should be valid
    expect(issues.filter((i) => i.field === "on_reject_to" && i.severity === "error")).toHaveLength(0);
  });

  // 11. on_reject_to pointing to non-existent stage
  it("reports error for on_reject_to targeting non-existent stage", () => {
    const stages = [
      {
        name: "gate",
        type: "human_confirm" as const,
        runtime: {
          engine: "human_gate" as const,
          on_reject_to: "does-not-exist",
        },
      },
    ];
    const issues = validatePipelineLogic(stages);
    expect(issues.some((i) => i.field === "on_reject_to" && i.severity === "error")).toBe(true);
  });

  // 12. Duplicate write key across non-sibling stages produces warning
  it("reports warning for duplicate write keys across sequential stages", () => {
    const stages = [
      makeStage("stage-a", ["analysis"]),
      makeStage("stage-b", ["analysis"]),
    ];
    const issues = validatePipelineLogic(stages);
    expect(issues.some((i) => i.field === "writes" && i.severity === "warning")).toBe(true);
  });

  // 13. Parallel group with overlapping writes
  it("reports error for overlapping write keys within a parallel group", () => {
    const stages = [
      {
        parallel: {
          name: "parallel-write",
          stages: [
            { name: "worker-a", type: "agent" as const, runtime: { engine: "llm", system_prompt: "a", writes: ["shared-key"] } },
            { name: "worker-b", type: "agent" as const, runtime: { engine: "llm", system_prompt: "b", writes: ["shared-key"] } },
          ],
        },
      },
    ];
    const issues = validatePipelineLogic(stages);
    expect(issues.some((i) => i.severity === "error" && i.message.includes("shared-key"))).toBe(true);
  });

  // 14. Parallel group with only one stage
  it("reports error for parallel group with fewer than 2 stages", () => {
    const stages = [
      {
        parallel: {
          name: "solo-parallel",
          stages: [
            { name: "only-child", type: "agent" as const },
          ],
        },
      },
    ];
    const issues = validatePipelineLogic(stages);
    expect(issues.some((i) => i.severity === "error" && i.message.includes("at least 2 stages"))).toBe(true);
  });
});
