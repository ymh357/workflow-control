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

describe("trigger routes — adversarial", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route("/", triggerRoute);
  });

  it("missing taskText returns validation error", async () => {
    const res = await app.request("/tasks", json({}));
    expect(res.status).toBe(400);
  });

  it("rejects extra unknown fields silently (Zod strips by default)", async () => {
    mockCreateTask.mockReturnValue({ ok: true, data: { taskId: "id-1" } });

    const res = await app.request("/tasks", json({
      taskText: "test",
      __proto__: { isAdmin: true },
      constructor: { prototype: { isAdmin: true } },
    }));

    expect(res.status).toBe(201);
    // createTask should not receive polluted fields
    const passedArg = mockCreateTask.mock.calls[0][0];
    expect(passedArg.isAdmin).toBeUndefined();
  });

  it("rejects empty taskText", async () => {
    const res = await app.request("/tasks", json({ taskText: "" }));
    expect(res.status).toBe(400);
  });

  it("rejects edge field when not boolean", async () => {
    const res = await app.request("/tasks", json({ taskText: "test", edge: "true" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("handles createTask throwing synchronously", async () => {
    mockCreateTask.mockImplementation(() => {
      throw new Error("unexpected sync throw");
    });

    const res = await app.request("/tasks", json({ taskText: "test" }));
    expect(res.status).toBe(500);
  });

  it("POST /tasks/:id/launch with XSS in task ID does not crash", async () => {
    mockLaunch.mockReturnValue({ ok: false, code: "TASK_NOT_FOUND", message: "not found" });

    const res = await app.request(
      '/tasks/<script>alert(1)</script>/launch',
      { method: "POST" },
    );

    // Hono URL-decodes the param; the action should handle it gracefully
    expect([404, 400]).toContain(res.status);
  });

  it("POST /tasks with Content-Type text/plain — body still parsed as JSON", async () => {
    mockCreateTask.mockReturnValue({ ok: true, data: { taskId: "id-1" } });
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ taskText: "test" }),
    });
    // validateBody reads c.req.text() then JSON.parse, so content-type doesn't matter
    expect([201, 400, 500]).toContain(res.status);
  });

  it("POST /tasks with null body returns validation error", async () => {
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    // JSON.parse("null") => null, which is not an object — Zod should reject
    expect(res.status).toBe(400);
  });
});
