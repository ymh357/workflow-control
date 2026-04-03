import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockCreateTask = vi.fn();
const mockLaunch = vi.fn();

vi.mock("../actions/task-actions.js", () => ({
  createTask: (...args: unknown[]) => mockCreateTask(...args),
  launch: (...args: unknown[]) => mockLaunch(...args),
}));

import { triggerRoute } from "./trigger.js";

function json(body: unknown) {
  return {
    method: "POST" as const,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("trigger routes", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route("/", triggerRoute);
  });

  // --- POST /tasks ---

  describe("POST /tasks", () => {
    it("returns 201 with taskId on successful creation with taskText", async () => {
      mockCreateTask.mockReturnValue({
        ok: true,
        data: { taskId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" },
      });

      const res = await app.request(
        "/tasks",
        json({ taskText: "Build a feature" }),
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.taskId).toBe("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    });

    it("passes all optional fields", async () => {
      mockCreateTask.mockReturnValue({
        ok: true,
        data: { taskId: "cccccccc-cccc-cccc-cccc-cccccccccccc" },
      });

      const res = await app.request(
        "/tasks",
        json({
          taskText: "Do something",
          repoName: "my-repo",
          pipelineName: "default",
          edge: true,
        }),
      );

      expect(res.status).toBe(201);
      expect(mockCreateTask).toHaveBeenCalledWith({
        taskText: "Do something",
        repoName: "my-repo",
        pipelineName: "default",
        edge: true,
      });
    });

    it("returns 400 validation error when taskText is missing", async () => {
      const res = await app.request("/tasks", json({}));

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("VALIDATION_FAILED");
    });

    it("returns 409 when task already in progress", async () => {
      mockCreateTask.mockReturnValue({
        ok: false,
        code: "INVALID_STATE",
        message: "Task already in progress",
      });

      const res = await app.request(
        "/tasks",
        json({ taskText: "test" }),
      );

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe("INVALID_STATE");
    });

    it("returns 409 when task already exists", async () => {
      mockCreateTask.mockReturnValue({
        ok: false,
        code: "INTERNAL_ERROR",
        message: "Task already exists",
      });

      const res = await app.request(
        "/tasks",
        json({ taskText: "test" }),
      );

      expect(res.status).toBe(409);
    });

    it("returns 400 when pipeline not found", async () => {
      mockCreateTask.mockReturnValue({
        ok: false,
        code: "INTERNAL_ERROR",
        message: "Pipeline not found",
      });

      const res = await app.request(
        "/tasks",
        json({ taskText: "test" }),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("INVALID_CONFIG");
    });

    it("returns 500 on generic internal error", async () => {
      mockCreateTask.mockReturnValue({
        ok: false,
        code: "INTERNAL_ERROR",
        message: "Something broke",
      });

      const res = await app.request(
        "/tasks",
        json({ taskText: "test" }),
      );

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.code).toBe("INTERNAL_ERROR");
    });

    it("returns 400 when body is invalid JSON", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{bad json",
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("VALIDATION_FAILED");
    });
  });

  // --- POST /tasks/:id/launch ---

  describe("POST /tasks/:id/launch", () => {
    it("returns 200 with ok:true on successful launch", async () => {
      mockLaunch.mockReturnValue({ ok: true, data: {} });

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/launch",
        { method: "POST" },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(mockLaunch).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111");
    });

    it("returns 404 when task not found or already launched", async () => {
      mockLaunch.mockReturnValue({
        ok: false,
        code: "TASK_NOT_FOUND",
        message: "Task not found or already launched",
      });

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/launch",
        { method: "POST" },
      );

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("TASK_NOT_FOUND");
      expect(body.error).toBe("Task not found or already launched");
    });
  });
});
