import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DeltaThrottler } from "./agent-message-delta.js";
import type { KernelNextBroadcaster } from "../sse/broadcaster.js";
import type { KernelNextSSEEvent } from "../sse/types.js";

describe("DeltaThrottler", () => {
  let published: KernelNextSSEEvent[];
  let broadcaster: Pick<KernelNextBroadcaster, "publish">;

  beforeEach(() => {
    vi.useFakeTimers();
    published = [];
    broadcaster = {
      publish: (e: KernelNextSSEEvent) => { published.push(e); },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces consecutive push() calls within the flush window", () => {
    const t = new DeltaThrottler(
      broadcaster as KernelNextBroadcaster,
      "tid",
      "aid",
      "stage",
    );
    t.push("hello ");
    t.push("world");
    expect(published).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(published).toHaveLength(1);
    const data = (published[0] as { data: { textDelta: string } }).data;
    expect(data.textDelta).toBe("hello world");
  });

  it("emits multiple events if deltas arrive in separate windows", () => {
    const t = new DeltaThrottler(
      broadcaster as KernelNextBroadcaster,
      "tid",
      "aid",
      "s",
    );
    t.push("A");
    vi.advanceTimersByTime(100);
    t.push("B");
    vi.advanceTimersByTime(100);
    expect(published).toHaveLength(2);
    expect((published[0] as { data: { textDelta: string } }).data.textDelta).toBe("A");
    expect((published[1] as { data: { textDelta: string } }).data.textDelta).toBe("B");
  });

  it("flush() publishes immediately and resets buffer", () => {
    const t = new DeltaThrottler(
      broadcaster as KernelNextBroadcaster,
      "tid",
      "aid",
      "s",
    );
    t.push("x");
    t.flush();
    expect(published).toHaveLength(1);
    t.flush();
    expect(published).toHaveLength(1);
  });

  it("dispose() flushes any pending buffer", () => {
    const t = new DeltaThrottler(
      broadcaster as KernelNextBroadcaster,
      "tid",
      "aid",
      "s",
    );
    t.push("pending");
    t.dispose();
    expect(published).toHaveLength(1);
    expect((published[0] as { data: { textDelta: string } }).data.textDelta).toBe("pending");
  });

  it("ignores empty deltas", () => {
    const t = new DeltaThrottler(
      broadcaster as KernelNextBroadcaster,
      "tid",
      "aid",
      "s",
    );
    t.push("");
    vi.advanceTimersByTime(100);
    expect(published).toEqual([]);
  });

  it("payload has the expected shape", () => {
    const t = new DeltaThrottler(
      broadcaster as KernelNextBroadcaster,
      "t",
      "a",
      "s",
    );
    t.push("x");
    vi.advanceTimersByTime(100);
    expect(published[0]).toMatchObject({
      type: "agent_message_delta",
      taskId: "t",
      data: {
        attemptId: "a",
        stage: "s",
        textDelta: "x",
        role: "assistant",
      },
    });
    expect(typeof (published[0] as { timestamp: unknown }).timestamp).toBe("string");
  });

  it("swallows broadcaster errors", () => {
    const errBroadcaster: Pick<KernelNextBroadcaster, "publish"> = {
      publish: () => { throw new Error("boom"); },
    };
    const t = new DeltaThrottler(
      errBroadcaster as KernelNextBroadcaster,
      "t",
      "a",
      "s",
    );
    t.push("x");
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(() => t.dispose()).not.toThrow();
  });

  it("honours a custom role on construction", () => {
    const t = new DeltaThrottler(
      broadcaster as KernelNextBroadcaster,
      "t",
      "a",
      "s",
      "other",
    );
    t.push("x");
    vi.advanceTimersByTime(100);
    expect((published[0] as { data: { role: string } }).data.role).toBe("other");
  });
});
