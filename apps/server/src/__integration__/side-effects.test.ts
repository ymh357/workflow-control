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
  };
}

// ── Import under test (after mocks) ─────────────────────────────────────────

const { registerSideEffects } = await import("../machine/side-effects.js");

// ── Tests ────────────────────────────────────────────────────────────────────

describe("registerSideEffects", () => {
  let actor: ReturnType<typeof createFakeActor>;

  beforeEach(() => {
    vi.clearAllMocks();
    actor = createFakeActor();
    registerSideEffects(actor as any);
  });

  // 1. wf.status → SSE pushMessage
  it("wf.status → pushes SSE status message", () => {
    actor.emit({ type: "wf.status", taskId: "t1", status: "analyzing", message: "Started" });

    expect(pushMessage).toHaveBeenCalledOnce();
    const [taskId, payload] = pushMessage.mock.calls[0];
    expect(taskId).toBe("t1");
    expect(payload.type).toBe("status");
    expect(payload.taskId).toBe("t1");
    expect(payload.data).toEqual({ status: "analyzing", message: "Started" });
    expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // 2. wf.error → SSE pushMessage
  it("wf.error → pushes SSE error message", () => {
    actor.emit({ type: "wf.error", taskId: "t2", error: "something broke" });

    expect(pushMessage).toHaveBeenCalledOnce();
    const [taskId, payload] = pushMessage.mock.calls[0];
    expect(taskId).toBe("t2");
    expect(payload.type).toBe("error");
    expect(payload.data).toEqual({ error: "something broke" });
  });

  // 3. wf.costUpdate → SSE pushMessage
  it("wf.costUpdate → pushes SSE cost_update message", () => {
    actor.emit({ type: "wf.costUpdate", taskId: "t3", totalCostUsd: 1.5, stageCostUsd: 0.3 });

    expect(pushMessage).toHaveBeenCalledOnce();
    const [taskId, payload] = pushMessage.mock.calls[0];
    expect(taskId).toBe("t3");
    expect(payload.type).toBe("cost_update");
    expect(payload.data).toEqual({ totalCostUsd: 1.5, stageCostUsd: 0.3 });
  });

  // 4. wf.streamClose → close stream + notify terminated
  it("wf.streamClose → closes SSE stream and notifies task terminated", () => {
    actor.emit({ type: "wf.streamClose", taskId: "t4" });

    expect(closeStream).toHaveBeenCalledWith("t4");
    expect(notifyTaskTerminated).toHaveBeenCalledWith("t4", "completed or error");
  });

  // 5. wf.notionSync → Notion API
  describe("wf.notionSync", () => {
    it("does NOT call updateNotionPageStatus when notionPageId is absent", () => {
      actor.emit({ type: "wf.notionSync", taskId: "t5", status: "analyzing" });

      expect(updateNotionPageStatus).not.toHaveBeenCalled();
    });

    it("calls updateNotionPageStatus with correct label when notionPageId is present", () => {
      actor.emit({
        type: "wf.notionSync",
        taskId: "t5",
        status: "completed",
        notionPageId: "page-123",
        pipelineStages: [],
      });

      expect(updateNotionPageStatus).toHaveBeenCalledWith("t5", "page-123", "待验收");
    });

    it("resolves stage notion_label from pipelineStages", () => {
      actor.emit({
        type: "wf.notionSync",
        taskId: "t5",
        status: "code_review",
        notionPageId: "page-456",
        pipelineStages: [
          { name: "code_review", notion_label: "代码审查中" },
        ],
      });

      expect(updateNotionPageStatus).toHaveBeenCalledWith("t5", "page-456", "代码审查中");
    });

    it("falls back to 待确认 for human_confirm stages without notion_label", () => {
      actor.emit({
        type: "wf.notionSync",
        taskId: "t5",
        status: "review_gate",
        notionPageId: "page-789",
        pipelineStages: [
          { name: "review_gate", type: "human_confirm" },
        ],
      });

      expect(updateNotionPageStatus).toHaveBeenCalledWith("t5", "page-789", "待确认");
    });

    it("falls back to 执行中 for unknown status", () => {
      actor.emit({
        type: "wf.notionSync",
        taskId: "t5",
        status: "some_unknown",
        notionPageId: "page-000",
      });

      expect(updateNotionPageStatus).toHaveBeenCalledWith("t5", "page-000", "执行中");
    });
  });

  // 6. wf.slackBlocked → Slack notify + terminated
  it("wf.slackBlocked → calls notifyBlocked and notifyTaskTerminated", () => {
    actor.emit({ type: "wf.slackBlocked", taskId: "t6", stage: "build", error: "build failed" });

    expect(notifyBlocked).toHaveBeenCalledWith("t6", "build", "build failed");
    expect(notifyTaskTerminated).toHaveBeenCalledWith("t6", "blocked");
  });

  // 7. wf.slackStageComplete → notifyStageComplete
  it("wf.slackStageComplete → calls notifyStageComplete", () => {
    actor.emit({ type: "wf.slackStageComplete", taskId: "t7", title: "Build", templateName: "build-tpl" });

    expect(notifyStageComplete).toHaveBeenCalledWith("t7", "Build", "build-tpl");
  });

  // 8. wf.slackCompleted → notifyCompleted
  it("wf.slackCompleted → calls notifyCompleted", () => {
    actor.emit({ type: "wf.slackCompleted", taskId: "t8", deliverable: "PR #42" });

    expect(notifyCompleted).toHaveBeenCalledWith("t8", "PR #42");
  });

  // 9. wf.slackCancelled → notifyCancelled
  it("wf.slackCancelled → calls notifyCancelled", () => {
    actor.emit({ type: "wf.slackCancelled", taskId: "t9" });

    expect(notifyCancelled).toHaveBeenCalledWith("t9");
  });

  // 10. wf.slackGate → notifyGenericGate
  it("wf.slackGate → calls notifyGenericGate", () => {
    actor.emit({ type: "wf.slackGate", taskId: "t10", stageName: "approval", template: "gate-tpl" });

    expect(notifyGenericGate).toHaveBeenCalledWith("t10", "approval", "gate-tpl");
  });

  // 11. wf.taskListUpdate → broadcaster
  it("wf.taskListUpdate → calls broadcastTaskUpdate", () => {
    actor.emit({ type: "wf.taskListUpdate", taskId: "t11" });

    expect(broadcastTaskUpdate).toHaveBeenCalledWith("t11");
  });

  // 12. wf.persistSession
  describe("wf.persistSession", () => {
    it("writes session.json when worktreePath and sessionId are present", () => {
      actor.emit({ type: "wf.persistSession", worktreePath: "/tmp/wt", sessionId: "sess-1" });

      expect(writeArtifact).toHaveBeenCalledOnce();
      const [path, filename, content] = writeArtifact.mock.calls[0];
      expect(path).toBe("/tmp/wt");
      expect(filename).toBe("session.json");
      const parsed = JSON.parse(content);
      expect(parsed.sessionId).toBe("sess-1");
      expect(parsed.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("does NOT write when worktreePath is absent", () => {
      actor.emit({ type: "wf.persistSession", sessionId: "sess-2" });

      expect(writeArtifact).not.toHaveBeenCalled();
    });

    it("does NOT write when sessionId is absent", () => {
      actor.emit({ type: "wf.persistSession", worktreePath: "/tmp/wt" });

      expect(writeArtifact).not.toHaveBeenCalled();
    });
  });

  // 13. wf.cancelAgent → cancel + clear slots + notify
  it("wf.cancelAgent → calls cancelTask, clearTaskSlots, notifyTaskTerminated", () => {
    actor.emit({ type: "wf.cancelAgent", taskId: "t13" });

    expect(cancelTask).toHaveBeenCalledWith("t13");
    expect(clearTaskSlots).toHaveBeenCalledWith("t13");
    expect(notifyTaskTerminated).toHaveBeenCalledWith("t13", "cancelled");
  });

  // 14. wf.cancelQuestions → questionManager.cancelForTask
  it("wf.cancelQuestions → calls questionManager.cancelForTask", () => {
    actor.emit({ type: "wf.cancelQuestions", taskId: "t14" });

    expect(cancelForTask).toHaveBeenCalledWith("t14");
  });

  // 15. wf.worktreeCleanup
  describe("wf.worktreeCleanup", () => {
    it("calls execFile with git worktree remove when worktreePath is present", async () => {
      actor.emit({ type: "wf.worktreeCleanup", taskId: "t15", worktreePath: "/tmp/wt-cleanup" });

      // The handler uses dynamic import(), so give the microtask queue a tick
      await new Promise((r) => setTimeout(r, 50));

      expect(execFileMock).toHaveBeenCalledWith(
        "git",
        ["worktree", "remove", "--force", "--", "/tmp/wt-cleanup"],
        { timeout: 30_000 },
        expect.any(Function),
      );
    });

    it("does NOT call execFile when worktreePath is absent", async () => {
      actor.emit({ type: "wf.worktreeCleanup", taskId: "t15", worktreePath: "" });

      await new Promise((r) => setTimeout(r, 50));

      expect(execFileMock).not.toHaveBeenCalled();
    });
  });
});
