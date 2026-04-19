import { describe, it, expect, afterEach } from "vitest";
import { taskRegistry } from "./task-registry.js";
import type { EventDispatcher } from "./port-runtime.js";

function makeDispatcher(): EventDispatcher & { events: unknown[] } {
  const events: unknown[] = [];
  return {
    events,
    send(e) { events.push(e); },
  };
}

describe("taskRegistry", () => {
  afterEach(() => {
    taskRegistry.__clearForTest();
  });

  it("register + get", () => {
    const d = makeDispatcher();
    taskRegistry.register("t1", d);
    expect(taskRegistry.get("t1")).toBe(d);
  });

  it("returns undefined for unregistered tasks", () => {
    expect(taskRegistry.get("absent")).toBeUndefined();
  });

  it("unregister removes the entry", () => {
    const d = makeDispatcher();
    taskRegistry.register("t1", d);
    taskRegistry.unregister("t1");
    expect(taskRegistry.get("t1")).toBeUndefined();
  });

  it("double-register throws", () => {
    const d1 = makeDispatcher();
    const d2 = makeDispatcher();
    taskRegistry.register("t1", d1);
    expect(() => taskRegistry.register("t1", d2)).toThrow(/already registered/);
  });

  it("size reflects live registrations", () => {
    expect(taskRegistry.size()).toBe(0);
    taskRegistry.register("a", makeDispatcher());
    taskRegistry.register("b", makeDispatcher());
    expect(taskRegistry.size()).toBe(2);
    taskRegistry.unregister("a");
    expect(taskRegistry.size()).toBe(1);
  });
});
