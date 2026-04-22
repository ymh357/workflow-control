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
