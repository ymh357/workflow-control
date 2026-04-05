import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { DatabaseSync } from "node:sqlite";

// Create a real in-memory SQLite DB for persistence tests
const testDb = new DatabaseSync(":memory:");
testDb.exec("PRAGMA journal_mode = WAL");
testDb.exec(`
  CREATE TABLE IF NOT EXISTS edge_slots (
    task_id TEXT NOT NULL,
    stage_name TEXT NOT NULL,
    nonce TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, stage_name)
  );
`);

vi.mock("../lib/db.js", () => ({
  getDb: () => testDb,
}));

vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  createSlot,
  resolveSlot,
  rejectSlot,
  hasSlot,
  getSlotNonce,
  getTaskSlots,
  getAllSlots,
  clearTaskSlots,
  waitForNextSlot,
  addSlotListener,
  addTaskTerminationListener,
  notifyTaskTerminated,
  setPendingRecovery,
} from "./registry.js";

// Helper to drain microtasks
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("registry", () => {
  afterEach(() => {
    // Clean up all slots to avoid leaking timers across tests
    for (const slot of getAllSlots()) {
      rejectSlot(slot.taskId, slot.stageName, new Error("test cleanup"));
    }
  });

  describe("createSlot", () => {
    it("should create a slot and make it visible via hasSlot", () => {
      const promise = createSlot("t1", "stage-a");
      expect(hasSlot("t1", "stage-a")).toBe(true);
      // Clean up
      resolveSlot("t1", "stage-a", { resultText: "", costUsd: 0, durationMs: 0 });
      return promise;
    });

    it("should generate a UUID nonce", () => {
      const promise = createSlot("t1", "stage-b");
      const nonce = getSlotNonce("t1", "stage-b");
      expect(nonce).toBeDefined();
      expect(nonce).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      resolveSlot("t1", "stage-b", { resultText: "", costUsd: 0, durationMs: 0 });
      return promise;
    });

    it("should replace an existing slot and reject the old one", async () => {
      const p1 = createSlot("t1", "stage-c");
      const p2 = createSlot("t1", "stage-c");

      await expect(p1).rejects.toThrow("replaced by new invocation");
      expect(hasSlot("t1", "stage-c")).toBe(true);

      resolveSlot("t1", "stage-c", { resultText: "ok", costUsd: 0, durationMs: 0 });
      const result = await p2;
      expect(result.resultText).toBe("ok");
    });

    it("should timeout and reject the promise", async () => {
      vi.useFakeTimers();
      const promise = createSlot("t1", "stage-timeout", 100);

      vi.advanceTimersByTime(101);

      await expect(promise).rejects.toThrow("timed out");
      expect(hasSlot("t1", "stage-timeout")).toBe(false);
      vi.useRealTimers();
    });

    it("should notify slot listeners on creation", () => {
      const listener = vi.fn();
      const remove = addSlotListener(listener);

      const promise = createSlot("t1", "stage-listen");
      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "t1", stageName: "stage-listen" }),
      );

      remove();
      resolveSlot("t1", "stage-listen", { resultText: "", costUsd: 0, durationMs: 0 });
      return promise;
    });
  });

  describe("resolveSlot", () => {
    it("should resolve the slot promise and remove the slot", async () => {
      const promise = createSlot("t1", "resolve-test");
      const result = resolveSlot("t1", "resolve-test", {
        resultText: "done",
        costUsd: 1.5,
        durationMs: 500,
      });

      expect(result).toBe(true);
      expect(hasSlot("t1", "resolve-test")).toBe(false);

      const agentResult = await promise;
      expect(agentResult.resultText).toBe("done");
      expect(agentResult.costUsd).toBe(1.5);
    });

    it("should return false when no slot exists", () => {
      expect(resolveSlot("nope", "nope", { resultText: "", costUsd: 0, durationMs: 0 })).toBe(false);
    });

    it("should reject when nonce does not match", () => {
      const promise = createSlot("t1", "nonce-test");
      const result = resolveSlot("t1", "nonce-test", { resultText: "", costUsd: 0, durationMs: 0 }, "wrong-nonce");

      expect(result).toBe(false);
      // Slot should still exist
      expect(hasSlot("t1", "nonce-test")).toBe(true);

      // Clean up
      resolveSlot("t1", "nonce-test", { resultText: "", costUsd: 0, durationMs: 0 });
      return promise;
    });

    it("should accept when nonce matches", async () => {
      const promise = createSlot("t1", "nonce-match");
      const nonce = getSlotNonce("t1", "nonce-match")!;
      const result = resolveSlot("t1", "nonce-match", { resultText: "ok", costUsd: 0, durationMs: 0 }, nonce);

      expect(result).toBe(true);
      const agentResult = await promise;
      expect(agentResult.resultText).toBe("ok");
    });

    it("should accept when no nonce is provided (nonce check skipped)", async () => {
      const promise = createSlot("t1", "no-nonce");
      const result = resolveSlot("t1", "no-nonce", { resultText: "ok", costUsd: 0, durationMs: 0 });

      expect(result).toBe(true);
      await promise;
    });
  });

  describe("rejectSlot", () => {
    it("should reject the slot promise and remove the slot", async () => {
      const promise = createSlot("t1", "reject-test");
      const result = rejectSlot("t1", "reject-test", new Error("fail"));

      expect(result).toBe(true);
      expect(hasSlot("t1", "reject-test")).toBe(false);
      await expect(promise).rejects.toThrow("fail");
    });

    it("should return false when no slot exists", () => {
      expect(rejectSlot("nope", "nope", new Error("nope"))).toBe(false);
    });
  });

  describe("getSlotNonce", () => {
    it("should return undefined for non-existent slot", () => {
      expect(getSlotNonce("nope", "nope")).toBeUndefined();
    });
  });

  describe("getTaskSlots", () => {
    it("should return all slots for a task", () => {
      const promises = [
        createSlot("t1", "a"),
        createSlot("t1", "b"),
        createSlot("t2", "c"),
      ];

      const t1Slots = getTaskSlots("t1");
      expect(t1Slots).toHaveLength(2);
      expect(t1Slots.map((s) => s.stageName).sort()).toEqual(["a", "b"]);

      const t2Slots = getTaskSlots("t2");
      expect(t2Slots).toHaveLength(1);

      // Clean up
      resolveSlot("t1", "a", { resultText: "", costUsd: 0, durationMs: 0 });
      resolveSlot("t1", "b", { resultText: "", costUsd: 0, durationMs: 0 });
      resolveSlot("t2", "c", { resultText: "", costUsd: 0, durationMs: 0 });
      return Promise.allSettled(promises);
    });

    it("should return empty array for unknown task", () => {
      expect(getTaskSlots("unknown")).toEqual([]);
    });

    it("should not expose resolve/reject/timer in returned info", () => {
      const promise = createSlot("t1", "info-test");
      const slots = getTaskSlots("t1");
      const slot = slots[0]!;

      expect(slot).toHaveProperty("taskId");
      expect(slot).toHaveProperty("stageName");
      expect(slot).toHaveProperty("createdAt");
      expect(slot).toHaveProperty("nonce");
      expect(slot).not.toHaveProperty("resolve");
      expect(slot).not.toHaveProperty("reject");
      expect(slot).not.toHaveProperty("timeoutTimer");

      resolveSlot("t1", "info-test", { resultText: "", costUsd: 0, durationMs: 0 });
      return promise;
    });
  });

  describe("getAllSlots", () => {
    it("should return slots across all tasks", () => {
      const promises = [
        createSlot("t1", "x"),
        createSlot("t2", "y"),
      ];

      const all = getAllSlots();
      expect(all).toHaveLength(2);

      resolveSlot("t1", "x", { resultText: "", costUsd: 0, durationMs: 0 });
      resolveSlot("t2", "y", { resultText: "", costUsd: 0, durationMs: 0 });
      return Promise.allSettled(promises);
    });
  });

  describe("clearTaskSlots", () => {
    it("should reject all slots for the given task", async () => {
      const p1 = createSlot("t1", "clear-a");
      const p2 = createSlot("t1", "clear-b");
      const p3 = createSlot("t2", "clear-c");

      clearTaskSlots("t1");

      expect(hasSlot("t1", "clear-a")).toBe(false);
      expect(hasSlot("t1", "clear-b")).toBe(false);
      // t2 should be untouched
      expect(hasSlot("t2", "clear-c")).toBe(true);

      await expect(p1).rejects.toThrow("Task cancelled");
      await expect(p2).rejects.toThrow("Task cancelled");

      resolveSlot("t2", "clear-c", { resultText: "", costUsd: 0, durationMs: 0 });
      await p3;
    });

    it("should be a no-op for unknown task", () => {
      expect(() => clearTaskSlots("unknown")).not.toThrow();
    });
  });

  describe("waitForNextSlot", () => {
    it("should resolve immediately if a slot already exists", async () => {
      const promise = createSlot("t1", "existing");
      const info = await waitForNextSlot("t1");

      expect(info.taskId).toBe("t1");
      expect(info.stageName).toBe("existing");

      resolveSlot("t1", "existing", { resultText: "", costUsd: 0, durationMs: 0 });
      await promise;
    });

    it("should resolve when a new slot is created", async () => {
      const waitPromise = waitForNextSlot("t1");

      // Create the slot after a tick
      await tick();
      const slotPromise = createSlot("t1", "new-stage");

      const info = await waitPromise;
      expect(info.stageName).toBe("new-stage");

      resolveSlot("t1", "new-stage", { resultText: "", costUsd: 0, durationMs: 0 });
      await slotPromise;
    });

    it("should reject when task is terminated", async () => {
      const waitPromise = waitForNextSlot("t1");

      await tick();
      notifyTaskTerminated("t1", "completed");

      await expect(waitPromise).rejects.toThrow("terminated: completed");
    });

    it("should ignore slots from other tasks", async () => {
      const waitPromise = waitForNextSlot("t1");

      await tick();
      // Create slot for different task
      const otherPromise = createSlot("t2", "other-stage");

      // waitPromise should still be pending, create the right one
      const slotPromise = createSlot("t1", "right-stage");
      const info = await waitPromise;
      expect(info.stageName).toBe("right-stage");

      resolveSlot("t2", "other-stage", { resultText: "", costUsd: 0, durationMs: 0 });
      resolveSlot("t1", "right-stage", { resultText: "", costUsd: 0, durationMs: 0 });
      await Promise.allSettled([otherPromise, slotPromise]);
    });

    it("should timeout after 30 minutes", async () => {
      vi.useFakeTimers();

      const waitPromise = waitForNextSlot("t-timeout");

      vi.advanceTimersByTime(30 * 60 * 1000 + 1);

      await expect(waitPromise).rejects.toThrow("timed out");
      vi.useRealTimers();
    });
  });

  describe("addSlotListener", () => {
    it("should return a cleanup function that removes the listener", () => {
      const listener = vi.fn();
      const remove = addSlotListener(listener);

      const p1 = createSlot("t1", "listen-1");
      expect(listener).toHaveBeenCalledTimes(1);

      remove();

      const p2 = createSlot("t1", "listen-2");
      expect(listener).toHaveBeenCalledTimes(1); // Not called again

      resolveSlot("t1", "listen-1", { resultText: "", costUsd: 0, durationMs: 0 });
      resolveSlot("t1", "listen-2", { resultText: "", costUsd: 0, durationMs: 0 });
      return Promise.allSettled([p1, p2]);
    });

    it("should not break slot creation when listener throws", () => {
      const badListener = vi.fn(() => { throw new Error("boom"); });
      const remove = addSlotListener(badListener);

      const promise = createSlot("t1", "safe");
      expect(hasSlot("t1", "safe")).toBe(true);

      remove();
      resolveSlot("t1", "safe", { resultText: "", costUsd: 0, durationMs: 0 });
      return promise;
    });
  });

  describe("addTaskTerminationListener / notifyTaskTerminated", () => {
    it("should fire listeners on termination", () => {
      const listener = vi.fn();
      addTaskTerminationListener("t1", listener);

      notifyTaskTerminated("t1", "completed");

      expect(listener).toHaveBeenCalledWith("t1", "completed");
    });

    it("should clean up listeners after termination", () => {
      const listener = vi.fn();
      addTaskTerminationListener("t1", listener);

      notifyTaskTerminated("t1", "done");
      notifyTaskTerminated("t1", "done again");

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("should return a cleanup function", () => {
      const listener = vi.fn();
      const remove = addTaskTerminationListener("t1", listener);

      remove();
      notifyTaskTerminated("t1", "done");

      expect(listener).not.toHaveBeenCalled();
    });

    it("should not affect other tasks", () => {
      const l1 = vi.fn();
      const l2 = vi.fn();
      addTaskTerminationListener("t1", l1);
      addTaskTerminationListener("t2", l2);

      notifyTaskTerminated("t1", "done");

      expect(l1).toHaveBeenCalledOnce();
      expect(l2).not.toHaveBeenCalled();

      // Clean up
      notifyTaskTerminated("t2", "cleanup");
    });

    it("should not break when listener throws", () => {
      const bad = vi.fn(() => { throw new Error("boom"); });
      const good = vi.fn();
      addTaskTerminationListener("t1", bad);
      addTaskTerminationListener("t1", good);

      expect(() => notifyTaskTerminated("t1", "done")).not.toThrow();
      expect(good).toHaveBeenCalled();
    });

    it("should be a no-op when no listeners registered", () => {
      expect(() => notifyTaskTerminated("no-listeners", "done")).not.toThrow();
    });
  });

  describe("nonce uniqueness", () => {
    it("should generate unique nonces for different slots", () => {
      const p1 = createSlot("t1", "u1");
      const p2 = createSlot("t1", "u2");

      const n1 = getSlotNonce("t1", "u1");
      const n2 = getSlotNonce("t1", "u2");

      expect(n1).not.toBe(n2);

      resolveSlot("t1", "u1", { resultText: "", costUsd: 0, durationMs: 0 });
      resolveSlot("t1", "u2", { resultText: "", costUsd: 0, durationMs: 0 });
      return Promise.allSettled([p1, p2]);
    });
  });

  describe("slot timeout (additional)", () => {
    it("should reject the promise on timeout and remove the slot", async () => {
      vi.useFakeTimers();
      const promise = createSlot("t-to", "stage-x", 500);

      expect(hasSlot("t-to", "stage-x")).toBe(true);

      vi.advanceTimersByTime(501);

      await expect(promise).rejects.toThrow("timed out");
      expect(hasSlot("t-to", "stage-x")).toBe(false);
      vi.useRealTimers();
    });

    it("resolveSlot returns false after timeout (slot already removed)", async () => {
      vi.useFakeTimers();
      const promise = createSlot("t-to2", "stage-y", 200);

      vi.advanceTimersByTime(201);

      await expect(promise).rejects.toThrow("timed out");

      const result = resolveSlot("t-to2", "stage-y", {
        resultText: "late",
        costUsd: 0,
        durationMs: 0,
      });
      expect(result).toBe(false);
      vi.useRealTimers();
    });
  });

  describe("multiple slots for same task (different stages)", () => {
    it("supports concurrent slots for different stages of the same task", async () => {
      const p1 = createSlot("t-multi", "analyze");
      const p2 = createSlot("t-multi", "implement");

      expect(hasSlot("t-multi", "analyze")).toBe(true);
      expect(hasSlot("t-multi", "implement")).toBe(true);

      const slots = getTaskSlots("t-multi");
      expect(slots).toHaveLength(2);
      expect(slots.map((s) => s.stageName).sort()).toEqual(["analyze", "implement"]);

      resolveSlot("t-multi", "analyze", { resultText: "analyzed", costUsd: 0, durationMs: 0 });
      resolveSlot("t-multi", "implement", { resultText: "implemented", costUsd: 0, durationMs: 0 });

      const r1 = await p1;
      const r2 = await p2;
      expect(r1.resultText).toBe("analyzed");
      expect(r2.resultText).toBe("implemented");
    });

    it("resolving one stage does not affect the other", async () => {
      const p1 = createSlot("t-multi2", "plan");
      const p2 = createSlot("t-multi2", "code");

      resolveSlot("t-multi2", "plan", { resultText: "planned", costUsd: 0, durationMs: 0 });

      expect(hasSlot("t-multi2", "plan")).toBe(false);
      expect(hasSlot("t-multi2", "code")).toBe(true);

      resolveSlot("t-multi2", "code", { resultText: "coded", costUsd: 0, durationMs: 0 });
      await Promise.all([p1, p2]);
    });
  });

  describe("waitForNextSlot timeout (additional)", () => {
    it("rejects after exactly 30 minutes with descriptive message", async () => {
      vi.useFakeTimers();
      const promise = waitForNextSlot("t-wait-timeout");

      // Just under 30 min - should still be pending
      vi.advanceTimersByTime(30 * 60 * 1000 - 100);

      // Advance past the timeout
      vi.advanceTimersByTime(200);

      await expect(promise).rejects.toThrow("timed out");
      vi.useRealTimers();
    });

    it("cleans up listeners after timeout (no double-fire)", async () => {
      vi.useFakeTimers();
      const promise = waitForNextSlot("t-wait-clean");

      vi.advanceTimersByTime(30 * 60 * 1000 + 1);
      await expect(promise).rejects.toThrow("timed out");

      // Creating a slot after timeout should not cause issues
      const slotPromise = createSlot("t-wait-clean", "late-stage");
      resolveSlot("t-wait-clean", "late-stage", { resultText: "", costUsd: 0, durationMs: 0 });
      await slotPromise;

      vi.useRealTimers();
    });
  });

  describe("slot persistence", () => {
    beforeEach(() => {
      // Clean DB rows between tests
      testDb.exec("DELETE FROM edge_slots");
    });

    it("createSlot persists slot metadata to SQLite", async () => {
      const promise = createSlot("tp-1", "persist-stage");
      const nonce = getSlotNonce("tp-1", "persist-stage")!;

      const row = testDb.prepare(
        "SELECT task_id, stage_name, nonce FROM edge_slots WHERE task_id = ? AND stage_name = ?"
      ).get("tp-1", "persist-stage") as { task_id: string; stage_name: string; nonce: string } | undefined;

      expect(row).toBeDefined();
      expect(row!.task_id).toBe("tp-1");
      expect(row!.stage_name).toBe("persist-stage");
      expect(row!.nonce).toBe(nonce);

      resolveSlot("tp-1", "persist-stage", { resultText: "", costUsd: 0, durationMs: 0 });
      await promise;
    });

    it("resolveSlot deletes persisted slot from DB", async () => {
      const promise = createSlot("tp-2", "resolve-persist");

      // Verify row exists
      const before = testDb.prepare(
        "SELECT 1 FROM edge_slots WHERE task_id = ? AND stage_name = ?"
      ).get("tp-2", "resolve-persist");
      expect(before).toBeDefined();

      resolveSlot("tp-2", "resolve-persist", { resultText: "done", costUsd: 0, durationMs: 0 });
      await promise;

      const after = testDb.prepare(
        "SELECT 1 FROM edge_slots WHERE task_id = ? AND stage_name = ?"
      ).get("tp-2", "resolve-persist");
      expect(after).toBeUndefined();
    });

    it("resolveSlot falls back to DB when in-memory slot is missing", () => {
      // Directly insert a DB row (simulating server restart — no in-memory slot)
      testDb.prepare(
        "INSERT INTO edge_slots (task_id, stage_name, nonce, created_at) VALUES (?, ?, ?, ?)"
      ).run("tp-3", "db-only-stage", "fake-nonce-123", Date.now());

      const result = resolveSlot("tp-3", "db-only-stage", { resultText: "recovered", costUsd: 0, durationMs: 0 });
      expect(result).toBe("persisted");

      // DB row should be cleaned up
      const row = testDb.prepare(
        "SELECT 1 FROM edge_slots WHERE task_id = ? AND stage_name = ?"
      ).get("tp-3", "db-only-stage");
      expect(row).toBeUndefined();
    });

    it("resolveSlot rejects expired persisted slot", () => {
      const expiredTime = Date.now() - 31 * 60 * 1000; // 31 minutes ago
      testDb.prepare(
        "INSERT INTO edge_slots (task_id, stage_name, nonce, created_at) VALUES (?, ?, ?, ?)"
      ).run("tp-4", "expired-stage", "old-nonce", expiredTime);

      const result = resolveSlot("tp-4", "expired-stage", { resultText: "late", costUsd: 0, durationMs: 0 });
      expect(result).toBe(false);

      // Expired row should be cleaned up
      const row = testDb.prepare(
        "SELECT 1 FROM edge_slots WHERE task_id = ? AND stage_name = ?"
      ).get("tp-4", "expired-stage");
      expect(row).toBeUndefined();
    });

    it("clearTaskSlots cleans both in-memory and DB slots", async () => {
      const promise = createSlot("tp-5", "clear-persist");

      // Verify in-memory and DB
      expect(hasSlot("tp-5", "clear-persist")).toBe(true);
      const before = testDb.prepare(
        "SELECT 1 FROM edge_slots WHERE task_id = ?"
      ).get("tp-5");
      expect(before).toBeDefined();

      clearTaskSlots("tp-5");

      expect(hasSlot("tp-5", "clear-persist")).toBe(false);
      const after = testDb.prepare(
        "SELECT 1 FROM edge_slots WHERE task_id = ?"
      ).get("tp-5");
      expect(after).toBeUndefined();

      await expect(promise).rejects.toThrow("Task cancelled");
    });

    it("setPendingRecovery is consumed by createSlot", async () => {
      const recoveryResult = { resultText: "recovered-data", costUsd: 0.5, durationMs: 100 };
      setPendingRecovery("tp-6", "recovery-stage", recoveryResult);

      const result = await createSlot("tp-6", "recovery-stage");
      expect(result.resultText).toBe("recovered-data");
      expect(result.costUsd).toBe(0.5);

      // Slot should not remain in memory
      expect(hasSlot("tp-6", "recovery-stage")).toBe(false);
    });

    it("clearTaskSlots cleans pendingRecovery", async () => {
      const recoveryResult = { resultText: "will-be-cleared", costUsd: 0, durationMs: 0 };
      setPendingRecovery("tp-7", "pending-stage", recoveryResult);

      clearTaskSlots("tp-7");

      // Now createSlot should NOT auto-resolve (pending was cleared)
      const promise = createSlot("tp-7", "pending-stage");
      expect(hasSlot("tp-7", "pending-stage")).toBe(true);

      resolveSlot("tp-7", "pending-stage", { resultText: "manual", costUsd: 0, durationMs: 0 });
      const result = await promise;
      expect(result.resultText).toBe("manual");
    });
  });
});
