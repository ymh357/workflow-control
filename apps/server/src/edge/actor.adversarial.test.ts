import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../sse/manager.js", () => ({
  sseManager: { pushMessage: vi.fn() },
}));

vi.mock("./registry.js", () => ({
  createSlot: vi.fn(),
}));

import { runEdgeAgent } from "./actor.js";
import { sseManager } from "../sse/manager.js";
import { createSlot } from "./registry.js";

const mockPushMessage = vi.mocked(sseManager.pushMessage);
const mockCreateSlot = vi.mocked(createSlot);

beforeEach(() => {
  vi.clearAllMocks();
});

function makeInput(overrides: Partial<Parameters<typeof runEdgeAgent>[1]> = {}): Parameters<typeof runEdgeAgent>[1] {
  return {
    stageName: "analysis",
    runtime: { engine: "llm" as const, system_prompt: "test" },
    worktreePath: "/tmp/worktree",
    tier1Context: "context",
    attempt: 1,
    ...overrides,
  };
}

describe("actor — adversarial", () => {
  it("handles taskId with special characters in SSE message", async () => {
    mockCreateSlot.mockResolvedValue({ resultText: "ok", costUsd: 0, durationMs: 0 });

    await runEdgeAgent('<script>alert("xss")</script>', makeInput());

    expect(mockPushMessage).toHaveBeenCalledOnce();
    const [taskId] = mockPushMessage.mock.calls[0];
    expect(taskId).toBe('<script>alert("xss")</script>');
  });

  it("handles stageName with null bytes", async () => {
    mockCreateSlot.mockResolvedValue({ resultText: "ok", costUsd: 0, durationMs: 0 });

    await runEdgeAgent("task-1", makeInput({ stageName: "stage\0evil" }));

    expect(mockCreateSlot).toHaveBeenCalledWith("task-1", "stage\0evil", 30 * 60 * 1000);
  });

  it("handles empty stageName", async () => {
    mockCreateSlot.mockResolvedValue({ resultText: "ok", costUsd: 0, durationMs: 0 });

    await runEdgeAgent("task-1", makeInput({ stageName: "" }));

    const msg = mockPushMessage.mock.calls[0][1] as any;
    expect(msg.data.status).toBe("");
    expect(msg.data.message).toContain('""');
  });

  it("createSlot rejection with non-Error value", async () => {
    mockCreateSlot.mockRejectedValue("string rejection" as never);

    await expect(runEdgeAgent("task-1", makeInput())).rejects.toBe("string rejection");
  });

  it("pushMessage is called even when createSlot rejects synchronously", async () => {
    mockCreateSlot.mockImplementation(() => {
      throw new Error("sync throw from createSlot");
    });

    await expect(runEdgeAgent("task-1", makeInput())).rejects.toThrow("sync throw from createSlot");
    expect(mockPushMessage).toHaveBeenCalledOnce();
  });

  it("concurrent runEdgeAgent calls for same task/stage", async () => {
    let resolveFirst: (v: any) => void;
    const firstPromise = new Promise((r) => { resolveFirst = r; });

    mockCreateSlot
      .mockImplementationOnce(() => firstPromise as any)
      .mockResolvedValueOnce({ resultText: "second", costUsd: 0, durationMs: 0 });

    const run1 = runEdgeAgent("task-1", makeInput());
    const run2 = runEdgeAgent("task-1", makeInput());

    resolveFirst!({ resultText: "first", costUsd: 0, durationMs: 0 });

    const [result1, result2] = await Promise.all([run1, run2]);
    expect(result1.resultText).toBe("first");
    expect(result2.resultText).toBe("second");
    expect(mockPushMessage).toHaveBeenCalledTimes(2);
  });

  it("returns exact AgentResult shape from createSlot", async () => {
    const fullResult = {
      resultText: '{"key": "value"}',
      sessionId: "sess-123",
      costUsd: 2.5,
      durationMs: 45000,
    };
    mockCreateSlot.mockResolvedValue(fullResult);

    const result = await runEdgeAgent("task-1", makeInput());
    expect(result).toStrictEqual(fullResult);
  });
});
