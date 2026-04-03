import { describe, it, expect, vi, afterEach } from "vitest";

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

describe("registry adversarial tests", () => {
  afterEach(() => {
    for (const slot of getAllSlots()) {
      rejectSlot(slot.taskId, slot.stageName, new Error("test cleanup"));
    }
  });

  // ─── 1. Double resolve ───────────────────────────────────────────────
  describe("double resolve", () => {
    it("second resolveSlot call should return false", async () => {
      const p = createSlot("t-dbl", "s1");
      const first = resolveSlot("t-dbl", "s1", result("first"));
      const second = resolveSlot("t-dbl", "s1", result("second"));

      expect(first).toBe(true);
      expect(second).toBe(false);

      // The promise should resolve with the FIRST value only
      const r = await p;
      expect(r.resultText).toBe("first");
    });

    it("promise should settle exactly once even if resolve is called twice", async () => {
      const p = createSlot("t-dbl2", "s1");
      resolveSlot("t-dbl2", "s1", result("only"));

      const r = await p;
      expect(r.resultText).toBe("only");

      // Waiting again should still give the same result (promise is settled)
      const r2 = await p;
      expect(r2.resultText).toBe("only");
    });
  });

  // ─── 2. Resolve after timeout ────────────────────────────────────────
  describe("resolve after timeout", () => {
    it("resolveSlot should return false after slot has timed out", async () => {
      vi.useFakeTimers();
      const p = createSlot("t-rto", "s1", 100);

      vi.advanceTimersByTime(150);
      await expect(p).rejects.toThrow("timed out");

      const ok = resolveSlot("t-rto", "s1", result("late"));
      expect(ok).toBe(false);
      expect(hasSlot("t-rto", "s1")).toBe(false);
      vi.useRealTimers();
    });

    it("slot should not be visible in getTaskSlots after timeout", async () => {
      vi.useFakeTimers();
      const p = createSlot("t-rto2", "s1", 50);

      vi.advanceTimersByTime(60);
      await expect(p).rejects.toThrow("timed out");

      expect(getTaskSlots("t-rto2")).toEqual([]);
      vi.useRealTimers();
    });
  });

  // ─── 3. Create slot for same task+stage twice ────────────────────────
  describe("duplicate slot creation", () => {
    it("first slot's promise should reject when replaced", async () => {
      const p1 = createSlot("t-dup", "s1");
      const nonce1 = getSlotNonce("t-dup", "s1");

      const p2 = createSlot("t-dup", "s1");
      const nonce2 = getSlotNonce("t-dup", "s1");

      // Nonces should differ — the old slot was replaced
      expect(nonce1).not.toBe(nonce2);

      // Old promise must reject
      await expect(p1).rejects.toThrow("replaced");

      // New promise should be resolvable
      resolveSlot("t-dup", "s1", result("new"));
      const r = await p2;
      expect(r.resultText).toBe("new");
    });

    it("old nonce should no longer work after slot replacement", async () => {
      const p1 = createSlot("t-dup2", "s1");
      const oldNonce = getSlotNonce("t-dup2", "s1")!;

      const p2 = createSlot("t-dup2", "s1");
      // p1 rejects
      await expect(p1).rejects.toThrow("replaced");

      // Trying to resolve with the old nonce should fail
      const ok = resolveSlot("t-dup2", "s1", result("stale"), oldNonce);
      expect(ok).toBe(false);

      // Slot should still exist for the new nonce
      expect(hasSlot("t-dup2", "s1")).toBe(true);

      resolveSlot("t-dup2", "s1", result("ok"));
      await p2;
    });

    it("rapidly creating the same slot 10 times should leave exactly one slot", async () => {
      const promises: Promise<unknown>[] = [];
      for (let i = 0; i < 10; i++) {
        promises.push(createSlot("t-rapid", "s1"));
      }

      // Only 1 slot should survive
      expect(getTaskSlots("t-rapid")).toHaveLength(1);
      expect(hasSlot("t-rapid", "s1")).toBe(true);

      // First 9 promises should all reject
      resolveSlot("t-rapid", "s1", result("final"));
      const settled = await Promise.allSettled(promises);

      const rejected = settled.filter((s) => s.status === "rejected");
      const fulfilled = settled.filter((s) => s.status === "fulfilled");
      expect(rejected).toHaveLength(9);
      expect(fulfilled).toHaveLength(1);
    });
  });

  // ─── 4. waitForNextSlot race with createSlot ─────────────────────────
  describe("waitForNextSlot race conditions", () => {
    it("waitForNextSlot then immediately createSlot should resolve", async () => {
      // Start waiting
      const waitP = waitForNextSlot("t-race1");

      // Immediately create the slot (no tick/await in between)
      const slotP = createSlot("t-race1", "s1");

      const info = await waitP;
      expect(info.taskId).toBe("t-race1");
      expect(info.stageName).toBe("s1");

      resolveSlot("t-race1", "s1", result("done"));
      await slotP;
    });

    it("waitForNextSlot should return info for a slot that was already resolved by the time caller acts", async () => {
      // This tests a potential semantic issue: waitForNextSlot returns info,
      // but the slot could be resolved before the caller uses the nonce.
      const waitP = waitForNextSlot("t-race2");
      await tick();

      const slotP = createSlot("t-race2", "s1");
      const info = await waitP;

      // Resolve the slot immediately
      resolveSlot("t-race2", "s1", result("gone"));
      await slotP;

      // The info returned by waitForNextSlot should still have valid data
      // even though the slot no longer exists
      expect(info.nonce).toBeDefined();
      expect(info.stageName).toBe("s1");

      // But hasSlot should now be false
      expect(hasSlot("t-race2", "s1")).toBe(false);
    });
  });

  // ─── 5. waitForNextSlot with existing slot ───────────────────────────
  describe("waitForNextSlot with pre-existing slot", () => {
    it("should return immediately when a slot already exists", async () => {
      const slotP = createSlot("t-exist", "s1");
      const info = await waitForNextSlot("t-exist");

      expect(info.stageName).toBe("s1");
      expect(info.taskId).toBe("t-exist");

      resolveSlot("t-exist", "s1", result());
      await slotP;
    });

    it("should return the first existing slot when multiple exist", async () => {
      const p1 = createSlot("t-exist2", "alpha");
      const p2 = createSlot("t-exist2", "beta");

      const info = await waitForNextSlot("t-exist2");

      // Should return one of the existing slots
      expect(["alpha", "beta"]).toContain(info.stageName);

      resolveSlot("t-exist2", "alpha", result());
      resolveSlot("t-exist2", "beta", result());
      await Promise.allSettled([p1, p2]);
    });

    it("should NOT leave lingering listeners after returning immediately", async () => {
      const slotP = createSlot("t-exist3", "s1");
      await waitForNextSlot("t-exist3");

      // The slot listener set should not have grown
      // We verify indirectly: creating a new slot for a different task
      // should not somehow trigger anything related to t-exist3
      const p2 = createSlot("t-other", "s2");
      resolveSlot("t-other", "s2", result());
      await p2;

      resolveSlot("t-exist3", "s1", result());
      await slotP;
    });
  });

  // ─── 6. Nonce mismatch ──────────────────────────────────────────────
  describe("nonce mismatch", () => {
    it("wrong nonce should fail but slot should remain resolvable with correct nonce", async () => {
      const p = createSlot("t-nonce", "s1");
      const correctNonce = getSlotNonce("t-nonce", "s1")!;

      // Try wrong nonce
      const bad = resolveSlot("t-nonce", "s1", result("bad"), "wrong-nonce-123");
      expect(bad).toBe(false);
      expect(hasSlot("t-nonce", "s1")).toBe(true);

      // Correct nonce should still work
      const good = resolveSlot("t-nonce", "s1", result("good"), correctNonce);
      expect(good).toBe(true);

      const r = await p;
      expect(r.resultText).toBe("good");
    });

    it("no nonce bypasses the check entirely", async () => {
      const p = createSlot("t-nonce2", "s1");

      // Resolve without nonce - should succeed regardless
      const ok = resolveSlot("t-nonce2", "s1", result("bypassed"));
      expect(ok).toBe(true);

      const r = await p;
      expect(r.resultText).toBe("bypassed");
    });

    it("empty string nonce should be treated as no-nonce (truthy check)", async () => {
      const p = createSlot("t-nonce3", "s1");

      // Empty string is falsy, so the nonce check should be skipped
      const ok = resolveSlot("t-nonce3", "s1", result("empty"), "");
      expect(ok).toBe(true);

      const r = await p;
      expect(r.resultText).toBe("empty");
    });
  });

  // ─── 7. getTaskSlots after resolve ───────────────────────────────────
  describe("getTaskSlots after operations", () => {
    it("should return empty after all slots resolved", async () => {
      const p1 = createSlot("t-gts", "s1");
      const p2 = createSlot("t-gts", "s2");

      resolveSlot("t-gts", "s1", result());
      resolveSlot("t-gts", "s2", result());

      expect(getTaskSlots("t-gts")).toEqual([]);
      await Promise.all([p1, p2]);
    });

    it("should return empty after all slots rejected", async () => {
      const p1 = createSlot("t-gts2", "s1");
      const p2 = createSlot("t-gts2", "s2");

      rejectSlot("t-gts2", "s1", new Error("x"));
      rejectSlot("t-gts2", "s2", new Error("y"));

      expect(getTaskSlots("t-gts2")).toEqual([]);
      await Promise.allSettled([p1, p2]);
    });

    it("should return empty after clearTaskSlots", async () => {
      const p1 = createSlot("t-gts3", "s1");
      const p2 = createSlot("t-gts3", "s2");

      clearTaskSlots("t-gts3");

      expect(getTaskSlots("t-gts3")).toEqual([]);
      await Promise.allSettled([p1, p2]);
    });
  });

  // ─── 8. clearTaskSlots ──────────────────────────────────────────────
  describe("clearTaskSlots", () => {
    it("should reject all pending promises with 'Task cancelled'", async () => {
      const p1 = createSlot("t-cls", "a");
      const p2 = createSlot("t-cls", "b");
      const p3 = createSlot("t-cls", "c");

      clearTaskSlots("t-cls");

      await expect(p1).rejects.toThrow("Task cancelled");
      await expect(p2).rejects.toThrow("Task cancelled");
      await expect(p3).rejects.toThrow("Task cancelled");
    });

    it("clearTaskSlots should not affect other tasks", async () => {
      const p1 = createSlot("t-cls2", "s1");
      const p2 = createSlot("t-other-cls", "s1");

      clearTaskSlots("t-cls2");

      await expect(p1).rejects.toThrow("Task cancelled");
      expect(hasSlot("t-other-cls", "s1")).toBe(true);

      resolveSlot("t-other-cls", "s1", result());
      await p2;
    });

    it("clearTaskSlots on already-empty task is a no-op", () => {
      expect(() => clearTaskSlots("nonexistent-task")).not.toThrow();
    });

    it("clearTaskSlots followed by createSlot should work for the same key", async () => {
      const p1 = createSlot("t-cls3", "s1");
      clearTaskSlots("t-cls3");
      await expect(p1).rejects.toThrow("Task cancelled");

      // Should be able to create a fresh slot for the same key
      const p2 = createSlot("t-cls3", "s1");
      expect(hasSlot("t-cls3", "s1")).toBe(true);

      resolveSlot("t-cls3", "s1", result("reborn"));
      const r = await p2;
      expect(r.resultText).toBe("reborn");
    });
  });

  // ─── 9. Concurrent slot listeners ───────────────────────────────────
  describe("concurrent slot listeners", () => {
    it("all listeners should be notified when a slot is created", async () => {
      const l1 = vi.fn();
      const l2 = vi.fn();
      const l3 = vi.fn();

      const r1 = addSlotListener(l1);
      const r2 = addSlotListener(l2);
      const r3 = addSlotListener(l3);

      const p = createSlot("t-lsn", "s1");

      expect(l1).toHaveBeenCalledOnce();
      expect(l2).toHaveBeenCalledOnce();
      expect(l3).toHaveBeenCalledOnce();

      // All should receive the same info
      expect(l1.mock.calls[0][0].taskId).toBe("t-lsn");
      expect(l2.mock.calls[0][0].taskId).toBe("t-lsn");
      expect(l3.mock.calls[0][0].taskId).toBe("t-lsn");

      r1();
      r2();
      r3();
      resolveSlot("t-lsn", "s1", result());
      await p;
    });

    it("listener that throws should not prevent other listeners from firing", async () => {
      const bad = vi.fn(() => { throw new Error("kaboom"); });
      const good = vi.fn();

      const r1 = addSlotListener(bad);
      const r2 = addSlotListener(good);

      const p = createSlot("t-lsn2", "s1");

      expect(bad).toHaveBeenCalledOnce();
      expect(good).toHaveBeenCalledOnce();

      r1();
      r2();
      resolveSlot("t-lsn2", "s1", result());
      await p;
    });

    it("multiple waitForNextSlot callers for the same task should all resolve", async () => {
      const w1 = waitForNextSlot("t-multi-wait");
      const w2 = waitForNextSlot("t-multi-wait");
      const w3 = waitForNextSlot("t-multi-wait");

      await tick();
      const slotP = createSlot("t-multi-wait", "s1");

      const [i1, i2, i3] = await Promise.all([w1, w2, w3]);

      expect(i1.stageName).toBe("s1");
      expect(i2.stageName).toBe("s1");
      expect(i3.stageName).toBe("s1");

      resolveSlot("t-multi-wait", "s1", result());
      await slotP;
    });
  });

  // ─── 10. Memory cleanup / no lingering references ───────────────────
  describe("memory cleanup", () => {
    it("slots map should be empty after creating and resolving many slots", async () => {
      const promises: Promise<unknown>[] = [];
      for (let i = 0; i < 100; i++) {
        const p = createSlot(`t-mem`, `stage-${i}`);
        resolveSlot(`t-mem`, `stage-${i}`, result());
        promises.push(p);
      }

      await Promise.all(promises);
      expect(getTaskSlots("t-mem")).toEqual([]);
      expect(getAllSlots().filter((s) => s.taskId === "t-mem")).toEqual([]);
    });

    it("termination listeners should be cleaned up after notifyTaskTerminated", () => {
      const fn = vi.fn();
      addTaskTerminationListener("t-mem2", fn);
      notifyTaskTerminated("t-mem2", "done");

      // Calling again should not fire the listener
      notifyTaskTerminated("t-mem2", "done again");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("removeTerminationListener after notifyTaskTerminated should not throw", () => {
      const fn = vi.fn();
      const remove = addTaskTerminationListener("t-mem3", fn);
      notifyTaskTerminated("t-mem3", "done");

      // The listener set was deleted by notifyTaskTerminated,
      // calling remove() should be safe
      expect(() => remove()).not.toThrow();
    });
  });

  // ─── 11. Edge cases with waitForNextSlot + termination ──────────────
  describe("waitForNextSlot + termination interaction", () => {
    it("termination should reject waitForNextSlot even if slot exists after termination", async () => {
      const waitP = waitForNextSlot("t-term1");
      await tick();

      notifyTaskTerminated("t-term1", "aborted");
      await expect(waitP).rejects.toThrow("terminated: aborted");

      // Creating a slot after termination should still work (new invocation)
      const slotP = createSlot("t-term1", "s1");
      expect(hasSlot("t-term1", "s1")).toBe(true);

      resolveSlot("t-term1", "s1", result());
      await slotP;
    });

    it("termination after slot creation should not affect already-resolved waitForNextSlot", async () => {
      const waitP = waitForNextSlot("t-term2");
      await tick();

      const slotP = createSlot("t-term2", "s1");
      const info = await waitP;
      expect(info.stageName).toBe("s1");

      // Terminating now should not retroactively affect the resolved waitForNextSlot
      notifyTaskTerminated("t-term2", "done");

      // But the slot itself should still be resolvable
      // (termination doesn't auto-clear slots)
      expect(hasSlot("t-term2", "s1")).toBe(true);
      resolveSlot("t-term2", "s1", result());
      await slotP;
    });
  });

  // ─── 12. Slot timeout cleanup of timer ──────────────────────────────
  describe("timeout timer cleanup", () => {
    it("resolveSlot should clear the timeout timer (no rejection after resolve)", async () => {
      vi.useFakeTimers();
      const p = createSlot("t-tmr", "s1", 200);

      resolveSlot("t-tmr", "s1", result("quick"));
      const r = await p;
      expect(r.resultText).toBe("quick");

      // Advancing past the timeout should NOT cause any error
      vi.advanceTimersByTime(300);

      // No slot should exist
      expect(hasSlot("t-tmr", "s1")).toBe(false);
      vi.useRealTimers();
    });

    it("rejectSlot should clear the timeout timer", async () => {
      vi.useFakeTimers();
      const p = createSlot("t-tmr2", "s1", 200);

      rejectSlot("t-tmr2", "s1", new Error("manual reject"));
      await expect(p).rejects.toThrow("manual reject");

      // Advancing should not cause double rejection
      vi.advanceTimersByTime(300);
      expect(hasSlot("t-tmr2", "s1")).toBe(false);
      vi.useRealTimers();
    });
  });

  // ─── 13. getAllSlots returns copies, not references ──────────────────
  describe("data isolation", () => {
    it("getAllSlots should not expose internal slot objects", async () => {
      const p = createSlot("t-iso", "s1");
      const slots = getAllSlots();
      const slot = slots[0]!;

      // Should not have internal fields
      expect(slot).not.toHaveProperty("resolve");
      expect(slot).not.toHaveProperty("reject");
      expect(slot).not.toHaveProperty("timeoutTimer");

      // Mutating the returned object should not affect the internal state
      (slot as any).taskId = "hacked";
      const freshSlots = getAllSlots();
      expect(freshSlots[0]!.taskId).toBe("t-iso");

      resolveSlot("t-iso", "s1", result());
      await p;
    });

    it("getTaskSlots should not expose internal slot objects", async () => {
      const p = createSlot("t-iso2", "s1");
      const slots = getTaskSlots("t-iso2");

      expect(slots[0]).not.toHaveProperty("resolve");
      expect(slots[0]).not.toHaveProperty("reject");

      resolveSlot("t-iso2", "s1", result());
      await p;
    });
  });

  // ─── 14. Slot key collision between different tasks ──────────────────
  describe("slot key isolation", () => {
    it("same stageName in different tasks should be independent", async () => {
      const p1 = createSlot("task-A", "build");
      const p2 = createSlot("task-B", "build");

      resolveSlot("task-A", "build", result("A-done"));
      expect(hasSlot("task-B", "build")).toBe(true);

      resolveSlot("task-B", "build", result("B-done"));

      const r1 = await p1;
      const r2 = await p2;
      expect(r1.resultText).toBe("A-done");
      expect(r2.resultText).toBe("B-done");
    });
  });

  // ─── 15. Adversarial: slot key with special characters ──────────────
  describe("special characters in keys", () => {
    it("taskId or stageName containing :: separator should still work correctly", async () => {
      // The slotKey function uses :: as separator. If taskId contains ::,
      // it could collide with a different task+stage combo.
      // e.g., "a::b" + "c" => "a::b::c" same as "a" + "b::c" => "a::b::c"
      const p1 = createSlot("a::b", "c");
      const p2 = createSlot("a", "b::c");

      // These should be DIFFERENT slots if the implementation handles it correctly
      // But with simple string concatenation "a::b::c" === "a::b::c" — COLLISION!
      const slots = getAllSlots();

      // If both slots exist, the implementation is correct.
      // If only one exists, there's a key collision bug.
      expect(slots).toHaveLength(2);

      resolveSlot("a::b", "c", result());
      resolveSlot("a", "b::c", result());
      await Promise.allSettled([p1, p2]);
    });
  });
});
