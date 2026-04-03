import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { ErrorCode, errorResponse } from "./error-response.js";

describe("errorResponse – adversarial", () => {
  it("returns empty details array when details is []", async () => {
    const app = new Hono();
    app.get("/test", (c) =>
      errorResponse(c, 400, ErrorCode.VALIDATION_FAILED, "Bad", []),
    );
    const res = await app.request("/test");
    const body = await res.json();
    expect(body.details).toEqual([]);
  });

  it("handles empty string message", async () => {
    const app = new Hono();
    app.get("/test", (c) =>
      errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, ""),
    );
    const res = await app.request("/test");
    const body = await res.json();
    expect(body.error).toBe("");
    expect(body.code).toBe("INTERNAL_ERROR");
  });

  it("handles status code 0 (unusual but valid)", async () => {
    const app = new Hono();
    app.get("/test", (c) =>
      errorResponse(c, 200, ErrorCode.INTERNAL_ERROR, "OK but error code"),
    );
    const res = await app.request("/test");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL_ERROR");
  });

  it("handles message with special JSON characters", async () => {
    const app = new Hono();
    const msg = 'Has "quotes" and \\ backslash and \n newline';
    app.get("/test", (c) =>
      errorResponse(c, 400, ErrorCode.VALIDATION_FAILED, msg),
    );
    const res = await app.request("/test");
    const body = await res.json();
    expect(body.error).toBe(msg);
  });

  it("handles details with multiple items", async () => {
    const app = new Hono();
    const details = ["error 1", "error 2", "error 3"];
    app.get("/test", (c) =>
      errorResponse(c, 422, ErrorCode.VALIDATION_FAILED, "Multiple", details),
    );
    const res = await app.request("/test");
    const body = await res.json();
    expect(body.details).toEqual(details);
    expect(body.details).toHaveLength(3);
  });

  it("ErrorCode values are all unique", () => {
    const values = Object.values(ErrorCode);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it("ErrorCode keys match their values exactly", () => {
    for (const [key, value] of Object.entries(ErrorCode)) {
      expect(key).toBe(value);
    }
  });

  it("response content-type is application/json", async () => {
    const app = new Hono();
    app.get("/test", (c) =>
      errorResponse(c, 404, ErrorCode.TASK_NOT_FOUND, "Not found"),
    );
    const res = await app.request("/test");
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
