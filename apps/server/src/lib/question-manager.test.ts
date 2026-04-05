import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { broadcastTaskUpdate } = vi.hoisted(() => ({
  broadcastTaskUpdate: vi.fn(),
}));

vi.mock("../sse/manager.js", () => ({
  sseManager: {
    pushMessage: vi.fn(),
  },
}));

vi.mock("./slack.js", () => ({
  notifyQuestionAsked: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../sse/task-list-broadcaster.js", () => ({
  taskListBroadcaster: { broadcastTaskUpdate },
}));

const mockPrepare = vi.fn();
vi.mock("./db.js", () => ({
  getDb: () => ({
    prepare: (...args: unknown[]) => mockPrepare(...args),
  }),
}));

import { sseManager } from "../sse/manager.js";
import { notifyQuestionAsked } from "./slack.js";

// We need a fresh QuestionManager per test since it's a singleton.
// Re-import the module each time would be complex; instead we use cancelForTask to clean up.
import { questionManager } from "./question-manager.js";

const mockPushMessage = vi.mocked(sseManager.pushMessage);
const mockNotifyQuestion = vi.mocked(notifyQuestionAsked);

beforeEach(() => {
  vi.clearAllMocks();
  mockPrepare.mockReturnValue({ run: vi.fn(), get: vi.fn() });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("QuestionManager", () => {
  describe("ask", () => {
    it("creates a pending question and pushes SSE message", async () => {
      const promise = questionManager.ask("task-1", "What color?", ["Red", "Blue"]);
      expect(mockPushMessage).toHaveBeenCalledWith(
        "task-1",
        expect.objectContaining({
          type: "question",
          taskId: "task-1",
          data: expect.objectContaining({
            question: "What color?",
            options: ["Red", "Blue"],
          }),
        }),
      );

      // The question should be pending
      expect(questionManager.hasPending("task-1")).toBe(true);

      // Answer it to resolve the promise
      const pending = questionManager.getPending("task-1");
      expect(pending).toBeDefined();
      expect(pending!.question).toBe("What color?");
      questionManager.answer(pending!.questionId, "Red");
      const answer = await promise;
      expect(answer).toBe("Red");
    });

    it("broadcasts task list update when a question is asked", async () => {
      broadcastTaskUpdate.mockClear();
      const promise = questionManager.ask("task-broadcast-1", "Need input?");
      await vi.waitFor(() => {
        expect(
          broadcastTaskUpdate.mock.calls.some(([taskId]) => taskId === "task-broadcast-1"),
        ).toBe(true);
      });

      const pending = questionManager.getPending("task-broadcast-1");
      questionManager.answer(pending!.questionId, "done");
      await promise;
    });

    it("persists question to DB", async () => {
      const mockRun = vi.fn();
      mockPrepare.mockReturnValue({ run: mockRun, get: vi.fn() });

      const promise = questionManager.ask("task-2", "Yes or no?");
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO pending_questions"),
      );
      expect(mockRun).toHaveBeenCalled();

      // Clean up
      const pending = questionManager.getPending("task-2");
      questionManager.answer(pending!.questionId, "yes");
      await promise;
    });

    it("notifies Slack", async () => {
      const promise = questionManager.ask("task-3", "What now?", ["A", "B"]);
      // notifyQuestionAsked is called but not awaited (fire-and-forget)
      expect(mockNotifyQuestion).toHaveBeenCalledWith(
        "task-3",
        expect.any(String),
        "What now?",
        ["A", "B"],
      );

      const pending = questionManager.getPending("task-3");
      questionManager.answer(pending!.questionId, "A");
      await promise;
    });

    it("returns a promise that resolves with the answer", async () => {
      const promise = questionManager.ask("task-4", "Pick one");
      const pending = questionManager.getPending("task-4");
      questionManager.answer(pending!.questionId, "chosen");
      await expect(promise).resolves.toBe("chosen");
    });
  });

  describe("answer", () => {
    it("resolves the question and returns true", async () => {
      const promise = questionManager.ask("task-10", "Q?");
      const pending = questionManager.getPending("task-10");
      const result = questionManager.answer(pending!.questionId, "A");
      expect(result).toBe(true);
      expect(questionManager.hasPending("task-10")).toBe(false);
      await promise;
    });

    it("returns false when questionId does not exist", () => {
      const result = questionManager.answer("nonexistent-id", "A");
      expect(result).toBe(false);
    });

    it("broadcasts task list update when a question is answered", async () => {
      const promise = questionManager.ask("task-10b", "Q?");
      await Promise.resolve();
      broadcastTaskUpdate.mockClear();

      const pending = questionManager.getPending("task-10b");
      const result = questionManager.answer(pending!.questionId, "A");

      expect(result).toBe(true);
      await vi.waitFor(() => {
        expect(
          broadcastTaskUpdate.mock.calls.some(([taskId]) => taskId === "task-10b"),
        ).toBe(true);
      });
      await promise;
    });

    it("returns false when taskId does not match", async () => {
      const promise = questionManager.ask("task-11", "Q?");
      const pending = questionManager.getPending("task-11");
      const result = questionManager.answer(pending!.questionId, "A", "wrong-task");
      expect(result).toBe(false);
      // Question should still be pending
      expect(questionManager.hasPending("task-11")).toBe(true);

      // Clean up
      questionManager.answer(pending!.questionId, "A", "task-11");
      await promise;
    });

    it("returns 'stale' when question exists only in DB (server restarted)", () => {
      const mockGet = vi.fn().mockReturnValue({ question_id: "db-q-1" });
      const mockRun = vi.fn();
      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes("SELECT 1")) return { get: mockGet };
        if (sql.includes("DELETE")) return { run: mockRun };
        return { run: vi.fn(), get: vi.fn() };
      });

      const result = questionManager.answer("db-q-1", "late answer");
      expect(result).toBe("stale");
    });

    it("broadcasts task list update when a stale DB-only question is cleared", () => {
      broadcastTaskUpdate.mockClear();
      const mockGet = vi.fn().mockReturnValue({ question_id: "db-q-1" });
      const mockRun = vi.fn();
      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes("SELECT 1")) return { get: mockGet };
        if (sql.includes("DELETE")) return { run: mockRun };
        return { run: vi.fn(), get: vi.fn() };
      });

      const result = questionManager.answer("db-q-1", "late answer", "task-stale-1");
      expect(result).toBe("stale");
      expect(broadcastTaskUpdate).toHaveBeenCalledWith("task-stale-1");
    });
  });

  describe("cancelForTask", () => {
    it("rejects all pending questions for the task", async () => {
      const p1 = questionManager.ask("task-20", "Q1?");
      const p2 = questionManager.ask("task-20", "Q2?");

      questionManager.cancelForTask("task-20");

      await expect(p1).rejects.toThrow("Task terminated");
      await expect(p2).rejects.toThrow("Task terminated");
      expect(questionManager.hasPending("task-20")).toBe(false);
    });

    it("does not affect questions from other tasks", async () => {
      const p1 = questionManager.ask("task-21", "Q1?");
      const p2 = questionManager.ask("task-22", "Q2?");

      questionManager.cancelForTask("task-21");

      await expect(p1).rejects.toThrow("Task terminated");
      expect(questionManager.hasPending("task-22")).toBe(true);

      // Clean up
      const pending = questionManager.getPending("task-22");
      questionManager.answer(pending!.questionId, "ok");
      await p2;
    });

    it("cleans up DB records", () => {
      const mockRun = vi.fn();
      mockPrepare.mockReturnValue({ run: mockRun, get: vi.fn() });

      questionManager.cancelForTask("task-23");
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM pending_questions WHERE task_id"),
      );
    });
  });

  describe("hasPending / getPending / getAllPending", () => {
    it("hasPending returns false when no questions", () => {
      expect(questionManager.hasPending("no-task")).toBe(false);
    });

    it("getPending returns undefined when no questions", () => {
      expect(questionManager.getPending("no-task")).toBeUndefined();
    });

    it("getAllPending returns empty array when no questions", () => {
      expect(questionManager.getAllPending("no-task")).toEqual([]);
    });

    it("getAllPending returns all questions for a task", async () => {
      const p1 = questionManager.ask("task-30", "Q1?");
      const p2 = questionManager.ask("task-30", "Q2?", ["A", "B"]);

      const all = questionManager.getAllPending("task-30");
      expect(all).toHaveLength(2);
      expect(all[0].question).toBe("Q1?");
      expect(all[1].question).toBe("Q2?");
      expect(all[1].options).toEqual(["A", "B"]);

      // Clean up
      questionManager.cancelForTask("task-30");
      await Promise.allSettled([p1, p2]);
    });
  });

  describe("getPersistedPending", () => {
    it("returns in-memory question first", async () => {
      const promise = questionManager.ask("task-40", "In memory?");
      const result = questionManager.getPersistedPending("task-40");
      expect(result).toBeDefined();
      expect(result!.question).toBe("In memory?");
      expect(result!.createdAt).toBeTruthy();

      questionManager.cancelForTask("task-40");
      await promise.catch(() => {});
    });

    it("falls back to DB when no in-memory question", () => {
      const mockGet = vi.fn().mockReturnValue({
        question_id: "db-q-99",
        question: "From DB?",
        options: JSON.stringify(["X", "Y"]),
        created_at: "2026-01-01T00:00:00.000Z",
      });
      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes("SELECT question_id")) return { get: mockGet };
        return { run: vi.fn(), get: vi.fn() };
      });

      const result = questionManager.getPersistedPending("task-41");
      expect(result).toEqual({
        questionId: "db-q-99",
        question: "From DB?",
        options: ["X", "Y"],
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    });

    it("returns undefined when no in-memory and no DB question", () => {
      mockPrepare.mockReturnValue({ run: vi.fn(), get: vi.fn().mockReturnValue(undefined) });
      const result = questionManager.getPersistedPending("task-42");
      expect(result).toBeUndefined();
    });

    it("handles DB with null options", () => {
      const mockGet = vi.fn().mockReturnValue({
        question_id: "db-q-100",
        question: "No options?",
        options: null,
        created_at: "2026-01-02T00:00:00.000Z",
      });
      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes("SELECT question_id")) return { get: mockGet };
        return { run: vi.fn(), get: vi.fn() };
      });

      const result = questionManager.getPersistedPending("task-43");
      expect(result).toEqual({
        questionId: "db-q-100",
        question: "No options?",
        options: undefined,
        createdAt: "2026-01-02T00:00:00.000Z",
      });
    });
  });

  describe("notifyQuestionAsked failure in ask", () => {
    it("still returns the promise even when notifyQuestionAsked rejects", async () => {
      mockNotifyQuestion.mockRejectedValueOnce(new Error("Slack down"));

      const promise = questionManager.ask("task-notify-fail", "Question?");
      // The promise should still be resolvable
      expect(questionManager.hasPending("task-notify-fail")).toBe(true);

      const pending = questionManager.getPending("task-notify-fail");
      questionManager.answer(pending!.questionId, "answer");
      await expect(promise).resolves.toBe("answer");
    });
  });

  describe("existsInDb error handling", () => {
    it("returns false (answer returns false) when DB throws during existsInDb", () => {
      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes("SELECT 1")) throw new Error("DB crashed");
        return { run: vi.fn(), get: vi.fn() };
      });

      // For a non-pending question, answer() calls existsInDb which will throw
      const result = questionManager.answer("nonexistent-db-error", "A");
      expect(result).toBe(false);
    });
  });

  describe("getPersistedPending DB error", () => {
    it("returns undefined when DB throws", () => {
      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes("SELECT question_id")) throw new Error("DB crashed");
        return { run: vi.fn(), get: vi.fn() };
      });

      const result = questionManager.getPersistedPending("task-db-error");
      expect(result).toBeUndefined();
    });
  });

  describe("timeout behavior", () => {
    it("question times out after 30 minutes", async () => {
      vi.useFakeTimers();
      broadcastTaskUpdate.mockClear();

      const promise = questionManager.ask("task-50", "Will timeout?");

      vi.advanceTimersByTime(30 * 60 * 1000 + 1);

      await expect(promise).rejects.toThrow("timed out");
      expect(questionManager.hasPending("task-50")).toBe(false);
      expect(broadcastTaskUpdate).toHaveBeenCalledWith("task-50");
    });

    it("sends warning SSE message at 20 minutes (10 min before timeout)", async () => {
      vi.useFakeTimers();
      mockPushMessage.mockClear();

      const promise = questionManager.ask("task-51", "Will warn?");

      // Initial SSE call is the question itself
      const initialCallCount = mockPushMessage.mock.calls.length;

      // Advance to 20 minutes (QUESTION_TIMEOUT_MS - WARNING_BEFORE_MS = 30-10 = 20)
      vi.advanceTimersByTime(20 * 60 * 1000 + 1);

      // Should have the warning call now
      const warningCalls = mockPushMessage.mock.calls.slice(initialCallCount);
      expect(warningCalls.length).toBeGreaterThanOrEqual(1);
      const warningCall = warningCalls.find(
        (call) => call[1]?.type === "question_timeout_warning",
      );
      expect(warningCall).toBeDefined();

      // Clean up: advance to trigger timeout
      vi.advanceTimersByTime(10 * 60 * 1000 + 1);
      await promise.catch(() => {});
    });

    it("answer clears timeout and warning timers", async () => {
      vi.useFakeTimers();

      const promise = questionManager.ask("task-52", "Will be answered");
      const pending = questionManager.getPending("task-52");

      questionManager.answer(pending!.questionId, "answered");
      await promise;

      // Advancing time should not cause any issues
      vi.advanceTimersByTime(31 * 60 * 1000);
      // If timers weren't cleared, the question would try to delete from map again - no crash expected
    });
  });
});
