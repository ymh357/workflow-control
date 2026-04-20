import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { KernelNextBroadcaster } from "./broadcaster.js";
import { createKernelNextStream } from "./http.js";
import type { KernelNextSSEEvent } from "./types.js";

function makeEvent(taskId: string, seq: number): KernelNextSSEEvent {
  return {
    type: "task_state",
    taskId,
    timestamp: new Date().toISOString(),
    data: { state: "running" as const, seq },
  };
}

// Drain a ReadableStream into UTF-8 text until `timeoutMs` elapses
// since the last chunk. Returns the accumulated string. Uses a
// cooperative polling loop because the stream stays open for live
// events — we're not waiting for end-of-stream.
async function readUntilQuiet(
  stream: ReadableStream<Uint8Array>,
  quietMs = 20,
): Promise<{ text: string; reader: ReadableStreamDefaultReader<Uint8Array> }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  return new Promise((resolve) => {
    const schedule = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => resolve({ text, reader }), quietMs);
    };
    schedule();
    void (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            resolve({ text, reader });
            return;
          }
          text += decoder.decode(value, { stream: true });
          schedule();
        }
      } catch {
        resolve({ text, reader });
      }
    })();
  });
}

describe("createKernelNextStream", () => {
  let broadcaster: KernelNextBroadcaster;

  beforeEach(() => {
    broadcaster = new KernelNextBroadcaster();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("replays history on connect and formats SSE frames with event + data fields", async () => {
    broadcaster.publish(makeEvent("T1", 1));
    broadcaster.publish(makeEvent("T1", 2));

    const stream = createKernelNextStream(broadcaster, "T1");
    vi.useRealTimers(); // readUntilQuiet uses setTimeout; swap back to real clock
    const { text, reader } = await readUntilQuiet(stream);
    reader.cancel();

    // Each frame = "event: <type>\ndata: <json>\n\n"
    const frames = text.split("\n\n").filter((f) => f.startsWith("event:"));
    expect(frames.length).toBeGreaterThanOrEqual(2);
    for (const frame of frames) {
      expect(frame).toMatch(/^event: task_state\n/);
      expect(frame).toMatch(/\ndata: \{/);
    }
    // Both history events are present.
    expect(text).toContain('"seq":1');
    expect(text).toContain('"seq":2');
  });

  it("delivers live events after subscribe", async () => {
    const stream = createKernelNextStream(broadcaster, "T2");
    vi.useRealTimers();
    // Read initial (empty) output, then publish and read the live event.
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    // Publish a live event.
    broadcaster.publish(makeEvent("T2", 99));

    // Wait briefly for flush.
    await new Promise((r) => setTimeout(r, 20));
    const { value } = await reader.read();
    reader.cancel();
    const text = decoder.decode(value);
    expect(text).toContain('"seq":99');
    expect(text).toContain("event: task_state");
  });

  it("sends heartbeat comment at the configured interval", async () => {
    const stream = createKernelNextStream(broadcaster, "T3", { heartbeatMs: 50 });
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    // Advance fake timer past one heartbeat tick.
    vi.advanceTimersByTime(60);
    const { value } = await reader.read();
    reader.cancel();

    const text = decoder.decode(value);
    expect(text).toContain(": heartbeat");
  });

  it("cancel() unsubscribes from broadcaster", async () => {
    vi.useRealTimers();
    const stream = createKernelNextStream(broadcaster, "T4");
    expect(broadcaster.subscriberCount("T4")).toBe(1);

    await stream.cancel();
    // Hono's c.body closes via stream.cancel(); the implementation
    // must drop its broadcaster subscription.
    expect(broadcaster.subscriberCount("T4")).toBe(0);
  });

  it("isolates tasks — stream for T5 does not see T6's events", async () => {
    vi.useRealTimers();
    const streamT5 = createKernelNextStream(broadcaster, "T5");
    const readerT5 = streamT5.getReader();
    const decoder = new TextDecoder();

    broadcaster.publish(makeEvent("T6", 42));
    // Allow microtask flush.
    await new Promise((r) => setTimeout(r, 20));

    // Nothing was published for T5; the reader should not have any
    // data available. Attempt a short-windowed read.
    const readPromise = readerT5.read();
    const timeoutPromise = new Promise<{ timeout: true }>((r) =>
      setTimeout(() => r({ timeout: true }), 30),
    );
    const outcome = await Promise.race([readPromise, timeoutPromise]);
    readerT5.cancel();

    if ("timeout" in outcome) {
      // Good — T5 had nothing to deliver.
      expect(outcome.timeout).toBe(true);
    } else {
      // If we did get data, it must not mention T6 or seq:42.
      const text = decoder.decode(outcome.value);
      expect(text).not.toContain('"seq":42');
      expect(text).not.toContain('"taskId":"T6"');
    }
  });
});
