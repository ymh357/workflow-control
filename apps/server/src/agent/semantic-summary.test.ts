import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

import { generateSemanticSummary } from "./semantic-summary.js";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("generateSemanticSummary", () => {
  it("returns LLM-generated summary for a value with summary_prompt", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "5 tasks total, currently on task 3, overall approach is TDD" }],
    });

    const result = await generateSemanticSummary(
      "test-task",
      "tasks",
      { items: ["a", "b", "c", "d", "e"], current: 3 },
      "Summarize: how many tasks, current progress",
    );

    expect(result).toBe("5 tasks total, currently on task 3, overall approach is TDD");
    expect(mockCreate).toHaveBeenCalledOnce();
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe("claude-haiku-4-5-20251001");
    expect(callArgs.max_tokens).toBe(300);
    expect(callArgs.messages[0].content).toContain("Summarize: how many tasks, current progress");
  });

  it("truncates large values to 4000 chars", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "summary" }],
    });

    const largeValue = "x".repeat(10000);
    await generateSemanticSummary("test-task", "key", largeValue, "summarize");

    const callArgs = mockCreate.mock.calls[0][0];
    const content = callArgs.messages[0].content;
    expect(content).toContain("... [truncated]");
  });

  it("returns null when LLM call fails", async () => {
    mockCreate.mockRejectedValue(new Error("API error"));

    const result = await generateSemanticSummary("test-task", "key", { data: true }, "summarize");
    expect(result).toBeNull();
  });

  it("returns null when response has no text content", async () => {
    mockCreate.mockResolvedValue({ content: [] });

    const result = await generateSemanticSummary("test-task", "key", { data: true }, "summarize");
    expect(result).toBeNull();
  });
});
