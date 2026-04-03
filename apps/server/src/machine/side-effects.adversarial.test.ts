import { describe, it, expect, vi, beforeEach } from "vitest";

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

const mockSafeFire = vi.fn();
vi.mock("../lib/safe-fire.js", () => ({
  safeFire: (...args: any[]) => mockSafeFire(...args),
}));

vi.mock("./helpers.js", () => ({
  getNotionStatusLabel: vi.fn().mockReturnValue("执行中"),
}));

const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

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

const { registerSideEffects } = await import("./side-effects.js");

describe("side-effects adversarial", () => {
  let actor: ReturnType<typeof createFakeActor>;

  beforeEach(() => {
    vi.clearAllMocks();
    actor = createFakeActor();
    registerSideEffects(actor as any);
  });

  it("wf.notionSync with notionPageId calls updateNotionPageStatus via safeFire", () => {
    actor.emit({
      type: "wf.notionSync",
      taskId: "t-notion",
      status: "running",
      notionPageId: "page-123",
      pipelineStages: [{ name: "dev", type: "agent" }],
    });
    expect(mockSafeFire).toHaveBeenCalled();
  });

  it("wf.notionSync with undefined notionPageId is a no-op", () => {
    actor.emit({
      type: "wf.notionSync",
      taskId: "t-no-notion",
      status: "running",
      notionPageId: undefined,
    });
    expect(mockSafeFire).not.toHaveBeenCalled();
  });

  it("wf.persistSession writes session.json when both worktreePath and sessionId are present", () => {
    actor.emit({
      type: "wf.persistSession",
      worktreePath: "/tmp/wt",
      sessionId: "sess-42",
    });
    expect(mockSafeFire).toHaveBeenCalledOnce();
  });

  it("wf.persistSession with empty string worktreePath is a no-op", () => {
    actor.emit({
      type: "wf.persistSession",
      worktreePath: "",
      sessionId: "sess-42",
    });
    expect(writeArtifact).not.toHaveBeenCalled();
    expect(mockSafeFire).not.toHaveBeenCalled();
  });

  it("wf.worktreeCleanup with empty worktreePath is a no-op", () => {
    actor.emit({ type: "wf.worktreeCleanup", taskId: "t-no-wt", worktreePath: "" });
    // No dynamic import should be triggered for empty path
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("wf.slackStageComplete passes all fields through to safeFire", () => {
    actor.emit({
      type: "wf.slackStageComplete",
      taskId: "t-stage",
      title: "Dev Complete",
      templateName: "dev-done",
    });
    expect(mockSafeFire).toHaveBeenCalled();
    expect(notifyStageComplete).toHaveBeenCalledWith("t-stage", "Dev Complete", "dev-done");
  });

  it("wf.slackGate passes stageName and template correctly", () => {
    actor.emit({
      type: "wf.slackGate",
      taskId: "t-gate",
      stageName: "review",
      template: "needs-approval",
    });
    expect(mockSafeFire).toHaveBeenCalled();
    expect(notifyGenericGate).toHaveBeenCalledWith("t-gate", "review", "needs-approval");
  });

  it("wf.status includes ISO timestamp in pushed SSE message", () => {
    actor.emit({ type: "wf.status", taskId: "t-ts", status: "running", message: "go" });
    expect(pushMessage).toHaveBeenCalledOnce();
    const payload = pushMessage.mock.calls[0][1];
    expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("registering side effects on same actor twice doubles event handlers", () => {
    // Register again
    registerSideEffects(actor as any);
    actor.emit({ type: "wf.taskListUpdate", taskId: "t-double" });
    // Should be called twice (one per registration)
    expect(broadcastTaskUpdate).toHaveBeenCalledTimes(2);
  });

  it("wf.cancelQuestions calls questionManager.cancelForTask", () => {
    actor.emit({ type: "wf.cancelQuestions", taskId: "t-cancel-q" });
    expect(cancelForTask).toHaveBeenCalledWith("t-cancel-q");
  });
});
