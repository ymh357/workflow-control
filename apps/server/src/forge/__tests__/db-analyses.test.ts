import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initForgeSchema } from "../db/schema.js";
import { insertAnalysis, getAnalysis } from "../db/analyses.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  initForgeSchema(db);
});

describe("forge_analyses CRUD", () => {
  it("round-trips a real-distill handle (no emptyResult)", () => {
    insertAnalysis(db, {
      analysisId: "forge-distill-1777993813697-4d43d155",
      sessionId: "sess-abc",
      jsonlPath: "/tmp/sess-abc.jsonl",
      taskId: "forge-distill-1777993813697-4d43d155",
      truncated: false,
      startedAt: 1_700_000_000_000,
    });

    const row = getAnalysis(db, "forge-distill-1777993813697-4d43d155");
    expect(row).not.toBeNull();
    expect(row!.sessionId).toBe("sess-abc");
    expect(row!.jsonlPath).toBe("/tmp/sess-abc.jsonl");
    expect(row!.taskId).toBe("forge-distill-1777993813697-4d43d155");
    expect(row!.truncated).toBe(false);
    expect(row!.emptyResult).toBeNull();
  });

  it("round-trips an empty-session handle (synthetic id, taskId='', emptyResult populated)", () => {
    const empty = {
      episodes: [],
      reasonNoEpisodes: "session has fewer than 4 events",
    };
    insertAnalysis(db, {
      analysisId: "empty-1700000000000-deadbeef",
      sessionId: "sess-tiny",
      jsonlPath: "/tmp/sess-tiny.jsonl",
      taskId: "",
      truncated: false,
      startedAt: 1_700_000_000_000,
      emptyResult: empty,
    });

    const row = getAnalysis(db, "empty-1700000000000-deadbeef");
    expect(row).not.toBeNull();
    expect(row!.taskId).toBe("");
    expect(row!.emptyResult).toEqual(empty);
  });

  it("returns null for unknown analysis_id (handler maps this to INVALID_ANALYSIS_ID)", () => {
    expect(getAnalysis(db, "definitely-not-real")).toBeNull();
  });

  it("INSERT OR REPLACE upserts on duplicate analysis_id", () => {
    insertAnalysis(db, {
      analysisId: "forge-distill-1-aaa",
      sessionId: "s1", jsonlPath: "/tmp/s1.jsonl",
      taskId: "forge-distill-1-aaa", truncated: false,
      startedAt: 100,
    });
    insertAnalysis(db, {
      analysisId: "forge-distill-1-aaa",
      sessionId: "s1", jsonlPath: "/tmp/s1.jsonl",
      taskId: "forge-distill-1-aaa", truncated: true,  // changed
      startedAt: 200,
    });
    const row = getAnalysis(db, "forge-distill-1-aaa")!;
    expect(row.truncated).toBe(true);
    expect(row.startedAt).toBe(200);
  });

  it("survives DB close+reopen — handle is durable across server restarts", () => {
    // Use a real file rather than :memory: to test persistence semantics.
    const path = `/tmp/forge-analyses-test-${Date.now()}.db`;
    let dbA: DatabaseSync | null = new DatabaseSync(path);
    initForgeSchema(dbA);
    insertAnalysis(dbA, {
      analysisId: "forge-distill-restart-test",
      sessionId: "s1", jsonlPath: "/tmp/s1.jsonl",
      taskId: "forge-distill-restart-test", truncated: false,
      startedAt: 1,
    });
    dbA.close();
    dbA = null;

    const dbB = new DatabaseSync(path);
    const row = getAnalysis(dbB, "forge-distill-restart-test");
    expect(row).not.toBeNull();
    expect(row!.sessionId).toBe("s1");
    dbB.close();
  });
});
