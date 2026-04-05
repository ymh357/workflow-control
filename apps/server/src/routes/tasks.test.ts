import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockGetAllWorkflows = vi.fn();
const mockGetWorkflow = vi.fn();
const mockRestoreWorkflow = vi.fn();
const mockLoadAllPersistedTaskIds = vi.fn();
const mockGetLatestSessionId = vi.fn();
const mockSendEvent = vi.fn();

vi.mock("../machine/workflow.js", () => ({
  getAllWorkflows: (...args: unknown[]) => mockGetAllWorkflows(...args),
  getWorkflow: (...args: unknown[]) => mockGetWorkflow(...args),
  restoreWorkflow: (...args: unknown[]) => mockRestoreWorkflow(...args),
  loadAllPersistedTaskIds: (...args: unknown[]) => mockLoadAllPersistedTaskIds(...args),
  getLatestSessionId: (...args: unknown[]) => mockGetLatestSessionId(...args),
  sendEvent: (...args: unknown[]) => mockSendEvent(...args),
}));

const mockGetPersistedPending = vi.fn();

vi.mock("../lib/question-manager.js", () => ({
  questionManager: { getPersistedPending: (...args: unknown[]) => mockGetPersistedPending(...args) },
}));

vi.mock("../sse/manager.js", () => ({
  sseManager: { broadcast: vi.fn() },
}));

const mockGetNestedValue = vi.fn();

vi.mock("../lib/config-loader.js", () => ({
  getNestedValue: (...args: unknown[]) => mockGetNestedValue(...args),
}));

const mockSendMessage = vi.fn();
const mockInterruptTask = vi.fn();

vi.mock("../actions/task-actions.js", () => ({
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
  interruptTask: (...args: unknown[]) => mockInterruptTask(...args),
}));

import { tasksRoute } from "./tasks.js";

function json(body: unknown) {
  return {
    method: "POST" as const,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function makeActor(context: Record<string, unknown>) {
  return {
    getSnapshot: () => ({ context }),
    send: vi.fn(),
    subscribe: vi.fn(),
  };
}

describe("tasks routes", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route("/", tasksRoute);
  });

  // --- GET /tasks ---

  describe("GET /tasks", () => {
    it("returns list of tasks", async () => {
      mockLoadAllPersistedTaskIds.mockReturnValue([]);
      const actor = makeActor({
                taskText: "build feature",
        status: "coding",
        lastStage: "coding",
        branch: "feat-1",
        error: null,
        totalCostUsd: 1.5,
        store: { title: "My Task" },
        config: { pipeline: { display: { title_path: "title" } } },
      });
      mockGetAllWorkflows.mockReturnValue(new Map([["task-1", actor]]));
      mockGetLatestSessionId.mockReturnValue("sess-1");
      mockGetNestedValue.mockReturnValue("My Task");
      mockGetPersistedPending.mockReturnValue(null);

      const res = await app.request("/tasks");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].id).toBe("task-1");
      expect(body.tasks[0].status).toBe("coding");
      expect(body.tasks[0].displayTitle).toBe("My Task");
      expect(body.tasks[0].totalCostUsd).toBe(1.5);
      expect(body.tasks[0].pendingQuestion).toBe(false);
      expect(body.failedRestores).toEqual([]);
    });

    it("returns empty tasks when none exist", async () => {
      mockLoadAllPersistedTaskIds.mockReturnValue([]);
      mockGetAllWorkflows.mockReturnValue(new Map());

      const res = await app.request("/tasks");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tasks).toEqual([]);
    });

    it("restores persisted tasks that are not in memory", async () => {
      mockLoadAllPersistedTaskIds.mockReturnValue(["persisted-1"]);
      mockGetWorkflow.mockReturnValue(null);
      mockRestoreWorkflow.mockReturnValue(undefined);
      mockGetAllWorkflows.mockReturnValue(new Map());

      const res = await app.request("/tasks");

      expect(res.status).toBe(200);
      expect(mockRestoreWorkflow).toHaveBeenCalledWith("persisted-1");
    });

    it("reports failed restores without crashing", async () => {
      mockLoadAllPersistedTaskIds.mockReturnValue(["bad-1"]);
      mockGetWorkflow.mockReturnValue(null);
      mockRestoreWorkflow.mockImplementation(() => {
        throw new Error("corrupt snapshot");
      });
      mockGetAllWorkflows.mockReturnValue(new Map());

      const res = await app.request("/tasks");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.failedRestores).toHaveLength(1);
      expect(body.failedRestores[0].id).toBe("bad-1");
      expect(body.failedRestores[0].reason).toBe("corrupt snapshot");
    });

    it("reports restore attempts that return no workflow", async () => {
      mockLoadAllPersistedTaskIds.mockReturnValue(["missing-1"]);
      mockGetWorkflow.mockReturnValue(null);
      mockRestoreWorkflow.mockReturnValue(undefined);
      mockGetAllWorkflows.mockReturnValue(new Map());

      const res = await app.request("/tasks");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.failedRestores).toEqual([
        { id: "missing-1", reason: "Task snapshot could not be restored" },
      ]);
    });

    it("skips actors with missing snapshot context", async () => {
      mockLoadAllPersistedTaskIds.mockReturnValue([]);
      const badActor = { getSnapshot: () => ({ context: null }) };
      mockGetAllWorkflows.mockReturnValue(new Map([["bad", badActor]]));

      const res = await app.request("/tasks");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tasks).toEqual([]);
    });

    it("uses task id as displayTitle when no title_path", async () => {
      mockLoadAllPersistedTaskIds.mockReturnValue([]);
      const actor = makeActor({
        status: "running",
        lastStage: "coding",
        store: {},
        config: { pipeline: {} },
        totalCostUsd: 0,
      });
      mockGetAllWorkflows.mockReturnValue(new Map([["task-no-title", actor]]));
      mockGetLatestSessionId.mockReturnValue(null);
      mockGetPersistedPending.mockReturnValue(null);

      const res = await app.request("/tasks");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tasks[0].displayTitle).toBe("task-no-title");
    });

    it("defaults status to 'unknown' when not set", async () => {
      mockLoadAllPersistedTaskIds.mockReturnValue([]);
      const actor = makeActor({
        lastStage: null,
        store: {},
        config: {},
        totalCostUsd: undefined,
      });
      mockGetAllWorkflows.mockReturnValue(new Map([["t", actor]]));
      mockGetLatestSessionId.mockReturnValue(null);
      mockGetPersistedPending.mockReturnValue(null);

      const res = await app.request("/tasks");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tasks[0].status).toBe("unknown");
      expect(body.tasks[0].totalCostUsd).toBe(0);
    });
  });

  // --- GET /tasks/:taskId ---

  describe("GET /tasks/:taskId", () => {
    it("returns full task details", async () => {
      const ctx = {
                taskText: "implement auth",
        status: "coding",
        lastStage: "coding",
        branch: "feat-auth",
        worktreePath: "/tmp/wt",
        error: null,
        retryCount: 2,
        stageSessionIds: { coding: "sess-1" },
        stageCwds: { coding: "/tmp" },
        totalCostUsd: 3.2,
        config: {
          pipeline: {
            display: { title_path: "title", completion_summary_path: "summary" },
            stages: [{ name: "coding", type: "ai" }],
          },
        },
        store: { title: "Auth Feature", summary: "Done!" },
      };
      const actor = makeActor(ctx);
      mockGetWorkflow.mockReturnValue(actor);
      mockGetLatestSessionId.mockReturnValue("sess-1");
      mockGetNestedValue.mockImplementation((_store: unknown, path: string) =>
        path === "title" ? "Auth Feature" : path === "summary" ? "Done!" : undefined,
      );
      mockGetPersistedPending.mockReturnValue(null);

      const res = await app.request("/tasks/11111111-1111-1111-1111-111111111111");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("11111111-1111-1111-1111-111111111111");
      expect(body.status).toBe("coding");
      expect(body.branch).toBe("feat-auth");
      expect(body.retryCount).toBe(2);
      expect(body.displayTitle).toBe("Auth Feature");
      expect(body.completionSummary).toBe("Done!");
      expect(body.totalCostUsd).toBe(3.2);
      expect(body.pipelineSchema).toEqual([{ name: "coding", type: "ai" }]);
    });

    it("returns 404 when task not found", async () => {
      mockGetWorkflow.mockReturnValue(null);
      mockRestoreWorkflow.mockReturnValue(null);

      const res = await app.request("/tasks/99999999-9999-9999-9999-999999999999");

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("TASK_NOT_FOUND");
    });

    it("falls back to restoreWorkflow when getWorkflow returns null", async () => {
      const ctx = {
        status: "completed",
        config: {},
        store: {},
        totalCostUsd: 0,
      };
      const actor = makeActor(ctx);
      mockGetWorkflow.mockReturnValue(null);
      mockRestoreWorkflow.mockReturnValue(actor);
      mockGetLatestSessionId.mockReturnValue(null);
      mockGetPersistedPending.mockReturnValue(null);

      const res = await app.request("/tasks/11111111-1111-1111-1111-111111111111");

      expect(res.status).toBe(200);
      expect(mockRestoreWorkflow).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111");
    });

    it("includes pendingQuestion when available", async () => {
      const actor = makeActor({
        status: "blocked",
        config: {},
        store: {},
        totalCostUsd: 0,
      });
      mockGetWorkflow.mockReturnValue(actor);
      mockGetLatestSessionId.mockReturnValue(null);
      mockGetPersistedPending.mockReturnValue({
        questionId: "q-1",
        question: "What repo?",
        createdAt: "2026-01-04T00:00:00.000Z",
      });

      const res = await app.request("/tasks/11111111-1111-1111-1111-111111111111");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pendingQuestion).toEqual({
        questionId: "q-1",
        question: "What repo?",
        createdAt: "2026-01-04T00:00:00.000Z",
      });
      expect(body.updatedAt).toBe("2026-01-04T00:00:00.000Z");
    });
  });

  // --- POST /tasks/:taskId/message ---

  describe("POST /tasks/:taskId/message", () => {
    it("returns 200 on successful message send", async () => {
      mockSendMessage.mockResolvedValue({ ok: true, data: {} });

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/message",
        json({ message: "hello agent" }),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledWith(
        "11111111-1111-1111-1111-111111111111",
        "hello agent",
      );
    });

    it("returns 400 when message is missing", async () => {
      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/message",
        json({}),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("VALIDATION_FAILED");
      expect(body.error).toBe("message is required");
    });

    it("returns 400 when message is empty string", async () => {
      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/message",
        json({ message: "" }),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("VALIDATION_FAILED");
    });

    it("returns 400 when message is whitespace only", async () => {
      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/message",
        json({ message: "   " }),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("VALIDATION_FAILED");
    });

    it("returns 404 when task not found", async () => {
      mockSendMessage.mockResolvedValue({
        ok: false,
        code: "TASK_NOT_FOUND",
        message: "Task not found",
      });

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/message",
        json({ message: "hello" }),
      );

      expect(res.status).toBe(404);
    });

    it("handles malformed JSON body gracefully", async () => {
      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/message",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "not json",
        },
      );

      // c.req.json().catch returns { message: undefined }, so message is falsy
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("VALIDATION_FAILED");
    });
  });

  // --- POST /tasks/:taskId/interrupt ---

  describe("POST /tasks/:taskId/interrupt", () => {
    it("returns 200 on successful interrupt", async () => {
      mockInterruptTask.mockResolvedValue({ ok: true, data: {} });

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/interrupt",
        json({ message: "stop please" }),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(mockInterruptTask).toHaveBeenCalledWith(
        "11111111-1111-1111-1111-111111111111",
        "stop please",
      );
    });

    it("uses default message when none provided", async () => {
      mockInterruptTask.mockResolvedValue({ ok: true, data: {} });

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/interrupt",
        json({}),
      );

      expect(res.status).toBe(200);
      expect(mockInterruptTask).toHaveBeenCalledWith(
        "11111111-1111-1111-1111-111111111111",
        "User interrupted to edit configuration.",
      );
    });

    it("uses default message when message is empty string", async () => {
      mockInterruptTask.mockResolvedValue({ ok: true, data: {} });

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/interrupt",
        json({ message: "" }),
      );

      expect(res.status).toBe(200);
      expect(mockInterruptTask).toHaveBeenCalledWith(
        "11111111-1111-1111-1111-111111111111",
        "User interrupted to edit configuration.",
      );
    });

    it("accepts empty body (message is optional)", async () => {
      mockInterruptTask.mockResolvedValue({ ok: true, data: {} });

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/interrupt",
        { method: "POST" },
      );

      expect(res.status).toBe(200);
    });

    it("returns 404 when task not found", async () => {
      mockInterruptTask.mockResolvedValue({
        ok: false,
        code: "TASK_NOT_FOUND",
        message: "Task not found",
      });

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/interrupt",
        json({}),
      );

      expect(res.status).toBe(404);
    });
  });

  // --- GET /tasks/:taskId/config ---

  describe("GET /tasks/:taskId/config", () => {
    it("returns config for existing task", async () => {
      const config = { pipeline: { stages: [] }, model: "gpt-4" };
      const actor = makeActor({ config });
      mockGetWorkflow.mockReturnValue(actor);

      const res = await app.request("/tasks/11111111-1111-1111-1111-111111111111/config");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.config).toEqual(config);
    });

    it("returns 404 when task not found", async () => {
      mockGetWorkflow.mockReturnValue(null);
      mockRestoreWorkflow.mockReturnValue(null);

      const res = await app.request("/tasks/99999999-9999-9999-9999-999999999999/config");

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("TASK_NOT_FOUND");
    });

    it("falls back to restoreWorkflow", async () => {
      const config = { pipeline: { stages: [] } };
      const actor = makeActor({ config });
      mockGetWorkflow.mockReturnValue(null);
      mockRestoreWorkflow.mockReturnValue(actor);

      const res = await app.request("/tasks/11111111-1111-1111-1111-111111111111/config");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.config).toEqual(config);
    });
  });

  // --- PUT /tasks/:taskId/config ---

  describe("PUT /tasks/:taskId/config", () => {
    it("returns updated config on success", async () => {
      const updatedConfig = { pipeline: { stages: [] }, agent: { default_engine: "codex" } };
      const actor = makeActor({ status: "blocked", config: updatedConfig });
      mockGetWorkflow.mockReturnValue(actor);
      mockSendEvent.mockReturnValue(true);

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/config",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config: { agent: { default_engine: "codex" } } }),
        },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.config).toEqual(updatedConfig);
      expect(mockSendEvent).toHaveBeenCalledWith(
        "11111111-1111-1111-1111-111111111111",
        { type: "UPDATE_CONFIG", config: { agent: { default_engine: "codex" } } },
      );
    });

    it("returns 404 when task not found", async () => {
      mockGetWorkflow.mockReturnValue(null);
      mockRestoreWorkflow.mockReturnValue(null);

      const res = await app.request(
        "/tasks/99999999-9999-9999-9999-999999999999/config",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config: { agent: { default_engine: "codex" } } }),
        },
      );

      expect(res.status).toBe(404);
    });

    it("returns 409 while task is still running", async () => {
      const actor = makeActor({ status: "running" });
      mockGetWorkflow.mockReturnValue(actor);

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/config",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config: { agent: { default_engine: "codex" } } }),
        },
      );

      expect(res.status).toBe(409);
      expect(mockSendEvent).not.toHaveBeenCalled();
    });

    it("returns 400 when config field is missing", async () => {
      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/config",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("VALIDATION_FAILED");
    });

    it("returns 400 when body is invalid JSON", async () => {
      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/config",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: "not json",
        },
      );

      expect(res.status).toBe(400);
    });
  });
});
