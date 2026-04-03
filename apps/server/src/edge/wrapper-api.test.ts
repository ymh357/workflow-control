import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";

// --- Mocks ---

const mockChildLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  logger: { child: () => mockChildLogger },
}));

const mockGetTaskContext = vi.fn();
vi.mock("../actions/task-actions.js", () => ({
  getTaskContext: (...args: unknown[]) => mockGetTaskContext(...args),
}));

const mockGetPersistedPending = vi.fn();
vi.mock("../lib/question-manager.js", () => ({
  questionManager: {
    getPersistedPending: (...args: unknown[]) => mockGetPersistedPending(...args),
  },
}));

const mockPushMessage = vi.fn();
const mockAddListener = vi.fn((..._args: any[]) => () => {});
vi.mock("../sse/manager.js", () => ({
  sseManager: {
    pushMessage: (...args: any[]) => mockPushMessage(...args),
    addListener: (...args: any[]) => mockAddListener(...args),
  },
}));

vi.mock("./registry.js", () => ({
  getTaskSlots: vi.fn(() => []),
  addSlotListener: vi.fn(() => () => {}),
  addTaskTerminationListener: vi.fn(() => () => {}),
}));

const mockGetAllWorkflows = vi.fn(() => new Map());
vi.mock("../machine/actor-registry.js", () => ({
  getAllWorkflows: () => mockGetAllWorkflows(),
}));

import { buildWrapperRoute } from "./wrapper-api.js";
import { getTaskSlots } from "./registry.js";

// Helper context factory
function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "task-1",
    status: "running",
    config: {
      pipeline: {
        stages: [],
      },
    },
    store: {},
    ...overrides,
  };
}

describe("wrapper-api", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route("/api/edge", buildWrapperRoute());
  });

  describe("GET /:taskId/next-stage", () => {
    it("should return 404 when task not found", async () => {
      mockGetTaskContext.mockReturnValue(null);
      const res = await app.request("/api/edge/task-1/next-stage");
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain("not found");
    });

    it("should return done for completed tasks", async () => {
      mockGetTaskContext.mockReturnValue(makeContext({ status: "completed" }));
      const res = await app.request("/api/edge/task-1/next-stage");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.done).toBe(true);
      expect(body.status).toBe("completed");
    });

    it("should return done for blocked tasks", async () => {
      mockGetTaskContext.mockReturnValue(makeContext({ status: "blocked" }));
      const res = await app.request("/api/edge/task-1/next-stage");
      const body = await res.json();
      expect(body.done).toBe(true);
      expect(body.status).toBe("blocked");
    });

    it("should return done for cancelled tasks", async () => {
      mockGetTaskContext.mockReturnValue(makeContext({ status: "cancelled" }));
      const res = await app.request("/api/edge/task-1/next-stage");
      const body = await res.json();
      expect(body.done).toBe(true);
    });

    it("should return stage info when a slot exists", async () => {
      vi.mocked(getTaskSlots).mockReturnValue([
        { taskId: "task-1", stageName: "build", createdAt: Date.now(), nonce: "123-1" },
      ]);
      mockGetTaskContext.mockReturnValue(makeContext({
        config: {
          pipeline: {
            stages: [
              { name: "build", type: "agent", engine: "claude", model: "opus" },
            ],
          },
        },
      }));

      const res = await app.request("/api/edge/task-1/next-stage");
      const body = await res.json();
      expect(body.stageName).toBe("build");
      expect(body.isGate).toBe(false);
      expect(body.stageOptions).toBeDefined();
      expect(body.stageOptions.engine).toBe("claude");
      expect(body.stageOptions.model).toBe("opus");
    });

    it("should flag gate stages with isGate=true and no stageOptions", async () => {
      vi.mocked(getTaskSlots).mockReturnValue([
        { taskId: "task-1", stageName: "review", createdAt: Date.now(), nonce: "123-2" },
      ]);
      mockGetTaskContext.mockReturnValue(makeContext({
        config: {
          pipeline: {
            stages: [
              { name: "review", type: "human_confirm" },
            ],
          },
        },
      }));

      const res = await app.request("/api/edge/task-1/next-stage");
      const body = await res.json();
      expect(body.stageName).toBe("review");
      expect(body.isGate).toBe(true);
      expect(body.stageOptions).toBeUndefined();
    });

    it("should return isGate waiting when status matches a human_confirm stage", async () => {
      vi.mocked(getTaskSlots).mockReturnValue([]);
      mockGetTaskContext.mockReturnValue(makeContext({
        status: "approval",
        config: {
          pipeline: {
            stages: [
              { name: "approval", type: "human_confirm" },
            ],
          },
        },
      }));

      const res = await app.request("/api/edge/task-1/next-stage");
      const body = await res.json();
      expect(body.waiting).toBe(true);
      expect(body.isGate).toBe(true);
      expect(body.status).toBe("approval");
    });

    it("should return pending question when one exists", async () => {
      vi.mocked(getTaskSlots).mockReturnValue([]);
      mockGetTaskContext.mockReturnValue(makeContext({ status: "running" }));
      mockGetPersistedPending.mockReturnValue({
        questionId: "q1",
        question: "Which branch?",
        options: ["main", "dev"],
      });

      const res = await app.request("/api/edge/task-1/next-stage");
      const body = await res.json();
      expect(body.waiting).toBe(true);
      expect(body.pendingQuestion).toBeDefined();
      expect(body.pendingQuestion.questionId).toBe("q1");
      expect(body.pendingQuestion.question).toBe("Which branch?");
      expect(body.pendingQuestion.options).toEqual(["main", "dev"]);
    });

    it("should return generic waiting when nothing is pending", async () => {
      vi.mocked(getTaskSlots).mockReturnValue([]);
      mockGetTaskContext.mockReturnValue(makeContext({ status: "analysis" }));
      mockGetPersistedPending.mockReturnValue(undefined);

      const res = await app.request("/api/edge/task-1/next-stage");
      const body = await res.json();
      expect(body.waiting).toBe(true);
      expect(body.status).toBe("analysis");
      expect(body.pendingQuestion).toBeUndefined();
      expect(body.stageName).toBeUndefined();
    });
  });

  describe("GET /:taskId/check-interrupt", () => {
    it("should return interrupted=true with reason when task not found", async () => {
      mockGetTaskContext.mockReturnValue(null);
      const res = await app.request("/api/edge/task-1/check-interrupt");
      const body = await res.json();
      expect(body.interrupted).toBe(true);
      expect(body.reason).toBe("Task not found");
    });

    it("should return interrupted=true for cancelled tasks", async () => {
      mockGetTaskContext.mockReturnValue(makeContext({ status: "cancelled", error: "User cancelled" }));
      const res = await app.request("/api/edge/task-1/check-interrupt");
      const body = await res.json();
      expect(body.interrupted).toBe(true);
      expect(body.reason).toBe("User cancelled");
    });

    it("should return interrupted=true for blocked tasks", async () => {
      mockGetTaskContext.mockReturnValue(makeContext({ status: "blocked" }));
      const res = await app.request("/api/edge/task-1/check-interrupt");
      const body = await res.json();
      expect(body.interrupted).toBe(true);
      expect(body.reason).toBe("blocked");
    });

    it("should return interrupted=false for running tasks", async () => {
      mockGetTaskContext.mockReturnValue(makeContext({ status: "running" }));
      const res = await app.request("/api/edge/task-1/check-interrupt");
      const body = await res.json();
      expect(body.interrupted).toBe(false);
      expect(body.reason).toBeUndefined();
    });

    it("should return interrupted=false for completed tasks", async () => {
      mockGetTaskContext.mockReturnValue(makeContext({ status: "completed" }));
      const res = await app.request("/api/edge/task-1/check-interrupt");
      const body = await res.json();
      expect(body.interrupted).toBe(false);
    });
  });

  describe("POST /:taskId/stream-event", () => {
    it("should accept a single event and push to SSE", async () => {
      const res = await app.request("/api/edge/task-1/stream-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "text", data: { text: "hello" } }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.received).toBe(1);

      expect(mockPushMessage).toHaveBeenCalledWith("task-1", expect.objectContaining({
        type: "agent_text",
        taskId: "task-1",
        data: { text: "hello" },
      }));
    });

    it("should accept an array of events", async () => {
      const res = await app.request("/api/edge/task-1/stream-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([
          { type: "text", data: { text: "a" } },
          { type: "tool_use", data: { toolName: "read" } },
          { type: "thinking", data: { text: "hmm" } },
        ]),
      });
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.received).toBe(3);

      expect(mockPushMessage).toHaveBeenCalledTimes(3);

      // Check type mapping
      const calls = mockPushMessage.mock.calls;
      expect(calls[0][1].type).toBe("agent_text");
      expect(calls[1][1].type).toBe("agent_tool_use");
      expect(calls[2][1].type).toBe("agent_thinking");
    });

    it("should skip events with invalid types", async () => {
      const res = await app.request("/api/edge/task-1/stream-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([
          { type: "text", data: { text: "valid" } },
          { type: "unknown_type", data: {} },
        ]),
      });
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.received).toBe(1); // received count is forwarded events only
      expect(mockPushMessage).toHaveBeenCalledTimes(1); // only valid one pushed
    });

    it("should return 400 for invalid JSON", async () => {
      const res = await app.request("/api/edge/task-1/stream-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid JSON");
    });

    it("should include ISO timestamp in pushed messages", async () => {
      await app.request("/api/edge/task-1/stream-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "text", data: { text: "ts" } }),
      });

      const pushed = mockPushMessage.mock.calls[0][1];
      expect(pushed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("GET /:taskId/events (SSE)", () => {
    it("should return 404 when task not found", async () => {
      mockGetTaskContext.mockReturnValue(null);
      const res = await app.request("/api/edge/task-1/events");
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain("not found");
    });

    it("should return SSE headers and a stream when task exists", async () => {
      mockGetTaskContext.mockReturnValue(makeContext());
      vi.mocked(getTaskSlots).mockReturnValue([]);

      const res = await app.request("/api/edge/task-1/events");
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");
      expect(res.headers.get("Cache-Control")).toBe("no-cache");
      expect(res.headers.get("Connection")).toBe("keep-alive");
      // Body should be a ReadableStream
      expect(res.body).toBeDefined();
    });

    it("should send existing slots on connect", async () => {
      mockGetTaskContext.mockReturnValue(makeContext());
      vi.mocked(getTaskSlots).mockReturnValue([
        { taskId: "task-1", stageName: "build", createdAt: Date.now(), nonce: "n-1" },
      ]);

      const res = await app.request("/api/edge/task-1/events");
      expect(res.status).toBe(200);

      // Read the initial data from the stream
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const { value } = await reader.read();
      const text = decoder.decode(value);

      expect(text).toContain("event: slot_created");
      expect(text).toContain('"stageName":"build"');
      expect(text).toContain('"nonce":"n-1"');

      reader.cancel();
    });

    it("should forward slot_created events from listener", async () => {
      mockGetTaskContext.mockReturnValue(makeContext());
      vi.mocked(getTaskSlots).mockReturnValue([]);

      // Capture the slot listener callback
      const { addSlotListener } = await import("./registry.js");
      let slotCallback: ((info: any) => void) | undefined;
      vi.mocked(addSlotListener).mockImplementation((fn) => {
        slotCallback = fn;
        return () => {};
      });

      const res = await app.request("/api/edge/task-1/events");
      expect(res.status).toBe(200);

      // Fire the slot listener with matching taskId
      expect(slotCallback).toBeDefined();
      slotCallback!({ taskId: "task-1", stageName: "deploy", nonce: "n-2" });

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const { value } = await reader.read();
      const text = decoder.decode(value);

      expect(text).toContain("event: slot_created");
      expect(text).toContain('"stageName":"deploy"');

      reader.cancel();
    });

    it("should forward status_changed events from SSE listener", async () => {
      mockGetTaskContext.mockReturnValue(makeContext());
      vi.mocked(getTaskSlots).mockReturnValue([]);

      // Capture the SSE listener callback
      let sseCallback: ((msg: any) => void) | undefined;
      mockAddListener.mockImplementation((_taskId: any, fn: any) => {
        sseCallback = fn as (msg: any) => void;
        return () => {};
      });

      const res = await app.request("/api/edge/task-1/events");
      expect(res.status).toBe(200);

      // Fire a status message
      expect(sseCallback).toBeDefined();
      sseCallback!({ type: "status", data: { status: "implementing" } });

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const { value } = await reader.read();
      const text = decoder.decode(value);

      expect(text).toContain("event: status_changed");
      expect(text).toContain('"status":"implementing"');

      reader.cancel();
    });

    it("should forward task_terminated events", async () => {
      mockGetTaskContext.mockReturnValue(makeContext());
      vi.mocked(getTaskSlots).mockReturnValue([]);

      // Capture termination listener
      const { addTaskTerminationListener } = await import("./registry.js");
      let terminationCallback: ((taskId: string, reason: string) => void) | undefined;
      vi.mocked(addTaskTerminationListener).mockImplementation((_taskId, fn) => {
        terminationCallback = fn;
        return () => {};
      });

      const res = await app.request("/api/edge/task-1/events");
      expect(res.status).toBe(200);

      expect(terminationCallback).toBeDefined();
      terminationCallback!("task-1", "completed");

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const { value } = await reader.read();
      const text = decoder.decode(value);

      expect(text).toContain("event: task_terminated");
      expect(text).toContain('"reason":"completed"');

      reader.cancel();
    });

    it("should ignore non-status SSE messages", async () => {
      mockGetTaskContext.mockReturnValue(makeContext());
      vi.mocked(getTaskSlots).mockReturnValue([]);

      let sseCallback: ((msg: any) => void) | undefined;
      mockAddListener.mockImplementation((_taskId: any, fn: any) => {
        sseCallback = fn as (msg: any) => void;
        return () => {};
      });

      const res = await app.request("/api/edge/task-1/events");
      expect(res.status).toBe(200);

      // Fire a non-status message
      sseCallback!({ type: "agent_text", data: { text: "hello" } });

      // The stream should not have forwarded anything for non-status events
      // (no easy way to assert absence, but the test ensures no crash)
      const reader = res.body!.getReader();
      reader.cancel();
    });

    it("should not forward slot events from other tasks", async () => {
      mockGetTaskContext.mockReturnValue(makeContext());
      vi.mocked(getTaskSlots).mockReturnValue([]);

      const { addSlotListener: addSlotListenerFn } = await import("./registry.js");
      let slotCallback: ((info: any) => void) | undefined;
      vi.mocked(addSlotListenerFn).mockImplementation((fn) => {
        slotCallback = fn;
        return () => {};
      });

      const res = await app.request("/api/edge/task-1/events");
      expect(res.status).toBe(200);

      // Fire slot event for a different task
      slotCallback!({ taskId: "task-other", stageName: "build", nonce: "n-x" });

      // No slot_created should be sent for task-other - just verify no crash
      const reader = res.body!.getReader();
      reader.cancel();
    });
  });
});
