import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initForgeSchema } from "../db/schema.js";

describe("initForgeSchema", () => {
  function open(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.prepare("PRAGMA foreign_keys = ON").run();
    initForgeSchema(db);
    return db;
  }

  it("creates all forge tables", () => {
    const db = open();
    const rows = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
    ).all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    expect(names).toContain("sessions");
    expect(names).toContain("session_events");
    expect(names).toContain("session_episodes");
    expect(names).toContain("episode_signatures");
    expect(names).toContain("episode_clusters");
    expect(names).toContain("cluster_members");
    expect(names).toContain("pipeline_candidates");
    expect(names).toContain("forge_jobs");
  });

  it("is idempotent (running twice does not throw)", () => {
    const db = new DatabaseSync(":memory:");
    initForgeSchema(db);
    expect(() => initForgeSchema(db)).not.toThrow();
  });

  it("enforces sessions.status check constraint", () => {
    const db = open();
    expect(() =>
      db.prepare(
        `INSERT INTO sessions(session_id, cwd, jsonl_path, first_seen_at, last_event_at, status, event_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("s1", "/tmp", "/tmp/s1.jsonl", 1, 1, "bogus", 0),
    ).toThrow();
  });

  it("session_events PK enforces (session_id, seq) uniqueness", () => {
    const db = open();
    db.prepare(
      `INSERT INTO sessions(session_id, cwd, jsonl_path, first_seen_at, last_event_at, status, event_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("s1", "/tmp", "/p.jsonl", 1, 1, "active", 0);
    db.prepare(
      `INSERT INTO session_events(session_id, seq, ts, role) VALUES (?, ?, ?, ?)`,
    ).run("s1", 1, 100, "user");
    expect(() =>
      db.prepare(
        `INSERT INTO session_events(session_id, seq, ts, role) VALUES (?, ?, ?, ?)`,
      ).run("s1", 1, 200, "user"),
    ).toThrow();
  });

  it("ON DELETE CASCADE removes events when session is deleted", () => {
    const db = open();
    db.prepare(
      `INSERT INTO sessions(session_id, cwd, jsonl_path, first_seen_at, last_event_at, status, event_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("s1", "/tmp", "/p.jsonl", 1, 1, "active", 0);
    db.prepare(
      `INSERT INTO session_events(session_id, seq, ts, role) VALUES (?, ?, ?, ?)`,
    ).run("s1", 1, 100, "user");
    db.prepare(`DELETE FROM sessions WHERE session_id = ?`).run("s1");
    const remaining = db.prepare(
      `SELECT count(*) as n FROM session_events WHERE session_id = ?`,
    ).get("s1") as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("episode_clusters check constraint on status", () => {
    const db = open();
    expect(() =>
      db.prepare(
        `INSERT INTO episode_clusters
          (cluster_id, centroid_blob, centroid_model, member_count, distinct_session_count, distinct_day_count, first_seen_at, last_seen_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("c1", Buffer.from([0]), "m", 1, 1, 1, 100, 100, "bogus"),
    ).toThrow();
  });

  it("forge_jobs dedup index allows multiple completed but not duplicate pending", () => {
    const db = open();
    db.prepare(
      `INSERT INTO forge_jobs(job_id, kind, job_key, payload_json, enqueued_at, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("j1", "distill", "s1", "{}", 1, "pending");
    expect(() =>
      db.prepare(
        `INSERT INTO forge_jobs(job_id, kind, job_key, payload_json, enqueued_at, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("j2", "distill", "s1", "{}", 2, "pending"),
    ).toThrow();
    // Once first one is completed, a new pending is allowed.
    db.prepare(`UPDATE forge_jobs SET status = 'completed' WHERE job_id = ?`).run("j1");
    expect(() =>
      db.prepare(
        `INSERT INTO forge_jobs(job_id, kind, job_key, payload_json, enqueued_at, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("j3", "distill", "s1", "{}", 3, "pending"),
    ).not.toThrow();
  });
});
