import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  validateTaskId,
  validateBody,
  getValidatedBody,
  createTaskSchema,
  answerSchema,
  sandboxSchema,
  taskConfigUpdateSchema,
} from "./validate.js";

describe("validateTaskId — adversarial", () => {
  const app = new Hono();
  app.get("/tasks/:taskId", validateTaskId, (c) => c.json({ ok: true, id: c.req.param("taskId") }));

  it("rejects UUID with null bytes", async () => {
    const res = await app.request("/tasks/550e8400-e29b-41d4-a716-44665544\x00000");
    expect(res.status).toBe(400);
  });

  it("rejects SQL injection in taskId", async () => {
    const res = await app.request("/tasks/' OR 1=1 --");
    expect(res.status).toBe(400);
  });

  it("rejects taskId with newlines (HTTP header injection)", async () => {
    const res = await app.request("/tasks/550e8400-e29b-41d4-a716-446655440000%0d%0aX-Injected:true");
    expect(res.status).toBe(400);
  });

  it("accepts valid v4 UUID with all-zero variant", async () => {
    const res = await app.request("/tasks/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(200);
  });

  it("rejects UUID with unicode lookalike characters", async () => {
    // Using fullwidth digits
    const res = await app.request("/tasks/\uFF15\uFF15\uFF100e8400-e29b-41d4-a716-446655440000");
    expect(res.status).toBe(400);
  });
});

describe("validateBody — adversarial", () => {
  it("handles deeply nested JSON without stack overflow", async () => {
    const app = new Hono();
    app.post("/test", validateBody(taskConfigUpdateSchema), (c) => {
      return c.json(getValidatedBody(c));
    });

    let deep: any = { value: "leaf" };
    for (let i = 0; i < 100; i++) {
      deep = { nested: deep };
    }

    const res = await app.request("/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { pipeline: deep } }),
    });

    expect(res.status).toBe(200);
  });

  it("handles body with BOM (byte order mark)", async () => {
    const app = new Hono();
    app.post("/test", validateBody(answerSchema), (c) => {
      return c.json(getValidatedBody(c));
    });

    const bom = "\uFEFF";
    const res = await app.request("/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bom + JSON.stringify({ questionId: "q1", answer: "yes" }),
    });

    // BOM before JSON may cause parse error
    expect([200, 400]).toContain(res.status);
  });

  it("rejects body with whitespace-only text as empty object", async () => {
    const app = new Hono();
    app.post("/test", validateBody(answerSchema), (c) => {
      return c.json(getValidatedBody(c));
    });

    const res = await app.request("/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "   \n\t  ",
    });

    // Trimmed body is empty, treated as {} which fails answerSchema
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });
});

describe("createTaskSchema — adversarial", () => {
  it("rejects empty taskText", () => {
    const result = createTaskSchema.safeParse({ taskText: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing taskText", () => {
    const result = createTaskSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("accepts taskText with valid content", () => {
    const result = createTaskSchema.safeParse({ taskText: "Build a feature" });
    expect(result.success).toBe(true);
  });
});

describe("sandboxSchema — adversarial", () => {
  it("accepts filesystem paths with traversal (no path validation)", () => {
    const result = sandboxSchema.safeParse({
      filesystem: {
        allow_write: ["../../../etc"],
        deny_read: ["/proc/self/environ"],
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts network domains with wildcard patterns", () => {
    const result = sandboxSchema.safeParse({
      network: {
        allowed_domains: ["*", "*.evil.com", ""],
      },
    });
    expect(result.success).toBe(true);
  });
});
