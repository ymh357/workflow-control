import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SSEMessage } from "../types/index.js";

// --- DB mocks (same pattern as existing adversarial tests) ---
const mockRun = vi.fn();
const mockAll = vi.fn(() => []);
const mockGet = vi.fn(() => undefined);
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

// ---------------------------------------------------------------------------
// Concurrent streams and cancel isolation
// ---------------------------------------------------------------------------
describe("SSEManager new-adversarial — concurrent streams and cancel isolation", () => {
  let mgr: Awaited<ReturnType<typeof freshManager>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAll.mockReturnValue([]);
    mockGet.mockReturnValue(undefined);
    mgr = await freshManager();
  });

  it("cancel one of three streams, push message — surviving two both receive it", async () => {
    const taskId = "conc-cancel-one";

    const s1 = mgr.createStream(taskId);
    const s2 = mgr.createStream(taskId);
    const s3 = mgr.createStream(taskId);

    const r1 = s1.getReader();
    const r2 = s2.getReader();
    const r3 = s3.getReader();

    // Cancel the second stream
    await r2.cancel();

    const msg = makeMsg(taskId, 77);
    mgr.pushMessage(taskId, msg);

    // r1 and r3 should both get the message
    const { value: v1 } = await r1.read();
    expect(new TextDecoder().decode(v1)).toContain('"status":"s77"');

    const { value: v3 } = await r3.read();
    expect(new TextDecoder().decode(v3)).toContain('"status":"s77"');

    r1.releaseLock();
    r3.releaseLock();
    mgr.closeStream(taskId);
  });

  it("cancel a stream then push — no crash and other streams get the message", async () => {
    const taskId = "conc-cancel-push-safe";

    const s1 = mgr.createStream(taskId);
    const s2 = mgr.createStream(taskId);
    const r1 = s1.getReader();
    const r2 = s2.getReader();

    await r1.cancel();

    // pushMessage after cancel should not throw
    expect(() => mgr.pushMessage(taskId, makeMsg(taskId, 1))).not.toThrow();

    const { value } = await r2.read();
    expect(new TextDecoder().decode(value)).toContain('"status":"s1"');

    r2.releaseLock();
    mgr.closeStream(taskId);
  });

  it("create stream, push, close stream, create new stream — history replayed", async () => {
    const taskId = "conc-reopen-history";

    const s1 = mgr.createStream(taskId);
    const r1 = s1.getReader();

    mgr.pushMessage(taskId, makeMsg(taskId, 10));
    mgr.pushMessage(taskId, makeMsg(taskId, 20));

    // Drain from r1
    await r1.read();
    await r1.read();
    r1.releaseLock();

    // Close the stream (sets cleanup timer, but history still in memory)
    mgr.closeStream(taskId);

    // Create a brand new stream — should get history replay
    const s2 = mgr.createStream(taskId);
    const r2 = s2.getReader();

    const { value: v1 } = await r2.read();
    expect(new TextDecoder().decode(v1)).toContain('"status":"s10"');

    const { value: v2 } = await r2.read();
    expect(new TextDecoder().decode(v2)).toContain('"status":"s20"');

    r2.releaseLock();
    mgr.closeStream(taskId);
  });

  it("rapid create/cancel/create cycle does not corrupt state", async () => {
    const taskId = "conc-rapid-cycle";

    for (let i = 0; i < 20; i++) {
      const s = mgr.createStream(taskId);
      const r = s.getReader();
      await r.cancel();
    }

    // After all cancels, should be able to create a fresh stream and use it
    const s = mgr.createStream(taskId);
    const r = s.getReader();

    mgr.pushMessage(taskId, makeMsg(taskId, 999));

    const { value, done } = await r.read();
    expect(done).toBe(false);
    expect(new TextDecoder().decode(value)).toContain('"status":"s999"');

    r.releaseLock();
    mgr.closeStream(taskId);
  });
});

// ---------------------------------------------------------------------------
// Push edge cases
// ---------------------------------------------------------------------------
describe("SSEManager new-adversarial — push edge cases", () => {
  let mgr: Awaited<ReturnType<typeof freshManager>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAll.mockReturnValue([]);
    mockGet.mockReturnValue(undefined);
    mgr = await freshManager();
  });

  it("push message to taskId with no active streams — stored in history only", () => {
    const taskId = "push-no-streams";

    // No createStream called at all
    expect(() => mgr.pushMessage(taskId, makeMsg(taskId, 1))).not.toThrow();

    // Verify DB insert was still called
    expect(mockRun).toHaveBeenCalledTimes(1);

    // Create a stream now and verify history replay
    const s = mgr.createStream(taskId);
    const r = s.getReader();

    r.read().then(({ value }) => {
      expect(new TextDecoder().decode(value!)).toContain('"status":"s1"');
    });

    r.releaseLock();
    mgr.closeStream(taskId);
  });

  it("push message with very large data payload — no crash", async () => {
    const taskId = "push-large-payload";

    const largeData = { blob: "X".repeat(100_000) };
    const msg: SSEMessage = {
      type: "agent_text",
      taskId,
      timestamp: new Date().toISOString(),
      data: largeData,
    };

    const s = mgr.createStream(taskId);
    const r = s.getReader();

    expect(() => mgr.pushMessage(taskId, msg)).not.toThrow();

    const { value } = await r.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("X".repeat(100));
    // Verify it's valid SSE format
    expect(text.startsWith("data: ")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(true);

    r.releaseLock();
    mgr.closeStream(taskId);
  });
});

// ---------------------------------------------------------------------------
// MAX_CONNECTIONS_PER_TASK limit
// ---------------------------------------------------------------------------
describe("SSEManager new-adversarial — MAX_CONNECTIONS_PER_TASK boundary", () => {
  let mgr: Awaited<ReturnType<typeof freshManager>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAll.mockReturnValue([]);
    mockGet.mockReturnValue(undefined);
    mgr = await freshManager();
  });

  it("exactly 10 streams succeeds, 11th throws with descriptive error", () => {
    const taskId = "limit-exact-10";

    for (let i = 0; i < 10; i++) {
      expect(() => mgr.createStream(taskId)).not.toThrow();
    }

    expect(() => mgr.createStream(taskId)).toThrow(
      /Too many connections for task limit-exact-10 \(limit: 10\)/,
    );

    mgr.closeStream(taskId);
  });

  it("different taskIds have independent connection limits", () => {
    const taskA = "limit-taskA";
    const taskB = "limit-taskB";

    // Fill taskA to the limit
    for (let i = 0; i < 10; i++) {
      mgr.createStream(taskA);
    }

    // taskB should still allow connections
    expect(() => mgr.createStream(taskB)).not.toThrow();

    // taskA should still be blocked
    expect(() => mgr.createStream(taskA)).toThrow(/Too many connections/);

    mgr.closeStream(taskA);
    mgr.closeStream(taskB);
  });
});

// ---------------------------------------------------------------------------
// closeStream cleanup timer behavior
// ---------------------------------------------------------------------------
describe("SSEManager new-adversarial — closeStream cleanup timer", () => {
  let mgr: Awaited<ReturnType<typeof freshManager>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAll.mockReturnValue([]);
    mockGet.mockReturnValue(undefined);
    mgr = await freshManager();
  });

  it("closeStream sets timer; reconnecting before timer fires preserves history", () => {
    vi.useFakeTimers();

    const taskId = "cleanup-reconnect";

    const s1 = mgr.createStream(taskId);
    mgr.pushMessage(taskId, makeMsg(taskId, 42));

    mgr.closeStream(taskId);

    // Reconnect before the 5-minute cleanup fires
    vi.advanceTimersByTime(2 * 60 * 1000); // 2 minutes

    const s2 = mgr.createStream(taskId);
    const r2 = s2.getReader();

    // History should still be there
    r2.read().then(({ value }) => {
      expect(new TextDecoder().decode(value!)).toContain('"status":"s42"');
    });

    // Now advance past the cleanup timer (total 5min+)
    vi.advanceTimersByTime(4 * 60 * 1000);

    // Since there's an active connection, cleanup should skip memory purge
    expect(mgr.hasHistory(taskId)).toBe(true);

    r2.releaseLock();
    mgr.closeStream(taskId);
    vi.useRealTimers();
  });

  it("double closeStream deduplicates cleanup timer without crash", () => {
    vi.useFakeTimers();

    const taskId = "cleanup-double-close";

    mgr.createStream(taskId);
    mgr.pushMessage(taskId, makeMsg(taskId, 1));

    // Close twice in a row
    expect(() => mgr.closeStream(taskId)).not.toThrow();
    expect(() => mgr.closeStream(taskId)).not.toThrow();

    // After 5 min, history should be cleaned
    vi.advanceTimersByTime(5 * 60 * 1000 + 100);
    mockGet.mockReturnValue(undefined);
    expect(mgr.hasHistory(taskId)).toBe(false);

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Listener edge cases
// ---------------------------------------------------------------------------
describe("SSEManager new-adversarial — listener edge cases", () => {
  let mgr: Awaited<ReturnType<typeof freshManager>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAll.mockReturnValue([]);
    mockGet.mockReturnValue(undefined);
    mgr = await freshManager();
  });

  it("listener that throws does not prevent message delivery to connections", async () => {
    const taskId = "listener-throw-safe";

    const throwingFn = vi.fn(() => {
      throw new Error("listener exploded");
    });
    const goodFn = vi.fn();

    mgr.addListener(taskId, throwingFn);
    mgr.addListener(taskId, goodFn);

    const s = mgr.createStream(taskId);
    const r = s.getReader();

    const msg = makeMsg(taskId, 5);
    expect(() => mgr.pushMessage(taskId, msg)).not.toThrow();

    // Both listeners were invoked
    expect(throwingFn).toHaveBeenCalledOnce();
    expect(goodFn).toHaveBeenCalledOnce();

    // Connection still got the message
    const { value } = await r.read();
    expect(new TextDecoder().decode(value)).toContain('"status":"s5"');

    r.releaseLock();
    mgr.closeStream(taskId);
  });

  it("removing a listener inside a callback does not break iteration", () => {
    const taskId = "listener-remove-during";

    const results: number[] = [];
    let removeSelf: (() => void) | undefined;

    const selfRemover = vi.fn(() => {
      results.push(1);
      if (removeSelf) removeSelf();
    });
    const stable = vi.fn(() => {
      results.push(2);
    });

    removeSelf = mgr.addListener(taskId, selfRemover);
    mgr.addListener(taskId, stable);

    // First push: both should fire. selfRemover removes itself.
    expect(() => mgr.pushMessage(taskId, makeMsg(taskId, 1))).not.toThrow();
    expect(selfRemover).toHaveBeenCalledOnce();
    expect(stable).toHaveBeenCalledOnce();

    // Second push: only stable should fire (selfRemover was removed)
    mgr.pushMessage(taskId, makeMsg(taskId, 2));
    expect(selfRemover).toHaveBeenCalledOnce(); // still 1
    expect(stable).toHaveBeenCalledTimes(2);
  });
});
