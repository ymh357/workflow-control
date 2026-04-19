import { describe, it, expect } from "vitest";
import { TrivialPromptResolver } from "./prompt-resolver.js";
import type { AgentStage } from "../ir/schema.js";

function stage(promptRef: string): AgentStage {
  return {
    name: "s",
    type: "agent",
    inputs: [],
    outputs: [],
    config: { promptRef },
  };
}

describe("TrivialPromptResolver", () => {
  it("returns promptRef verbatim", () => {
    const r = new TrivialPromptResolver();
    expect(
      r.resolve({
        stage: stage("do the thing"),
        taskId: "t",
        attemptId: "a",
        inputs: {},
      }),
    ).toBe("do the thing");
  });

  it("throws when promptRef is empty / whitespace-only", () => {
    const r = new TrivialPromptResolver();
    expect(() =>
      r.resolve({ stage: stage(""), taskId: "t", attemptId: "a", inputs: {} }),
    ).toThrow(/empty promptRef/);
    expect(() =>
      r.resolve({ stage: stage("   "), taskId: "t", attemptId: "a", inputs: {} }),
    ).toThrow(/empty promptRef/);
  });

  it("ignores inputs / taskId / attemptId (trivial resolver does not splice)", () => {
    const r = new TrivialPromptResolver();
    const out = r.resolve({
      stage: stage("literal"),
      taskId: "task-123",
      attemptId: "attempt-456",
      inputs: { a: 1, b: "x" },
    });
    expect(out).toBe("literal");
  });
});
