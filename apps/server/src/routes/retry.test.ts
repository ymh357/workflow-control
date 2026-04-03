import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockRetryTask = vi.fn();

vi.mock("../actions/task-actions.js", () => ({
  retryTask: (...args: unknown[]) => mockRetryTask(...args),
}));

import { retryRoute } from "./retry.js";

function json(body: unknown) {
  return {
    method: "POST" as const,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("retry routes", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route("/", retryRoute);
  });

  describe("POST /tasks/:taskId/retry", () => {
    it("returns 200 with ok:true on successful retry", async () => {
      mockRetryTask.mockReturnValue({
        ok: true,
        data: { lastStage: "coding", statusAfter: "coding" },
      });

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/retry",
        json({}),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.lastStage).toBe("coding");
      expect(body.statusAfter).toBe("coding");
      expect(mockRetryTask).toHaveBeenCalledWith(
        "11111111-1111-1111-1111-111111111111",
        { sync: undefined },
      );
    });

    it("passes sync option when provided", async () => {
      mockRetryTask.mockReturnValue({
        ok: true,
        data: { lastStage: "testing", statusAfter: "testing" },
      });

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/retry",
        json({ sync: true }),
      );

      expect(res.status).toBe(200);
      expect(mockRetryTask).toHaveBeenCalledWith(
        "11111111-1111-1111-1111-111111111111",
        { sync: true },
      );
    });

    it("returns 404 when task not found", async () => {
      mockRetryTask.mockReturnValue({
        ok: false,
        code: "TASK_NOT_FOUND",
        message: "Task not found",
      });

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/retry",
        json({}),
      );

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("TASK_NOT_FOUND");
    });

    it("returns 400 when task is in terminal state", async () => {
      mockRetryTask.mockReturnValue({
        ok: false,
        code: "INVALID_STATE",
        message: "Cannot retry terminal state: completed",
      });

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/retry",
        json({}),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("INVALID_STATE");
    });

    it("returns 500 on internal error", async () => {
      mockRetryTask.mockReturnValue({
        ok: false,
        code: "INTERNAL_ERROR",
        message: "Failed to send event to workflow",
      });

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/retry",
        json({}),
      );

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.code).toBe("INTERNAL_ERROR");
    });

    it("handles empty/missing body gracefully", async () => {
      mockRetryTask.mockReturnValue({
        ok: true,
        data: { lastStage: "coding", statusAfter: "coding" },
      });

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/retry",
        { method: "POST" },
      );

      expect(res.status).toBe(200);
      expect(mockRetryTask).toHaveBeenCalledWith(
        "11111111-1111-1111-1111-111111111111",
        { sync: undefined },
      );
    });
  });
});
