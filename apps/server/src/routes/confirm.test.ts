import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockConfirmGate = vi.fn();
const mockRejectGate = vi.fn();

vi.mock("../actions/task-actions.js", () => ({
  confirmGate: (...args: unknown[]) => mockConfirmGate(...args),
  rejectGate: (...args: unknown[]) => mockRejectGate(...args),
}));

import { confirmRoute } from "./confirm.js";

function json(body: unknown, method = "POST") {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("confirm routes", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route("/", confirmRoute);
  });

  // --- POST /tasks/:taskId/confirm ---

  describe("POST /tasks/:taskId/confirm", () => {
    it("returns 200 with ok:true on successful confirm", async () => {
      mockConfirmGate.mockReturnValue({
        ok: true,
        data: { statusBefore: "review_gate", statusAfter: "coding" },
      });

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/confirm",
        json({}),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.statusBefore).toBe("review_gate");
      expect(body.statusAfter).toBe("coding");
      expect(mockConfirmGate).toHaveBeenCalledWith(
        "11111111-1111-1111-1111-111111111111",
        { repoName: undefined },
      );
    });

    it("passes repoName when provided", async () => {
      mockConfirmGate.mockReturnValue({
        ok: true,
        data: { statusBefore: "gate", statusAfter: "next" },
      });

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/confirm",
        json({ repoName: "my-repo" }),
      );

      expect(res.status).toBe(200);
      expect(mockConfirmGate).toHaveBeenCalledWith(
        "11111111-1111-1111-1111-111111111111",
        { repoName: "my-repo" },
      );
    });

    it("returns 404 when task not found", async () => {
      mockConfirmGate.mockReturnValue({
        ok: false,
        code: "TASK_NOT_FOUND",
        message: "Task not found",
      });

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/confirm",
        json({}),
      );

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("TASK_NOT_FOUND");
    });

    it("returns 400 when task is not at a gate", async () => {
      mockConfirmGate.mockReturnValue({
        ok: false,
        code: "INVALID_STATE",
        message: "Task is not awaiting confirmation",
      });

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/confirm",
        json({}),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("INVALID_STATE");
    });

    it("accepts empty body (all fields optional)", async () => {
      mockConfirmGate.mockReturnValue({ ok: true, data: { statusBefore: "g", statusAfter: "n" } });

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/confirm",
        { method: "POST" },
      );

      expect(res.status).toBe(200);
    });
  });

  // --- POST /tasks/:taskId/reject ---

  describe("POST /tasks/:taskId/reject", () => {
    it("returns 200 with ok:true on successful reject", async () => {
      mockRejectGate.mockReturnValue({
        ok: true,
        data: { statusBefore: "review_gate", statusAfter: "rejected" },
      });

      const res = await app.request(
        "/tasks/22222222-2222-2222-2222-222222222222/reject",
        json({ reason: "bad code" }),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(mockRejectGate).toHaveBeenCalledWith(
        "22222222-2222-2222-2222-222222222222",
        { reason: "bad code" },
      );
    });

    it("passes feedback when provided", async () => {
      mockRejectGate.mockReturnValue({
        ok: true,
        data: { statusBefore: "gate", statusAfter: "rework" },
      });

      const res = await app.request(
        "/tasks/22222222-2222-2222-2222-222222222222/reject",
        json({ feedback: "please fix tests" }),
      );

      expect(res.status).toBe(200);
      expect(mockRejectGate).toHaveBeenCalledWith(
        "22222222-2222-2222-2222-222222222222",
        { feedback: "please fix tests" },
      );
    });

    it("returns 404 when task not found", async () => {
      mockRejectGate.mockReturnValue({
        ok: false,
        code: "TASK_NOT_FOUND",
        message: "Task not found",
      });

      const res = await app.request(
        "/tasks/22222222-2222-2222-2222-222222222222/reject",
        json({}),
      );

      expect(res.status).toBe(404);
    });

    it("returns 400 when task is not at a gate", async () => {
      mockRejectGate.mockReturnValue({
        ok: false,
        code: "INVALID_STATE",
        message: "Task is not awaiting confirmation",
      });

      const res = await app.request(
        "/tasks/22222222-2222-2222-2222-222222222222/reject",
        json({}),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("INVALID_STATE");
    });

    it("accepts empty body (all fields optional)", async () => {
      mockRejectGate.mockReturnValue({ ok: true, data: { statusBefore: "g", statusAfter: "n" } });

      const res = await app.request(
        "/tasks/22222222-2222-2222-2222-222222222222/reject",
        { method: "POST" },
      );

      expect(res.status).toBe(200);
    });
  });
});
