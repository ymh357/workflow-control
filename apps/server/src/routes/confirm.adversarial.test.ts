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

describe("confirm routes — adversarial", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route("/", confirmRoute);
  });

  it("confirm with extra unknown fields — Zod strips them", async () => {
    mockConfirmGate.mockReturnValue({ ok: true, data: {} });

    const res = await app.request(
      "/tasks/11111111-1111-1111-1111-111111111111/confirm",
      json({ repoName: "repo", extraField: "should be stripped", __proto__: {} }),
    );

    expect(res.status).toBe(200);
    const passedOpts = mockConfirmGate.mock.calls[0][1];
    expect(passedOpts.extraField).toBeUndefined();
  });

  it("reject with very long feedback string", async () => {
    mockRejectGate.mockReturnValue({ ok: true, data: {} });
    const longFeedback = "x".repeat(100_000);

    const res = await app.request(
      "/tasks/11111111-1111-1111-1111-111111111111/reject",
      json({ feedback: longFeedback }),
    );

    expect(res.status).toBe(200);
    expect(mockRejectGate).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      { feedback: longFeedback },
    );
  });

  it("confirm with repoName containing path traversal", async () => {
    mockConfirmGate.mockReturnValue({ ok: true, data: {} });

    const res = await app.request(
      "/tasks/11111111-1111-1111-1111-111111111111/confirm",
      json({ repoName: "../../etc/passwd" }),
    );

    // Schema only validates it's a string; the value passes through
    expect(res.status).toBe(200);
    expect(mockConfirmGate).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      { repoName: "../../etc/passwd" },
    );
  });

  it("reject with HTML in reason — no server-side sanitization", async () => {
    mockRejectGate.mockReturnValue({ ok: true, data: {} });

    const res = await app.request(
      "/tasks/11111111-1111-1111-1111-111111111111/reject",
      json({ reason: '<img src=x onerror="alert(1)">' }),
    );

    expect(res.status).toBe(200);
  });

  it("confirmGate throws synchronously — 500 response", async () => {
    mockConfirmGate.mockImplementation(() => { throw new Error("boom"); });

    const res = await app.request(
      "/tasks/11111111-1111-1111-1111-111111111111/confirm",
      json({}),
    );

    expect(res.status).toBe(500);
  });

  it("reject with invalid JSON body returns 400", async () => {
    const res = await app.request(
      "/tasks/11111111-1111-1111-1111-111111111111/reject",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{broken}",
      },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("concurrent confirm and reject on same task", async () => {
    mockConfirmGate.mockReturnValue({ ok: true, data: {} });
    mockRejectGate.mockReturnValue({ ok: false, code: "INVALID_STATE", message: "already confirmed" });

    const [confirmRes, rejectRes] = await Promise.all([
      app.request("/tasks/11111111-1111-1111-1111-111111111111/confirm", json({})),
      app.request("/tasks/11111111-1111-1111-1111-111111111111/reject", json({})),
    ]);

    expect(confirmRes.status).toBe(200);
    expect(rejectRes.status).toBe(400);
  });
});
