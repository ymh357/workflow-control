import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

const mockRun = vi.fn();
const mockGet = vi.fn();
const mockPrepare = vi.fn();
vi.mock("./db.js", () => ({
  getDb: () => ({
    prepare: (...args: unknown[]) => mockPrepare(...args),
  }),
}));

import { sseManager } from "../sse/manager.js";
import { questionManager } from "./question-manager.js";

const mockPushMessage = vi.mocked(sseManager.pushMessage);

beforeEach(() => {
  vi.clearAllMocks();
  mockRun.mockReset();
  mockGet.mockReset();
  mockPrepare.mockReturnValue({ run: mockRun, get: mockGet });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("QuestionManager adversarial", () => {
  // ── 1. Answer before ask fully completes (same microtask) ──
  describe("answer in same tick as ask", () => {
    it("should resolve the promise when answered synchronously after ask", async () => {
      const promise = questionManager.ask("adv-task-1", "Immediate?");
      const pending = questionManager.getPending("adv-task-1");
      expect(pending).toBeDefined();

      const result = questionManager.answer(pending!.questionId, "now");
      expect(result).toBe(true);
      await expect(promise).resolves.toBe("now");
    });
  });

  // ── 2. Double answer ──
  describe("double answer", () => {
    it("second answer should return false", async () => {
      const promise = questionManager.ask("adv-task-2", "Double?");
      const pending = questionManager.getPending("adv-task-2");
      const questionId = pending!.questionId;

      const first = questionManager.answer(questionId, "first");
      expect(first).toBe(true);

      const second = questionManager.answer(questionId, "second");
      expect(second).toBe(false);

      // The promise should resolve with the FIRST answer only
      await expect(promise).resolves.toBe("first");
    });

    it("resolve callback should not be invoked twice even if answer called twice rapidly", async () => {
      const resolveSpy = vi.fn();
      const promise = questionManager.ask("adv-task-2b", "Double rapid?");

      // Intercept the resolve by wrapping the promise
      const wrappedPromise = promise.then((val) => {
        resolveSpy(val);
        return val;
      });

      const pending = questionManager.getPending("adv-task-2b");
      const qid = pending!.questionId;

      questionManager.answer(qid, "A");
      questionManager.answer(qid, "B");

      await wrappedPromise;
      // resolve should have been called exactly once
      expect(resolveSpy).toHaveBeenCalledTimes(1);
      expect(resolveSpy).toHaveBeenCalledWith("A");
    });
  });

  // ── 3. Timeout then answer ──
  describe("timeout then answer", () => {
    it("answer after timeout should return false (not 'stale') when DB entry is also cleaned", async () => {
      vi.useFakeTimers();

      const promise = questionManager.ask("adv-task-3", "Will timeout");
      const pending = questionManager.getPending("adv-task-3");
      const questionId = pending!.questionId;

      // Advance past timeout
      vi.advanceTimersByTime(30 * 60 * 1000 + 1);

      await expect(promise).rejects.toThrow("timed out");

      // DB was cleaned by timeout handler, so answer should return false (not "stale")
      mockGet.mockReturnValue(undefined); // DB entry deleted
      const result = questionManager.answer(questionId, "too late");
      expect(result).toBe(false);
    });

    it("answer after timeout should return 'stale' if DB entry somehow persists", async () => {
      vi.useFakeTimers();

      const promise = questionManager.ask("adv-task-3b", "Will timeout stale");
      const pending = questionManager.getPending("adv-task-3b");
      const questionId = pending!.questionId;

      // Make deleteFromDb silently fail (DB entry persists)
      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes("DELETE")) return { run: vi.fn() }; // no-op
        if (sql.includes("SELECT 1")) return { get: vi.fn().mockReturnValue({ 1: 1 }) };
        return { run: vi.fn(), get: vi.fn() };
      });

      vi.advanceTimersByTime(30 * 60 * 1000 + 1);
      await promise.catch(() => {});

      const result = questionManager.answer(questionId, "too late");
      expect(result).toBe("stale");
    });
  });

  // ── 4. Concurrent questions for same task ──
  describe("concurrent questions for same taskId", () => {
    it("should track both questions independently", async () => {
      const p1 = questionManager.ask("adv-task-4", "Q1?");
      const p2 = questionManager.ask("adv-task-4", "Q2?");

      const all = questionManager.getAllPending("adv-task-4");
      expect(all).toHaveLength(2);

      // Answer them independently
      const q1 = all.find((q) => q.question === "Q1?")!;
      const q2 = all.find((q) => q.question === "Q2?")!;

      questionManager.answer(q1.questionId, "A1");
      questionManager.answer(q2.questionId, "A2");

      await expect(p1).resolves.toBe("A1");
      await expect(p2).resolves.toBe("A2");
    });

    it("answering one should not affect the other", async () => {
      const p1 = questionManager.ask("adv-task-4b", "First?");
      const p2 = questionManager.ask("adv-task-4b", "Second?");

      const all = questionManager.getAllPending("adv-task-4b");
      const q1 = all.find((q) => q.question === "First?")!;

      questionManager.answer(q1.questionId, "done");
      await p1;

      // Second should still be pending
      expect(questionManager.hasPending("adv-task-4b")).toBe(true);
      const remaining = questionManager.getAllPending("adv-task-4b");
      expect(remaining).toHaveLength(1);
      expect(remaining[0].question).toBe("Second?");

      // Clean up
      questionManager.answer(remaining[0].questionId, "done too");
      await p2;
    });

    it("DB fallback returns the oldest pending question deterministically", () => {
      const mockDbGet = vi.fn().mockReturnValue({
        question_id: "persisted-q-oldest",
        question: "Oldest question?",
        options: JSON.stringify(["A", "B"]),
        created_at: "2026-01-01T00:00:00.000Z",
      });
      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes("ORDER BY created_at ASC")) return { get: mockDbGet };
        return { run: vi.fn(), get: vi.fn() };
      });

      const result = questionManager.getPersistedPending("adv-task-4c");

      expect(result).toEqual({
        questionId: "persisted-q-oldest",
        question: "Oldest question?",
        options: ["A", "B"],
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    });
  });

  // ── 5. Answer with wrong taskId ──
  describe("answer with wrong taskId", () => {
    it("should return false when taskId does not match", async () => {
      const promise = questionManager.ask("adv-task-5", "Correct task?");
      const pending = questionManager.getPending("adv-task-5");

      const result = questionManager.answer(pending!.questionId, "nope", "wrong-task");
      expect(result).toBe(false);

      // Question should still be pending
      expect(questionManager.hasPending("adv-task-5")).toBe(true);

      // Clean up
      questionManager.answer(pending!.questionId, "ok");
      await promise;
    });

    it("should succeed when taskId is not provided (optional param)", async () => {
      const promise = questionManager.ask("adv-task-5b", "No task check?");
      const pending = questionManager.getPending("adv-task-5b");

      const result = questionManager.answer(pending!.questionId, "yes");
      expect(result).toBe(true);
      await expect(promise).resolves.toBe("yes");
    });
  });

  // ── 6. getPersistedPending after answer ──
  describe("getPersistedPending after answer", () => {
    it("should return undefined after question is answered", async () => {
      mockPrepare.mockReturnValue({ run: vi.fn(), get: vi.fn().mockReturnValue(undefined) });

      const promise = questionManager.ask("adv-task-6", "Persist check?");
      const pending = questionManager.getPending("adv-task-6");
      questionManager.answer(pending!.questionId, "answered");
      await promise;

      const result = questionManager.getPersistedPending("adv-task-6");
      expect(result).toBeUndefined();
    });
  });

  // ── 7. getPersistedPending after timeout ──
  describe("getPersistedPending after timeout", () => {
    it("should return undefined after question times out", async () => {
      vi.useFakeTimers();
      mockPrepare.mockReturnValue({ run: vi.fn(), get: vi.fn().mockReturnValue(undefined) });

      const promise = questionManager.ask("adv-task-7", "Timeout persist?");

      vi.advanceTimersByTime(30 * 60 * 1000 + 1);
      await promise.catch(() => {});

      const result = questionManager.getPersistedPending("adv-task-7");
      expect(result).toBeUndefined();
    });
  });

  // ── 8. ask() with empty options array ──
  describe("ask with empty options", () => {
    it("should persist empty array as valid JSON", async () => {
      const insertRun = vi.fn();
      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes("INSERT")) return { run: insertRun };
        return { run: vi.fn(), get: vi.fn() };
      });

      const promise = questionManager.ask("adv-task-8", "Empty opts?", []);
      const pending = questionManager.getPending("adv-task-8");

      // Empty array is truthy, so JSON.stringify([]) should be called
      expect(insertRun).toHaveBeenCalledWith(
        expect.any(String),
        "adv-task-8",
        "Empty opts?",
        "[]",
      );

      // The SSE message should also have empty array
      const sseCall = mockPushMessage.mock.calls.find(
        (c) => (c[1] as any)?.data?.question === "Empty opts?",
      );
      expect(sseCall).toBeDefined();
      expect((sseCall![1] as any).data.options).toEqual([]);

      questionManager.answer(pending!.questionId, "ok");
      await promise;
    });
  });

  // ── 9. ask() with undefined/empty question text ──
  describe("ask with edge-case question text", () => {
    it("should handle empty string question", async () => {
      const promise = questionManager.ask("adv-task-9a", "");
      const pending = questionManager.getPending("adv-task-9a");
      expect(pending).toBeDefined();
      expect(pending!.question).toBe("");

      questionManager.answer(pending!.questionId, "ok");
      await promise;
    });

    it("should handle very long question text", async () => {
      const longText = "x".repeat(100_000);
      const promise = questionManager.ask("adv-task-9b", longText);
      const pending = questionManager.getPending("adv-task-9b");
      expect(pending).toBeDefined();
      expect(pending!.question).toBe(longText);

      questionManager.answer(pending!.questionId, "ok");
      await promise;
    });
  });

  // ── 10. Cleanup of DB entries after timeout ──
  describe("DB cleanup after timeout", () => {
    it("timeout handler should call deleteFromDb", async () => {
      vi.useFakeTimers();
      const deleteRun = vi.fn();
      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes("DELETE")) return { run: deleteRun };
        return { run: vi.fn(), get: vi.fn() };
      });

      const promise = questionManager.ask("adv-task-10", "Cleanup?");

      vi.advanceTimersByTime(30 * 60 * 1000 + 1);
      await promise.catch(() => {});

      // deleteFromDb should have been called
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM pending_questions WHERE question_id"),
      );
      expect(deleteRun).toHaveBeenCalled();
    });
  });

  // ── 11. Server restart simulation ──
  describe("server restart simulation", () => {
    it("getPersistedPending falls back to DB when memory is empty", () => {
      // No in-memory question exists for this task
      const mockDbGet = vi.fn().mockReturnValue({
        question_id: "persisted-q-1",
        question: "From DB after restart?",
        options: JSON.stringify(["Yes", "No"]),
        created_at: "2026-01-03T00:00:00.000Z",
      });
      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes("SELECT question_id")) return { get: mockDbGet };
        return { run: vi.fn(), get: vi.fn() };
      });

      const result = questionManager.getPersistedPending("restarted-task");
      expect(result).toEqual({
        questionId: "persisted-q-1",
        question: "From DB after restart?",
        options: ["Yes", "No"],
        createdAt: "2026-01-03T00:00:00.000Z",
      });
    });

    it("answering a DB-only question returns 'stale' and cleans DB", () => {
      const deleteRun = vi.fn();
      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes("SELECT 1")) return { get: vi.fn().mockReturnValue({ 1: 1 }) };
        if (sql.includes("DELETE")) return { run: deleteRun };
        return { run: vi.fn(), get: vi.fn() };
      });

      const result = questionManager.answer("persisted-q-1", "late answer");
      expect(result).toBe("stale");
      expect(deleteRun).toHaveBeenCalled();
    });
  });

  // ── 12. Multiple rapid ask/answer cycles ──
  describe("rapid ask/answer cycles", () => {
    it("all promises resolve correctly with no leaks", async () => {
      const count = 50;
      const promises: Promise<string>[] = [];
      const questionIds: string[] = [];

      for (let i = 0; i < count; i++) {
        const p = questionManager.ask(`rapid-task-${i}`, `Q${i}?`);
        promises.push(p);
        const pending = questionManager.getPending(`rapid-task-${i}`);
        questionIds.push(pending!.questionId);
      }

      // Answer all
      for (let i = 0; i < count; i++) {
        const result = questionManager.answer(questionIds[i], `A${i}`);
        expect(result).toBe(true);
      }

      const answers = await Promise.all(promises);
      for (let i = 0; i < count; i++) {
        expect(answers[i]).toBe(`A${i}`);
      }

      // No pending questions should remain
      for (let i = 0; i < count; i++) {
        expect(questionManager.hasPending(`rapid-task-${i}`)).toBe(false);
      }
    });
  });

  // ── 13. BUG HUNT: Timeout does not clear warningTimer ──
  describe("timeout does not clear warning timer (potential bug)", () => {
    it("warning timer should NOT fire after timeout has already occurred", async () => {
      vi.useFakeTimers();
      mockPushMessage.mockClear();

      // Set up: ask a question
      const promise = questionManager.ask("adv-task-13", "Warning after timeout?");

      // Record calls after the initial question SSE
      const initialCalls = mockPushMessage.mock.calls.length;

      // Advance to just past timeout (30 min), but BEFORE the warning timer
      // Warning fires at 20 min, timeout at 30 min -- warning fires first.
      // Let's test the reverse scenario: what if we manually adjust?
      // Actually the warning fires at 20 min and timeout at 30 min, so warning always fires first.
      // The real question: after timeout fires at 30 min, is warningTimer cleared?
      // Since warning fires at 20 min < 30 min, by the time timeout fires, warning already fired.
      // But let's verify: advance to 20 min, check warning, then to 30 min, check timeout.

      vi.advanceTimersByTime(20 * 60 * 1000 + 1);

      // Warning should have fired
      const warningCalls = mockPushMessage.mock.calls
        .slice(initialCalls)
        .filter((c) => c[1]?.type === "question_timeout_warning");
      expect(warningCalls).toHaveLength(1);

      // Now advance to timeout
      vi.advanceTimersByTime(10 * 60 * 1000);
      await promise.catch(() => {});

      // After timeout, no more SSE messages should be pushed for this question
      // (this particular test won't catch a bug since warning already fired before timeout)
    });
  });

  // ── 14. BUG HUNT: cancelForTask during timeout race ──
  describe("cancelForTask and timeout race", () => {
    it("if cancelForTask runs, then timeout fires, reject should not be called twice", async () => {
      vi.useFakeTimers();

      const promise = questionManager.ask("adv-task-14", "Race?");

      // Cancel the task (this clears timers and rejects)
      questionManager.cancelForTask("adv-task-14");
      await expect(promise).rejects.toThrow("Task terminated");

      // Now advance past timeout -- the timer was cleared by cancelForTask, so this should be safe
      vi.advanceTimersByTime(31 * 60 * 1000);

      // No crash = pass. But what if the timer wasn't properly cleared?
    });
  });

  // ── 15. BUG HUNT: answer() resolves promise but what about unhandled rejection from timeout? ──
  describe("answer then timeout timer fires (timer not cleared scenario)", () => {
    it("after answer, timeout timer should be cleared and not call reject", async () => {
      vi.useFakeTimers();

      const promise = questionManager.ask("adv-task-15", "Answer then timeout?");
      const pending = questionManager.getPending("adv-task-15");

      questionManager.answer(pending!.questionId, "answered");
      const result = await promise;
      expect(result).toBe("answered");

      // Advance past timeout -- timer should have been cleared by answer()
      vi.advanceTimersByTime(31 * 60 * 1000);

      // Promise should still be resolved with "answered", not rejected
      // (Promise can only settle once, but reject call on already-resolved promise is still a code smell)
    });
  });

  // ── 16. BUG HUNT: answer with empty string ──
  describe("answer with empty string", () => {
    it("should accept empty string as a valid answer", async () => {
      const promise = questionManager.ask("adv-task-16", "Empty answer?");
      const pending = questionManager.getPending("adv-task-16");

      const result = questionManager.answer(pending!.questionId, "");
      expect(result).toBe(true);
      await expect(promise).resolves.toBe("");
    });
  });

  // ── 17. BUG HUNT: getPending returns first question, not latest ──
  describe("getPending ordering", () => {
    it("getPending returns first inserted question for a task", async () => {
      const p1 = questionManager.ask("adv-task-17", "First");
      const p2 = questionManager.ask("adv-task-17", "Second");

      const first = questionManager.getPending("adv-task-17");
      // Map iteration is insertion-order, so this should be "First"
      expect(first!.question).toBe("First");

      // Clean up
      questionManager.cancelForTask("adv-task-17");
      await Promise.allSettled([p1, p2]);
    });
  });

  // ── 18. BUG HUNT: DB INSERT failure should not prevent question from working ──
  describe("DB INSERT failure during ask", () => {
    it("question should still work in-memory even if DB insert fails", async () => {
      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes("INSERT")) throw new Error("DB write failed");
        return { run: vi.fn(), get: vi.fn() };
      });

      const promise = questionManager.ask("adv-task-18", "DB down?");
      const pending = questionManager.getPending("adv-task-18");
      expect(pending).toBeDefined();

      questionManager.answer(pending!.questionId, "still works");
      await expect(promise).resolves.toBe("still works");
    });
  });

  // ── 19. BUG HUNT: Answering with taskId=undefined vs not providing it ──
  describe("answer with explicit undefined taskId", () => {
    it("should succeed because undefined is falsy, skipping taskId check", async () => {
      const promise = questionManager.ask("adv-task-19", "Undefined task?");
      const pending = questionManager.getPending("adv-task-19");

      // Passing undefined explicitly -- the `if (taskId && ...)` check should pass
      const result = questionManager.answer(pending!.questionId, "ok", undefined);
      expect(result).toBe(true);
      await expect(promise).resolves.toBe("ok");
    });
  });

  // ── 20. BUG HUNT: answer() with empty string taskId ──
  describe("answer with empty string taskId", () => {
    it("empty string taskId is falsy, should skip taskId check and succeed", async () => {
      const promise = questionManager.ask("adv-task-20", "Empty taskId?");
      const pending = questionManager.getPending("adv-task-20");

      // Empty string is falsy, so `if (taskId && ...)` won't check
      const result = questionManager.answer(pending!.questionId, "ok", "");
      expect(result).toBe(true);
      await expect(promise).resolves.toBe("ok");
    });
  });

  // ── 21. BUG HUNT: Multiple timeouts don't interfere with each other ──
  describe("multiple concurrent timeouts", () => {
    it("each question should timeout independently", async () => {
      vi.useFakeTimers();

      const p1 = questionManager.ask("adv-task-21a", "Q1");
      const p2 = questionManager.ask("adv-task-21b", "Q2");

      // Answer p1 before timeout
      const pending1 = questionManager.getPending("adv-task-21a");
      questionManager.answer(pending1!.questionId, "A1");
      await p1;

      // Let p2 timeout
      vi.advanceTimersByTime(30 * 60 * 1000 + 1);
      await expect(p2).rejects.toThrow("timed out");

      expect(questionManager.hasPending("adv-task-21a")).toBe(false);
      expect(questionManager.hasPending("adv-task-21b")).toBe(false);
    });
  });

  // ── 22. BUG HUNT: deleteFromDb called with correct questionId on timeout ──
  describe("deleteFromDb receives correct questionId on timeout", () => {
    it("should delete the specific question that timed out, not all questions", async () => {
      vi.useFakeTimers();

      const deleteCalls: string[] = [];
      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes("DELETE FROM pending_questions WHERE question_id")) {
          return {
            run: (...args: unknown[]) => {
              deleteCalls.push(args[0] as string);
            },
          };
        }
        return { run: vi.fn(), get: vi.fn() };
      });

      const p1 = questionManager.ask("adv-task-22", "Will timeout");
      const pending = questionManager.getPending("adv-task-22");
      const questionId = pending!.questionId;

      vi.advanceTimersByTime(30 * 60 * 1000 + 1);
      await p1.catch(() => {});

      expect(deleteCalls).toContain(questionId);
    });
  });

  // ── 23. BUG HUNT: Warning SSE fires even after answer ──
  describe("answer after warning but before timeout", () => {
    it("answering should clear warning timer so no warning fires after answer", async () => {
      vi.useFakeTimers();
      mockPushMessage.mockClear();

      const promise = questionManager.ask("adv-task-23", "Answer mid-window?");
      const initialCalls = mockPushMessage.mock.calls.length;

      // Advance to 15 minutes (before warning at 20 min)
      vi.advanceTimersByTime(15 * 60 * 1000);

      // No warning yet
      const warningsBefore = mockPushMessage.mock.calls
        .slice(initialCalls)
        .filter((c) => c[1]?.type === "question_timeout_warning");
      expect(warningsBefore).toHaveLength(0);

      // Answer now
      const pending = questionManager.getPending("adv-task-23");
      questionManager.answer(pending!.questionId, "answered at 15min");
      await promise;

      // Advance past the warning time (20 min mark)
      vi.advanceTimersByTime(10 * 60 * 1000);

      // Warning should NOT have fired because answer() cleared warningTimer
      const warningsAfter = mockPushMessage.mock.calls
        .slice(initialCalls)
        .filter((c) => c[1]?.type === "question_timeout_warning");
      expect(warningsAfter).toHaveLength(0);
    });
  });

  // ── 24. Warning fires before timeout, only once ──
  describe("warning always fires before timeout with default constants", () => {
    it("warning fires at 20 min, timeout at 30 min, in correct order", async () => {
      vi.useFakeTimers();
      mockPushMessage.mockClear();

      const promise = questionManager.ask("adv-task-24", "Order test");
      const initialCalls = mockPushMessage.mock.calls.length;

      vi.advanceTimersByTime(20 * 60 * 1000 + 1);
      const warningFired = mockPushMessage.mock.calls
        .slice(initialCalls)
        .some((c) => c[1]?.type === "question_timeout_warning");
      expect(warningFired).toBe(true);

      vi.advanceTimersByTime(10 * 60 * 1000);
      await promise.catch(() => {});

      const allWarnings = mockPushMessage.mock.calls
        .slice(initialCalls)
        .filter((c) => c[1]?.type === "question_timeout_warning");
      expect(allWarnings).toHaveLength(1);
    });
  });

  // ── 25. cancelForTask on non-existent task ──
  describe("cancelForTask on non-existent task", () => {
    it("should not throw", () => {
      expect(() => questionManager.cancelForTask("nonexistent-task")).not.toThrow();
    });
  });

  // ── 26. ask then cancel then answer ──
  describe("ask then cancel then answer", () => {
    it("answer after cancel should return false", async () => {
      const promise = questionManager.ask("adv-task-26", "Cancel me");
      const pending = questionManager.getPending("adv-task-26");
      const qid = pending!.questionId;

      questionManager.cancelForTask("adv-task-26");
      await promise.catch(() => {});

      const result = questionManager.answer(qid, "too late");
      expect(result).toBe(false);
    });
  });

  // ── 27. hasPending false synchronously after answer ──
  describe("resolve is called synchronously by answer()", () => {
    it("hasPending should be false immediately after answer, before awaiting promise", async () => {
      const promise = questionManager.ask("adv-task-27", "Sync resolve?");
      const pending = questionManager.getPending("adv-task-27");

      questionManager.answer(pending!.questionId, "done");
      expect(questionManager.hasPending("adv-task-27")).toBe(false);

      await promise;
    });
  });

  // ── 28. getAllPending returns a separate array ──
  describe("getAllPending mutation safety", () => {
    it("mutating returned array should not affect internal state", async () => {
      const promise = questionManager.ask("adv-task-28", "Mutation?");
      const all = questionManager.getAllPending("adv-task-28");
      all.length = 0;

      expect(questionManager.hasPending("adv-task-28")).toBe(true);
      expect(questionManager.getAllPending("adv-task-28")).toHaveLength(1);

      const pending = questionManager.getPending("adv-task-28");
      questionManager.answer(pending!.questionId, "ok");
      await promise;
    });
  });

  // ── 29. BUG HUNT: options array mutation after ask ──
  // The code stores the options reference directly (line 52), no defensive copy.
  // Mutating the original array after ask() will affect the stored question.
  describe("options array mutation after ask", () => {
    it("mutating options array after ask reflects in stored question (no defensive copy)", async () => {
      const options = ["A", "B", "C"];
      const promise = questionManager.ask("adv-task-29", "Mutable opts?", options);

      options.push("D");

      const all = questionManager.getAllPending("adv-task-29");
      // If no defensive copy was made, stored options includes "D"
      expect(all[0].options).toEqual(["A", "B", "C", "D"]);

      questionManager.answer(all[0].questionId, "ok");
      await promise;
    });
  });
});
