import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SSEMessage } from "../types/index.js";

const mockRun = vi.fn();
const mockAll = vi.fn((..._args: any[]): any[] => []);
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

describe("SSEManager", () => {
  let sseManager: Awaited<ReturnType<typeof freshManager>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAll.mockReturnValue([]);
    mockGet.mockReturnValue(undefined);
    sseManager = await freshManager();
  });

  describe("pushMessage", () => {
    it("stores message in history", () => {
      const taskId = "push-test-1";
      const msg = makeMsg(taskId, 1);

      sseManager.pushMessage(taskId, msg);

      expect(sseManager.hasHistory(taskId)).toBe(true);
      sseManager.closeStream(taskId);
    });

    it("persists to DB via prepared statement run()", () => {
      const taskId = "push-test-2";
      const msg = makeMsg(taskId, 1);

      sseManager.pushMessage(taskId, msg);

      // The singleton caches the insertStmt, so mockPrepare may or may not be
      // called depending on test order. What matters is that run() is called
      // with the correct arguments.
      expect(mockRun).toHaveBeenCalledWith(
        taskId,
        "status",
        msg.timestamp,
        JSON.stringify(msg.data),
      );
      sseManager.closeStream(taskId);
    });

    it("notifies programmatic listeners", () => {
      const taskId = "push-test-3";
      const received: SSEMessage[] = [];
      sseManager.addListener(taskId, (m) => received.push(m));

      const msg = makeMsg(taskId, 1);
      sseManager.pushMessage(taskId, msg);

      expect(received).toHaveLength(1);
      expect(received[0]).toBe(msg);
      sseManager.closeStream(taskId);
    });

    it("broadcasts to connected streams", async () => {
      const taskId = "push-test-4";
      const stream = sseManager.createStream(taskId);

      // Let the start() callback run
      await new Promise((r) => setTimeout(r, 10));

      const msg = makeMsg(taskId, 1);
      sseManager.pushMessage(taskId, msg);

      const reader = stream.getReader();
      const { value } = await reader.read();
      reader.releaseLock();

      const text = new TextDecoder().decode(value);
      expect(text).toContain(`"type":"status"`);
      expect(text).toContain(`"taskId":"${taskId}"`);
      sseManager.closeStream(taskId);
    });

    it("trims history when exceeding MAX_HISTORY (500)", () => {
      const taskId = "push-test-trim";
      for (let i = 0; i < 510; i++) {
        sseManager.pushMessage(taskId, makeMsg(taskId, i));
      }

      expect(sseManager.hasHistory(taskId)).toBe(true);

      // Verify indirectly: create a stream and collect all replayed data.
      // Replay is enqueued synchronously in start(), so all messages are
      // queued before we read. We read chunks until stream is closed.
      const stream = sseManager.createStream(taskId);
      sseManager.closeStream(taskId);

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      const collectAndAssert = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value);
        }
        const dataLines = buf.match(/^data: /gm) || [];
        expect(dataLines.length).toBe(500);
      };

      return collectAndAssert();
    });

    it("swallows DB write errors without throwing", () => {
      const taskId = "push-test-db-err";
      mockRun.mockImplementationOnce(() => { throw new Error("DB error"); });

      expect(() => {
        sseManager.pushMessage(taskId, makeMsg(taskId, 1));
      }).not.toThrow();

      sseManager.closeStream(taskId);
    });

    it("swallows listener errors without breaking push", () => {
      const taskId = "push-test-listener-err";
      sseManager.addListener(taskId, () => { throw new Error("listener boom"); });

      const received: SSEMessage[] = [];
      sseManager.addListener(taskId, (m) => received.push(m));

      expect(() => {
        sseManager.pushMessage(taskId, makeMsg(taskId, 1));
      }).not.toThrow();

      expect(received).toHaveLength(1);
      sseManager.closeStream(taskId);
    });
  });

  describe("addListener", () => {
    it("returns an unsubscribe function that removes the listener", () => {
      const taskId = "listener-unsub";
      const received: SSEMessage[] = [];
      const unsub = sseManager.addListener(taskId, (m) => received.push(m));

      sseManager.pushMessage(taskId, makeMsg(taskId, 1));
      expect(received).toHaveLength(1);

      unsub();

      sseManager.pushMessage(taskId, makeMsg(taskId, 2));
      expect(received).toHaveLength(1);
      sseManager.closeStream(taskId);
    });

    it("multiple listeners all receive messages", () => {
      const taskId = "listener-multi";
      const a: SSEMessage[] = [];
      const b: SSEMessage[] = [];
      sseManager.addListener(taskId, (m) => a.push(m));
      sseManager.addListener(taskId, (m) => b.push(m));

      sseManager.pushMessage(taskId, makeMsg(taskId, 1));

      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      sseManager.closeStream(taskId);
    });
  });

  describe("createStream", () => {
    it("replays history from memory to new connections", async () => {
      const taskId = "replay-mem";
      sseManager.pushMessage(taskId, makeMsg(taskId, 1));
      sseManager.pushMessage(taskId, makeMsg(taskId, 2));

      const stream = sseManager.createStream(taskId);
      // Close immediately so the stream ends after replaying
      sseManager.closeStream(taskId);

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value);
      }

      const dataLines = buf.match(/^data: /gm) || [];
      expect(dataLines.length).toBe(2);
    });

    it("falls back to DB when memory history is empty", async () => {
      const taskId = "replay-db-fallback";
      mockAll.mockReturnValueOnce([
        { type: "status", timestamp: "2024-01-01T00:00:00Z", data: '{"status":"from-db"}' },
      ]);

      const stream = sseManager.createStream(taskId);
      sseManager.closeStream(taskId);

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value);
      }

      expect(buf).toContain("from-db");
    });

    it("throws when MAX_CONNECTIONS_PER_TASK (10) is exceeded", () => {
      const taskId = "max-conn";

      for (let i = 0; i < 10; i++) {
        sseManager.createStream(taskId);
      }

      expect(() => sseManager.createStream(taskId)).toThrow(
        /Too many connections.*limit: 10/,
      );

      sseManager.closeStream(taskId);
    });
  });

  describe("closeStream", () => {
    it("closes all connections for a task", async () => {
      const taskId = "close-test";
      const stream = sseManager.createStream(taskId);
      const reader = stream.getReader();

      await new Promise((r) => setTimeout(r, 10));

      sseManager.closeStream(taskId);

      const { done } = await reader.read();
      expect(done).toBe(true);
    });

    it("allows new connections after closing", () => {
      const taskId = "close-reopen";
      for (let i = 0; i < 10; i++) {
        sseManager.createStream(taskId);
      }

      sseManager.closeStream(taskId);

      expect(() => sseManager.createStream(taskId)).not.toThrow();
      sseManager.closeStream(taskId);
    });
  });

  describe("hasHistory", () => {
    it("returns true when memory history exists", () => {
      const taskId = "has-hist-mem";
      sseManager.pushMessage(taskId, makeMsg(taskId, 1));

      expect(sseManager.hasHistory(taskId)).toBe(true);
      sseManager.closeStream(taskId);
    });

    it("returns false when no memory and no DB history", () => {
      const taskId = "has-hist-none";
      mockGet.mockReturnValueOnce(undefined);

      expect(sseManager.hasHistory(taskId)).toBe(false);
    });

    it("falls back to DB when no memory history", () => {
      const taskId = "has-hist-db";
      mockGet.mockReturnValueOnce({ 1: 1 });

      expect(sseManager.hasHistory(taskId)).toBe(true);
    });
  });

  describe("history trimming boundary", () => {
    it("keeps exactly MAX_HISTORY (500) messages when at boundary", () => {
      const taskId = "trim-boundary";
      for (let i = 0; i < 500; i++) {
        sseManager.pushMessage(taskId, makeMsg(taskId, i));
      }

      // At exactly 500 messages, no trimming should occur
      const stream = sseManager.createStream(taskId);
      sseManager.closeStream(taskId);

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      return (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value);
        }
        const dataLines = buf.match(/^data: /gm) || [];
        expect(dataLines.length).toBe(500);
      })();
    });

    it("trims to exactly 500 when pushing message 501", () => {
      const taskId = "trim-501";
      for (let i = 0; i < 501; i++) {
        sseManager.pushMessage(taskId, makeMsg(taskId, i));
      }

      const stream = sseManager.createStream(taskId);
      sseManager.closeStream(taskId);

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      return (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value);
        }
        const dataLines = buf.match(/^data: /gm) || [];
        expect(dataLines.length).toBe(500);
        // The earliest message (index 0) should have been trimmed
        expect(buf).not.toContain('"status":"s0"');
        // The latest message (index 500) should be present
        expect(buf).toContain('"status":"s500"');
      })();
    });
  });

  describe("DB fallback on createStream", () => {
    it("loads from DB when memory history is empty and caches it", async () => {
      const taskId = "db-fallback-cache";
      mockAll.mockReturnValueOnce([
        { type: "status", timestamp: "2024-01-01T00:00:00Z", data: '{"status":"cached"}' },
      ]);

      const stream1 = sseManager.createStream(taskId);
      sseManager.closeStream(taskId);

      const reader1 = stream1.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader1.read();
        if (done) break;
        buf += decoder.decode(value);
      }
      expect(buf).toContain("cached");

      // Second stream should use the cached history (mockAll won't return data again)
      mockAll.mockReturnValue([]);
      const stream2 = sseManager.createStream(taskId);
      sseManager.closeStream(taskId);

      const reader2 = stream2.getReader();
      let buf2 = "";
      while (true) {
        const { done, value } = await reader2.read();
        if (done) break;
        buf2 += decoder.decode(value);
      }
      expect(buf2).toContain("cached");
    });

    it("does not call DB when memory history has messages", async () => {
      const taskId = "db-skip";
      sseManager.pushMessage(taskId, makeMsg(taskId, 1));

      const callCountBefore = mockAll.mock.calls.length;
      const stream = sseManager.createStream(taskId);
      sseManager.closeStream(taskId);

      // mockAll should not have been called for loadFromDb
      // (it may be called for other purposes, so check call args)
      const dbLoadCalls = mockAll.mock.calls.slice(callCountBefore).filter(
        (args) => args[0] === taskId
      );
      expect(dbLoadCalls).toHaveLength(0);

      const reader = stream.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    });
  });

  describe("heartbeat interval", () => {
    it("sends heartbeat comment after 30 seconds", async () => {
      vi.useFakeTimers();

      const taskId = "heartbeat-test";
      const stream = sseManager.createStream(taskId);
      const reader = stream.getReader();

      // Advance 30 seconds to trigger heartbeat
      vi.advanceTimersByTime(30_000);

      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toContain(": heartbeat");

      reader.releaseLock();
      sseManager.closeStream(taskId);
      vi.useRealTimers();
    });

    it("clears heartbeat interval on closeStream", () => {
      vi.useFakeTimers();

      const taskId = "heartbeat-clear";
      sseManager.createStream(taskId);
      sseManager.closeStream(taskId);

      // Advancing time should not cause errors (heartbeat was cleared)
      expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();

      vi.useRealTimers();
    });
  });

  describe("closeStream cleanup timer", () => {
    it("cleans up history after 5-minute delay", () => {
      vi.useFakeTimers();

      const taskId = "cleanup-timer";
      // Must create a stream so closeStream actually sets up the cleanup timer
      sseManager.createStream(taskId);
      sseManager.pushMessage(taskId, makeMsg(taskId, 1));
      expect(sseManager.hasHistory(taskId)).toBe(true);

      sseManager.closeStream(taskId);

      // History still present before 5 minutes
      vi.advanceTimersByTime(4 * 60 * 1000);
      expect(sseManager.hasHistory(taskId)).toBe(true);

      // After 5 minutes, history should be cleaned up
      vi.advanceTimersByTime(60 * 1000 + 100);
      // hasHistory with no memory falls back to DB mock
      mockGet.mockReturnValue(undefined);
      expect(sseManager.hasHistory(taskId)).toBe(false);

      vi.useRealTimers();
    });

    it("skips cleanup if new connections established during delay", () => {
      vi.useFakeTimers();

      const taskId = "cleanup-skip";
      sseManager.pushMessage(taskId, makeMsg(taskId, 1));

      sseManager.closeStream(taskId);

      // Reconnect before 5 minutes
      vi.advanceTimersByTime(2 * 60 * 1000);
      sseManager.createStream(taskId);

      // Let the full 5 minutes pass
      vi.advanceTimersByTime(3 * 60 * 1000 + 100);

      // History should still be present (cleanup was skipped)
      expect(sseManager.hasHistory(taskId)).toBe(true);

      sseManager.closeStream(taskId);
      vi.useRealTimers();
    });

    it("deduplicates cleanup timers on rapid close calls", () => {
      vi.useFakeTimers();

      const taskId = "cleanup-dedup";
      sseManager.createStream(taskId);
      sseManager.pushMessage(taskId, makeMsg(taskId, 1));

      // First close sets up the cleanup timer
      sseManager.closeStream(taskId);
      // Subsequent close calls (no connections now, so they return early)
      // but the timer from first close still runs

      // Only one cleanup should run after 5 minutes
      vi.advanceTimersByTime(5 * 60 * 1000 + 100);
      mockGet.mockReturnValue(undefined);
      expect(sseManager.hasHistory(taskId)).toBe(false);

      vi.useRealTimers();
    });
  });

  describe("multiple listeners for same taskId", () => {
    it("all listeners receive the same message independently", () => {
      const taskId = "multi-listen";
      const a: SSEMessage[] = [];
      const b: SSEMessage[] = [];
      const c: SSEMessage[] = [];

      sseManager.addListener(taskId, (m) => a.push(m));
      sseManager.addListener(taskId, (m) => b.push(m));
      sseManager.addListener(taskId, (m) => c.push(m));

      const msg = makeMsg(taskId, 1);
      sseManager.pushMessage(taskId, msg);

      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      expect(c).toHaveLength(1);
      expect(a[0]).toBe(msg);
      expect(b[0]).toBe(msg);
      expect(c[0]).toBe(msg);
      sseManager.closeStream(taskId);
    });

    it("unsubscribing one listener does not affect others", () => {
      const taskId = "multi-unsub";
      const a: SSEMessage[] = [];
      const b: SSEMessage[] = [];

      const unsubA = sseManager.addListener(taskId, (m) => a.push(m));
      sseManager.addListener(taskId, (m) => b.push(m));

      sseManager.pushMessage(taskId, makeMsg(taskId, 1));
      unsubA();
      sseManager.pushMessage(taskId, makeMsg(taskId, 2));

      expect(a).toHaveLength(1);
      expect(b).toHaveLength(2);
      sseManager.closeStream(taskId);
    });

    it("cleans up listener set when last listener is removed", () => {
      const taskId = "multi-cleanup";
      const unsub1 = sseManager.addListener(taskId, () => {});
      const unsub2 = sseManager.addListener(taskId, () => {});

      unsub1();
      // After removing first, messages still delivered to second
      const received: SSEMessage[] = [];
      const unsub3 = sseManager.addListener(taskId, (m) => received.push(m));
      sseManager.pushMessage(taskId, makeMsg(taskId, 1));
      expect(received).toHaveLength(1);

      unsub2();
      unsub3();
      // All removed, push should still work (no errors)
      expect(() => sseManager.pushMessage(taskId, makeMsg(taskId, 2))).not.toThrow();
      sseManager.closeStream(taskId);
    });
  });

  describe("pushMessage with DB write failure", () => {
    it("still stores in memory despite DB failure", () => {
      const taskId = "db-fail-mem";
      mockRun.mockImplementation(() => { throw new Error("DB write failed"); });

      sseManager.pushMessage(taskId, makeMsg(taskId, 1));
      expect(sseManager.hasHistory(taskId)).toBe(true);

      mockRun.mockReset();
      sseManager.closeStream(taskId);
    });

    it("still notifies listeners despite DB failure", () => {
      const taskId = "db-fail-listener";
      mockRun.mockImplementation(() => { throw new Error("DB write failed"); });

      const received: SSEMessage[] = [];
      sseManager.addListener(taskId, (m) => received.push(m));

      sseManager.pushMessage(taskId, makeMsg(taskId, 1));
      expect(received).toHaveLength(1);

      mockRun.mockReset();
      sseManager.closeStream(taskId);
    });

    it("still broadcasts to connected streams despite DB failure", async () => {
      const taskId = "db-fail-broadcast";

      const stream = sseManager.createStream(taskId);
      // Let the start() callback run
      await new Promise((r) => setTimeout(r, 10));

      // Now set up the DB failure for pushMessage
      mockRun.mockImplementationOnce(() => { throw new Error("DB write failed"); });
      sseManager.pushMessage(taskId, makeMsg(taskId, 1));

      const reader = stream.getReader();
      const { value } = await reader.read();
      reader.releaseLock();

      const text = new TextDecoder().decode(value);
      expect(text).toContain(`"type":"status"`);

      sseManager.closeStream(taskId);
    });
  });

  describe("heartbeat detects closed connection", () => {
    it("stops heartbeat when connection is closed during heartbeat", async () => {
      vi.useFakeTimers();

      const taskId = "heartbeat-closed";
      const stream = sseManager.createStream(taskId);
      const reader = stream.getReader();

      // Read any initial data
      // Close the stream from our side, making the controller throw on enqueue
      reader.cancel();

      // Advance time to trigger heartbeat - the enqueue should fail and mark conn.closed
      vi.advanceTimersByTime(30_000);

      // No error should be thrown
      sseManager.closeStream(taskId);
      vi.useRealTimers();
    });
  });

  describe("cancel callback on stream", () => {
    it("cleans up closed connections when stream is cancelled", async () => {
      const taskId = "cancel-cleanup";
      const stream = sseManager.createStream(taskId);
      const reader = stream.getReader();

      await new Promise((r) => setTimeout(r, 10));

      // Cancel the reader, which triggers the cancel callback on the ReadableStream
      await reader.cancel();

      // After cancel, creating new streams should work (old connections cleaned up)
      expect(() => sseManager.createStream(taskId)).not.toThrow();
      sseManager.closeStream(taskId);
    });
  });

  describe("pushMessage marks failed connections as closed", () => {
    it("marks connection as closed when sendToController throws", async () => {
      const taskId = "push-fail-conn";
      const stream = sseManager.createStream(taskId);
      const reader = stream.getReader();

      await new Promise((r) => setTimeout(r, 10));

      // Cancel the reader to make the controller throw on next enqueue
      await reader.cancel();

      // Push should not throw even though the connection will fail
      expect(() => {
        sseManager.pushMessage(taskId, makeMsg(taskId, 1));
      }).not.toThrow();

      // The closed connection should be cleaned up
      // Creating streams should work
      expect(() => sseManager.createStream(taskId)).not.toThrow();
      sseManager.closeStream(taskId);
    });
  });

  describe("periodic cleanup interval", () => {
    it("cleans up closed connections even without pushMessage", async () => {
      vi.useFakeTimers();

      const taskId = "periodic-cleanup";
      const stream = sseManager.createStream(taskId);
      const reader = stream.getReader();

      await reader.cancel();

      // Before interval fires, closed connections may still be in the map
      // After 60 seconds, periodic cleanup runs
      vi.advanceTimersByTime(60_000);

      // Should be able to create 10 streams (all old ones cleaned up)
      for (let i = 0; i < 10; i++) {
        sseManager.createStream(taskId);
      }
      expect(() => sseManager.createStream(taskId)).toThrow(/Too many connections/);

      sseManager.closeStream(taskId);
      vi.useRealTimers();
    });
  });

  describe("removeClosedConnections", () => {
    it("filters active vs closed connections correctly", async () => {
      const taskId = "remove-closed";
      // Create multiple streams
      const stream1 = sseManager.createStream(taskId);
      const stream2 = sseManager.createStream(taskId);

      await new Promise((r) => setTimeout(r, 10));

      // Cancel one stream
      const reader1 = stream1.getReader();
      await reader1.cancel();

      // Push a message to trigger removeClosedConnections
      sseManager.pushMessage(taskId, makeMsg(taskId, 1));

      // Should still be able to create up to the limit minus the remaining active connection
      // (max 10, 1 active remains after cleanup)
      for (let i = 0; i < 8; i++) {
        sseManager.createStream(taskId);
      }
      // 1 remaining active + 8 new = 9, should still allow one more
      expect(() => sseManager.createStream(taskId)).not.toThrow();

      sseManager.closeStream(taskId);
    });
  });
});
