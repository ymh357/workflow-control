import { describe, it, expect } from "vitest";
import type { AgentStage } from "../ir/schema.js";
import { buildSystemPromptAppend } from "./real-executor.js";

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

describe("real-executor: buildSystemPromptAppend size-aware input handling", () => {
  const tinyStage: AgentStage = {
    name: "s1",
    type: "agent",
    inputs: [{ name: "p", type: "string" }],
    outputs: [{ name: "out", type: "string" }],
    config: { promptRef: "p" },
  };

  it("inlines small port value in full", () => {
    const result = buildSystemPromptAppend(
      tinyStage,
      "task",
      { p: "short" },
      { taskId: "t", attemptId: "a" },
    );
    expect(result).toContain('- p = "short"');
    expect(result).not.toContain("[large");
    expect(result).not.toContain("read_port");
  });

  it("inlines exactly up to the character limit", () => {
    // JSON.stringify of a 1022-char string produces a 1024-char JSON
    // string (quotes on both ends). That equals INLINE_PORT_VALUE_CHAR_LIMIT.
    const str = "x".repeat(1022);
    const result = buildSystemPromptAppend(
      tinyStage,
      "task",
      { p: str },
      { taskId: "t", attemptId: "a" },
    );
    expect(result).toContain(str);
    expect(result).not.toContain("[large");
  });

  it("replaces large port value with size summary + read_port instruction", () => {
    const str = "x".repeat(5_000);
    const result = buildSystemPromptAppend(
      tinyStage,
      "task",
      { p: str },
      { taskId: "task-A", attemptId: "attempt-B" },
    );
    // Summary line
    expect(result).toMatch(/- p \[large; \d+ chars as JSON; type: string\]/);
    // read_port instruction with exact IDs
    expect(result).toContain(
      'Call mcp__kernel_next__read_port with { taskId: "task-A", stage: "s1", port: "p" }',
    );
    // Actual large content is NOT inlined
    expect(result).not.toContain(str);
  });

  it("large object value reports type as object", () => {
    const big = { k: "y".repeat(5_000) };
    const result = buildSystemPromptAppend(
      tinyStage,
      "task",
      { p: big },
      { taskId: "t", attemptId: "a" },
    );
    expect(result).toMatch(/type: object/);
    expect(result).not.toContain(big.k);
  });

  it("mixes small + large inputs independently", () => {
    const multiStage: AgentStage = {
      name: "s1",
      type: "agent",
      inputs: [
        { name: "small", type: "string" },
        { name: "big", type: "string" },
      ],
      outputs: [{ name: "out", type: "string" }],
      config: { promptRef: "p" },
    };
    const small = "hello";
    const big = "z".repeat(5_000);
    const result = buildSystemPromptAppend(
      multiStage,
      "task",
      { small, big },
      { taskId: "t", attemptId: "a" },
    );
    expect(result).toContain('- small = "hello"');
    expect(result).toMatch(/- big \[large;/);
    expect(result).not.toContain(big);
  });
});
