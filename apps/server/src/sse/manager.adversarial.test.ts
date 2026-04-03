import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SSEMessage } from "../types/index.js";

const mockRun = vi.fn();
const mockAll = vi.fn((): any[] => []);
const mockGet = vi.fn((): any => undefined);
const mockPrepare = vi.fn(() => ({ run: mockRun, all: mockAll, get: mockGet }));
const mockDb = { prepare: mockPrepare, exec: vi.fn() };

vi.mock("../lib/db.js", () => ({ getDb: () => mockDb }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function makeMsg(taskId: string, index: number): SSEMessage {
  return {
    type: "status",
    taskId,
    timestamp: new Date(index).toISOString(),
    data: { status: `s${index}` },
  };
}

async function freshManager() {
  const mod = await import("./manager.js");
  return mod.sseManager;
}

describe("SSEManager adversarial — Bug 6: cancel callback kills all connections' heartbeats", () => {
  let sseManager: Awaited<ReturnType<typeof freshManager>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAll.mockReturnValue([]);
    mockGet.mockReturnValue(undefined);
    sseManager = await freshManager();
  });

  it("cancelling one stream does not stop heartbeat on the other stream for the same taskId", async () => {
    vi.useFakeTimers();

    const taskId = "bug6-heartbeat-isolation";

    // Create two streams for the same taskId
    const stream1 = sseManager.createStream(taskId);
    const stream2 = sseManager.createStream(taskId);

    const reader1 = stream1.getReader();
    const reader2 = stream2.getReader();

    // Cancel stream1 — should only affect stream1's heartbeat
    await reader1.cancel();

    // Advance 30s to trigger heartbeat on the surviving stream2
    vi.advanceTimersByTime(30_000);

    // stream2 should still receive a heartbeat
    const { value, done } = await reader2.read();
    expect(done).toBe(false);
    const text = new TextDecoder().decode(value);
    expect(text).toContain(": heartbeat");

    reader2.releaseLock();
    sseManager.closeStream(taskId);
    vi.useRealTimers();
  });

  it("cancelling one stream still allows the other stream to receive pushed messages", async () => {
    const taskId = "bug6-push-after-cancel";

    const stream1 = sseManager.createStream(taskId);
    const stream2 = sseManager.createStream(taskId);

    // Let start() callbacks run
    await new Promise((r) => setTimeout(r, 10));

    const reader1 = stream1.getReader();
    const reader2 = stream2.getReader();

    // Cancel stream1
    await reader1.cancel();

    // Push a message — stream2 should receive it
    const msg = makeMsg(taskId, 42);
    sseManager.pushMessage(taskId, msg);

    const { value, done } = await reader2.read();
    expect(done).toBe(false);
    const text = new TextDecoder().decode(value);
    expect(text).toContain('"status":"s42"');

    reader2.releaseLock();
    sseManager.closeStream(taskId);
  });

  it("cancelled stream is properly cleaned up and removed from connection list", async () => {
    const taskId = "bug6-cleanup";

    // Fill to 9 connections
    const streams: ReadableStream<Uint8Array>[] = [];
    for (let i = 0; i < 9; i++) {
      streams.push(sseManager.createStream(taskId));
    }

    // Cancel one stream to free a slot
    const reader = streams[0]!.getReader();
    await reader.cancel();

    // Trigger cleanup by pushing a message
    sseManager.pushMessage(taskId, makeMsg(taskId, 1));

    // Should be able to create 2 more (8 active + 2 = 10)
    expect(() => sseManager.createStream(taskId)).not.toThrow();
    expect(() => sseManager.createStream(taskId)).not.toThrow();

    // Now at limit
    expect(() => sseManager.createStream(taskId)).toThrow(/Too many connections/);

    sseManager.closeStream(taskId);
  });

  it("cancelling all streams for a taskId cleans up the connection list entirely", async () => {
    const taskId = "bug6-cancel-all";

    const stream1 = sseManager.createStream(taskId);
    const stream2 = sseManager.createStream(taskId);

    const reader1 = stream1.getReader();
    const reader2 = stream2.getReader();

    await reader1.cancel();
    await reader2.cancel();

    // Both cancelled — should be able to create the full 10 again
    for (let i = 0; i < 10; i++) {
      sseManager.createStream(taskId);
    }

    sseManager.closeStream(taskId);
  });
});

// ---------------------------------------------------------------------------
// Bug 6 extended — multi-connection scenarios
// ---------------------------------------------------------------------------
describe("SSEManager adversarial — Bug 6 extended: multi-connection scenarios", () => {
  let sseManager: Awaited<ReturnType<typeof freshManager>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAll.mockReturnValue([]);
    mockGet.mockReturnValue(undefined);
    sseManager = await freshManager();
  });

  it("cancel middle stream of 3 → first and third still work", async () => {
    const taskId = "multi-cancel-middle";

    const stream1 = sseManager.createStream(taskId);
    const stream2 = sseManager.createStream(taskId);
    const stream3 = sseManager.createStream(taskId);

    const reader1 = stream1.getReader();
    const reader2 = stream2.getReader();
    const reader3 = stream3.getReader();

    // Cancel the middle one
    await reader2.cancel();

    // Push a message — stream1 and stream3 should receive it
    const msg = makeMsg(taskId, 99);
    sseManager.pushMessage(taskId, msg);

    const { value: v1, done: d1 } = await reader1.read();
    expect(d1).toBe(false);
    expect(new TextDecoder().decode(v1)).toContain('"status":"s99"');

    const { value: v3, done: d3 } = await reader3.read();
    expect(d3).toBe(false);
    expect(new TextDecoder().decode(v3)).toContain('"status":"s99"');

    reader1.releaseLock();
    reader3.releaseLock();
    sseManager.closeStream(taskId);
  });

  it("create stream, push, cancel, create new → new stream gets history replay", async () => {
    const taskId = "multi-reconnect-history";

    const stream1 = sseManager.createStream(taskId);
    const reader1 = stream1.getReader();

    // Push a message while stream1 is active
    const msg = makeMsg(taskId, 7);
    sseManager.pushMessage(taskId, msg);

    // Drain the message from reader1
    await reader1.read();
    await reader1.cancel();

    // Create a new stream — should replay history
    const stream2 = sseManager.createStream(taskId);
    const reader2 = stream2.getReader();

    const { value, done } = await reader2.read();
    expect(done).toBe(false);
    expect(new TextDecoder().decode(value)).toContain('"status":"s7"');

    reader2.releaseLock();
    sseManager.closeStream(taskId);
  });

  it("cancel stream that was never started (edge case via closeStream) → no crash", () => {
    const taskId = "multi-never-started";
    // closeStream on a taskId with no connections should not throw
    expect(() => sseManager.closeStream(taskId)).not.toThrow();
  });

  it("push message to taskId with no connections → no crash, message stored in history", () => {
    const taskId = "multi-push-no-conn";
    const msg = makeMsg(taskId, 1);

    expect(() => sseManager.pushMessage(taskId, msg)).not.toThrow();

    // Verify history is stored by creating a stream and getting replay
    const stream = sseManager.createStream(taskId);
    const reader = stream.getReader();

    // The replayed message should be readable
    reader.read().then(({ value, done }) => {
      expect(done).toBe(false);
      expect(new TextDecoder().decode(value)).toContain('"status":"s1"');
    });

    reader.releaseLock();
    sseManager.closeStream(taskId);
  });

  it("push message after all connections cancelled → message stored in history for future replay", async () => {
    const taskId = "multi-push-after-cancel";

    const stream1 = sseManager.createStream(taskId);
    const reader1 = stream1.getReader();
    await reader1.cancel();

    // Push after all connections are gone
    const msg = makeMsg(taskId, 55);
    sseManager.pushMessage(taskId, msg);

    // New stream should replay
    const stream2 = sseManager.createStream(taskId);
    const reader2 = stream2.getReader();

    const { value, done } = await reader2.read();
    expect(done).toBe(false);
    expect(new TextDecoder().decode(value)).toContain('"status":"s55"');

    reader2.releaseLock();
    sseManager.closeStream(taskId);
  });
});

// ---------------------------------------------------------------------------
// Connection limits
// ---------------------------------------------------------------------------
describe("SSEManager adversarial — Connection limits", () => {
  let sseManager: Awaited<ReturnType<typeof freshManager>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAll.mockReturnValue([]);
    mockGet.mockReturnValue(undefined);
    sseManager = await freshManager();
  });

  it("create MAX_CONNECTIONS_PER_TASK (10) streams → all work", () => {
    const taskId = "limit-max-ok";

    const streams: ReadableStream<Uint8Array>[] = [];
    for (let i = 0; i < 10; i++) {
      streams.push(sseManager.createStream(taskId));
    }

    // Push a message — should not throw
    const msg = makeMsg(taskId, 1);
    expect(() => sseManager.pushMessage(taskId, msg)).not.toThrow();

    sseManager.closeStream(taskId);
  });

  it("create 11th stream → throws error", () => {
    const taskId = "limit-overflow";

    for (let i = 0; i < 10; i++) {
      sseManager.createStream(taskId);
    }

    expect(() => sseManager.createStream(taskId)).toThrow(/Too many connections/);

    sseManager.closeStream(taskId);
  });

  it("cancel one then create new → succeeds (back under limit)", async () => {
    const taskId = "limit-cancel-reuse";

    const streams: ReadableStream<Uint8Array>[] = [];
    for (let i = 0; i < 10; i++) {
      streams.push(sseManager.createStream(taskId));
    }

    // Cancel one to free a slot
    const reader = streams[0]!.getReader();
    await reader.cancel();

    // Trigger cleanup so removeClosedConnections runs
    sseManager.pushMessage(taskId, makeMsg(taskId, 1));

    // Should succeed now
    expect(() => sseManager.createStream(taskId)).not.toThrow();

    // But one more should fail (back to 10)
    expect(() => sseManager.createStream(taskId)).toThrow(/Too many connections/);

    sseManager.closeStream(taskId);
  });

  it("close stream via closeStream() then create new → succeeds", () => {
    const taskId = "limit-close-reopen";

    for (let i = 0; i < 10; i++) {
      sseManager.createStream(taskId);
    }

    // closeStream removes all connections
    sseManager.closeStream(taskId);

    // Now we can create new streams again
    expect(() => sseManager.createStream(taskId)).not.toThrow();

    sseManager.closeStream(taskId);
  });
});

// ---------------------------------------------------------------------------
// History management
// ---------------------------------------------------------------------------
describe("SSEManager adversarial — History management", () => {
  let sseManager: Awaited<ReturnType<typeof freshManager>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAll.mockReturnValue([]);
    mockGet.mockReturnValue(undefined);
    sseManager = await freshManager();
  });

  it("push MAX_HISTORY (500) + 1 messages → history trimmed to 500", () => {
    const taskId = "history-trim";

    for (let i = 0; i < 501; i++) {
      sseManager.pushMessage(taskId, makeMsg(taskId, i));
    }

    // Create a stream to count replayed messages
    let replayCount = 0;
    const originalEnqueue = ReadableStreamDefaultController.prototype.enqueue;

    const stream = sseManager.createStream(taskId);
    const reader = stream.getReader();

    // Read all replayed messages by checking how many are enqueued
    // The first replayed message should be index 1 (index 0 was trimmed)
    reader.read().then(({ value }) => {
      const text = new TextDecoder().decode(value);
      // The first message after trim should be s1, not s0
      expect(text).toContain('"status":"s1"');
    });

    reader.releaseLock();
    sseManager.closeStream(taskId);
  });

  it("push to empty history → history created", () => {
    const taskId = "history-create-empty";

    // No prior history exists
    const msg = makeMsg(taskId, 42);
    sseManager.pushMessage(taskId, msg);

    // Verify by creating a stream that replays it
    const stream = sseManager.createStream(taskId);
    const reader = stream.getReader();

    reader.read().then(({ value }) => {
      expect(new TextDecoder().decode(value)).toContain('"status":"s42"');
    });

    reader.releaseLock();
    sseManager.closeStream(taskId);
  });

  it("closeStream then wait (simulated) → history eventually cleaned", () => {
    vi.useFakeTimers();

    const taskId = "history-cleanup-timer";

    // Must create a stream so closeStream doesn't early-return (it checks connections)
    const stream = sseManager.createStream(taskId);
    sseManager.pushMessage(taskId, makeMsg(taskId, 1));

    // Close triggers a 5-minute cleanup timer
    sseManager.closeStream(taskId);

    // Before timer fires, in-memory history still exists
    expect(sseManager.hasHistory(taskId)).toBe(true);

    // Advance past the 5-minute cleanup window
    vi.advanceTimersByTime(5 * 60 * 1000 + 100);

    // After cleanup, in-memory history should be gone
    // hasHistory falls back to DB — mock returns undefined so it should be false
    mockGet.mockReturnValue(undefined);
    expect(sseManager.hasHistory(taskId)).toBe(false);

    vi.useRealTimers();
  });

  it("multiple rapid pushes → all stored and broadcast", async () => {
    const taskId = "history-rapid-push";

    const stream = sseManager.createStream(taskId);
    const reader = stream.getReader();

    // Push 5 messages rapidly
    for (let i = 0; i < 5; i++) {
      sseManager.pushMessage(taskId, makeMsg(taskId, i));
    }

    // Read all 5 messages
    for (let i = 0; i < 5; i++) {
      const { value, done } = await reader.read();
      expect(done).toBe(false);
      expect(new TextDecoder().decode(value)).toContain(`"status":"s${i}"`);
    }

    reader.releaseLock();
    sseManager.closeStream(taskId);
  });
});

// ---------------------------------------------------------------------------
// Message broadcasting
// ---------------------------------------------------------------------------
describe("SSEManager adversarial — Message broadcasting", () => {
  let sseManager: Awaited<ReturnType<typeof freshManager>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAll.mockReturnValue([]);
    mockGet.mockReturnValue(undefined);
    sseManager = await freshManager();
  });

  it("push message → all active connections receive it", async () => {
    const taskId = "broadcast-all";

    const stream1 = sseManager.createStream(taskId);
    const stream2 = sseManager.createStream(taskId);
    const stream3 = sseManager.createStream(taskId);

    const reader1 = stream1.getReader();
    const reader2 = stream2.getReader();
    const reader3 = stream3.getReader();

    const msg = makeMsg(taskId, 10);
    sseManager.pushMessage(taskId, msg);

    for (const reader of [reader1, reader2, reader3]) {
      const { value, done } = await reader.read();
      expect(done).toBe(false);
      expect(new TextDecoder().decode(value)).toContain('"status":"s10"');
    }

    reader1.releaseLock();
    reader2.releaseLock();
    reader3.releaseLock();
    sseManager.closeStream(taskId);
  });

  it("push message with one closed connection → closed one skipped, active ones receive", async () => {
    const taskId = "broadcast-skip-closed";

    const stream1 = sseManager.createStream(taskId);
    const stream2 = sseManager.createStream(taskId);

    const reader1 = stream1.getReader();
    const reader2 = stream2.getReader();

    // Close stream1
    await reader1.cancel();

    // Push message — only stream2 should get it
    const msg = makeMsg(taskId, 20);
    sseManager.pushMessage(taskId, msg);

    const { value, done } = await reader2.read();
    expect(done).toBe(false);
    expect(new TextDecoder().decode(value)).toContain('"status":"s20"');

    reader2.releaseLock();
    sseManager.closeStream(taskId);
  });

  it("push different message types → all broadcast correctly", async () => {
    const taskId = "broadcast-types";

    const stream = sseManager.createStream(taskId);
    const reader = stream.getReader();

    const types = ["agent_text", "agent_tool_use", "agent_thinking", "status"] as const;

    for (const type of types) {
      const msg: SSEMessage = {
        type,
        taskId,
        timestamp: new Date().toISOString(),
        data: { content: `payload-${type}` },
      };
      sseManager.pushMessage(taskId, msg);
    }

    for (const type of types) {
      const { value, done } = await reader.read();
      expect(done).toBe(false);
      const text = new TextDecoder().decode(value);
      expect(text).toContain(`"type":"${type}"`);
      expect(text).toContain(`"content":"payload-${type}"`);
    }

    reader.releaseLock();
    sseManager.closeStream(taskId);
  });
});

// ---------------------------------------------------------------------------
// Listener API
// ---------------------------------------------------------------------------
describe("SSEManager adversarial — Listener API", () => {
  let sseManager: Awaited<ReturnType<typeof freshManager>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAll.mockReturnValue([]);
    mockGet.mockReturnValue(undefined);
    sseManager = await freshManager();
  });

  it("addListener → listener called on pushMessage", () => {
    const taskId = "listener-basic";
    const listener = vi.fn();

    sseManager.addListener(taskId, listener);

    const msg = makeMsg(taskId, 1);
    sseManager.pushMessage(taskId, msg);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(msg);
  });

  it("addListener then remove → listener not called after removal", () => {
    const taskId = "listener-remove";
    const listener = vi.fn();

    const remove = sseManager.addListener(taskId, listener);

    // First push — should call listener
    sseManager.pushMessage(taskId, makeMsg(taskId, 1));
    expect(listener).toHaveBeenCalledOnce();

    // Remove listener
    remove();

    // Second push — should NOT call listener
    sseManager.pushMessage(taskId, makeMsg(taskId, 2));
    expect(listener).toHaveBeenCalledOnce(); // still 1
  });

  it("multiple listeners → all called", () => {
    const taskId = "listener-multiple";
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    const listener3 = vi.fn();

    sseManager.addListener(taskId, listener1);
    sseManager.addListener(taskId, listener2);
    sseManager.addListener(taskId, listener3);

    const msg = makeMsg(taskId, 5);
    sseManager.pushMessage(taskId, msg);

    expect(listener1).toHaveBeenCalledWith(msg);
    expect(listener2).toHaveBeenCalledWith(msg);
    expect(listener3).toHaveBeenCalledWith(msg);
  });

  it("listener throws → other listeners and connections not affected", async () => {
    const taskId = "listener-throws";

    const badListener = vi.fn(() => { throw new Error("listener boom"); });
    const goodListener = vi.fn();

    sseManager.addListener(taskId, badListener);
    sseManager.addListener(taskId, goodListener);

    const stream = sseManager.createStream(taskId);
    const reader = stream.getReader();

    const msg = makeMsg(taskId, 3);
    // Should not throw despite bad listener
    expect(() => sseManager.pushMessage(taskId, msg)).not.toThrow();

    // Good listener still called
    expect(goodListener).toHaveBeenCalledWith(msg);

    // Connection still receives the message
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(new TextDecoder().decode(value)).toContain('"status":"s3"');

    reader.releaseLock();
    sseManager.closeStream(taskId);
  });

  it("addListener for taskId with no connections → still works", () => {
    const taskId = "listener-no-connections";
    const listener = vi.fn();

    sseManager.addListener(taskId, listener);

    const msg = makeMsg(taskId, 1);
    sseManager.pushMessage(taskId, msg);

    expect(listener).toHaveBeenCalledWith(msg);
  });
});

// ---------------------------------------------------------------------------
// hasHistory
// ---------------------------------------------------------------------------
describe("SSEManager adversarial — hasHistory", () => {
  let sseManager: Awaited<ReturnType<typeof freshManager>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAll.mockReturnValue([]);
    mockGet.mockReturnValue(undefined);
    sseManager = await freshManager();
  });

  it("has in-memory history → returns true", () => {
    const taskId = "hashistory-memory";

    sseManager.pushMessage(taskId, makeMsg(taskId, 1));

    expect(sseManager.hasHistory(taskId)).toBe(true);
  });

  it("no memory history but has DB rows → returns true", () => {
    const taskId = "hashistory-db-only";

    // No pushMessage — no in-memory history
    // Mock DB to return a row
    mockGet.mockReturnValueOnce({ 1: 1 });

    expect(sseManager.hasHistory(taskId)).toBe(true);
    expect(mockPrepare).toHaveBeenCalledWith(
      "SELECT 1 FROM sse_messages WHERE task_id = ? LIMIT 1"
    );
  });

  it("no memory history and no DB rows → returns false", () => {
    const taskId = "hashistory-none";

    mockGet.mockReturnValueOnce(undefined);

    expect(sseManager.hasHistory(taskId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DB persistence
// ---------------------------------------------------------------------------
describe("SSEManager adversarial — DB persistence", () => {
  let sseManager: Awaited<ReturnType<typeof freshManager>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAll.mockReturnValue([]);
    mockGet.mockReturnValue(undefined);
    sseManager = await freshManager();
  });

  it("pushMessage stores to DB (verify insert called)", () => {
    const taskId = "db-insert";

    const msg = makeMsg(taskId, 1);
    sseManager.pushMessage(taskId, msg);

    expect(mockRun).toHaveBeenCalledWith(
      taskId,
      "status",
      msg.timestamp,
      JSON.stringify(msg.data)
    );
  });

  it("DB insert failure doesn't break SSE delivery", async () => {
    const taskId = "db-failure";

    // Make DB insert throw
    mockRun.mockImplementationOnce(() => { throw new Error("DB write failed"); });

    const stream = sseManager.createStream(taskId);
    const reader = stream.getReader();

    const msg = makeMsg(taskId, 1);
    // Should not throw
    expect(() => sseManager.pushMessage(taskId, msg)).not.toThrow();

    // Connection should still receive the message
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(new TextDecoder().decode(value)).toContain('"status":"s1"');

    reader.releaseLock();
    sseManager.closeStream(taskId);
  });

  it("loadFromDb on reconnect → history replayed", async () => {
    const taskId = "db-reconnect-replay";

    // Simulate DB returning stored messages in DESC order (as the SQL query does)
    // loadFromDb reverses them to get chronological order
    const dbRows = [
      { type: "agent_text", timestamp: new Date(2).toISOString(), data: JSON.stringify({ text: "from-db-2" }) },
      { type: "status", timestamp: new Date(1).toISOString(), data: JSON.stringify({ status: "from-db-1" }) },
    ];
    mockAll.mockReturnValueOnce(dbRows);

    // Create a stream — since no in-memory history, it should load from DB
    const stream = sseManager.createStream(taskId);
    const reader = stream.getReader();

    // Should replay the 2 DB messages in chronological order (after reverse)
    const { value: v1 } = await reader.read();
    expect(new TextDecoder().decode(v1)).toContain('"status":"from-db-1"');

    const { value: v2 } = await reader.read();
    expect(new TextDecoder().decode(v2)).toContain('"text":"from-db-2"');

    reader.releaseLock();
    sseManager.closeStream(taskId);
  });
});
