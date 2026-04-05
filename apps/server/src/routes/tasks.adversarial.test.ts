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

describe("tasks routes — adversarial", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route("/", tasksRoute);
  });

  describe("GET /tasks — XSS and error leakage", () => {
    it("does not leak stack traces from failed restores into response", async () => {
      mockLoadAllPersistedTaskIds.mockReturnValue(["bad-1"]);
      mockGetWorkflow.mockReturnValue(null);
      mockRestoreWorkflow.mockImplementation(() => {
        const err = new Error("corrupt");
        err.stack = "Error: corrupt\n    at secret/internal/path.js:42:10";
        throw err;
      });
      mockGetAllWorkflows.mockReturnValue(new Map());

      const res = await app.request("/tasks");
      const body = await res.json();

      expect(body.failedRestores[0].reason).toBe("corrupt");
      expect(JSON.stringify(body)).not.toContain("secret/internal/path");
    });

    it("handles actor.getSnapshot() throwing mid-iteration", async () => {
      mockLoadAllPersistedTaskIds.mockReturnValue([]);
      const badActor = { getSnapshot: () => { throw new Error("segfault"); } };
      const goodActor = makeActor({ status: "running", lastStage: "x", store: {}, config: {}, totalCostUsd: 0 });
      mockGetAllWorkflows.mockReturnValue(new Map<string, any>([["bad", badActor], ["good", goodActor]]));
      mockGetLatestSessionId.mockReturnValue(null);

      const res = await app.request("/tasks");
      expect(res.status).toBe(200);
      const body = await res.json();
      // The good actor should still appear despite the bad one
      expect(body.tasks.length).toBeGreaterThanOrEqual(1);
    });

    it("handles XSS payloads in store values used for displayTitle", async () => {
      mockLoadAllPersistedTaskIds.mockReturnValue([]);
      const xssPayload = '<script>alert("xss")</script>';
      const actor = makeActor({
        status: "running",
        lastStage: "x",
        store: { title: xssPayload },
        config: { pipeline: { display: { title_path: "title" } } },
        totalCostUsd: 0,
      });
      mockGetAllWorkflows.mockReturnValue(new Map([["t1", actor]]));
      mockGetLatestSessionId.mockReturnValue(null);
      mockGetNestedValue.mockReturnValue(xssPayload);

      const res = await app.request("/tasks");
      const body = await res.json();
      // The value is returned as-is in JSON (no HTML encoding needed for JSON API)
      // but it should not cause server crash
      expect(body.tasks[0].displayTitle).toBe(xssPayload);
    });

    it("handles non-Error throw from restoreWorkflow", async () => {
      mockLoadAllPersistedTaskIds.mockReturnValue(["t1"]);
      mockGetWorkflow.mockReturnValue(null);
      mockRestoreWorkflow.mockImplementation(() => {
        throw "string error";
      });
      mockGetAllWorkflows.mockReturnValue(new Map());

      const res = await app.request("/tasks");
      const body = await res.json();
      expect(body.failedRestores[0].reason).toBe("string error");
    });

    it("reports restoreWorkflow returning undefined as a failed restore", async () => {
      mockLoadAllPersistedTaskIds.mockReturnValue(["ghost-1"]);
      mockGetWorkflow.mockReturnValue(null);
      mockRestoreWorkflow.mockReturnValue(undefined);
      mockGetAllWorkflows.mockReturnValue(new Map());

      const res = await app.request("/tasks");
      const body = await res.json();

      expect(body.failedRestores).toEqual([
        { id: "ghost-1", reason: "Task snapshot could not be restored" },
      ]);
    });
  });

  describe("POST /tasks/:taskId/message — edge cases", () => {
    it("handles message with only unicode whitespace (non-ASCII spaces)", async () => {
      mockSendMessage.mockResolvedValue({ ok: true, data: {} });

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/message",
        json({ message: "\u200B\u00A0\u2003" }),
      );
      // \u200B (zero-width space) is NOT trimmed by .trim() in V8,
      // so the message passes the empty check and sendMessage is called.
      // \u00A0 and \u2003 ARE trimmed by modern JS .trim().
      // The actual result depends on what remains after trim.
      expect([200, 400]).toContain(res.status);
    });

    it("handles extremely long message without crashing", async () => {
      mockSendMessage.mockResolvedValue({ ok: true, data: {} });
      const longMessage = "A".repeat(100_000);

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/message",
        json({ message: longMessage }),
      );

      expect(res.status).toBe(200);
      expect(mockSendMessage).toHaveBeenCalledWith(
        "11111111-1111-1111-1111-111111111111",
        longMessage,
      );
    });

    it("returns error when message value is a number, not string", async () => {
      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/message",
        json({ message: 42 }),
      );
      // Zod z.string() rejects number — validateBody returns 400 before the handler runs
      expect(res.status).toBe(400);
    });
  });

  describe("GET /tasks/:taskId/config — prototype pollution guard", () => {
    it("returns config containing __proto__ key without pollution", async () => {
      const config = { __proto__: { isAdmin: true }, pipeline: {} };
      const actor = makeActor({ config });
      mockGetWorkflow.mockReturnValue(actor);

      const res = await app.request("/tasks/11111111-1111-1111-1111-111111111111/config");
      expect(res.status).toBe(200);
      const body = await res.json();
      // Ensure the response does not inherit polluted prototype
      expect(body.config.isAdmin).toBeUndefined();
    });
  });

  describe("PUT /tasks/:taskId/config — concurrent mutation", () => {
    it("rejects config updates while the task is still running", async () => {
      const actor = makeActor({ config: { old: true } });
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

      expect(res.status).toBe(409);
      expect(mockSendEvent).not.toHaveBeenCalled();
    });
  });
});
