import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAnswerQuestion = vi.fn();

vi.mock("../actions/task-actions.js", () => ({
  answerQuestion: (...args: unknown[]) => mockAnswerQuestion(...args),
}));

import { answerRoute } from "./answer.js";

function json(body: unknown) {
  return {
    method: "POST" as const,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("answer routes — adversarial", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route("/", answerRoute);
  });

  it("questionId with only whitespace passes validation (potential issue)", async () => {
    // Zod min(1) checks length, "   " has length 3, so it passes validation
    // Then answerQuestion is called with whitespace-only questionId
    mockAnswerQuestion.mockReturnValue({ ok: false, code: "QUESTION_NOT_FOUND", message: "not found" });

    const res = await app.request(
      "/tasks/11111111-1111-1111-1111-111111111111/answer",
      json({ questionId: "   ", answer: "yes" }),
    );
    // Passes schema, goes to answerQuestion which returns 404
    expect(res.status).toBe(404);
    expect(mockAnswerQuestion).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "   ",
      "yes",
    );
  });

  it("rejects answer with numeric value instead of string", async () => {
    const res = await app.request(
      "/tasks/11111111-1111-1111-1111-111111111111/answer",
      json({ questionId: "q-1", answer: 42 }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("rejects array values for questionId", async () => {
    const res = await app.request(
      "/tasks/11111111-1111-1111-1111-111111111111/answer",
      json({ questionId: ["q-1", "q-2"], answer: "yes" }),
    );
    expect(res.status).toBe(400);
  });

  it("handles answer containing JSON injection attempt", async () => {
    mockAnswerQuestion.mockReturnValue({ ok: true, data: {} });

    const malicious = '{"__proto__": {"isAdmin": true}}';
    const res = await app.request(
      "/tasks/11111111-1111-1111-1111-111111111111/answer",
      json({ questionId: "q-1", answer: malicious }),
    );

    expect(res.status).toBe(200);
    expect(mockAnswerQuestion).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "q-1",
      malicious,
    );
  });

  it("answerQuestion throws synchronously — 500 response", async () => {
    mockAnswerQuestion.mockImplementation(() => { throw new Error("unexpected"); });

    const res = await app.request(
      "/tasks/11111111-1111-1111-1111-111111111111/answer",
      json({ questionId: "q-1", answer: "yes" }),
    );

    expect(res.status).toBe(500);
  });

  it("handles extremely long answer string", async () => {
    mockAnswerQuestion.mockReturnValue({ ok: true, data: {} });
    const longAnswer = "B".repeat(1_000_000);

    const res = await app.request(
      "/tasks/11111111-1111-1111-1111-111111111111/answer",
      json({ questionId: "q-1", answer: longAnswer }),
    );

    expect(res.status).toBe(200);
    expect(mockAnswerQuestion.mock.calls[0][2]).toBe(longAnswer);
  });

  it("concurrent answers to same question — both go through", async () => {
    mockAnswerQuestion
      .mockReturnValueOnce({ ok: true, data: {} })
      .mockReturnValueOnce({ ok: false, code: "QUESTION_STALE", message: "already answered" });

    const [res1, res2] = await Promise.all([
      app.request("/tasks/11111111-1111-1111-1111-111111111111/answer", json({ questionId: "q-1", answer: "first" })),
      app.request("/tasks/11111111-1111-1111-1111-111111111111/answer", json({ questionId: "q-1", answer: "second" })),
    ]);

    expect([200, 409]).toContain(res1.status);
    expect([200, 409]).toContain(res2.status);
  });
});
