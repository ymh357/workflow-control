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

describe("actor - timeout passed to createSlot", () => {
  it("passes 30-minute timeout (1_800_000 ms) to createSlot", async () => {
    mockCreateSlot.mockResolvedValue({ resultText: "ok", costUsd: 0, durationMs: 0 });

    await runEdgeAgent("task-1", makeInput());

    expect(mockCreateSlot).toHaveBeenCalledWith("task-1", "analysis", 30 * 60 * 1000);
  });

  it("always uses DEFAULT_EDGE_TIMEOUT_MS regardless of input", async () => {
    mockCreateSlot.mockResolvedValue({ resultText: "ok", costUsd: 0, durationMs: 0 });

    await runEdgeAgent("task-2", makeInput({ stageName: "coding" }));

    const timeoutArg = mockCreateSlot.mock.calls[0][2];
    expect(timeoutArg).toBe(1_800_000);
  });
});

describe("actor - SSE status message format", () => {
  it("pushes a status message with correct taskId and stageName", async () => {
    mockCreateSlot.mockResolvedValue({ resultText: "done", costUsd: 0, durationMs: 0 });

    await runEdgeAgent("task-3", makeInput({ stageName: "review" }));

    expect(mockPushMessage).toHaveBeenCalledOnce();
    const [taskId, msg] = mockPushMessage.mock.calls[0] as [string, any];
    expect(taskId).toBe("task-3");
    expect(msg.type).toBe("status");
    expect(msg.taskId).toBe("task-3");
    expect(msg.data.status).toBe("review");
    expect(msg.data.message).toContain("review");
    expect(msg.data.message).toContain("edge agent");
  });

  it("includes a valid ISO timestamp in the SSE message", async () => {
    mockCreateSlot.mockResolvedValue({ resultText: "done", costUsd: 0, durationMs: 0 });

    await runEdgeAgent("task-4", makeInput());

    const msg = mockPushMessage.mock.calls[0][1];
    expect(() => new Date(msg.timestamp).toISOString()).not.toThrow();
    expect(msg.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("SSE message is pushed before createSlot is called", async () => {
    const callOrder: string[] = [];
    mockPushMessage.mockImplementation(() => { callOrder.push("sse"); return undefined as any; });
    mockCreateSlot.mockImplementation((() => {
      callOrder.push("slot");
      return Promise.resolve({ resultText: "ok", costUsd: 0, durationMs: 0 });
    }) as any);

    await runEdgeAgent("task-5", makeInput());

    expect(callOrder).toEqual(["sse", "slot"]);
  });
});

describe("actor - slot rejection handling", () => {
  it("propagates rejection from createSlot as-is", async () => {
    mockCreateSlot.mockRejectedValue(new Error("Edge agent timed out after 1800s") as never);

    await expect(runEdgeAgent("task-6", makeInput())).rejects.toThrow("Edge agent timed out");
  });

  it("propagates slot replacement error", async () => {
    mockCreateSlot.mockRejectedValue(new Error("Edge slot for \"analysis\" replaced by new invocation") as never);

    await expect(runEdgeAgent("task-7", makeInput())).rejects.toThrow("replaced by new invocation");
  });

  it("returns the AgentResult from createSlot on success", async () => {
    const expectedResult = { resultText: '{"plan":"do stuff"}', sessionId: "sess-1", costUsd: 0.5, durationMs: 12000 };
    mockCreateSlot.mockResolvedValue(expectedResult);

    const result = await runEdgeAgent("task-8", makeInput());

    expect(result).toEqual(expectedResult);
  });

  it("still pushes SSE even if createSlot rejects", async () => {
    mockCreateSlot.mockRejectedValue(new Error("timeout") as never);

    await runEdgeAgent("task-9", makeInput()).catch(() => {});

    expect(mockPushMessage).toHaveBeenCalledOnce();
  });
});
