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
