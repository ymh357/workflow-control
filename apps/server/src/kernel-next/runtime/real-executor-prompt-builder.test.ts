import { describe, it, expect } from "vitest";
import { buildSystemPromptAppend } from "./real-executor-prompt-builder.js";
import type { AgentStage } from "../ir/schema.js";

describe("real-executor-prompt-builder: public signature preserved after extraction", () => {
  it("emits write_port with 4-underscore MCP form for an agent stage output", () => {
    const stage: AgentStage = {
      name: "t",
      type: "agent",
      inputs: [],
      outputs: [{ name: "out", type: "string" }],
      config: { promptRef: "p" },
    };
    const result = buildSystemPromptAppend(stage, "task", {}, { taskId: "t", attemptId: "a" });
    expect(result).toContain("mcp____kernel_next____write_port");
  });
});

describe("buildSystemPromptAppend continuationMode", () => {
  const stage: AgentStage = {
    name: "writePr",
    type: "agent",
    inputs: [{ name: "diff", type: "string" }],
    outputs: [{ name: "prText", type: "string" }],
    config: { promptRef: "system/write-pr" },
  };

  it("includes Inputs section when continuationMode is true", () => {
    const out = buildSystemPromptAppend(
      stage,
      "Now produce the PR description.",
      { diff: "+++ a\n--- b\n" },
      { taskId: "t1", attemptId: "a1" },
      null,
      undefined,
      { continuationMode: true },
    );
    expect(out).toContain("Inputs");
    expect(out).toContain("diff");
  });

  it("omits Stage-contract overview in continuation form, keeps Output protocol", () => {
    const fullForm = buildSystemPromptAppend(
      stage,
      "Now produce the PR description.",
      { diff: "+++" },
      { taskId: "t1", attemptId: "a1" },
    );
    const continuationForm = buildSystemPromptAppend(
      stage,
      "Now produce the PR description.",
      { diff: "+++" },
      { taskId: "t1", attemptId: "a1" },
      null,
      undefined,
      { continuationMode: true },
    );
    // Continuation is shorter (no preamble, no Stage-contract block)
    expect(continuationForm.length).toBeLessThan(fullForm.length);
    // Stage-contract block must be gone
    expect(continuationForm).not.toContain("Stage contract");
    expect(continuationForm).not.toContain("You are running stage");
    // Output protocol must remain — this stage's output ports still need to be written
    expect(continuationForm).toContain("Output protocol");
    expect(continuationForm).toContain("write_port");
    expect(continuationForm).toContain("CRITICAL RULES");
    // Identity for this attempt (taskId/attemptId) also remains
    expect(continuationForm).toContain("t1");
    expect(continuationForm).toContain("a1");
  });

  it("non-continuation behaves identically (no flag) to default call", () => {
    const a = buildSystemPromptAppend(stage, "x", {}, { taskId: "t1", attemptId: "a1" });
    const b = buildSystemPromptAppend(stage, "x", {}, { taskId: "t1", attemptId: "a1" }, null, undefined);
    expect(a).toBe(b);
  });
});

// Continuation-3 dogfood regression: large external-source inputs were
// emitting the read_port hint with stage="<consuming-stage>" + port="<local-port>",
// which always returned port_not_declared (the seed phase writes port_values
// rows under stage_name="__external__" with the ORIGINAL externalInputs port
// name, not the consuming stage's local port name). The agent saw a broken
// hint and fell through to a placeholder design path. Discovered when
// pipeline-generator was asked to design web3-tech-research from a 7KB
// task description that exceeded INLINE_PORT_VALUE_CHAR_LIMIT.
describe("buildSystemPromptAppend large external-source input (read_port hint)", () => {
  const consumingStage: AgentStage = {
    name: "analyzing",
    type: "agent",
    inputs: [{ name: "taskText", type: "string" }],
    outputs: [{ name: "summary", type: "string" }],
    config: { promptRef: "p" },
  };

  it("emits read_port hint with stage='__external__' + the ORIGINAL external port name", () => {
    // External wire: __external__.taskDescription → analyzing.taskText
    // (port renaming across the wire is legal kernel behavior).
    const ir = {
      name: "p",
      externalInputs: [{ name: "taskDescription", type: "string" }],
      stages: [consumingStage],
      wires: [
        {
          from: { source: "external" as const, port: "taskDescription" },
          to: { stage: "analyzing", port: "taskText" },
        },
      ],
    };
    // 1500-char string > INLINE_PORT_VALUE_CHAR_LIMIT (1024) so the
    // large-value branch fires.
    const largeText = "x".repeat(1500);
    const out = buildSystemPromptAppend(
      consumingStage,
      "task",
      { taskText: largeText },
      { taskId: "t1", attemptId: "a1" },
      null,
      ir,
    );
    expect(out).toContain('stage: "__external__"');
    expect(out).toContain('port: "taskDescription"');
    // Should NOT point at the consuming stage / local port
    expect(out).not.toContain('stage: "analyzing", port: "taskText"');
  });

  it("for stage-source large input still uses the source stage + source port", () => {
    const downstream: AgentStage = {
      name: "downstream",
      type: "agent",
      inputs: [{ name: "blob", type: "string" }],
      outputs: [{ name: "out", type: "string" }],
      config: { promptRef: "p" },
    };
    const upstream: AgentStage = {
      name: "upstream",
      type: "agent",
      inputs: [],
      outputs: [{ name: "raw", type: "string" }],
      config: { promptRef: "p" },
    };
    const ir = {
      name: "p",
      externalInputs: [],
      stages: [upstream, downstream],
      wires: [
        {
          from: { source: "stage" as const, stage: "upstream", port: "raw" },
          to: { stage: "downstream", port: "blob" },
        },
      ],
    };
    const largeText = "y".repeat(1500);
    const out = buildSystemPromptAppend(
      downstream,
      "task",
      { blob: largeText },
      { taskId: "t1", attemptId: "a1" },
      null,
      ir,
    );
    expect(out).toContain('stage: "upstream"');
    expect(out).toContain('port: "raw"');
  });
});
