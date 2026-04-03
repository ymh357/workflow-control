import { describe, it, expect } from "vitest";
import { validatePipelineLogic } from "@workflow-control/shared";

describe("validatePipelineLogic — MCP reference validation", () => {
  const knownMcps = new Set(["notion", "context7", "figma"]);

  it("passes when stage mcps are all in knownMcps", () => {
    const stages = [
      { name: "analysis", type: "agent" as const, mcps: ["notion", "context7"] },
    ];
    const issues = validatePipelineLogic(stages, undefined, knownMcps);
    const mcpIssues = issues.filter((i) => i.field === "mcps");
    expect(mcpIssues).toHaveLength(0);
  });

  it("reports error for unknown MCP reference", () => {
    const stages = [
      { name: "build", type: "agent" as const, mcps: ["notion", "unknown-mcp"] },
    ];
    const issues = validatePipelineLogic(stages, undefined, knownMcps);
    const mcpIssues = issues.filter((i) => i.field === "mcps");
    expect(mcpIssues).toHaveLength(1);
    expect(mcpIssues[0].severity).toBe("error");
    expect(mcpIssues[0].message).toContain("unknown-mcp");
    expect(mcpIssues[0].message).toContain("not registered");
  });

  it("reports errors for multiple unknown MCPs in same stage", () => {
    const stages = [
      { name: "build", type: "agent" as const, mcps: ["bad1", "bad2"] },
    ];
    const issues = validatePipelineLogic(stages, undefined, knownMcps);
    const mcpIssues = issues.filter((i) => i.field === "mcps");
    expect(mcpIssues).toHaveLength(2);
  });

  it("skips MCP validation when knownMcps is undefined", () => {
    const stages = [
      { name: "build", type: "agent" as const, mcps: ["anything", "goes"] },
    ];
    const issues = validatePipelineLogic(stages, undefined, undefined);
    const mcpIssues = issues.filter((i) => i.field === "mcps");
    expect(mcpIssues).toHaveLength(0);
  });

  it("validates MCPs inside parallel groups", () => {
    const stages = [
      {
        parallel: {
          name: "research",
          stages: [
            { name: "a", type: "agent" as const, mcps: ["notion"], runtime: { writes: ["x"] } },
            { name: "b", type: "agent" as const, mcps: ["nonexistent"], runtime: { writes: ["y"] } },
          ],
        },
      },
    ];
    const issues = validatePipelineLogic(stages as any, undefined, knownMcps);
    const mcpIssues = issues.filter((i) => i.field === "mcps");
    expect(mcpIssues).toHaveLength(1);
    expect(mcpIssues[0].message).toContain("nonexistent");
  });

  it("no error for stages without mcps field", () => {
    const stages = [
      { name: "build", type: "agent" as const },
      { name: "gate", type: "human_confirm" as const },
    ];
    const issues = validatePipelineLogic(stages, undefined, knownMcps);
    const mcpIssues = issues.filter((i) => i.field === "mcps");
    expect(mcpIssues).toHaveLength(0);
  });

  it("no error for stages with empty mcps array", () => {
    const stages = [
      { name: "build", type: "agent" as const, mcps: [] },
    ];
    const issues = validatePipelineLogic(stages, undefined, knownMcps);
    const mcpIssues = issues.filter((i) => i.field === "mcps");
    expect(mcpIssues).toHaveLength(0);
  });

  it("should not crash when stage.mcps is null instead of array", () => {
    const stages = [
      { name: "build", type: "agent" as const, mcps: null as any },
    ];
    // null is falsy, so `if (stageMcps)` should skip — no crash, no error
    expect(() => validatePipelineLogic(stages, undefined, knownMcps)).not.toThrow();
    const issues = validatePipelineLogic(stages, undefined, knownMcps);
    const mcpIssues = issues.filter((i) => i.field === "mcps");
    expect(mcpIssues).toHaveLength(0);
  });

  it("should not crash when stage.mcps contains null elements", () => {
    const stages = [
      { name: "build", type: "agent" as const, mcps: ["notion", null as any, "figma"] },
    ];
    // Should either skip null elements or report them, but not crash
    expect(() => validatePipelineLogic(stages, undefined, knownMcps)).not.toThrow();
  });

  it("should not crash when stage.mcps contains empty string", () => {
    const stages = [
      { name: "build", type: "agent" as const, mcps: [""] },
    ];
    expect(() => validatePipelineLogic(stages, undefined, knownMcps)).not.toThrow();
    const issues = validatePipelineLogic(stages, undefined, knownMcps);
    const mcpIssues = issues.filter((i) => i.field === "mcps");
    // Empty string is not in knownMcps — should report error
    expect(mcpIssues).toHaveLength(1);
  });

  it("should handle knownMcps with whitespace variant names (exact match)", () => {
    const whitespaceSet = new Set(["notion", "notion "]);
    const stages = [
      { name: "build", type: "agent" as const, mcps: ["notion "] },
    ];
    const issues = validatePipelineLogic(stages, undefined, whitespaceSet);
    const mcpIssues = issues.filter((i) => i.field === "mcps");
    // "notion " is in the set — should pass
    expect(mcpIssues).toHaveLength(0);
  });

  it("should report error when stage.mcps is a string instead of array (YAML parse error)", () => {
    const stages = [
      { name: "build", type: "agent" as const, mcps: "notion" as any },
    ];
    // String is truthy but not iterable with for...of in the expected way
    // for (const mcp of "notion") iterates characters — each char fails lookup
    // This is a realistic YAML parse scenario: `mcps: notion` vs `mcps: [notion]`
    expect(() => validatePipelineLogic(stages, undefined, knownMcps)).not.toThrow();
  });

  it("validates MCPs across multiple parallel groups", () => {
    const stages = [
      {
        parallel: {
          name: "group1",
          stages: [
            { name: "a", type: "agent" as const, mcps: ["bad-mcp-1"], runtime: { writes: ["x"] } },
            { name: "b", type: "agent" as const, mcps: ["notion"], runtime: { writes: ["y"] } },
          ],
        },
      },
      {
        parallel: {
          name: "group2",
          stages: [
            { name: "c", type: "agent" as const, mcps: ["bad-mcp-2"], runtime: { writes: ["z"] } },
            { name: "d", type: "agent" as const, mcps: ["figma"], runtime: { writes: ["w"] } },
          ],
        },
      },
    ];
    const issues = validatePipelineLogic(stages as any, undefined, knownMcps);
    const mcpIssues = issues.filter((i) => i.field === "mcps");
    expect(mcpIssues).toHaveLength(2);
    expect(mcpIssues[0].message).toContain("bad-mcp-1");
    expect(mcpIssues[1].message).toContain("bad-mcp-2");
  });

  it("validates MCPs in mixed pipeline (regular + parallel stages)", () => {
    const stages = [
      { name: "analysis", type: "agent" as const, mcps: ["unknown-1"] },
      {
        parallel: {
          name: "research",
          stages: [
            { name: "a", type: "agent" as const, mcps: ["unknown-2"], runtime: { writes: ["x"] } },
            { name: "b", type: "agent" as const, mcps: ["context7"], runtime: { writes: ["y"] } },
          ],
        },
      },
      { name: "final", type: "agent" as const, mcps: ["notion"] },
    ];
    const issues = validatePipelineLogic(stages as any, undefined, knownMcps);
    const mcpIssues = issues.filter((i) => i.field === "mcps");
    expect(mcpIssues).toHaveLength(2);
  });
});
