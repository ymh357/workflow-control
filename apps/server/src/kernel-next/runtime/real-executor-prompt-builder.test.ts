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
