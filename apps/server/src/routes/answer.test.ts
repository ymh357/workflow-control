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

describe("answer routes", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route("/", answerRoute);
  });

  describe("POST /tasks/:taskId/answer", () => {
    it("returns 200 with ok:true on successful answer", async () => {
      mockAnswerQuestion.mockReturnValue({ ok: true, data: {} });

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/answer",
        json({ questionId: "q-1", answer: "yes" }),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(mockAnswerQuestion).toHaveBeenCalledWith(
        "11111111-1111-1111-1111-111111111111",
        "q-1",
        "yes",
      );
    });

    it("returns 404 when question not found", async () => {
      mockAnswerQuestion.mockReturnValue({
        ok: false,
        code: "QUESTION_NOT_FOUND",
        message: "Question not found or already answered",
      });

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/answer",
        json({ questionId: "q-missing", answer: "yes" }),
      );

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("QUESTION_NOT_FOUND");
    });

    it("returns 409 when question is stale", async () => {
      mockAnswerQuestion.mockReturnValue({
        ok: false,
        code: "QUESTION_STALE",
        message: "Question was persisted but the agent session is gone",
      });

      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/answer",
        json({ questionId: "q-stale", answer: "yes" }),
      );

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe("QUESTION_STALE");
    });

    it("returns 400 when questionId is missing", async () => {
      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/answer",
        json({ answer: "yes" }),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("VALIDATION_FAILED");
    });

    it("returns 400 when answer is missing", async () => {
      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/answer",
        json({ questionId: "q-1" }),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("VALIDATION_FAILED");
    });

    it("returns 400 when questionId is empty string", async () => {
      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/answer",
        json({ questionId: "", answer: "yes" }),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("VALIDATION_FAILED");
    });

    it("returns 400 when answer is empty string", async () => {
      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/answer",
        json({ questionId: "q-1", answer: "" }),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("VALIDATION_FAILED");
    });

    it("returns 400 when body is invalid JSON", async () => {
      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/answer",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "not json",
        },
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("VALIDATION_FAILED");
    });

    it("returns 400 when body is empty", async () => {
      const res = await app.request(
        "/tasks/11111111-1111-1111-1111-111111111111/answer",
        { method: "POST" },
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("VALIDATION_FAILED");
    });
  });
});
