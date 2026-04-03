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

describe("cancel routes — adversarial", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route("/", cancelRoute);
  });

  it("cancelTask_ rejects with async error — propagates to 500", async () => {
    mockCancelTask_.mockRejectedValue(new Error("async boom"));

    const res = await app.request(
      "/tasks/11111111-1111-1111-1111-111111111111/cancel",
      { method: "POST" },
    );
    expect(res.status).toBe(500);
  });

  it("resumeTask throws synchronously — propagates to 500", async () => {
    mockResumeTask.mockImplementation(() => {
      throw new Error("sync boom");
    });

    const res = await app.request(
      "/tasks/11111111-1111-1111-1111-111111111111/resume",
      { method: "POST" },
    );
    expect(res.status).toBe(500);
  });

  it("DELETE with taskId containing URL-encoded chars", async () => {
    mockDeleteTask.mockReturnValue({ ok: true, data: {} });

    const res = await app.request(
      "/tasks/task%20with%20spaces",
      { method: "DELETE" },
    );

    expect(res.status).toBe(200);
    expect(mockDeleteTask).toHaveBeenCalledWith("task with spaces");
  });

  it("concurrent cancel and resume on same task — both calls go through", async () => {
    mockCancelTask_.mockResolvedValue({ ok: true, data: {} });
    mockResumeTask.mockReturnValue({ ok: true, data: { statusAfter: "running" } });

    const [cancelRes, resumeRes] = await Promise.all([
      app.request("/tasks/11111111-1111-1111-1111-111111111111/cancel", { method: "POST" }),
      app.request("/tasks/11111111-1111-1111-1111-111111111111/resume", { method: "POST" }),
    ]);

    // Both calls should complete without crashing
    expect(cancelRes.status).toBe(200);
    expect(resumeRes.status).toBe(200);
  });

  it("cancel route ignores request body entirely", async () => {
    mockCancelTask_.mockResolvedValue({ ok: true, data: {} });

    const res = await app.request(
      "/tasks/11111111-1111-1111-1111-111111111111/cancel",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ malicious: true }),
      },
    );

    expect(res.status).toBe(200);
    // Only taskId param is used
    expect(mockCancelTask_).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111");
  });

  it("deleteTask returns INTERNAL_ERROR maps to 500", async () => {
    mockDeleteTask.mockReturnValue({
      ok: false,
      code: "INTERNAL_ERROR",
      message: "fs permission denied",
    });

    const res = await app.request(
      "/tasks/11111111-1111-1111-1111-111111111111",
      { method: "DELETE" },
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL_ERROR");
  });
});
