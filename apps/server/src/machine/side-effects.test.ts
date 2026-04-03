import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const pushMessage = vi.fn();
const closeStream = vi.fn();
vi.mock("../sse/manager.js", () => ({
  sseManager: { pushMessage, closeStream },
}));

const broadcastTaskUpdate = vi.fn();
vi.mock("../sse/task-list-broadcaster.js", () => ({
  taskListBroadcaster: { broadcastTaskUpdate },
}));

const notifyBlocked = vi.fn().mockResolvedValue(undefined);
const notifyStageComplete = vi.fn().mockResolvedValue(undefined);
const notifyCompleted = vi.fn().mockResolvedValue(undefined);
const notifyCancelled = vi.fn().mockResolvedValue(undefined);
const notifyGenericGate = vi.fn().mockResolvedValue(undefined);
vi.mock("../lib/slack.js", () => ({
  notifyBlocked,
  notifyStageComplete,
  notifyCompleted,
  notifyCancelled,
  notifyGenericGate,
}));

const updateNotionPageStatus = vi.fn().mockResolvedValue(undefined);
vi.mock("../lib/notion.js", () => ({
  updateNotionPageStatus,
}));

const writeArtifact = vi.fn().mockResolvedValue(undefined);
vi.mock("../lib/artifacts.js", () => ({
  writeArtifact,
}));

const cancelTask = vi.fn();
vi.mock("../agent/query-tracker.js", () => ({
  cancelTask,
}));

const clearTaskSlots = vi.fn();
const notifyTaskTerminated = vi.fn();
vi.mock("../edge/registry.js", () => ({
  clearTaskSlots,
  notifyTaskTerminated,
}));

const cancelForTask = vi.fn();
vi.mock("../lib/question-manager.js", () => ({
  questionManager: { cancelForTask },
}));

vi.mock("../lib/logger.js", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { taskLogger: () => logger };
});

vi.mock("../lib/safe-fire.js", () => ({
  safeFire: (p: Promise<unknown>) => {
    p.catch(() => {});
  },
}));

const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

// ── Fake actor ───────────────────────────────────────────────────────────────

function createFakeActor() {
  const handlers = new Map<string, Function[]>();
  return {
    on(type: string, handler: Function) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type)!.push(handler);
      return {
        unsubscribe() {
          const fns = handlers.get(type);
          if (fns) {
            const idx = fns.indexOf(handler);
            if (idx !== -1) fns.splice(idx, 1);
          }
        },
      };
    },
    emit(event: { type: string; [key: string]: unknown }) {
      const fns = handlers.get(event.type) ?? [];
      for (const fn of fns) fn(event);
    },
    registeredEvents(): string[] {
      return [...handlers.keys()];
    },
  };
}

// ── Import under test (after mocks) ─────────────────────────────────────────

const { registerSideEffects } = await import("./side-effects.js");

// ── Tests ────────────────────────────────────────────────────────────────────

describe("registerSideEffects", () => {
  let actor: ReturnType<typeof createFakeActor>;

  beforeEach(() => {
    vi.clearAllMocks();
    actor = createFakeActor();
    registerSideEffects(actor as any);
  });

  // 1. Registers handlers for all expected event types
  it("registers handlers for all 15 event types", () => {
    const events = actor.registeredEvents();
    expect(events).toContain("wf.status");
    expect(events).toContain("wf.error");
    expect(events).toContain("wf.costUpdate");
    expect(events).toContain("wf.streamClose");
    expect(events).toContain("wf.notionSync");
    expect(events).toContain("wf.slackBlocked");
    expect(events).toContain("wf.slackStageComplete");
    expect(events).toContain("wf.slackCompleted");
    expect(events).toContain("wf.slackCancelled");
    expect(events).toContain("wf.slackGate");
    expect(events).toContain("wf.taskListUpdate");
    expect(events).toContain("wf.persistSession");
    expect(events).toContain("wf.cancelAgent");
    expect(events).toContain("wf.cancelQuestions");
    expect(events).toContain("wf.worktreeCleanup");
  });

  // 2. wf.status routes to SSE pushMessage with correct shape
  it("wf.status pushes SSE message with status and message fields", () => {
    actor.emit({ type: "wf.status", taskId: "t1", status: "running", message: "step 1" });

    expect(pushMessage).toHaveBeenCalledOnce();
    const [taskId, payload] = pushMessage.mock.calls[0];
    expect(taskId).toBe("t1");
    expect(payload.type).toBe("status");
    expect(payload.data).toEqual({ status: "running", message: "step 1" });
  });

  // 3. wf.error routes to SSE pushMessage with error field
  it("wf.error pushes SSE error message", () => {
    actor.emit({ type: "wf.error", taskId: "t2", error: "boom" });

    const [, payload] = pushMessage.mock.calls[0];
    expect(payload.type).toBe("error");
    expect(payload.data).toEqual({ error: "boom" });
  });

  // 4. wf.costUpdate routes to SSE with cost data
  it("wf.costUpdate pushes cost_update SSE message", () => {
    actor.emit({ type: "wf.costUpdate", taskId: "t3", totalCostUsd: 2.0, stageCostUsd: 0.5 });

    const [, payload] = pushMessage.mock.calls[0];
    expect(payload.type).toBe("cost_update");
    expect(payload.data.totalCostUsd).toBe(2.0);
    expect(payload.data.stageCostUsd).toBe(0.5);
  });

  // 5. wf.streamClose closes SSE stream and notifies termination
  it("wf.streamClose closes stream and notifies terminated", () => {
    actor.emit({ type: "wf.streamClose", taskId: "t4" });

    expect(closeStream).toHaveBeenCalledWith("t4");
    expect(notifyTaskTerminated).toHaveBeenCalledWith("t4", "completed or error");
  });

  // 6. wf.slackBlocked calls notifyBlocked and notifyTaskTerminated
  it("wf.slackBlocked triggers Slack notify and task termination", () => {
    actor.emit({ type: "wf.slackBlocked", taskId: "t6", stage: "deploy", error: "timeout" });

    expect(notifyBlocked).toHaveBeenCalledWith("t6", "deploy", "timeout");
    expect(notifyTaskTerminated).toHaveBeenCalledWith("t6", "blocked");
  });

  // 7. wf.cancelAgent calls cancelTask + clearTaskSlots + notifyTaskTerminated
  it("wf.cancelAgent orchestrates full cancellation", () => {
    actor.emit({ type: "wf.cancelAgent", taskId: "t7" });

    expect(cancelTask).toHaveBeenCalledWith("t7");
    expect(clearTaskSlots).toHaveBeenCalledWith("t7");
    expect(notifyTaskTerminated).toHaveBeenCalledWith("t7", "cancelled");
  });

  // 8. wf.persistSession skips when worktreePath is missing
  it("wf.persistSession does nothing when worktreePath is absent", () => {
    actor.emit({ type: "wf.persistSession", sessionId: "s1" });

    expect(writeArtifact).not.toHaveBeenCalled();
  });

  // 9. wf.persistSession skips when sessionId is missing
  it("wf.persistSession does nothing when sessionId is absent", () => {
    actor.emit({ type: "wf.persistSession", worktreePath: "/tmp/wt" });

    expect(writeArtifact).not.toHaveBeenCalled();
  });

  // 10. wf.notionSync skips when notionPageId is missing
  it("wf.notionSync does nothing when notionPageId is absent", () => {
    actor.emit({ type: "wf.notionSync", taskId: "t10", status: "running" });

    expect(updateNotionPageStatus).not.toHaveBeenCalled();
  });

  // 11. Error isolation: one handler throwing does not block others
  it("error in one handler does not prevent other event handlers from working", () => {
    // Make pushMessage throw on first call
    pushMessage.mockImplementationOnce(() => {
      throw new Error("SSE broken");
    });

    // wf.status will throw
    expect(() => {
      actor.emit({ type: "wf.status", taskId: "bad", status: "x" });
    }).toThrow("SSE broken");

    // But other handlers should still work fine
    actor.emit({ type: "wf.taskListUpdate", taskId: "ok" });
    expect(broadcastTaskUpdate).toHaveBeenCalledWith("ok");

    actor.emit({ type: "wf.cancelQuestions", taskId: "ok2" });
    expect(cancelForTask).toHaveBeenCalledWith("ok2");
  });

  // 12. wf.worktreeCleanup calls git worktree remove via execFile
  it("wf.worktreeCleanup invokes git worktree remove", async () => {
    actor.emit({ type: "wf.worktreeCleanup", taskId: "t12", worktreePath: "/tmp/wt-rm" });

    // Handler uses dynamic import(), so yield to microtask queue
    await new Promise((r) => setTimeout(r, 50));

    expect(execFileMock).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "--force", "/tmp/wt-rm"],
      { timeout: 30_000 },
      expect.any(Function),
    );
  });
});
