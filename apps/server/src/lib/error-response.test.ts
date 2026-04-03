import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { ErrorCode, errorResponse } from "./error-response.js";

describe("errorResponse", () => {
  it("returns correct status and JSON body", async () => {
    const app = new Hono();
    app.get("/test", (c) =>
      errorResponse(c, 404, ErrorCode.TASK_NOT_FOUND, "Task not found"),
    );
    const res = await app.request("/test");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({
      error: "Task not found",
      code: "TASK_NOT_FOUND",
    });
  });

  it("includes details when provided", async () => {
    const app = new Hono();
    app.get("/test", (c) =>
      errorResponse(c, 422, ErrorCode.VALIDATION_FAILED, "Bad input", [
        "field 'name' is required",
      ]),
    );
    const res = await app.request("/test");
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toEqual({
      error: "Bad input",
      code: "VALIDATION_FAILED",
      details: ["field 'name' is required"],
    });
  });

  it("omits details key when not provided", async () => {
    const app = new Hono();
    app.get("/test", (c) =>
      errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, "Something broke"),
    );
    const res = await app.request("/test");
    const body = await res.json();
    expect(body).not.toHaveProperty("details");
  });

  it("returns 429 for rate limiting", async () => {
    const app = new Hono();
    app.get("/test", (c) =>
      errorResponse(c, 429, ErrorCode.RATE_LIMITED, "Too many requests"),
    );
    const res = await app.request("/test");
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("RATE_LIMITED");
  });
});
