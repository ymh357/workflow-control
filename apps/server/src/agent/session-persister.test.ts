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
const mockPersistSnapshot = vi.fn<(taskId: string, actor: unknown) => Promise<void>>(async () => {});

vi.mock("../machine/actor-registry.js", () => ({
  getWorkflow: (taskId: string) => mockGetWorkflow(taskId),
}));
vi.mock("../machine/persistence.js", () => ({
  persistSnapshot: (taskId: string, actor: unknown) => mockPersistSnapshot(taskId, actor),
}));

import { persistSessionId } from "./session-persister.js";

describe("persistSessionId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches PERSIST_SESSION_ID event to the actor", async () => {
    // The new contract: persistSessionId sends an event instead of mutating
    // snapshot context directly. Mutating was a real bug (see bug #2 in
    // review) because XState v5 context is supposed to be immutable and
    // subscribers don't fire on direct mutation.
    const send = vi.fn();
    mockGetWorkflow.mockReturnValue({
      send,
      getSnapshot: () => ({ context: { stageSessionIds: {} } }),
    });

    await persistSessionId("task-1", "implementing", "sess-abc");

    expect(send).toHaveBeenCalledWith({
      type: "PERSIST_SESSION_ID",
      stageName: "implementing",
      sessionId: "sess-abc",
    });
  });

  it("triggers snapshot flush after dispatching", async () => {
    const send = vi.fn();
    const actor = { send, getSnapshot: () => ({ context: { stageSessionIds: {} } }) };
    mockGetWorkflow.mockReturnValue(actor);

    await persistSessionId("task-1", "implementing", "sess-abc");

    expect(mockPersistSnapshot).toHaveBeenCalledWith("task-1", actor);
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
    expect(mockPersistSnapshot).not.toHaveBeenCalled();
  });

  it("silently catches errors from dynamic import or getWorkflow", async () => {
    mockGetWorkflow.mockImplementation(() => { throw new Error("boom"); });

    // Should not throw
    await expect(persistSessionId("task-1", "stage1", "sess-1")).resolves.toBeUndefined();
  });

  it("dispatches the same event even when an existing session id is present", async () => {
    // The reducer in machine.ts de-duplicates when the value is unchanged;
    // the test just verifies the event is always dispatched (reducer owns
    // the de-dup logic).
    const send = vi.fn();
    mockGetWorkflow.mockReturnValue({
      send,
      getSnapshot: () => ({ context: { stageSessionIds: { implementing: "old-sess" } } }),
    });

    await persistSessionId("task-1", "implementing", "new-sess");

    expect(send).toHaveBeenCalledWith({
      type: "PERSIST_SESSION_ID",
      stageName: "implementing",
      sessionId: "new-sess",
    });
  });
});
