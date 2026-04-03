import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  validateTaskId,
  validateBody,
  getValidatedBody,
  createTaskSchema,
  answerSchema,
  rejectSchema,
  confirmSchema,
  yamlContentSchema,
  sandboxSchema,
  taskConfigUpdateSchema,
  interruptSchema,
  retrySchema,
} from "./validate.js";

// ---------- validateTaskId ----------

describe("validateTaskId", () => {
  const app = new Hono();
  app.get("/tasks/:taskId", validateTaskId, (c) => c.json({ ok: true }));

  it("passes valid UUID", async () => {
    const res = await app.request("/tasks/550e8400-e29b-41d4-a716-446655440000");
    expect(res.status).toBe(200);
  });

  it("passes uppercase UUID", async () => {
    const res = await app.request("/tasks/550E8400-E29B-41D4-A716-446655440000");
    expect(res.status).toBe(200);
  });

  it("rejects non-UUID string", async () => {
    const res = await app.request("/tasks/not-a-uuid");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("rejects empty taskId", async () => {
    const res = await app.request("/tasks/");
    // Empty param won't match route at all, so 404
    expect(res.status).toBe(404);
  });

  it("rejects partial UUID", async () => {
    const res = await app.request("/tasks/550e8400-e29b-41d4-a716");
    expect(res.status).toBe(400);
  });

  it("rejects UUID with extra chars", async () => {
    const res = await app.request("/tasks/550e8400-e29b-41d4-a716-446655440000x");
    expect(res.status).toBe(400);
  });
});

// ---------- validateBody ----------

describe("validateBody", () => {
  const app = new Hono();
  app.post("/test", validateBody(yamlContentSchema), (c) => {
    const body = getValidatedBody(c);
    return c.json(body);
  });

  it("passes valid JSON matching schema", async () => {
    const res = await app.request("/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ content: "hello" });
  });

  it("rejects invalid JSON syntax", async () => {
    const res = await app.request("/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{{bad json",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.error).toContain("Invalid JSON");
  });

  it("rejects body that fails schema validation", async () => {
    const res = await app.request("/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wrong: "field" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.error).toContain("Validation failed");
    expect(body.details).toBeDefined();
  });

  it("treats empty body as empty object", async () => {
    const res = await app.request("/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });
    // Empty object will fail yamlContentSchema (needs content string)
    expect(res.status).toBe(400);
  });
});

// ---------- getValidatedBody ----------

describe("getValidatedBody", () => {
  it("returns the validated body from context", async () => {
    const app = new Hono();
    app.post("/extract", validateBody(answerSchema), (c) => {
      const body = getValidatedBody<{ questionId: string; answer: string }>(c);
      return c.json({ qid: body.questionId, ans: body.answer });
    });

    const res = await app.request("/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionId: "q1", answer: "yes" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ qid: "q1", ans: "yes" });
  });
});

// ---------- Zod Schemas ----------

describe("createTaskSchema", () => {
  it("accepts body with taskText", () => {
    const result = createTaskSchema.safeParse({ taskText: "do something" });
    expect(result.success).toBe(true);
  });

  it("rejects body without taskText", () => {
    const result = createTaskSchema.safeParse({ repoName: "my-repo" });
    expect(result.success).toBe(false);
  });

  it("rejects empty taskText", () => {
    const result = createTaskSchema.safeParse({ taskText: "" });
    expect(result.success).toBe(false);
  });

  it("accepts all optional fields", () => {
    const result = createTaskSchema.safeParse({
      taskText: "work",
      repoName: "repo",
      pipelineName: "pipe",
      edge: true,
    });
    expect(result.success).toBe(true);
  });
});

describe("answerSchema", () => {
  it("accepts valid answer", () => {
    const result = answerSchema.safeParse({ questionId: "q1", answer: "yes" });
    expect(result.success).toBe(true);
  });

  it("rejects empty questionId", () => {
    const result = answerSchema.safeParse({ questionId: "", answer: "yes" });
    expect(result.success).toBe(false);
  });

  it("rejects empty answer", () => {
    const result = answerSchema.safeParse({ questionId: "q1", answer: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing fields", () => {
    const result = answerSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("rejectSchema", () => {
  it("accepts empty object", () => {
    const result = rejectSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts reason and feedback", () => {
    const result = rejectSchema.safeParse({ reason: "bad", feedback: "fix this" });
    expect(result.success).toBe(true);
  });
});

describe("confirmSchema", () => {
  it("accepts empty object", () => {
    const result = confirmSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts repoName", () => {
    const result = confirmSchema.safeParse({ repoName: "my-repo" });
    expect(result.success).toBe(true);
  });
});

describe("yamlContentSchema", () => {
  it("accepts content string", () => {
    const result = yamlContentSchema.safeParse({ content: "key: value" });
    expect(result.success).toBe(true);
  });

  it("rejects missing content", () => {
    const result = yamlContentSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects non-string content", () => {
    const result = yamlContentSchema.safeParse({ content: 123 });
    expect(result.success).toBe(false);
  });
});

describe("sandboxSchema", () => {
  it("accepts empty object", () => {
    const result = sandboxSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts full sandbox config", () => {
    const result = sandboxSchema.safeParse({
      enabled: true,
      auto_allow_bash: false,
      allow_unsandboxed_commands: false,
      network: { allowed_domains: ["example.com"] },
      filesystem: {
        allow_write: ["/tmp"],
        deny_write: ["/etc"],
        deny_read: ["/secret"],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects enabled as string", () => {
    const result = sandboxSchema.safeParse({ enabled: "yes" });
    expect(result.success).toBe(false);
  });
});

describe("taskConfigUpdateSchema", () => {
  it("accepts config record", () => {
    const result = taskConfigUpdateSchema.safeParse({ config: { key: "value" } });
    expect(result.success).toBe(true);
  });

  it("rejects missing config", () => {
    const result = taskConfigUpdateSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("interruptSchema", () => {
  it("accepts empty object", () => {
    const result = interruptSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts message", () => {
    const result = interruptSchema.safeParse({ message: "stop" });
    expect(result.success).toBe(true);
  });
});

describe("retrySchema", () => {
  it("accepts empty object", () => {
    const result = retrySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts sync boolean", () => {
    const result = retrySchema.safeParse({ sync: true });
    expect(result.success).toBe(true);
  });

  it("rejects sync as string", () => {
    const result = retrySchema.safeParse({ sync: "true" });
    expect(result.success).toBe(false);
  });
});
