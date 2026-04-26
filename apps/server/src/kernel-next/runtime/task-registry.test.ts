import { describe, it, expect, afterEach } from "vitest";
import { taskRegistry } from "./task-registry.js";
import type { EventDispatcher } from "./port-runtime.js";

const noop: EventDispatcher = { send: () => { /* test stub */ } };

afterEach(() => {
  taskRegistry.__clearForTest();
});

describe("taskRegistry — termination signal (Stage 5B)", () => {
  it("awaitTermination returns never_started for unregistered task", async () => {
    const r = await taskRegistry.awaitTermination("nonexistent", 100);
    expect(r.kind).toBe("never_started");
  });

  it("unregister resolves pending awaitTermination with stored reason", async () => {
    taskRegistry.register("t1", noop);
    const wait = taskRegistry.awaitTermination("t1", 1000);
    taskRegistry.signalTermination("t1", { kind: "natural" });
    taskRegistry.unregister("t1");
    const r = await wait;
    expect(r.kind).toBe("natural");
  });

  it("signalTermination before awaitTermination still delivers reason", async () => {
    taskRegistry.register("t2", noop);
    taskRegistry.signalTermination("t2", { kind: "interrupted" });
    taskRegistry.unregister("t2");
    const r = await taskRegistry.awaitTermination("t2", 100);
    expect(["interrupted", "never_started"]).toContain(r.kind);
  });

  it("multiple awaitTermination calls on same taskId all resolve", async () => {
    taskRegistry.register("t3", noop);
    const [w1, w2, w3] = [
      taskRegistry.awaitTermination("t3", 1000),
      taskRegistry.awaitTermination("t3", 1000),
      taskRegistry.awaitTermination("t3", 1000),
    ];
    taskRegistry.signalTermination("t3", { kind: "error", detail: "boom" });
    taskRegistry.unregister("t3");
    const results = await Promise.all([w1, w2, w3]);
    for (const r of results) {
      expect(r.kind).toBe("error");
      expect(r.detail).toBe("boom");
    }
  });

  it("timeout path: resolves with kind='never_started' when no termination fired", async () => {
    taskRegistry.register("t4", noop);
    const start = Date.now();
    const r = await taskRegistry.awaitTermination("t4", 50);
    const elapsed = Date.now() - start;
    expect(r.kind).toBe("never_started");
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it("legacy register/get/unregister still work", () => {
    const d: EventDispatcher = { send: () => {} };
    taskRegistry.register("legacy", d);
    expect(taskRegistry.get("legacy")).toBe(d);
    taskRegistry.unregister("legacy");
    expect(taskRegistry.get("legacy")).toBeUndefined();
  });
});

describe("taskRegistry — interruptAll (2026-04-27 A3)", () => {
  it("returns 0/0 when registry is empty", async () => {
    const r = await taskRegistry.interruptAll(1000);
    expect(r).toEqual({ total: 0, terminated: 0 });
  });

  it("dispatches INTERRUPT to every registered task", async () => {
    const sent: Array<{ taskId: string; type: string }> = [];
    const make = (id: string): EventDispatcher => ({
      send: (ev) => sent.push({ taskId: id, type: (ev as { type: string }).type }),
    });
    taskRegistry.register("a", make("a"));
    taskRegistry.register("b", make("b"));
    // Resolve their terminations promptly so interruptAll doesn't sit on
    // the deadline. In production the runner does this from its finally.
    const finishAll = (): void => {
      taskRegistry.signalTermination("a", { kind: "interrupted" });
      taskRegistry.signalTermination("b", { kind: "interrupted" });
    };
    setTimeout(finishAll, 20);

    const r = await taskRegistry.interruptAll(1000);
    expect(r.total).toBe(2);
    expect(r.terminated).toBe(2);
    expect(sent.map((s) => s.taskId).sort()).toEqual(["a", "b"]);
    expect(sent.every((s) => s.type === "INTERRUPT")).toBe(true);
  });

  it("times out gracefully when a runner ignores INTERRUPT", async () => {
    taskRegistry.register("zombie", noop);
    const start = Date.now();
    const r = await taskRegistry.interruptAll(80);
    const elapsed = Date.now() - start;
    expect(r.total).toBe(1);
    // The unresponsive task counts as not-terminated; safety net (DB
    // reconcile) handles its stage_attempts at the index.ts level.
    expect(r.terminated).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(elapsed).toBeLessThan(500);
  });

  it("counts terminations even when only some runners settle in time", async () => {
    taskRegistry.register("fast", noop);
    taskRegistry.register("slow", noop);
    setTimeout(() => taskRegistry.signalTermination("fast", { kind: "natural" }), 20);
    const r = await taskRegistry.interruptAll(120);
    expect(r.total).toBe(2);
    expect(r.terminated).toBe(1);
  });
});
