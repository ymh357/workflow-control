import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";

// --- Mocks (same pattern as existing test file) ---

vi.mock("../lib/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  taskLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../machine/actor-registry.js", () => ({
  getAllWorkflows: vi.fn(() => new Map()),
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

import { buildWrapperRoute } from "./wrapper-api.js";
import { getTaskSlots } from "./registry.js";

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

describe("wrapper-api adversarial tests", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route("/api/edge", buildWrapperRoute());
  });

  // ===== GET /next-stage adversarial =====

  describe("GET /:taskId/next-stage — adversarial", () => {
    it("should return 404 for a non-existent task (status code check)", async () => {
      mockGetTaskContext.mockReturnValue(null);
      const res = await app.request("/api/edge/nonexistent-task-xyz/next-stage");
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBeDefined();
      // Error message should include the actual taskId from the request
      expect(body.error).toContain("nonexistent-task-xyz");
    });

    it("should return done:true for completed task", async () => {
      mockGetTaskContext.mockReturnValue(makeContext({ status: "completed" }));
      const res = await app.request("/api/edge/task-1/next-stage");
      const body = await res.json();
      expect(body.done).toBe(true);
      expect(body.status).toBe("completed");
      // Should NOT have waiting or stageName
      expect(body.waiting).toBeUndefined();
      expect(body.stageName).toBeUndefined();
    });

    it("should return waiting:true when no slots and no gate (running status)", async () => {
      vi.mocked(getTaskSlots).mockReturnValue([]);
      mockGetTaskContext.mockReturnValue(makeContext({ status: "running" }));
      mockGetPersistedPending.mockReturnValue(undefined);

      const res = await app.request("/api/edge/task-1/next-stage");
      const body = await res.json();
      expect(body.waiting).toBe(true);
      expect(body.status).toBe("running");
      expect(body.done).toBeUndefined();
      expect(body.stageName).toBeUndefined();
      expect(body.isGate).toBeUndefined();
    });

    it("should include pendingQuestion when a question is pending", async () => {
      vi.mocked(getTaskSlots).mockReturnValue([]);
      mockGetTaskContext.mockReturnValue(makeContext({ status: "running" }));
      mockGetPersistedPending.mockReturnValue({
        questionId: "q-abc",
        question: "Pick a color",
        options: ["red", "blue"],
      });

      const res = await app.request("/api/edge/task-1/next-stage");
      const body = await res.json();
      expect(body.waiting).toBe(true);
      expect(body.pendingQuestion).toBeDefined();
      expect(body.pendingQuestion.questionId).toBe("q-abc");
      expect(body.pendingQuestion.question).toBe("Pick a color");
      expect(body.pendingQuestion.options).toEqual(["red", "blue"]);
    });

    it("should return stageOptions with all configured fields including runtime options", async () => {
      vi.mocked(getTaskSlots).mockReturnValue([
        { taskId: "task-1", stageName: "build", createdAt: Date.now(), nonce: "n-1" },
      ]);
      mockGetTaskContext.mockReturnValue(makeContext({
        config: {
          pipeline: {
            stages: [
              {
                name: "build",
                type: "agent",
                engine: "claude",
                model: "sonnet",
                effort: "high",
                permission_mode: "auto",
                debug: true,
                max_turns: 50,
                max_budget_usd: 10.0,
                runtime: {
                  disallowed_tools: ["bash", "write"],
                  agents: { coder: { model: "opus" } },
                },
                mcps: [{ name: "github", url: "http://localhost:3001" }],
              },
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
      expect(body.stageOptions.model).toBe("sonnet");
      expect(body.stageOptions.effort).toBe("high");
      expect(body.stageOptions.permission_mode).toBe("auto");
      expect(body.stageOptions.debug).toBe(true);
      expect(body.stageOptions.max_turns).toBe(50);
      expect(body.stageOptions.max_budget_usd).toBe(10.0);
      expect(body.stageOptions.disallowed_tools).toEqual(["bash", "write"]);
      expect(body.stageOptions.agents).toEqual({ coder: { model: "opus" } });
      expect(body.stageOptions.mcps).toEqual([{ name: "github", url: "http://localhost:3001" }]);
    });

    it("should return isGate:true for gate stage slot", async () => {
      vi.mocked(getTaskSlots).mockReturnValue([
        { taskId: "task-1", stageName: "approval", createdAt: Date.now(), nonce: "n-g" },
      ]);
      mockGetTaskContext.mockReturnValue(makeContext({
        config: {
          pipeline: {
            stages: [{ name: "approval", type: "human_confirm" }],
          },
        },
      }));

      const res = await app.request("/api/edge/task-1/next-stage");
      const body = await res.json();
      expect(body.stageName).toBe("approval");
      expect(body.isGate).toBe(true);
      expect(body.stageOptions).toBeUndefined();
    });

    it("should handle slot with no matching stage config gracefully", async () => {
      // Slot exists for stage "deploy" but no stage config in pipeline
      vi.mocked(getTaskSlots).mockReturnValue([
        { taskId: "task-1", stageName: "deploy", createdAt: Date.now(), nonce: "n-orphan" },
      ]);
      mockGetTaskContext.mockReturnValue(makeContext({
        config: {
          pipeline: {
            stages: [{ name: "build", type: "agent" }], // no "deploy" stage
          },
        },
      }));

      const res = await app.request("/api/edge/task-1/next-stage");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.stageName).toBe("deploy");
      // isGate should be false since stageConfig is undefined
      expect(body.isGate).toBe(false);
      // stageOptions should still be absent since stageConfig is undefined
      // BUG CANDIDATE: the code does `stageConfig && !isGate`, stageConfig is undefined,
      // so stageOptions won't be included — is this intentional?
      expect(body.stageOptions).toBeUndefined();
    });

    it("should handle task with no pipeline config at all", async () => {
      vi.mocked(getTaskSlots).mockReturnValue([]);
      mockGetTaskContext.mockReturnValue({
        taskId: "task-1",
        status: "running",
        config: {}, // no pipeline at all
        store: {},
      });
      mockGetPersistedPending.mockReturnValue(undefined);

      const res = await app.request("/api/edge/task-1/next-stage");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.waiting).toBe(true);
    });

    it("should handle task with null config", async () => {
      vi.mocked(getTaskSlots).mockReturnValue([]);
      mockGetTaskContext.mockReturnValue({
        taskId: "task-1",
        status: "running",
        config: null,
        store: {},
      });
      mockGetPersistedPending.mockReturnValue(undefined);

      const res = await app.request("/api/edge/task-1/next-stage");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.waiting).toBe(true);
    });
  });

  // ===== POST /stream-event adversarial =====

  describe("POST /:taskId/stream-event — adversarial", () => {
    it("should return 400 for invalid JSON body", async () => {
      const res = await app.request("/api/edge/task-1/stream-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{broken json",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid JSON");
    });

    it("should return 400 for completely empty body", async () => {
      const res = await app.request("/api/edge/task-1/stream-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid JSON");
    });

    it("should return ok with received:0 for empty array", async () => {
      const res = await app.request("/api/edge/task-1/stream-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([]),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.received).toBe(0);
      expect(mockPushMessage).not.toHaveBeenCalled();
    });

    it("should skip events with invalid type without error", async () => {
      const res = await app.request("/api/edge/task-1/stream-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([
          { type: "bogus_event", data: { x: 1 } },
        ]),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      // received reflects only forwarded events (0 valid)
      expect(body.received).toBe(0);
      expect(mockPushMessage).not.toHaveBeenCalled();
    });

    it("should forward only valid events from mixed valid/invalid batch", async () => {
      const res = await app.request("/api/edge/task-1/stream-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([
          { type: "text", data: { text: "valid1" } },
          { type: "garbage", data: {} },
          { type: "tool_use", data: { tool: "read" } },
          { type: "nope", data: {} },
          { type: "thinking", data: { text: "hmm" } },
        ]),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      // received reflects only forwarded events (3 valid out of 5)
      expect(body.received).toBe(3);
      // Only 3 valid events should be pushed
      expect(mockPushMessage).toHaveBeenCalledTimes(3);
    });

    it("should handle 1000 events without crashing", async () => {
      const events = Array.from({ length: 1000 }, (_, i) => ({
        type: "text",
        data: { text: `message-${i}` },
      }));

      const res = await app.request("/api/edge/task-1/stream-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(events),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.received).toBe(1000);
      expect(mockPushMessage).toHaveBeenCalledTimes(1000);
    });

    it("should handle event with missing data field", async () => {
      // Event has type but no data — code doesn't validate event.data exists
      const res = await app.request("/api/edge/task-1/stream-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "text" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      // The event has a valid type so it gets pushed, even without data
      expect(mockPushMessage).toHaveBeenCalledTimes(1);
      // data will be undefined in the pushed message
      const pushed = mockPushMessage.mock.calls[0][1];
      expect(pushed.data).toBeUndefined();
    });

    it("should handle event with null type", async () => {
      const res = await app.request("/api/edge/task-1/stream-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: null, data: {} }),
      });
      expect(res.status).toBe(200);
      // null is not in VALID_EVENT_TYPES, so it should be skipped
      expect(mockPushMessage).not.toHaveBeenCalled();
    });

    it("should handle non-object body (e.g., a string)", async () => {
      const res = await app.request("/api/edge/task-1/stream-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify("just a string"),
      });
      // Non-object/array JSON is now rejected with 400
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Expected JSON object or array");
      expect(mockPushMessage).not.toHaveBeenCalled();
    });

    it("should handle numeric JSON body", async () => {
      const res = await app.request("/api/edge/task-1/stream-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(42),
      });
      // Non-object/array JSON is now rejected with 400
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Expected JSON object or array");
      expect(mockPushMessage).not.toHaveBeenCalled();
    });
  });

  // ===== GET /check-interrupt adversarial =====

  describe("GET /:taskId/check-interrupt — adversarial", () => {
    it("should return interrupted:true for non-existent task (not 404)", async () => {
      // BUG CANDIDATE: This endpoint does NOT return 404 for missing tasks.
      // It returns 200 with interrupted:true. This is arguably a bug —
      // the caller can't distinguish "task was cancelled" from "task never existed".
      mockGetTaskContext.mockReturnValue(null);
      const res = await app.request("/api/edge/nonexistent/check-interrupt");
      expect(res.status).toBe(200); // Not 404!
      const body = await res.json();
      expect(body.interrupted).toBe(true);
      expect(body.reason).toBe("Task not found");
    });

    it("should return interrupted:false for running task", async () => {
      mockGetTaskContext.mockReturnValue(makeContext({ status: "running" }));
      const res = await app.request("/api/edge/task-1/check-interrupt");
      const body = await res.json();
      expect(body.interrupted).toBe(false);
      expect(body.reason).toBeUndefined();
    });

    it("should return interrupted:true with reason for cancelled task", async () => {
      mockGetTaskContext.mockReturnValue(makeContext({
        status: "cancelled",
        error: "Cancelled by user",
      }));
      const res = await app.request("/api/edge/task-1/check-interrupt");
      const body = await res.json();
      expect(body.interrupted).toBe(true);
      expect(body.reason).toBe("Cancelled by user");
    });

    it("should return interrupted:true for blocked task with no error field", async () => {
      // When error is undefined, reason should fall back to ctx.status
      mockGetTaskContext.mockReturnValue(makeContext({ status: "blocked" }));
      const res = await app.request("/api/edge/task-1/check-interrupt");
      const body = await res.json();
      expect(body.interrupted).toBe(true);
      expect(body.reason).toBe("blocked");
    });

    it("should return interrupted:false for completed task", async () => {
      // BUG CANDIDATE: completed is a terminal state in next-stage (done:true),
      // but check-interrupt says interrupted:false for completed.
      // Is this inconsistent? A completed task should arguably also signal the runner to stop.
      mockGetTaskContext.mockReturnValue(makeContext({ status: "completed" }));
      const res = await app.request("/api/edge/task-1/check-interrupt");
      const body = await res.json();
      expect(body.interrupted).toBe(false);
    });

    it("should return interrupted:false for a custom stage status", async () => {
      mockGetTaskContext.mockReturnValue(makeContext({ status: "implementing" }));
      const res = await app.request("/api/edge/task-1/check-interrupt");
      const body = await res.json();
      expect(body.interrupted).toBe(false);
      expect(body.reason).toBeUndefined();
    });
  });

  // ===== GET /events (SSE) adversarial =====

  describe("GET /:taskId/events — adversarial", () => {
    it("should return 404 for non-existent task", async () => {
      mockGetTaskContext.mockReturnValue(null);
      const res = await app.request("/api/edge/fake-task/events");
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain("not found");
    });
  });

  // ===== Edge cases for received count =====

  describe("stream-event received count semantics", () => {
    it("received should reflect only forwarded events, not total", async () => {
      // This test captures a potential semantic bug:
      // The API returns events.length as "received" count,
      // but only valid events are actually forwarded to SSE.
      // A client checking "received" to confirm delivery would be misled.
      const res = await app.request("/api/edge/task-1/stream-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([
          { type: "text", data: { text: "ok" } },
          { type: "invalid_type", data: {} },
          { type: "also_invalid", data: {} },
        ]),
      });
      const body = await res.json();
      // BUG: received is 3 (total) but only 1 was actually forwarded
      // This test EXPECTS the "correct" behavior (received = forwarded count)
      // and should FAIL against the current implementation.
      expect(body.received).toBe(1); // WILL FAIL — actual is 3
    });
  });
});
