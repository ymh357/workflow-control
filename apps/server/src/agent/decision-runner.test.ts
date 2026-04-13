import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LlmDecisionInput } from "./decision-runner.js";

vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../lib/config-loader.js", () => ({
  getNestedValue: (store: Record<string, any>, path: string) => {
    const parts = path.split(".");
    let val: any = store;
    for (const p of parts) {
      if (val == null) return undefined;
      val = val[p];
    }
    return val;
  },
  loadSystemSettings: () => ({ paths: { data_dir: "/tmp/test" } }),
}));

vi.mock("./context-builder.js", () => ({
  buildTier1Context: () => "test context",
}));

// Mock Anthropic SDK
const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

import { runLlmDecision } from "./decision-runner.js";

function makeInput(overrides?: Partial<LlmDecisionInput>): LlmDecisionInput {
  return {
    taskId: "test-task",
    stageName: "route",
    context: {
      taskId: "test-task",
      status: "running",
      retryCount: 0,
      qaRetryCount: 0,
      stageSessionIds: {},
      store: { analysis: { complexity: "high" } },
    } as any,
    runtime: {
      engine: "llm_decision" as const,
      prompt: "Decide the approach",
      reads: { analysis: "analysis" },
      choices: [
        { id: "simple", description: "Simple", goto: "quick_execute" },
        { id: "complex", description: "Complex", goto: "detailed_plan" },
      ],
      default_choice: "complex",
    },
    ...overrides,
  };
}

describe("runLlmDecision", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("returns matched choice when LLM responds with valid id", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "simple" }],
    });

    const result = await runLlmDecision("test-task", makeInput());
    expect(result).toEqual({ choiceId: "simple", goto: "quick_execute" });
  });

  it("returns default choice when LLM response doesn't match", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "something random" }],
    });

    const result = await runLlmDecision("test-task", makeInput());
    expect(result).toEqual({ choiceId: "complex", goto: "detailed_plan" });
  });

  it("returns default choice on LLM API error", async () => {
    mockCreate.mockRejectedValue(new Error("API timeout"));

    const result = await runLlmDecision("test-task", makeInput());
    expect(result).toEqual({ choiceId: "complex", goto: "detailed_plan" });
  });

  it("matches case-insensitively", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "SIMPLE" }],
    });

    const result = await runLlmDecision("test-task", makeInput());
    expect(result).toEqual({ choiceId: "simple", goto: "quick_execute" });
  });

  it("matches when response contains the choice id", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "I think simple is the right choice" }],
    });

    const result = await runLlmDecision("test-task", makeInput());
    expect(result).toEqual({ choiceId: "simple", goto: "quick_execute" });
  });
});
