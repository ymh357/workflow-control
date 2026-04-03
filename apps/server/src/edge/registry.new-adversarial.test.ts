import { vi, describe, it, expect, afterEach } from "vitest";

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
} from "./registry.js";

const tick = () => new Promise((r) => setTimeout(r, 0));
const result = (text = "") => ({ resultText: text, costUsd: 0, durationMs: 0 });

describe("registry new adversarial tests", () => {
  afterEach(() => {
    for (const slot of getAllSlots()) {
      rejectSlot(slot.taskId, slot.stageName, new Error("test cleanup"));
    }
  });

  // ─── 1. slotKey collision resistance ─────────────────────────────────
  // Previously used \0 as separator, which allowed taskId="a\0b",stageName="c"
  // to collide with taskId="a",stageName="b\0c". Fixed by using JSON.stringify.
  describe("slotKey collision resistance", () => {
    it("taskId containing \\0 must NOT collide with different taskId+stageName", async () => {
      const p1 = createSlot("a\0b", "c");
      const p2 = createSlot("a", "b\0c");

      // Both slots must exist independently — no collision
      expect(getAllSlots()).toHaveLength(2);
      expect(hasSlot("a\0b", "c")).toBe(true);
      expect(hasSlot("a", "b\0c")).toBe(true);

      resolveSlot("a\0b", "c", result());
      resolveSlot("a", "b\0c", result());
      await Promise.all([p1, p2]);
    });

    it("stageName containing \\0 must NOT collide with different task+stage", async () => {
      const p1 = createSlot("x", "y\0z");
      const p2 = createSlot("x\0y", "z");

      expect(getAllSlots()).toHaveLength(2);
      expect(hasSlot("x", "y\0z")).toBe(true);
      expect(hasSlot("x\0y", "z")).toBe(true);

      resolveSlot("x", "y\0z", result());
      resolveSlot("x\0y", "z", result());
      await Promise.all([p1, p2]);
    });
  });

  // ─── 2. Extremely long taskId/stageName ───────────────────────────────
  describe("extremely long taskId and stageName", () => {
    it("should handle very long taskId (10000 chars) without error", async () => {
      const longId = "t-" + "a".repeat(10000);
      const p = createSlot(longId, "stage");
      expect(hasSlot(longId, "stage")).toBe(true);

      resolveSlot(longId, "stage", result("ok"));
      const r = await p;
      expect(r.resultText).toBe("ok");
    });

    it("should handle very long stageName (10000 chars) without error", async () => {
      const longStage = "s-" + "b".repeat(10000);
      const p = createSlot("t-long", longStage);
      expect(hasSlot("t-long", longStage)).toBe(true);

      resolveSlot("t-long", longStage, result("ok"));
      const r = await p;
      expect(r.resultText).toBe("ok");
    });
  });

  // ─── 3. Rapid slot creation (100 different slots) ─────────────────────
  describe("rapid slot creation — 100 distinct slots", () => {
    it("should create 100 slots for same task with different stage names", async () => {
      const promises: Promise<unknown>[] = [];
      for (let i = 0; i < 100; i++) {
        promises.push(createSlot("t-rapid100", `stage-${i}`));
      }

      const slots = getTaskSlots("t-rapid100");
      expect(slots).toHaveLength(100);

      // Resolve all
      for (let i = 0; i < 100; i++) {
        resolveSlot("t-rapid100", `stage-${i}`, result(`done-${i}`));
      }
      const settled = await Promise.allSettled(promises);
      const fulfilled = settled.filter((s) => s.status === "fulfilled");
      expect(fulfilled).toHaveLength(100);
    });
  });

  // ─── 4. waitForNextSlot with multiple existing slots ──────────────────
  describe("waitForNextSlot with multiple existing slots", () => {
    it("should return the first slot found by Map iteration order", async () => {
      // Create two slots for the same task
      const p1 = createSlot("t-multi", "alpha");
      const p2 = createSlot("t-multi", "beta");

      // waitForNextSlot iterates slots.values() and returns the first match
      const info = await waitForNextSlot("t-multi");

      // Should return whichever the Map yields first (insertion order in JS Maps)
      expect(info.stageName).toBe("alpha");
      expect(info.taskId).toBe("t-multi");

      resolveSlot("t-multi", "alpha", result());
      resolveSlot("t-multi", "beta", result());
      await Promise.all([p1, p2]);
    });
  });

  // ─── 5. addSlotListener that throws ───────────────────────────────────
  describe("addSlotListener — throwing listener", () => {
    it("should not prevent slot creation when a listener throws", async () => {
      const thrower = vi.fn(() => { throw new Error("listener explosion"); });
      const observer = vi.fn();

      const r1 = addSlotListener(thrower);
      const r2 = addSlotListener(observer);

      const p = createSlot("t-throw", "s1");

      // Both listeners were called
      expect(thrower).toHaveBeenCalledOnce();
      expect(observer).toHaveBeenCalledOnce();

      // Slot was still created despite the throw
      expect(hasSlot("t-throw", "s1")).toBe(true);

      r1();
      r2();
      resolveSlot("t-throw", "s1", result());
      await p;
    });

    it("should not prevent subsequent listeners from receiving events after one throws", async () => {
      const calls: string[] = [];
      const thrower = vi.fn(() => {
        calls.push("thrower");
        throw new Error("boom");
      });
      const afterThrower = vi.fn(() => { calls.push("after"); });

      const r1 = addSlotListener(thrower);
      const r2 = addSlotListener(afterThrower);

      const p = createSlot("t-throw2", "s1");

      expect(calls).toEqual(["thrower", "after"]);

      r1();
      r2();
      resolveSlot("t-throw2", "s1", result());
      await p;
    });
  });

  // ─── 6. addTaskTerminationListener cleanup — no memory leak ───────────
  describe("addTaskTerminationListener cleanup", () => {
    it("should clean up listener set after notifyTaskTerminated", () => {
      const fn1 = vi.fn();
      const fn2 = vi.fn();

      addTaskTerminationListener("t-term-clean", fn1);
      addTaskTerminationListener("t-term-clean", fn2);

      notifyTaskTerminated("t-term-clean", "done");

      expect(fn1).toHaveBeenCalledOnce();
      expect(fn2).toHaveBeenCalledOnce();

      // Subsequent termination should not fire listeners (set was deleted)
      fn1.mockClear();
      fn2.mockClear();
      notifyTaskTerminated("t-term-clean", "done again");
      expect(fn1).not.toHaveBeenCalled();
      expect(fn2).not.toHaveBeenCalled();
    });

    it("calling remove after notifyTaskTerminated should not throw", () => {
      const fn = vi.fn();
      const remove = addTaskTerminationListener("t-term-safe", fn);
      notifyTaskTerminated("t-term-safe", "done");

      // The internal Set was deleted, remove() calls terminationListeners.get(taskId)?.delete(fn)
      // which should be safe since ?.delete on undefined returns undefined
      expect(() => remove()).not.toThrow();
    });

    it("remove should prevent listener from firing if called before termination", () => {
      const fn = vi.fn();
      const remove = addTaskTerminationListener("t-term-pre", fn);

      remove();

      notifyTaskTerminated("t-term-pre", "done");
      expect(fn).not.toHaveBeenCalled();
    });
  });

  // ─── 7. Resolved slot promise can be awaited multiple times ───────────
  describe("resolved slot promise — multiple awaits", () => {
    it("should return the same result on repeated awaits", async () => {
      const p = createSlot("t-reawait", "s1");
      resolveSlot("t-reawait", "s1", result("stable"));

      const r1 = await p;
      const r2 = await p;
      const r3 = await p;

      expect(r1.resultText).toBe("stable");
      expect(r2.resultText).toBe("stable");
      expect(r3.resultText).toBe("stable");
      // All should be the same reference
      expect(r1).toBe(r2);
      expect(r2).toBe(r3);
    });

    it("rejected slot promise should throw the same error on repeated awaits", async () => {
      const p = createSlot("t-reawait2", "s1");
      rejectSlot("t-reawait2", "s1", new Error("fail once"));

      await expect(p).rejects.toThrow("fail once");
      await expect(p).rejects.toThrow("fail once");
      await expect(p).rejects.toThrow("fail once");
    });
  });

  // ─── 8. waitForNextSlot timeout ───────────────────────────────────────
  describe("waitForNextSlot timeout", () => {
    it("should reject after 30 minutes if no slot appears", async () => {
      vi.useFakeTimers();
      const waitP = waitForNextSlot("t-wait-timeout");

      // Advance past the 30-minute internal timeout
      vi.advanceTimersByTime(30 * 60 * 1000 + 1000);

      await expect(waitP).rejects.toThrow("timed out");
      vi.useRealTimers();
    });
  });

  // ─── 9. notifyTaskTerminated with no listeners ────────────────────────
  describe("notifyTaskTerminated edge cases", () => {
    it("should not throw when no listeners are registered for the task", () => {
      expect(() => notifyTaskTerminated("no-such-task", "done")).not.toThrow();
    });

    it("should handle termination listener that throws without breaking others", () => {
      const bad = vi.fn(() => { throw new Error("listener crash"); });
      const good = vi.fn();

      addTaskTerminationListener("t-term-throw", bad);
      addTaskTerminationListener("t-term-throw", good);

      // notifyTaskTerminated wraps in try/catch
      expect(() => notifyTaskTerminated("t-term-throw", "done")).not.toThrow();

      expect(bad).toHaveBeenCalledOnce();
      expect(good).toHaveBeenCalledOnce();
    });
  });

  // ─── 10. clearTaskSlots idempotency ───────────────────────────────────
  describe("clearTaskSlots idempotency", () => {
    it("double clearTaskSlots should not throw", async () => {
      const p = createSlot("t-dblclear", "s1");
      clearTaskSlots("t-dblclear");
      await expect(p).rejects.toThrow("Task cancelled");

      // Second clear on now-empty task
      expect(() => clearTaskSlots("t-dblclear")).not.toThrow();
      expect(getTaskSlots("t-dblclear")).toEqual([]);
    });
  });
});
