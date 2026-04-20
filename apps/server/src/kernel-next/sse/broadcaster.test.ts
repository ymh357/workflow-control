import { describe, it, expect, vi } from "vitest";
import { KernelNextBroadcaster } from "./broadcaster.js";
import type { KernelNextSSEEvent } from "./types.js";

function makeEvent(taskId: string, seq: number): KernelNextSSEEvent {
  return {
    type: "task_state",
    taskId,
    timestamp: new Date().toISOString(),
    data: { state: "running" as const, seq },
  };
}

describe("KernelNextBroadcaster", () => {
  it("delivers live events to active subscribers and isolates tasks", () => {
    const broadcaster = new KernelNextBroadcaster();
    const receivedA: KernelNextSSEEvent[] = [];
    const receivedB: KernelNextSSEEvent[] = [];
    broadcaster.subscribe("A", (e) => receivedA.push(e));
    broadcaster.subscribe("B", (e) => receivedB.push(e));

    broadcaster.publish(makeEvent("A", 1));
    broadcaster.publish(makeEvent("B", 2));
    broadcaster.publish(makeEvent("A", 3));

    expect(receivedA).toHaveLength(2);
    expect(receivedB).toHaveLength(1);
    expect((receivedA[0]!.data as { seq: number }).seq).toBe(1);
    expect((receivedA[1]!.data as { seq: number }).seq).toBe(3);
    expect((receivedB[0]!.data as { seq: number }).seq).toBe(2);
  });

  it("replays history to a late subscriber in publish order", () => {
    const broadcaster = new KernelNextBroadcaster();
    broadcaster.publish(makeEvent("A", 1));
    broadcaster.publish(makeEvent("A", 2));
    broadcaster.publish(makeEvent("A", 3));

    const received: KernelNextSSEEvent[] = [];
    broadcaster.subscribe("A", (e) => received.push(e));

    // All three history events fire synchronously on subscribe.
    expect(received.map((e) => (e.data as { seq: number }).seq)).toEqual([1, 2, 3]);

    // And live events continue to flow.
    broadcaster.publish(makeEvent("A", 4));
    expect(received.map((e) => (e.data as { seq: number }).seq)).toEqual([1, 2, 3, 4]);
  });

  it("trims history to historyLimit when overflowing (FIFO)", () => {
    const broadcaster = new KernelNextBroadcaster({ historyLimit: 3 });
    for (let i = 1; i <= 5; i++) broadcaster.publish(makeEvent("A", i));

    const history = broadcaster.historyFor("A");
    expect(history.map((e) => (e.data as { seq: number }).seq)).toEqual([3, 4, 5]);

    // Late subscriber only sees what's left in the buffer, not the
    // evicted 1 and 2.
    const received: KernelNextSSEEvent[] = [];
    broadcaster.subscribe("A", (e) => received.push(e));
    expect(received.map((e) => (e.data as { seq: number }).seq)).toEqual([3, 4, 5]);
  });

  it("unsubscribe stops delivery and is idempotent", () => {
    const broadcaster = new KernelNextBroadcaster();
    const received: KernelNextSSEEvent[] = [];
    const unsub = broadcaster.subscribe("A", (e) => received.push(e));

    broadcaster.publish(makeEvent("A", 1));
    expect(received).toHaveLength(1);

    unsub();
    broadcaster.publish(makeEvent("A", 2));
    expect(received).toHaveLength(1); // Still 1 — unsub took effect.

    // Idempotent: calling again does not throw.
    expect(() => unsub()).not.toThrow();
    expect(broadcaster.subscriberCount("A")).toBe(0);
  });

  it("listener errors do not poison the publish loop", () => {
    const broadcaster = new KernelNextBroadcaster();
    const goodCalls: KernelNextSSEEvent[] = [];
    const badListener = vi.fn(() => { throw new Error("boom"); });
    broadcaster.subscribe("A", badListener);
    broadcaster.subscribe("A", (e) => goodCalls.push(e));

    // Must not throw even though one listener explodes.
    expect(() => broadcaster.publish(makeEvent("A", 1))).not.toThrow();
    expect(badListener).toHaveBeenCalledTimes(1);
    // Second listener still received the event despite the first
    // one's error. Order of Set iteration is insertion order in V8,
    // but we assert on delivery, not sequence between them.
    expect(goodCalls).toHaveLength(1);
  });

  it("multiple subscribers on the same task all receive live events", () => {
    const broadcaster = new KernelNextBroadcaster();
    const a: KernelNextSSEEvent[] = [];
    const b: KernelNextSSEEvent[] = [];
    broadcaster.subscribe("T", (e) => a.push(e));
    broadcaster.subscribe("T", (e) => b.push(e));
    broadcaster.publish(makeEvent("T", 1));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(broadcaster.subscriberCount("T")).toBe(2);
  });

  it("clearTask drops history and subscribers for the task only", () => {
    const broadcaster = new KernelNextBroadcaster();
    broadcaster.publish(makeEvent("A", 1));
    broadcaster.publish(makeEvent("B", 2));
    const aReceived: KernelNextSSEEvent[] = [];
    broadcaster.subscribe("A", (e) => aReceived.push(e));
    expect(aReceived).toHaveLength(1); // replayed history

    broadcaster.clearTask("A");
    expect(broadcaster.historyFor("A")).toEqual([]);
    expect(broadcaster.subscriberCount("A")).toBe(0);

    // B is untouched.
    expect(broadcaster.historyFor("B").map((e) => (e.data as { seq: number }).seq)).toEqual([2]);

    // A fresh subscribe after clear has an empty replay.
    const aReceivedAgain: KernelNextSSEEvent[] = [];
    broadcaster.subscribe("A", (e) => aReceivedAgain.push(e));
    expect(aReceivedAgain).toEqual([]);

    // Publishing to A after clear still works and starts a fresh
    // channel.
    broadcaster.publish(makeEvent("A", 99));
    expect(aReceivedAgain).toHaveLength(1);
  });
});
