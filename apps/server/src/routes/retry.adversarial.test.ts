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

describe("retry routes — adversarial", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route("/", retryRoute);
  });

  it("handles sync field as string 'true' — should fail JSON parse catch path", async () => {
    // The route does c.req.json().catch(() => ({})) then accesses body.sync
    // If body is { sync: "true" }, it's a string, not boolean
    mockRetryTask.mockReturnValue({ ok: true, data: {} });

    const res = await app.request(
      "/tasks/11111111-1111-1111-1111-111111111111/retry",
      json({ sync: "true" }),
    );

    // No schema validation on this route's body (it catches JSON parse errors)
    // So "true" string passes through as sync value
    expect(res.status).toBe(200);
    expect(mockRetryTask).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      { sync: "true" },
    );
  });

  it("handles invalid JSON body — falls back to empty object", async () => {
    mockRetryTask.mockReturnValue({ ok: true, data: {} });

    const res = await app.request(
      "/tasks/11111111-1111-1111-1111-111111111111/retry",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{{not json",
      },
    );

    expect(res.status).toBe(200);
    expect(mockRetryTask).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      { sync: undefined },
    );
  });

  it("retryTask throws async error", async () => {
    mockRetryTask.mockImplementation(() => {
      throw new Error("unexpected sync throw");
    });

    const res = await app.request(
      "/tasks/11111111-1111-1111-1111-111111111111/retry",
      json({}),
    );

    expect(res.status).toBe(500);
  });

  it("handles body with extra fields — they are ignored", async () => {
    mockRetryTask.mockReturnValue({ ok: true, data: {} });

    const res = await app.request(
      "/tasks/11111111-1111-1111-1111-111111111111/retry",
      json({ sync: true, extraField: "malicious", __proto__: {} }),
    );

    expect(res.status).toBe(200);
    // Only sync is extracted
    expect(mockRetryTask).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      { sync: true },
    );
  });

  it("rapid concurrent retries on same task", async () => {
    let callCount = 0;
    mockRetryTask.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return { ok: true, data: {} };
      return { ok: false, code: "INVALID_STATE", message: "already retrying" };
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.request("/tasks/11111111-1111-1111-1111-111111111111/retry", json({})),
      ),
    );

    const statuses = results.map((r) => r.status);
    expect(statuses).toContain(200);
    // At least some should be 400 (INVALID_STATE)
    expect(statuses.some((s) => s === 400)).toBe(true);
  });

  it("GET method on retry endpoint returns 404 (only POST defined)", async () => {
    const res = await app.request("/tasks/11111111-1111-1111-1111-111111111111/retry");
    expect(res.status).toBe(404);
  });
});
