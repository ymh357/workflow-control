import { describe, it, expect, vi, beforeEach } from "vitest";

// -- Mocks --

const mockSendEvent = vi.fn();
const mockGetWorkflow = vi.fn();
const mockRestoreWorkflow = vi.fn();
const mockDeleteWorkflow = vi.fn();
const mockCreateTaskDraft = vi.fn();
const mockLaunchTask = vi.fn();

const mockGetAllWorkflows = vi.fn(() => new Map());

vi.mock("../machine/actor-registry.js", () => ({
  sendEvent: (...args: unknown[]) => mockSendEvent(...args),
  getWorkflow: (...args: unknown[]) => mockGetWorkflow(...args),
  getAllWorkflows: () => mockGetAllWorkflows(),
  restoreWorkflow: (...args: unknown[]) => mockRestoreWorkflow(...args),
  deleteWorkflow: (...args: unknown[]) => mockDeleteWorkflow(...args),
  createTaskDraft: (...args: unknown[]) => mockCreateTaskDraft(...args),
  launchTask: (...args: unknown[]) => mockLaunchTask(...args),
}));

const mockCancelTask = vi.fn();
const mockQueueInterruptMessage = vi.fn();
const mockInterruptActiveQuery = vi.fn();
const mockGetActiveQueryInfo = vi.fn();

vi.mock("../agent/executor.js", () => ({
  cancelTask: (...args: unknown[]) => mockCancelTask(...args),
  queueInterruptMessage: (...args: unknown[]) => mockQueueInterruptMessage(...args),
  interruptActiveQuery: (...args: unknown[]) => mockInterruptActiveQuery(...args),
  getActiveQueryInfo: (...args: unknown[]) => mockGetActiveQueryInfo(...args),
}));

const mockWarn = vi.fn();
const mockInfo = vi.fn();
const mockTaskLoggerInstance = { warn: mockWarn, info: mockInfo, error: vi.fn(), debug: vi.fn() };
const mockExecFile = vi.fn();

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  taskLogger: () => mockTaskLoggerInstance,
}));

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

vi.mock("../lib/question-manager.js", () => ({
  questionManager: { answer: vi.fn() },
}));

// -- Helpers --

function makeActor(status: string, opts?: {
  subscribeCallback?: (cb: (snap: { context?: { status?: string } }) => void) => void;
}) {
  const subscribers = new Set<(snap: { context?: { status?: string } }) => void>();
  return {
    getSnapshot: () => ({
      context: { status, config: {}, lastStage: "build" },
    }),
    send: vi.fn(),
    subscribe: vi.fn((cb: (snap: { context?: { status?: string } }) => void) => {
      subscribers.add(cb);
      if (opts?.subscribeCallback) opts.subscribeCallback(cb);
      return {
        unsubscribe: () => subscribers.delete(cb),
      };
    }),
    // Expose for test manipulation
    _notifySubscribers(snap: { context?: { status?: string } }) {
      for (const cb of subscribers) cb(snap);
    },
  };
}

describe("cancelTask_ adversarial — Bug 8: timeout returns success silently", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("logs a warning when cancel does NOT reach 'cancelled' state within 3s", async () => {
    vi.useFakeTimers();

    // Actor that never transitions to 'cancelled'
    const actor = makeActor("running");
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);

    const { cancelTask_ } = await import("./task-actions.js");
    const resultPromise = cancelTask_("task-timeout-1");

    // Advance past the 3s timeout
    await vi.advanceTimersByTimeAsync(3100);

    const result = await resultPromise;

    // The function still returns ok even on timeout
    expect(result.ok).toBe(true);

    // But the warn log should have been called
    expect(mockWarn).toHaveBeenCalledWith(
      "Cancel timed out waiting for state machine — agent was force-killed",
    );

    // cancelTask (agent kill) should always be called
    expect(mockCancelTask).toHaveBeenCalledWith("task-timeout-1");

    vi.useRealTimers();
  });

  it("does NOT log a warning when cancel reaches 'cancelled' immediately (snapshot check)", async () => {
    // Actor already in 'cancelled' state at the moment getSnapshot() is called after sendEvent
    const actor = makeActor("cancelled");
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);

    // sendEvent transitions state (mocked): actor status becomes 'cancelled'
    // Since the actor snapshot already shows 'cancelled', the promise resolves immediately

    // Note: cancelTask_ checks terminal states first, so we need the actor
    // to start non-terminal, then its snapshot returns 'cancelled' after sendEvent
    const snapshots = [
      { context: { status: "running", config: {}, lastStage: "build" } },
      { context: { status: "cancelled", config: {}, lastStage: "build" } },
    ];
    let callCount = 0;
    const dynamicActor = {
      getSnapshot: () => {
        const snap = snapshots[Math.min(callCount, snapshots.length - 1)]!;
        callCount++;
        return snap;
      },
      send: vi.fn(),
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    };
    mockGetWorkflow.mockReturnValue(dynamicActor);

    const { cancelTask_ } = await import("./task-actions.js");
    const result = await cancelTask_("task-immediate-1");

    expect(result.ok).toBe(true);
    // No warning should be logged
    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockCancelTask).toHaveBeenCalledWith("task-immediate-1");
  });

  it("does NOT log a warning when cancel reaches 'cancelled' via subscription before timeout", async () => {
    vi.useFakeTimers();

    // Actor starts as 'running', transitions to 'cancelled' via subscription notification
    const actor = makeActor("running", {
      subscribeCallback: (cb) => {
        // Simulate state machine transitioning after 500ms
        setTimeout(() => {
          cb({ context: { status: "cancelled" } });
        }, 500);
      },
    });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);

    const { cancelTask_ } = await import("./task-actions.js");
    const resultPromise = cancelTask_("task-sub-1");

    // Advance 500ms to trigger the subscription notification
    await vi.advanceTimersByTimeAsync(600);

    const result = await resultPromise;

    expect(result.ok).toBe(true);
    // No warning — cancel succeeded before timeout
    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockCancelTask).toHaveBeenCalledWith("task-sub-1");

    vi.useRealTimers();
  });

  it("returns TASK_NOT_FOUND when actor does not exist", async () => {
    mockGetWorkflow.mockReturnValue(null);
    mockRestoreWorkflow.mockReturnValue(null);

    const { cancelTask_ } = await import("./task-actions.js");
    const result = await cancelTask_("nonexistent-task");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("TASK_NOT_FOUND");
    }
  });

  it("returns INVALID_STATE when task is already in terminal state", async () => {
    const actor = makeActor("completed");
    mockGetWorkflow.mockReturnValue(actor);

    const { cancelTask_ } = await import("./task-actions.js");
    const result = await cancelTask_("already-done");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_STATE");
      expect(result.message).toContain("completed");
    }
  });
});

// -- Extended helpers --

function makeActorWithContext(ctx: Record<string, unknown>) {
  const fullContext = { status: "running", config: {}, lastStage: "build", ...ctx };
  let currentContext = { ...fullContext };
  const subscribers = new Set<(snap: { context: typeof currentContext }) => void>();
  return {
    getSnapshot: () => ({ context: currentContext }),
    send: vi.fn(),
    subscribe: vi.fn((cb: (snap: { context: typeof currentContext }) => void) => {
      subscribers.add(cb);
      return { unsubscribe: () => subscribers.delete(cb) };
    }),
    _setContext(patch: Record<string, unknown>) {
      currentContext = { ...currentContext, ...patch };
    },
    _notifySubscribers() {
      for (const cb of subscribers) cb({ context: currentContext });
    },
  };
}

function makeGateContext(stageName = "review") {
  return {
    status: stageName,
    config: { pipeline: { stages: [{ name: stageName, type: "human_confirm" }] } },
    lastStage: stageName,
  };
}

// =====================================================================
// confirmGate
// =====================================================================

describe("confirmGate adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns TASK_NOT_FOUND when task does not exist", async () => {
    mockGetWorkflow.mockReturnValue(null);
    mockRestoreWorkflow.mockReturnValue(null);

    const { confirmGate } = await import("./task-actions.js");
    const result = confirmGate("no-such-task");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("TASK_NOT_FOUND");
    }
  });

  it("returns INVALID_STATE when task is not in a gate state", async () => {
    const actor = makeActorWithContext({ status: "running", config: { pipeline: { stages: [] } } });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);

    const { confirmGate } = await import("./task-actions.js");
    const result = confirmGate("task-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_STATE");
    }
  });

  it("returns statusBefore and statusAfter on valid confirm", async () => {
    const actor = makeActorWithContext(makeGateContext("review"));
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    mockSendEvent.mockImplementation(() => {
      actor._setContext({ status: "build" });
      return true;
    });

    const { confirmGate } = await import("./task-actions.js");
    const result = confirmGate("task-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.statusBefore).toBe("review");
      expect(result.data.statusAfter).toBe("build");
    }
  });

  it("includes repoName in event when provided", async () => {
    const actor = makeActorWithContext(makeGateContext("review"));
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    mockSendEvent.mockReturnValue(true);

    const { confirmGate } = await import("./task-actions.js");
    confirmGate("task-1", { repoName: "my-repo" });

    expect(mockSendEvent).toHaveBeenCalledWith("task-1", { type: "CONFIRM", repoName: "my-repo" });
  });

  it("logs warning on duplicate confirm when status does not change", async () => {
    // Status stays the same after sendEvent
    const actor = makeActorWithContext(makeGateContext("review"));
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    mockSendEvent.mockReturnValue(true);

    const { confirmGate } = await import("./task-actions.js");
    const result = confirmGate("task-1");

    expect(result.ok).toBe(true);
    expect(mockWarn).toHaveBeenCalled();
  });

  it("returns INVALID_STATE when config has no stages", async () => {
    const actor = makeActorWithContext({ status: "review", config: { pipeline: { stages: [] } } });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);

    const { confirmGate } = await import("./task-actions.js");
    const result = confirmGate("task-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_STATE");
    }
  });
});

// =====================================================================
// rejectGate
// =====================================================================

describe("rejectGate adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns TASK_NOT_FOUND when task does not exist", async () => {
    mockGetWorkflow.mockReturnValue(null);
    mockRestoreWorkflow.mockReturnValue(null);

    const { rejectGate } = await import("./task-actions.js");
    const result = rejectGate("no-such-task", {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("TASK_NOT_FOUND");
    }
  });

  it("returns INVALID_STATE when task is not in a gate state", async () => {
    const actor = makeActorWithContext({ status: "running", config: { pipeline: { stages: [] } } });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);

    const { rejectGate } = await import("./task-actions.js");
    const result = rejectGate("task-1", { reason: "bad" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_STATE");
    }
  });

  it("sends REJECT event with reason", async () => {
    const actor = makeActorWithContext(makeGateContext("review"));
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    mockSendEvent.mockReturnValue(true);

    const { rejectGate } = await import("./task-actions.js");
    rejectGate("task-1", { reason: "not ready" });

    expect(mockSendEvent).toHaveBeenCalledWith("task-1", { type: "REJECT", reason: "not ready" });
  });

  it("sends REJECT_WITH_FEEDBACK event when feedback is provided", async () => {
    const actor = makeActorWithContext(makeGateContext("review"));
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    mockSendEvent.mockReturnValue(true);

    const { rejectGate } = await import("./task-actions.js");
    rejectGate("task-1", { feedback: "needs more work" });

    expect(mockSendEvent).toHaveBeenCalledWith("task-1", { type: "REJECT_WITH_FEEDBACK", feedback: "needs more work" });
  });

  it("returns VALIDATION_FAILED when feedback is whitespace only", async () => {
    const actor = makeActorWithContext(makeGateContext("review"));
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);

    const { rejectGate } = await import("./task-actions.js");
    const result = rejectGate("task-1", { feedback: "   " });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VALIDATION_FAILED");
    }
  });

  it("feedback takes priority when both reason and feedback are provided", async () => {
    const actor = makeActorWithContext(makeGateContext("review"));
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    mockSendEvent.mockReturnValue(true);

    const { rejectGate } = await import("./task-actions.js");
    rejectGate("task-1", { reason: "rejected", feedback: "please fix X" });

    expect(mockSendEvent).toHaveBeenCalledWith("task-1", { type: "REJECT_WITH_FEEDBACK", feedback: "please fix X" });
  });

  it("sends REJECT with default reason when neither reason nor feedback is provided", async () => {
    const actor = makeActorWithContext(makeGateContext("review"));
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    mockSendEvent.mockReturnValue(true);

    const { rejectGate } = await import("./task-actions.js");
    rejectGate("task-1", {});

    // reason will be undefined since opts.reason is undefined
    expect(mockSendEvent).toHaveBeenCalledWith("task-1", { type: "REJECT", reason: undefined });
  });

  it("logs warning on duplicate reject when status does not change", async () => {
    const actor = makeActorWithContext(makeGateContext("review"));
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    mockSendEvent.mockReturnValue(true);

    const { rejectGate } = await import("./task-actions.js");
    rejectGate("task-1", { reason: "bad" });

    // Status doesn't change so warn is called
    expect(mockWarn).toHaveBeenCalled();
  });
});

// =====================================================================
// retryTask
// =====================================================================

describe("retryTask adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns TASK_NOT_FOUND when task does not exist", async () => {
    mockGetWorkflow.mockReturnValue(null);
    mockRestoreWorkflow.mockReturnValue(null);

    const { retryTask } = await import("./task-actions.js");
    const result = retryTask("no-such-task");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("TASK_NOT_FOUND");
    }
  });

  it("returns INVALID_STATE for terminal state: completed", async () => {
    const actor = makeActorWithContext({ status: "completed" });
    mockGetWorkflow.mockReturnValue(actor);

    const { retryTask } = await import("./task-actions.js");
    const result = retryTask("task-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_STATE");
      expect(result.message).toContain("completed");
    }
  });

  it("returns INVALID_STATE for terminal state: error", async () => {
    const actor = makeActorWithContext({ status: "error" });
    mockGetWorkflow.mockReturnValue(actor);

    const { retryTask } = await import("./task-actions.js");
    const result = retryTask("task-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_STATE");
      expect(result.message).toContain("error");
    }
  });

  it("sends RETRY event for blocked state and returns new status", async () => {
    const actor = makeActorWithContext({ status: "blocked", lastStage: "build" });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    mockSendEvent.mockImplementation(() => {
      actor._setContext({ status: "running" });
      return true;
    });

    const { retryTask } = await import("./task-actions.js");
    const result = retryTask("task-1");

    expect(mockSendEvent).toHaveBeenCalledWith("task-1", { type: "RETRY" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.statusAfter).toBe("running");
    }
  });

  it("sends SYNC_RETRY event when blocked with sync=true and sessionId", async () => {
    const actor = makeActorWithContext({
      status: "blocked",
      lastStage: "build",
      stageSessionIds: { build: "sess-123" },
    });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    mockSendEvent.mockImplementation(() => {
      actor._setContext({ status: "running" });
      return true;
    });

    const { retryTask } = await import("./task-actions.js");
    const result = retryTask("task-1", { sync: true });

    expect(mockSendEvent).toHaveBeenCalledWith("task-1", { type: "SYNC_RETRY", sessionId: "sess-123" });
    expect(result.ok).toBe(true);
  });

  it("falls back to RETRY when sync=true but no sessionId", async () => {
    const actor = makeActorWithContext({ status: "blocked", lastStage: "build", stageSessionIds: {} });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    mockSendEvent.mockImplementation(() => {
      actor._setContext({ status: "running" });
      return true;
    });

    const { retryTask } = await import("./task-actions.js");
    const result = retryTask("task-1", { sync: true });

    expect(mockSendEvent).toHaveBeenCalledWith("task-1", { type: "RETRY" });
    expect(result.ok).toBe(true);
  });

  it("returns INVALID_STATE when blocked but stage is not retryable (status stays blocked)", async () => {
    const actor = makeActorWithContext({ status: "blocked", lastStage: "build" });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    // sendEvent returns true but status doesn't change
    mockSendEvent.mockReturnValue(true);

    const { retryTask } = await import("./task-actions.js");
    const result = retryTask("task-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_STATE");
      expect(result.message).toContain("not retryable");
    }
  });

  it("sends RESUME event for cancelled state", async () => {
    const actor = makeActorWithContext({ status: "cancelled", lastStage: "build" });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    mockSendEvent.mockImplementation(() => {
      actor._setContext({ status: "running" });
      return true;
    });

    const { retryTask } = await import("./task-actions.js");
    const result = retryTask("task-1");

    expect(mockSendEvent).toHaveBeenCalledWith("task-1", { type: "RESUME" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.statusAfter).toBe("running");
    }
  });

  it("returns INVALID_STATE when cancelled but not resumable", async () => {
    const actor = makeActorWithContext({ status: "cancelled", lastStage: "build" });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    // Status stays cancelled
    mockSendEvent.mockReturnValue(true);

    const { retryTask } = await import("./task-actions.js");
    const result = retryTask("task-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_STATE");
      expect(result.message).toContain("not resumable");
    }
  });

  it("performs cancelTask + INTERRUPT + RETRY sequence for running state", async () => {
    let callIndex = 0;
    const actor = makeActorWithContext({ status: "running", lastStage: "build" });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    mockSendEvent.mockImplementation((_id: string, event: { type: string }) => {
      callIndex++;
      if (event.type === "INTERRUPT") {
        actor._setContext({ status: "blocked" });
      }
      if (event.type === "RETRY") {
        actor._setContext({ status: "running" });
      }
      return true;
    });

    const { retryTask } = await import("./task-actions.js");
    const result = retryTask("task-1");

    expect(mockCancelTask).toHaveBeenCalledWith("task-1");
    expect(mockSendEvent).toHaveBeenCalledWith("task-1", { type: "INTERRUPT", reason: "Force retry requested" });
    expect(mockSendEvent).toHaveBeenCalledWith("task-1", { type: "RETRY" });
    expect(result.ok).toBe(true);
  });

  it("returns INVALID_STATE when running but interrupt fails (status not blocked)", async () => {
    const actor = makeActorWithContext({ status: "running", lastStage: "build" });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    // sendEvent doesn't change status to blocked
    mockSendEvent.mockReturnValue(true);

    const { retryTask } = await import("./task-actions.js");
    const result = retryTask("task-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_STATE");
      expect(result.message).toContain("Failed to interrupt");
    }
  });
});

// =====================================================================
// cancelTask_ extended
// =====================================================================

describe("cancelTask_ extended adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("subscription callback resolves before timeout — no warning", async () => {
    vi.useFakeTimers();

    const actor = makeActor("running", {
      subscribeCallback: (cb) => {
        setTimeout(() => cb({ context: { status: "cancelled" } }), 100);
      },
    });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);

    const { cancelTask_ } = await import("./task-actions.js");
    const promise = cancelTask_("task-early");

    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result.ok).toBe(true);
    expect(mockWarn).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("multiple rapid cancels on same task — idempotent (second call hits terminal state)", async () => {
    // First call: actor starts running, transitions to cancelled
    const snapshots = [
      { context: { status: "running", config: {}, lastStage: "build" } },
      { context: { status: "cancelled", config: {}, lastStage: "build" } },
    ];
    let callCount = 0;
    const dynamicActor = {
      getSnapshot: () => {
        const snap = snapshots[Math.min(callCount, snapshots.length - 1)]!;
        callCount++;
        return snap;
      },
      send: vi.fn(),
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    };
    mockGetWorkflow.mockReturnValue(dynamicActor);
    mockRestoreWorkflow.mockReturnValue(null);

    const { cancelTask_ } = await import("./task-actions.js");
    const result1 = await cancelTask_("task-dup");
    expect(result1.ok).toBe(true);

    // Second call sees cancelled (terminal) — returns INVALID_STATE
    const result2 = await cancelTask_("task-dup");
    expect(result2.ok).toBe(false);
    if (!result2.ok) {
      expect(result2.code).toBe("INVALID_STATE");
    }
  });

  it("cancel on blocked state works (not terminal)", async () => {
    const snapshots = [
      { context: { status: "blocked", config: {}, lastStage: "build" } },
      { context: { status: "cancelled", config: {}, lastStage: "build" } },
    ];
    let callCount = 0;
    const dynamicActor = {
      getSnapshot: () => {
        const snap = snapshots[Math.min(callCount, snapshots.length - 1)]!;
        callCount++;
        return snap;
      },
      send: vi.fn(),
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    };
    mockGetWorkflow.mockReturnValue(dynamicActor);
    mockRestoreWorkflow.mockReturnValue(null);

    const { cancelTask_ } = await import("./task-actions.js");
    const result = await cancelTask_("task-blocked");

    expect(result.ok).toBe(true);
    expect(mockCancelTask).toHaveBeenCalledWith("task-blocked");
  });
});

// =====================================================================
// resumeTask
// =====================================================================

describe("resumeTask adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns TASK_NOT_FOUND when task does not exist", async () => {
    mockGetWorkflow.mockReturnValue(null);
    mockRestoreWorkflow.mockReturnValue(null);

    const { resumeTask } = await import("./task-actions.js");
    const result = resumeTask("no-such-task");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("TASK_NOT_FOUND");
    }
  });

  it("sends RESUME event for cancelled state and returns statusAfter", async () => {
    const actor = makeActorWithContext({ status: "cancelled", lastStage: "deploy" });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    mockSendEvent.mockImplementation(() => {
      actor._setContext({ status: "running" });
      return true;
    });

    const { resumeTask } = await import("./task-actions.js");
    const result = resumeTask("task-1");

    expect(mockSendEvent).toHaveBeenCalledWith("task-1", { type: "RESUME" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.statusAfter).toBe("running");
    }
  });

  it("returns INVALID_STATE when cancelled but not resumable", async () => {
    const actor = makeActorWithContext({ status: "cancelled", lastStage: "deploy" });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    // Status stays cancelled
    mockSendEvent.mockReturnValue(true);

    const { resumeTask } = await import("./task-actions.js");
    const result = resumeTask("task-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_STATE");
      expect(result.message).toContain("not resumable");
    }
  });

  it("sends RETRY event for blocked state and returns statusAfter", async () => {
    const actor = makeActorWithContext({ status: "blocked", lastStage: "build" });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    mockSendEvent.mockImplementation(() => {
      actor._setContext({ status: "running" });
      return true;
    });

    const { resumeTask } = await import("./task-actions.js");
    const result = resumeTask("task-1");

    expect(mockSendEvent).toHaveBeenCalledWith("task-1", { type: "RETRY" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.statusAfter).toBe("running");
    }
  });

  it("returns INVALID_STATE when blocked but not retryable", async () => {
    const actor = makeActorWithContext({ status: "blocked", lastStage: "build" });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    mockSendEvent.mockReturnValue(true);

    const { resumeTask } = await import("./task-actions.js");
    const result = resumeTask("task-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_STATE");
      expect(result.message).toContain("not retryable");
    }
  });

  it("returns INVALID_STATE for running state", async () => {
    const actor = makeActorWithContext({ status: "running" });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);

    const { resumeTask } = await import("./task-actions.js");
    const result = resumeTask("task-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_STATE");
      expect(result.message).toContain("Cannot resume");
    }
  });

  it("returns INVALID_STATE for completed state", async () => {
    const actor = makeActorWithContext({ status: "completed" });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);

    const { resumeTask } = await import("./task-actions.js");
    const result = resumeTask("task-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_STATE");
    }
  });
});

// =====================================================================
// interruptTask
// =====================================================================

describe("interruptTask adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns TASK_NOT_FOUND when task does not exist", async () => {
    mockGetWorkflow.mockReturnValue(null);
    mockRestoreWorkflow.mockReturnValue(null);

    const { interruptTask } = await import("./task-actions.js");
    const result = await interruptTask("no-such-task");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("TASK_NOT_FOUND");
    }
  });

  it("sends INTERRUPT event with provided reason", async () => {
    const actor = makeActorWithContext({ status: "running" });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    mockGetActiveQueryInfo.mockReturnValue(null);
    mockSendEvent.mockImplementation(() => {
      actor._setContext({ status: "blocked" });
    });

    const { interruptTask } = await import("./task-actions.js");
    const result = await interruptTask("task-1", "Stop now");

    expect(mockSendEvent).toHaveBeenCalledWith("task-1", { type: "INTERRUPT", reason: "Stop now" });
    expect(result.ok).toBe(true);
  });

  it("uses default message when message is empty", async () => {
    const actor = makeActorWithContext({ status: "running" });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    mockGetActiveQueryInfo.mockReturnValue(null);
    mockSendEvent.mockImplementation(() => {
      actor._setContext({ status: "blocked" });
    });

    const { interruptTask } = await import("./task-actions.js");
    await interruptTask("task-1", "");

    expect(mockSendEvent).toHaveBeenCalledWith("task-1", { type: "INTERRUPT", reason: "Interrupted by user" });
  });

  it("calls interruptActiveQuery when active query exists", async () => {
    const actor = makeActorWithContext({ status: "running" });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    mockGetActiveQueryInfo.mockReturnValue({ sessionId: "sess-1" });
    mockInterruptActiveQuery.mockResolvedValue(undefined);

    const { interruptTask } = await import("./task-actions.js");
    await interruptTask("task-1", "stop");

    expect(mockInterruptActiveQuery).toHaveBeenCalledWith("task-1");
  });

  it("returns INVALID_STATE when interrupt has no effect and there is no active query", async () => {
    const actor = makeActorWithContext({ status: "running" });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    mockGetActiveQueryInfo.mockReturnValue(null);

    const { interruptTask } = await import("./task-actions.js");
    const result = await interruptTask("task-1", "stop");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_STATE");
    }
  });

  it("returns INVALID_STATE for completed tasks", async () => {
    const actor = makeActorWithContext({ status: "completed" });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);

    const { interruptTask } = await import("./task-actions.js");
    const result = await interruptTask("task-1", "stop");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_STATE");
    }
  });

  it("does not call interruptActiveQuery when no active query", async () => {
    const actor = makeActorWithContext({ status: "running" });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    mockGetActiveQueryInfo.mockReturnValue(null);

    const { interruptTask } = await import("./task-actions.js");
    await interruptTask("task-1", "stop");

    expect(mockInterruptActiveQuery).not.toHaveBeenCalled();
  });
});

// =====================================================================
// sendMessage
// =====================================================================

describe("sendMessage adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns INVALID_STATE when task is not interruptible", async () => {
    const actor = makeActorWithContext({ status: "completed" });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);

    const { sendMessage } = await import("./task-actions.js");
    const result = await sendMessage("task-1", "hello");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_STATE");
    }
  });

  it("returns INVALID_STATE when fallback interrupt has no effect", async () => {
    const actor = makeActorWithContext({ status: "running" });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    mockGetActiveQueryInfo.mockReturnValue(null);

    const { sendMessage } = await import("./task-actions.js");
    const result = await sendMessage("task-1", "hello");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_STATE");
    }
  });

  it("queues message when active query session exists", async () => {
    const actor = makeActorWithContext({ status: "running" });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    mockGetActiveQueryInfo.mockReturnValue({ sessionId: "sess-1" });
    mockQueueInterruptMessage.mockReturnValue(true);
    mockInterruptActiveQuery.mockResolvedValue(undefined);

    const { sendMessage } = await import("./task-actions.js");
    const result = await sendMessage("task-1", "hello");

    expect(result.ok).toBe(true);
    expect(mockQueueInterruptMessage).toHaveBeenCalledWith("task-1", "hello");
    expect(mockInterruptActiveQuery).toHaveBeenCalledWith("task-1");
  });
});

// =====================================================================
// answerQuestion
// =====================================================================

describe("answerQuestion adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok on valid answer", async () => {
    const { questionManager } = await import("../lib/question-manager.js");
    (questionManager.answer as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const { answerQuestion } = await import("./task-actions.js");
    const result = answerQuestion("task-1", "q-1", "yes");

    expect(result.ok).toBe(true);
  });

  it("returns QUESTION_STALE when answer is stale", async () => {
    const { questionManager } = await import("../lib/question-manager.js");
    (questionManager.answer as ReturnType<typeof vi.fn>).mockReturnValue("stale");

    const { answerQuestion } = await import("./task-actions.js");
    const result = answerQuestion("task-1", "q-1", "yes");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("QUESTION_STALE");
    }
  });

  it("returns QUESTION_NOT_FOUND when question is not found", async () => {
    const { questionManager } = await import("../lib/question-manager.js");
    (questionManager.answer as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const { answerQuestion } = await import("./task-actions.js");
    const result = answerQuestion("task-1", "q-999", "yes");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("QUESTION_NOT_FOUND");
    }
  });
});

// =====================================================================
// deleteTask
// =====================================================================

describe("deleteTask adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => cb(null));
  });

  it("calls cancelTask, cleans worktree, and deleteWorkflow on valid delete", async () => {
    const actor = makeActorWithContext({ status: "running", worktreePath: "/tmp/task-1-wt" });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    mockSendEvent.mockImplementation((_taskId: string, event: { type: string }) => {
      if (event.type === "CANCEL") actor._setContext({ status: "cancelled" });
      return true;
    });
    const { deleteTask } = await import("./task-actions.js");
    const result = await deleteTask("task-1");

    expect(mockCancelTask).toHaveBeenCalledWith("task-1");
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "--force", "/tmp/task-1-wt"],
      { timeout: 30_000 },
      expect.any(Function),
    );
    expect(mockDeleteWorkflow).toHaveBeenCalledWith("task-1");
    expect(mockSendEvent).toHaveBeenCalledWith("task-1", { type: "CANCEL" });
    expect(result.ok).toBe(true);
  });

  it("returns TASK_NOT_FOUND for non-existent task", async () => {
    mockGetWorkflow.mockReturnValue(null);
    mockRestoreWorkflow.mockReturnValue(null);

    const { deleteTask } = await import("./task-actions.js");
    const result = await deleteTask("nonexistent");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("TASK_NOT_FOUND");
    }
    expect(mockCancelTask).not.toHaveBeenCalled();
    expect(mockDeleteWorkflow).not.toHaveBeenCalled();
  });

  it("cancels child sub-tasks before deleting parent task", async () => {
    const actor = makeActorWithContext({ status: "running" });
    mockGetWorkflow.mockReturnValue(actor);
    mockRestoreWorkflow.mockReturnValue(null);
    const child = makeActorWithContext({ status: "running" });
    mockGetAllWorkflows.mockReturnValue(new Map([
      ["task-1-sub-a", child],
      ["task-1", actor],
    ]));
    mockSendEvent.mockImplementation((taskId: string, event: { type: string }) => {
      if (taskId === "task-1" && event.type === "CANCEL") actor._setContext({ status: "cancelled" });
      return true;
    });

    const { deleteTask } = await import("./task-actions.js");
    const result = await deleteTask("task-1");

    expect(result.ok).toBe(true);
    expect(mockSendEvent).toHaveBeenCalledWith("task-1-sub-a", { type: "CANCEL" });
    expect(mockCancelTask).toHaveBeenCalledWith("task-1-sub-a");
  });
});

// =====================================================================
// createTask
// =====================================================================

describe("createTask adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok with taskId when taskText is provided", async () => {
    mockCreateTaskDraft.mockReturnValue(undefined);

    const { createTask } = await import("./task-actions.js");
    const result = createTask({ taskText: "do something" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.taskId).toBeDefined();
      expect(typeof result.data.taskId).toBe("string");
    }
    expect(mockCreateTaskDraft).toHaveBeenCalled();
  });

  it("returns VALIDATION_FAILED when taskText is missing", async () => {
    const { createTask } = await import("./task-actions.js");
    const result = createTask({} as any);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VALIDATION_FAILED");
    }
  });

  it("returns INTERNAL_ERROR when creation throws", async () => {
    mockCreateTaskDraft.mockImplementation(() => {
      throw new Error("disk full");
    });

    const { createTask } = await import("./task-actions.js");
    const result = createTask({ taskText: "do something" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INTERNAL_ERROR");
      expect(result.message).toBe("disk full");
    }
  });
});

// =====================================================================
// launch
// =====================================================================

describe("launch adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok on valid launch", async () => {
    mockGetWorkflow.mockReturnValue(makeActorWithContext({ status: "idle" }));
    mockRestoreWorkflow.mockReturnValue(null);
    mockLaunchTask.mockReturnValue(true);

    const { launch } = await import("./task-actions.js");
    const result = launch("task-1");

    expect(result.ok).toBe(true);
    expect(mockLaunchTask).toHaveBeenCalledWith("task-1");
  });

  it("returns TASK_NOT_FOUND when task does not exist", async () => {
    mockGetWorkflow.mockReturnValue(null);
    mockRestoreWorkflow.mockReturnValue(null);

    const { launch } = await import("./task-actions.js");
    const result = launch("no-such-task");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("TASK_NOT_FOUND");
    }
  });

  it("returns INVALID_STATE when task is not idle", async () => {
    mockGetWorkflow.mockReturnValue(makeActorWithContext({ status: "running" }));
    mockRestoreWorkflow.mockReturnValue(null);

    const { launch } = await import("./task-actions.js");
    const result = launch("task-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_STATE");
    }
    expect(mockLaunchTask).not.toHaveBeenCalled();
  });
});
