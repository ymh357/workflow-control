import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initForgeSchema } from "../db/schema.js";
import {
  upsertSession, advanceByteOffset, setSessionStatus,
  getSession, listSessionsByStatus, insertEvents, listEventsBySession,
  getMaxSeq,
} from "../db/sessions.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  initForgeSchema(db);
});

describe("sessions CRUD", () => {
  it("upsert + get round-trips", () => {
    upsertSession(db, {
      sessionId: "s1", cwd: "/p", jsonlPath: "/p/s1.jsonl",
      firstSeenAt: 100, lastEventAt: 200,
    });
    const row = getSession(db, "s1");
    expect(row).not.toBeNull();
    expect(row!.cwd).toBe("/p");
    expect(row!.byteOffset).toBe(0);
    expect(row!.status).toBe("active");
  });

  it("upsert is idempotent and bumps lastEventAt forward", () => {
    upsertSession(db, { sessionId: "s1", cwd: "/p", jsonlPath: "/p/s1.jsonl", firstSeenAt: 100, lastEventAt: 200 });
    upsertSession(db, { sessionId: "s1", cwd: "/p", jsonlPath: "/p/s1.jsonl", firstSeenAt: 100, lastEventAt: 300 });
    expect(getSession(db, "s1")!.lastEventAt).toBe(300);
  });

  it("upsert never regresses lastEventAt", () => {
    upsertSession(db, { sessionId: "s1", cwd: "/p", jsonlPath: "/p/s1.jsonl", firstSeenAt: 100, lastEventAt: 300 });
    upsertSession(db, { sessionId: "s1", cwd: "/p", jsonlPath: "/p/s1.jsonl", firstSeenAt: 100, lastEventAt: 200 });
    expect(getSession(db, "s1")!.lastEventAt).toBe(300);
  });

  it("advanceByteOffset only advances forward (never regresses)", () => {
    upsertSession(db, { sessionId: "s1", cwd: "/p", jsonlPath: "/p/s1.jsonl", firstSeenAt: 100, lastEventAt: 200 });
    advanceByteOffset(db, "s1", 1024);
    advanceByteOffset(db, "s1", 512);
    expect(getSession(db, "s1")!.byteOffset).toBe(1024);
  });

  it("setSessionStatus transitions correctly", () => {
    upsertSession(db, { sessionId: "s1", cwd: "/p", jsonlPath: "/p/s1.jsonl", firstSeenAt: 100, lastEventAt: 200 });
    setSessionStatus(db, "s1", "quiescent");
    expect(getSession(db, "s1")!.status).toBe("quiescent");
    setSessionStatus(db, "s1", "skipped", "test");
    expect(getSession(db, "s1")!.status).toBe("skipped");
    expect(getSession(db, "s1")!.skipReason).toBe("test");
  });

  it("listSessionsByStatus returns matching rows ordered by lastEventAt asc", () => {
    upsertSession(db, { sessionId: "s2", cwd: "/p", jsonlPath: "/b.jsonl", firstSeenAt: 100, lastEventAt: 300 });
    upsertSession(db, { sessionId: "s1", cwd: "/p", jsonlPath: "/a.jsonl", firstSeenAt: 100, lastEventAt: 200 });
    setSessionStatus(db, "s1", "quiescent");
    setSessionStatus(db, "s2", "quiescent");
    const list = listSessionsByStatus(db, "quiescent");
    expect(list).toHaveLength(2);
    expect(list[0]!.sessionId).toBe("s1");
    expect(list[1]!.sessionId).toBe("s2");
  });

  it("getSession returns null for unknown id", () => {
    expect(getSession(db, "ghost")).toBeNull();
  });
});

describe("session_events", () => {
  beforeEach(() => {
    upsertSession(db, { sessionId: "s1", cwd: "/p", jsonlPath: "/p/s1.jsonl", firstSeenAt: 100, lastEventAt: 200 });
  });

  it("insertEvents writes a batch and bumps eventCount", () => {
    insertEvents(db, "s1", [
      { sessionId: "s1", seq: 1, ts: 100, role: "user", textExcerpt: "hi", textHash: "h1", textLength: 2, toolName: null, toolArgsExcerpt: null },
      { sessionId: "s1", seq: 2, ts: 110, role: "assistant", textExcerpt: "hello", textHash: "h2", textLength: 5, toolName: null, toolArgsExcerpt: null },
    ]);
    expect(getSession(db, "s1")!.eventCount).toBe(2);
    const events = listEventsBySession(db, "s1");
    expect(events).toHaveLength(2);
    expect(events[0]!.role).toBe("user");
    expect(events[1]!.role).toBe("assistant");
  });

  it("insertEvents is idempotent on (session, seq)", () => {
    const ev = {
      sessionId: "s1", seq: 1, ts: 100, role: "user" as const,
      textExcerpt: "hi", textHash: "h1", textLength: 2, toolName: null, toolArgsExcerpt: null,
    };
    insertEvents(db, "s1", [ev]);
    expect(() => insertEvents(db, "s1", [ev])).not.toThrow();
    expect(listEventsBySession(db, "s1")).toHaveLength(1);
    expect(getSession(db, "s1")!.eventCount).toBe(1);
  });

  it("getMaxSeq returns 0 for empty session", () => {
    expect(getMaxSeq(db, "s1")).toBe(0);
  });

  it("getMaxSeq returns highest seq inserted", () => {
    insertEvents(db, "s1", [
      { sessionId: "s1", seq: 1, ts: 100, role: "user", textExcerpt: null, textHash: null, textLength: null, toolName: null, toolArgsExcerpt: null },
      { sessionId: "s1", seq: 5, ts: 110, role: "assistant", textExcerpt: null, textHash: null, textLength: null, toolName: null, toolArgsExcerpt: null },
    ]);
    expect(getMaxSeq(db, "s1")).toBe(5);
  });

  it("insertEvents tolerates empty array", () => {
    expect(() => insertEvents(db, "s1", [])).not.toThrow();
    expect(getSession(db, "s1")!.eventCount).toBe(0);
  });
});
