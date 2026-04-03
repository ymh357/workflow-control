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

describe("persistSessionId – adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when snapshot is null", async () => {
    mockGetWorkflow.mockReturnValue({
      getSnapshot: () => null,
    });

    await expect(persistSessionId("task-1", "stage", "sess")).resolves.toBeUndefined();
  });

  it("does nothing when snapshot.context is undefined", async () => {
    mockGetWorkflow.mockReturnValue({
      getSnapshot: () => ({ context: undefined }),
    });

    await expect(persistSessionId("task-1", "stage", "sess")).resolves.toBeUndefined();
  });

  it("handles stageSessionIds being null (not undefined)", async () => {
    mockGetWorkflow.mockReturnValue({
      getSnapshot: () => ({ context: { stageSessionIds: null } }),
    });

    // null is falsy so the if check prevents assignment
    await expect(persistSessionId("task-1", "stage", "sess")).resolves.toBeUndefined();
  });

  it("can persist to multiple different stages on same context", async () => {
    const stageSessionIds: Record<string, string> = {};
    mockGetWorkflow.mockReturnValue({
      getSnapshot: () => ({ context: { stageSessionIds } }),
    });

    await persistSessionId("task-1", "analysis", "sess-1");
    await persistSessionId("task-1", "implementing", "sess-2");

    expect(stageSessionIds).toEqual({
      analysis: "sess-1",
      implementing: "sess-2",
    });
  });

  it("handles empty string stageName and sessionId", async () => {
    const stageSessionIds: Record<string, string> = {};
    mockGetWorkflow.mockReturnValue({
      getSnapshot: () => ({ context: { stageSessionIds } }),
    });

    await persistSessionId("task-1", "", "");
    expect(stageSessionIds[""]).toBe("");
  });

  it("silently catches when getSnapshot throws", async () => {
    mockGetWorkflow.mockReturnValue({
      getSnapshot: () => { throw new Error("snapshot failed"); },
    });

    await expect(persistSessionId("task-1", "stage", "sess")).resolves.toBeUndefined();
  });

  it("does not mutate stageSessionIds if it is a frozen object", async () => {
    const stageSessionIds = Object.freeze({}) as Record<string, string>;
    mockGetWorkflow.mockReturnValue({
      getSnapshot: () => ({ context: { stageSessionIds } }),
    });

    // Assigning to a frozen object throws in strict mode; the catch block handles it
    await expect(persistSessionId("task-1", "stage", "sess")).resolves.toBeUndefined();
  });
});
