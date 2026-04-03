import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";

// --- Mocks (same pattern as existing test files) ---

vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
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
import { getTaskSlots, addSlotListener, addTaskTerminationListener } from "./registry.js";

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

describe("wrapper-api new adversarial tests", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route("/api/edge", buildWrapperRoute());
  });

  // ===== POST /stream-event — all invalid types =====

  describe("POST /:taskId/stream-event — all invalid event types", () => {
    it("should return received:0 when every event has an invalid type", async () => {
      const res = await app.request("/api/edge/task-1/stream-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([
          { type: "foo", data: { a: 1 } },
          { type: "bar", data: { b: 2 } },
          { type: "baz", data: { c: 3 } },
          { type: "result", data: {} },
          { type: "error", data: {} },
        ]),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.received).toBe(0);
      expect(mockPushMessage).not.toHaveBeenCalled();
    });
  });

  // ===== POST /stream-event — exact forwarded count with mixed types =====

  describe("POST /:taskId/stream-event — mixed valid/invalid exact count", () => {
    it("should forward exactly 2 out of 5 events when 2 are valid", async () => {
      const res = await app.request("/api/edge/task-1/stream-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([
          { type: "text", data: { text: "ok1" } },
          { type: "invalid_a", data: {} },
          { type: "invalid_b", data: {} },
          { type: "thinking", data: { text: "thought" } },
          { type: "invalid_c", data: {} },
        ]),
      });
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.received).toBe(2);
      expect(mockPushMessage).toHaveBeenCalledTimes(2);

      // Verify correct type mapping for the two forwarded events
      expect(mockPushMessage.mock.calls[0][1].type).toBe("agent_text");
      expect(mockPushMessage.mock.calls[1][1].type).toBe("agent_thinking");
    });
  });

  // ===== POST /stream-event — empty array body =====

  describe("POST /:taskId/stream-event — empty array", () => {
    it("should return received:0 and not push any messages for empty array", async () => {
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
  });

  // ===== POST /stream-event — event.data edge cases =====

  describe("POST /:taskId/stream-event — event.data edge cases", () => {
    it("should forward event with null data without crashing", async () => {
      const res = await app.request("/api/edge/task-1/stream-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "text", data: null }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.received).toBe(1);
      expect(mockPushMessage).toHaveBeenCalledTimes(1);
      // data is null but still forwarded — the code does not validate data shape
      expect(mockPushMessage.mock.calls[0][1].data).toBeNull();
    });

    it("should forward event with undefined data (missing field)", async () => {
      const res = await app.request("/api/edge/task-1/stream-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "tool_use" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.received).toBe(1);
      expect(mockPushMessage.mock.calls[0][1].data).toBeUndefined();
    });

    it("should forward event with non-object data (string)", async () => {
      const res = await app.request("/api/edge/task-1/stream-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "thinking", data: "just a string" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.received).toBe(1);
      // The code casts data as SSEMessage["data"] but doesn't validate
      expect(mockPushMessage.mock.calls[0][1].data).toBe("just a string");
    });
  });

  // ===== POST /stream-event — extremely large batch =====

  describe("POST /:taskId/stream-event — large batch", () => {
    it("should handle 2000 events without crashing", async () => {
      const events = Array.from({ length: 2000 }, (_, i) => ({
        type: i % 3 === 0 ? "text" : i % 3 === 1 ? "tool_use" : "thinking",
        data: { index: i },
      }));

      const res = await app.request("/api/edge/task-1/stream-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(events),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.received).toBe(2000);
      expect(mockPushMessage).toHaveBeenCalledTimes(2000);
    });
  });

  // ===== GET /context (next-stage) when task doesn't exist =====

  describe("GET /:taskId/next-stage — non-existent task with special chars", () => {
    it("should return 404 and include taskId with URL-encoded special chars", async () => {
      mockGetTaskContext.mockReturnValue(null);
      const res = await app.request("/api/edge/task%2F123/next-stage");
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });
  });

  // ===== GET /events SSE stream — verify actual event streaming =====

  describe("GET /:taskId/events — verify event content in stream", () => {
    it("should stream slot_created events with correct SSE format", async () => {
      mockGetTaskContext.mockReturnValue(makeContext());
      vi.mocked(getTaskSlots).mockReturnValue([
        { taskId: "task-1", stageName: "deploy", createdAt: Date.now(), nonce: "n-42" },
      ]);

      const res = await app.request("/api/edge/task-1/events");
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const { value } = await reader.read();
      const text = decoder.decode(value);

      // Verify SSE format: "event: <name>\ndata: <json>\n\n"
      expect(text).toMatch(/^event: slot_created\ndata: .+\n\n$/);

      const dataLine = text.split("\n")[1]!;
      const data = JSON.parse(dataLine.replace("data: ", ""));
      expect(data.stageName).toBe("deploy");
      expect(data.nonce).toBe("n-42");

      reader.cancel();
    });

    it("should stream task_terminated and then close", async () => {
      mockGetTaskContext.mockReturnValue(makeContext());
      vi.mocked(getTaskSlots).mockReturnValue([]);

      let terminationCallback: ((taskId: string, reason: string) => void) | undefined;
      vi.mocked(addTaskTerminationListener).mockImplementation((_taskId, fn) => {
        terminationCallback = fn;
        return () => {};
      });

      const res = await app.request("/api/edge/task-1/events");
      expect(res.status).toBe(200);

      terminationCallback!("task-1", "cancelled");

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const { value } = await reader.read();
      const text = decoder.decode(value);

      expect(text).toContain("event: task_terminated");
      expect(text).toContain('"reason":"cancelled"');

      reader.cancel();
    });
  });

  // ===== Concurrent /stream-event requests for same taskId =====

  describe("POST /:taskId/stream-event — concurrent requests", () => {
    it("should handle concurrent stream-event requests without data loss", async () => {
      const batch1 = Array.from({ length: 50 }, (_, i) => ({
        type: "text",
        data: { text: `batch1-${i}` },
      }));
      const batch2 = Array.from({ length: 50 }, (_, i) => ({
        type: "tool_use",
        data: { tool: `batch2-${i}` },
      }));

      const [res1, res2] = await Promise.all([
        app.request("/api/edge/task-1/stream-event", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(batch1),
        }),
        app.request("/api/edge/task-1/stream-event", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(batch2),
        }),
      ]);

      const body1 = await res1.json();
      const body2 = await res2.json();

      expect(body1.ok).toBe(true);
      expect(body1.received).toBe(50);
      expect(body2.ok).toBe(true);
      expect(body2.received).toBe(50);

      // Total pushes should be 100
      expect(mockPushMessage).toHaveBeenCalledTimes(100);
    });
  });

  // ===== POST /stream-event — body is boolean or null JSON =====

  describe("POST /:taskId/stream-event — exotic JSON bodies", () => {
    it("should return 400 for boolean JSON body", async () => {
      const res = await app.request("/api/edge/task-1/stream-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(true),
      });
      // boolean is not object/array — rejected early
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Expected JSON object or array");
    });

    it("should return 400 for null JSON body after fix", async () => {
      // null is valid JSON but not an object/array — now rejected early
      const res = await app.request("/api/edge/task-1/stream-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(null),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Expected JSON object or array");
    });
  });
});
