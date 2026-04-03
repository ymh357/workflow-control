import { sseManager } from "../sse/manager.js";
import { notifyQuestionAsked } from "./slack.js";
import { logger as rootLogger } from "./logger.js";
import { getDb } from "./db.js";

const QUESTION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const WARNING_BEFORE_MS = 10 * 60 * 1000; // warn 10 minutes before timeout

interface PendingQuestion {
  id: string;
  taskId: string;
  question: string;
  options?: string[];
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  warningTimer: ReturnType<typeof setTimeout>;
}

class QuestionManager {
  private pending = new Map<string, PendingQuestion>();

  async ask(
    taskId: string,
    question: string,
    options?: string[],
  ): Promise<string> {
    const id = crypto.randomUUID();

    let resolve!: (value: string) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const timer = setTimeout(() => {
      this.pending.delete(id);
      this.deleteFromDb(id);
      reject(new Error(`Question timed out after ${QUESTION_TIMEOUT_MS / 60000} minutes`));
    }, QUESTION_TIMEOUT_MS);

    const warningTimer = setTimeout(() => {
      sseManager.pushMessage(taskId, {
        type: "question_timeout_warning",
        taskId,
        timestamp: new Date().toISOString(),
        data: { questionId: id, remainingMs: WARNING_BEFORE_MS },
      });
    }, QUESTION_TIMEOUT_MS - WARNING_BEFORE_MS);

    this.pending.set(id, { id, taskId, question, options, resolve, reject, timer, warningTimer });

    // Persist to DB
    try {
      getDb().prepare(
        "INSERT INTO pending_questions (question_id, task_id, question, options) VALUES (?, ?, ?, ?)"
      ).run(id, taskId, question, options ? JSON.stringify(options) : null);
    } catch {
      // Non-critical
    }

    sseManager.pushMessage(taskId, {
      type: "question",
      taskId,
      timestamp: new Date().toISOString(),
      data: { questionId: id, question, options },
    });

    notifyQuestionAsked(taskId, id, question, options).catch((err) => {
      rootLogger.warn({ err, taskId }, "Failed to send question notification");
    });

    return promise;
  }

  answer(questionId: string, answer: string, taskId?: string): boolean | "stale" {
    const q = this.pending.get(questionId);
    if (!q) {
      // Check if question exists in DB (server restarted, Promise lost)
      if (this.existsInDb(questionId)) {
        this.deleteFromDb(questionId);
        return "stale";
      }
      return false;
    }
    if (taskId && q.taskId !== taskId) return false;
    clearTimeout(q.timer);
    clearTimeout(q.warningTimer);
    this.pending.delete(questionId);
    this.deleteFromDb(questionId);
    q.resolve(answer);
    return true;
  }

  private existsInDb(questionId: string): boolean {
    try {
      const row = getDb().prepare("SELECT 1 FROM pending_questions WHERE question_id = ? LIMIT 1").get(questionId);
      return !!row;
    } catch {
      return false;
    }
  }

  cancelForTask(taskId: string): void {
    const toRemove = [...this.pending.entries()].filter(([, q]) => q.taskId === taskId);
    for (const [id, q] of toRemove) {
      clearTimeout(q.timer);
      clearTimeout(q.warningTimer);
      this.pending.delete(id);
      q.reject(new Error("Task terminated"));
    }
    // Clean DB
    try {
      getDb().prepare("DELETE FROM pending_questions WHERE task_id = ?").run(taskId);
    } catch {
      // Non-critical
    }
  }

  hasPending(taskId: string): boolean {
    for (const q of this.pending.values()) {
      if (q.taskId === taskId) return true;
    }
    return false;
  }

  getAllPending(taskId: string): Array<{ questionId: string; question: string; options?: string[] }> {
    const result: Array<{ questionId: string; question: string; options?: string[] }> = [];
    for (const q of this.pending.values()) {
      if (q.taskId === taskId) result.push({ questionId: q.id, question: q.question, options: q.options });
    }
    return result;
  }

  getPending(taskId: string): { questionId: string; question: string; options?: string[] } | undefined {
    return this.getAllPending(taskId)[0];
  }

  getPersistedPending(taskId: string): { questionId: string; question: string; options?: string[] } | undefined {
    // Check in-memory first
    const mem = this.getPending(taskId);
    if (mem) return mem;
    // Fallback to DB (e.g. after server restart, question is persisted but Promise is lost)
    try {
      const row = getDb().prepare(
        "SELECT question_id, question, options FROM pending_questions WHERE task_id = ? LIMIT 1"
      ).get(taskId) as { question_id: string; question: string; options: string | null } | undefined;
      if (!row) return undefined;
      return {
        questionId: row.question_id,
        question: row.question,
        options: row.options ? JSON.parse(row.options) : undefined,
      };
    } catch {
      return undefined;
    }
  }

  private deleteFromDb(questionId: string): void {
    try {
      getDb().prepare("DELETE FROM pending_questions WHERE question_id = ?").run(questionId);
    } catch {
      // Non-critical
    }
  }
}

export const questionManager = new QuestionManager();
