import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockGetWorkflow = vi.fn();

vi.mock("../machine/actor-registry.js", () => ({
  getWorkflow: (...args: any[]) => mockGetWorkflow(...args),
}));

import { persistSessionId } from "./session-persister.js";

describe("persistSessionId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists session ID into stageSessionIds", async () => {
    const stageSessionIds: Record<string, string> = {};
    mockGetWorkflow.mockReturnValue({
      getSnapshot: () => ({ context: { stageSessionIds } }),
    });

    await persistSessionId("task-1", "implementing", "sess-abc");

    expect(stageSessionIds["implementing"]).toBe("sess-abc");
  });

  it("calls getWorkflow with the correct taskId", async () => {
    mockGetWorkflow.mockReturnValue(null);

    await persistSessionId("task-77", "stage1", "sess-1");

    expect(mockGetWorkflow).toHaveBeenCalledWith("task-77");
  });

  it("does nothing when actor is null", async () => {
    mockGetWorkflow.mockReturnValue(null);

    // Should not throw
    await expect(persistSessionId("task-1", "stage1", "sess-1")).resolves.toBeUndefined();
  });

  it("does nothing when stageSessionIds is missing from context", async () => {
    mockGetWorkflow.mockReturnValue({
      getSnapshot: () => ({ context: {} }),
    });

    // Should not throw
    await expect(persistSessionId("task-1", "stage1", "sess-1")).resolves.toBeUndefined();
  });

  it("silently catches errors from dynamic import or getWorkflow", async () => {
    mockGetWorkflow.mockImplementation(() => { throw new Error("boom"); });

    // Should not throw
    await expect(persistSessionId("task-1", "stage1", "sess-1")).resolves.toBeUndefined();
  });

  it("overwrites existing session ID for the same stage", async () => {
    const stageSessionIds: Record<string, string> = { implementing: "old-sess" };
    mockGetWorkflow.mockReturnValue({
      getSnapshot: () => ({ context: { stageSessionIds } }),
    });

    await persistSessionId("task-1", "implementing", "new-sess");

    expect(stageSessionIds["implementing"]).toBe("new-sess");
  });
});
