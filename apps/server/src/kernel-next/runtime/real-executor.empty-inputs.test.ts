import { describe, it, expect } from "vitest";
import type { AgentStage, PortIR } from "../ir/schema.js";

/**
 * Test for the enhanced system prompt that handles empty inputs.
 * When collectTargetSources stage is invoked with empty pipelineConfig
 * and projectContext, the agent should be explicitly instructed to emit
 * write_port calls for all 8 output ports with appropriate empty/default values.
 */

// Inline the helper function for testing
function exampleValueFor(tsType: string): string {
  const t = tsType.trim();
  if (t === "number") return "42";
  if (t === "boolean") return "true";
  if (t === "string") return "\"example plain text value\"";
  if (t.endsWith("[]") || /^Array</.test(t)) return "[]";
  if (t === "object" || (t.startsWith("{") && t.endsWith("}"))) return "{}";
  return "\"...\"";
}

function buildSystemPromptAppend(
  stage: AgentStage,
  resolvedPrompt: string,
  inputs: Record<string, unknown>,
  ctx: { taskId: string; attemptId: string },
): string {
  const inputPortLines = stage.inputs
    .map((p) => `  - ${p.name}: ${p.type}`)
    .join("\n");
  const outputPortLines = stage.outputs
    .map((p) => `  - ${p.name}: ${p.type}`)
    .join("\n");
  const promptSummary =
    resolvedPrompt.length > 400
      ? resolvedPrompt.slice(0, 400) + " [...]"
      : resolvedPrompt;
  const inputDump = Object.keys(inputs).length === 0
    ? "  (no inputs)"
    : Object.entries(inputs)
        .map(([k, v]) => `  - ${k} = ${JSON.stringify(v)}`)
        .join("\n");

  // Per-port write_port call examples grounded in the actual IDs.
  const writeCallExamples = stage.outputs
    .map((p) => {
      const valueExample = exampleValueFor(p.type);
      return `  write_port(taskId="${ctx.taskId}", attemptId="${ctx.attemptId}", stage="${stage.name}", port="${p.name}", value=${valueExample})`;
    })
    .join("\n");

  // Check if inputs are empty or sparse (all provided inputs are empty objects/arrays)
  const allInputsEmpty = Object.entries(inputs).every(
    ([, v]) => v === null || v === undefined || (typeof v === "object" && Object.keys(v as Record<string, unknown>).length === 0),
  );
  const emptyInputsWarning = allInputsEmpty && Object.keys(inputs).length > 0
    ? "\n### IMPORTANT: Empty or sparse inputs detected\nAll provided inputs are empty. You must still emit write_port calls for all output ports. Use appropriate empty/default values:\n" +
      "  - For string ports: use an empty string \"\" or an error message\n" +
      "  - For number ports: use 0 or -1\n" +
      "  - For array ports (string[], etc.): use an empty array []\n" +
      "If you cannot proceed due to missing input data, emit these default values for each port and describe the issue in a string port (e.g., summary or error_message if available)."
    : "";

  return [
    `You are running stage '${stage.name}' in a kernel-next pipeline.`,
    "",
    "### Stage contract",
    "Input ports (already materialized in this message):",
    inputPortLines || "  (none)",
    "Output ports you MUST produce:",
    outputPortLines || "  (none)",
    "",
    "### Inputs",
    inputDump,
    "",
    "### Task",
    promptSummary,
    emptyInputsWarning,
    "",
    "### Output protocol (MANDATORY — read carefully)",
    "The ONLY way to emit output for this stage is to call the MCP tool",
    "  `mcp__kernel_next__write_port`",
    "exactly once per declared output port.",
  ].join("\n");
}

describe("real-executor: buildSystemPromptAppend with empty inputs", () => {
  it("includes empty inputs warning for collectTargetSources with empty pipelineConfig and projectContext", () => {
    const stage: AgentStage = {
      name: "collectTargetSources",
      type: "agent",
      inputs: [
        { name: "pipelineConfig", type: "unknown" },
        { name: "projectContext", type: "unknown" },
      ],
      outputs: [
        { name: "targetName", type: "string" },
        { name: "subjectType", type: "string" },
        { name: "officialSourceCount", type: "number" },
        { name: "spaWarnings", type: "string[]" },
        { name: "sourceCatalog", type: "string[]" },
        { name: "extractedFacts", type: "string[]" },
        { name: "reportPath", type: "string" },
        { name: "summary", type: "string" },
      ],
      config: { promptRef: "collect-target-sources" },
    };

    const result = buildSystemPromptAppend(
      stage,
      "Collect target sources for research",
      { pipelineConfig: {}, projectContext: {} },
      { taskId: "task-123", attemptId: "attempt-456" },
    );

    // Verify the warning is included
    expect(result).toContain("IMPORTANT: Empty or sparse inputs detected");
    expect(result).toContain("All provided inputs are empty");
    expect(result).toContain("You must still emit write_port calls for all output ports");

    // Verify guidance for different port types
    expect(result).toContain("For string ports: use an empty string");
    expect(result).toContain("For number ports: use 0 or -1");
    expect(result).toContain("For array ports (string[], etc.): use an empty array []");

    // Verify all 8 output ports are listed
    expect(result).toContain("targetName");
    expect(result).toContain("subjectType");
    expect(result).toContain("officialSourceCount");
    expect(result).toContain("spaWarnings");
    expect(result).toContain("sourceCatalog");
    expect(result).toContain("extractedFacts");
    expect(result).toContain("reportPath");
    expect(result).toContain("summary");

    // Verify write_port instructions are present
    expect(result).toContain("write_port");
    expect(result).toContain("mcp__kernel_next__write_port");
  });

  it("does not include warning when inputs are absent entirely", () => {
    const stage: AgentStage = {
      name: "simpleStage",
      type: "agent",
      inputs: [],
      outputs: [{ name: "result", type: "string" }],
      config: { promptRef: "simple" },
    };

    const result = buildSystemPromptAppend(
      stage,
      "Simple task",
      {},
      { taskId: "task-123", attemptId: "attempt-456" },
    );

    expect(result).not.toContain("IMPORTANT: Empty or sparse inputs detected");
    expect(result).toContain("(no inputs)");
  });

  it("does not include warning when inputs are provided and non-empty", () => {
    const stage: AgentStage = {
      name: "testStage",
      type: "agent",
      inputs: [{ name: "data", type: "string" }],
      outputs: [{ name: "result", type: "string" }],
      config: { promptRef: "test" },
    };

    const result = buildSystemPromptAppend(
      stage,
      "Test task",
      { data: "non-empty value" },
      { taskId: "task-123", attemptId: "attempt-456" },
    );

    expect(result).not.toContain("IMPORTANT: Empty or sparse inputs detected");
    expect(result).toContain("non-empty value");
  });

  it("includes warning when one input is empty and another is provided", () => {
    const stage: AgentStage = {
      name: "mixedInputStage",
      type: "agent",
      inputs: [
        { name: "config", type: "object" },
        { name: "data", type: "string" },
      ],
      outputs: [{ name: "output", type: "string" }],
      config: { promptRef: "mixed" },
    };

    const result = buildSystemPromptAppend(
      stage,
      "Mixed inputs task",
      { config: {}, data: "value" },
      { taskId: "task-123", attemptId: "attempt-456" },
    );

    // Should NOT include warning because not ALL inputs are empty
    expect(result).not.toContain("IMPORTANT: Empty or sparse inputs detected");
  });

  it("includes correct write_port examples for all 8 collectTargetSources output ports", () => {
    const stage: AgentStage = {
      name: "collectTargetSources",
      type: "agent",
      inputs: [
        { name: "pipelineConfig", type: "unknown" },
        { name: "projectContext", type: "unknown" },
      ],
      outputs: [
        { name: "targetName", type: "string" },
        { name: "subjectType", type: "string" },
        { name: "officialSourceCount", type: "number" },
        { name: "spaWarnings", type: "string[]" },
        { name: "sourceCatalog", type: "string[]" },
        { name: "extractedFacts", type: "string[]" },
        { name: "reportPath", type: "string" },
        { name: "summary", type: "string" },
      ],
      config: { promptRef: "collect-target-sources" },
    };

    const result = buildSystemPromptAppend(
      stage,
      "Collect",
      { pipelineConfig: {}, projectContext: {} },
      { taskId: "tid", attemptId: "aid" },
    );

    // Verify all 8 ports appear in the output port list
    expect(result).toContain("Output ports you MUST produce:");
    expect(result).toContain("- targetName: string");
    expect(result).toContain("- subjectType: string");
    expect(result).toContain("- officialSourceCount: number");
    expect(result).toContain("- spaWarnings: string[]");
    expect(result).toContain("- sourceCatalog: string[]");
    expect(result).toContain("- extractedFacts: string[]");
    expect(result).toContain("- reportPath: string");
    expect(result).toContain("- summary: string");

    // Verify the main instruction point about calling write_port for each port
    expect(result).toContain("write_port");
    expect(result).toContain("mcp__kernel_next__write_port");
  });
});
