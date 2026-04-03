import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockCancelTask_ = vi.fn();
const mockResumeTask = vi.fn();
const mockDeleteTask = vi.fn();

vi.mock("../actions/task-actions.js", () => ({
  cancelTask_: (...args: unknown[]) => mockCancelTask_(...args),
  resumeTask: (...args: unknown[]) => mockResumeTask(...args),
  deleteTask: (...args: unknown[]) => mockDeleteTask(...args),
}));

import { cancelRoute } from "./cancel.js";

describe("cancel routes", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route("/", cancelRoute);
  });

  // --- POST /tasks/:taskId/cancel ---

  describe("POST /tasks/:taskId/cancel", () => {
    it("returns 200 with ok:true on successful cancel", async () => {
      mockCancelTask_.mockResolvedValue({ ok: true, data: {} });

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/cancel",
        { method: "POST" },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(mockCancelTask_).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111");
    });

    it("returns 404 when task not found", async () => {
      mockCancelTask_.mockResolvedValue({
        ok: false,
        code: "TASK_NOT_FOUND",
        message: "Task not found",
      });

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/cancel",
        { method: "POST" },
      );

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("TASK_NOT_FOUND");
    });

    it("returns 400 when task is already in terminal state", async () => {
      mockCancelTask_.mockResolvedValue({
        ok: false,
        code: "INVALID_STATE",
        message: "Task already in terminal state: completed",
      });

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/cancel",
        { method: "POST" },
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("INVALID_STATE");
    });
  });

  // --- POST /tasks/:taskId/resume ---

  describe("POST /tasks/:taskId/resume", () => {
    it("returns 200 with ok:true and statusAfter on successful resume", async () => {
      mockResumeTask.mockReturnValue({
        ok: true,
        data: { statusAfter: "coding" },
      });

      const res = await app.request(
        "/tasks/22222222-2222-2222-2222-222222222222/resume",
        { method: "POST" },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.statusAfter).toBe("coding");
      expect(mockResumeTask).toHaveBeenCalledWith("22222222-2222-2222-2222-222222222222");
    });

    it("returns 404 when task not found", async () => {
      mockResumeTask.mockReturnValue({
        ok: false,
        code: "TASK_NOT_FOUND",
        message: "Task not found",
      });

      const res = await app.request(
        "/tasks/22222222-2222-2222-2222-222222222222/resume",
        { method: "POST" },
      );

      expect(res.status).toBe(404);
    });

    it("returns 400 when task cannot be resumed", async () => {
      mockResumeTask.mockReturnValue({
        ok: false,
        code: "INVALID_STATE",
        message: "Cannot resume from status: running",
      });

      const res = await app.request(
        "/tasks/22222222-2222-2222-2222-222222222222/resume",
        { method: "POST" },
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("INVALID_STATE");
    });
  });

  // --- DELETE /tasks/:taskId ---

  describe("DELETE /tasks/:taskId", () => {
    it("returns 200 with ok:true on successful delete", async () => {
      mockDeleteTask.mockReturnValue({ ok: true, data: {} });

      const res = await app.request(
        "/tasks/33333333-3333-3333-3333-333333333333",
        { method: "DELETE" },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(mockDeleteTask).toHaveBeenCalledWith("33333333-3333-3333-3333-333333333333");
    });

    it("returns 404 when task not found (if action returns error)", async () => {
      mockDeleteTask.mockReturnValue({
        ok: false,
        code: "TASK_NOT_FOUND",
        message: "Task not found",
      });

      const res = await app.request(
        "/tasks/33333333-3333-3333-3333-333333333333",
        { method: "DELETE" },
      );

      expect(res.status).toBe(404);
    });
  });
});
