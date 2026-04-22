import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../../kernel-next/ir/sql.js";
import {
  countAttemptsToDelete,
  pruneAttempts,
  attemptStats,
  parseDuration,
} from "./prune-kernel-records.js";

function mkDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

interface SeedArgs {
  attemptId: string;
  taskId: string;
  startedAt?: number;
  withAed?: boolean;
  withPortValue?: boolean;
  withGate?: boolean;
  withCheckpoint?: boolean;
}

function seedAttempt(db: DatabaseSync, a: SeedArgs): void {
  const {
    attemptId, taskId,
    startedAt = Date.now(),
    withAed = false,
    withPortValue = false,
    withGate = false,
    withCheckpoint = false,
  } = a;

  db.prepare(
    `INSERT INTO stage_attempts
     (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status, kind)
     VALUES (?, ?, 'v1', 's1', 1, ?, 'success', 'regular')`,
  ).run(attemptId, taskId, startedAt);

  if (withAed) {
    // agent_execution_details requires a prompt_contents row it FK's into.
    db.prepare(
      `INSERT OR IGNORE INTO prompt_contents (content_hash, content, created_at)
       VALUES ('hash-${attemptId}', 'prompt', ?)`,
    ).run(startedAt);
    db.prepare(
      `INSERT INTO agent_execution_details
       (attempt_id, prompt_ref, prompt_content_hash, prompt_content, model,
        started_at, last_heartbeat_at)
       VALUES (?, 'p', 'hash-${attemptId}', 'prompt', 'claude-haiku-4-5',
               ?, ?)`,
    ).run(attemptId, startedAt, startedAt);
  }
  if (withPortValue) {
    db.prepare(
      `INSERT INTO port_values
       (value_id, attempt_id, stage_name, port_name, direction, value_json, written_at)
       VALUES (?, ?, 's1', 'out1', 'out', '"v"', ?)`,
    ).run(`pv-${attemptId}`, attemptId, startedAt);
  }
  if (withGate) {
    db.prepare(
      `INSERT INTO gate_queue
       (gate_id, task_id, stage_name, attempt_id, question_json, created_at)
       VALUES (?, ?, 's1', ?, '{}', ?)`,
    ).run(`gq-${attemptId}`, taskId, attemptId, startedAt);
  }
  if (withCheckpoint) {
    db.prepare(
      `INSERT INTO stage_checkpoints
       (attempt_id, workdir, status, captured_before_at)
       VALUES (?, '/tmp', 'capturing', ?)`,
    ).run(attemptId, startedAt);
  }
}

describe("parseDuration", () => {
  it("parses d/h/m/s", () => {
    expect(parseDuration("30d")).toBe(30 * 86_400_000);
    expect(parseDuration("12h")).toBe(12 * 3_600_000);
    expect(parseDuration("45m")).toBe(45 * 60_000);
    expect(parseDuration("90s")).toBe(90_000);
  });
  it("allows whitespace", () => {
    expect(parseDuration(" 7d ")).toBe(7 * 86_400_000);
  });
  it("rejects garbage", () => {
    expect(() => parseDuration("nope")).toThrow(/Invalid duration/);
    expect(() => parseDuration("5x")).toThrow(/Invalid duration/);
    expect(() => parseDuration("")).toThrow(/Invalid duration/);
  });
});

describe("countAttemptsToDelete", () => {
  let db: DatabaseSync;
  beforeEach(() => { db = mkDb(); });

  it("counts by task_id", () => {
    seedAttempt(db, { attemptId: "a1", taskId: "t1" });
    seedAttempt(db, { attemptId: "a2", taskId: "t1" });
    seedAttempt(db, { attemptId: "a3", taskId: "t2" });
    expect(countAttemptsToDelete(db, { taskId: "t1" })).toBe(2);
    expect(countAttemptsToDelete(db, { taskId: "t2" })).toBe(1);
    expect(countAttemptsToDelete(db, { taskId: "none" })).toBe(0);
  });

  it("counts by olderThanMs (started_at)", () => {
    const now = Date.now();
    seedAttempt(db, { attemptId: "old", taskId: "t", startedAt: now - 10_000 });
    seedAttempt(db, { attemptId: "new", taskId: "t", startedAt: now - 1_000 });
    // older-than 5s → only the "old" one qualifies
    expect(countAttemptsToDelete(db, { olderThanMs: 5_000 })).toBe(1);
  });

  it("counts with both filters (AND)", () => {
    const now = Date.now();
    seedAttempt(db, { attemptId: "a1", taskId: "t1", startedAt: now - 20_000 });
    seedAttempt(db, { attemptId: "a2", taskId: "t2", startedAt: now - 20_000 });
    seedAttempt(db, { attemptId: "a3", taskId: "t1", startedAt: now - 1_000 });
    expect(
      countAttemptsToDelete(db, { taskId: "t1", olderThanMs: 5_000 }),
    ).toBe(1); // only a1
  });

  it("refuses empty filter", () => {
    expect(() => countAttemptsToDelete(db, {})).toThrow(/refuses empty filter/);
  });
});

describe("pruneAttempts", () => {
  let db: DatabaseSync;
  beforeEach(() => { db = mkDb(); });

  it("deletes matching stage_attempts + all FK children atomically", () => {
    seedAttempt(db, {
      attemptId: "a1", taskId: "t1",
      withAed: true, withPortValue: true, withGate: true, withCheckpoint: true,
    });
    seedAttempt(db, {
      attemptId: "a2", taskId: "t2",
      withAed: true, withCheckpoint: true,
    });

    const counts = pruneAttempts(db, { taskId: "t1" });

    expect(counts.attempts).toBe(1);
    expect(counts.agent_execution_details).toBe(1);
    expect(counts.port_values).toBe(1);
    expect(counts.gate_queue).toBe(1);
    expect(counts.stage_checkpoints).toBe(1);

    // t2 untouched
    expect((db.prepare(`SELECT COUNT(*) AS n FROM stage_attempts`).get() as { n: number }).n).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM agent_execution_details`).get() as { n: number }).n).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM stage_checkpoints`).get() as { n: number }).n).toBe(1);
  });

  it("CASCADE removes stage_checkpoints without manual DELETE", () => {
    seedAttempt(db, { attemptId: "a1", taskId: "t1", withCheckpoint: true });
    // Don't add any other children — stage_checkpoints is the only FK.
    const counts = pruneAttempts(db, { taskId: "t1" });
    expect(counts.attempts).toBe(1);
    expect(counts.stage_checkpoints).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM stage_checkpoints`).get() as { n: number }).n).toBe(0);
  });

  it("no match — no deletion, zero counts", () => {
    seedAttempt(db, { attemptId: "a1", taskId: "t1" });
    const counts = pruneAttempts(db, { taskId: "no-such-task" });
    expect(counts.attempts).toBe(0);
    expect(counts.port_values).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM stage_attempts`).get() as { n: number }).n).toBe(1);
  });

  it("refuses empty filter", () => {
    expect(() => pruneAttempts(db, {})).toThrow(/refuses empty filter/);
  });

  it("rolls back on mid-transaction error (atomicity)", () => {
    seedAttempt(db, { attemptId: "a1", taskId: "t1", withAed: true });
    // Inject a failure by dropping the port_values table between prepares.
    // Actually simpler: monkey-patch db.prepare to throw on a specific SQL.
    const origPrepare = db.prepare.bind(db);
    let called = 0;
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      called += 1;
      if (called > 3 && sql.startsWith("DELETE FROM port_values")) {
        throw new Error("synthetic mid-tx error");
      }
      return origPrepare(sql);
    }) as typeof db.prepare;

    expect(() => pruneAttempts(db, { taskId: "t1" })).toThrow(/synthetic/);

    // Restore + assert state unchanged.
    (db as unknown as { prepare: typeof db.prepare }).prepare = origPrepare;
    expect((db.prepare(`SELECT COUNT(*) AS n FROM stage_attempts`).get() as { n: number }).n).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM agent_execution_details`).get() as { n: number }).n).toBe(1);
  });
});

describe("attemptStats", () => {
  let db: DatabaseSync;
  beforeEach(() => { db = mkDb(); });

  it("zero state", () => {
    const s = attemptStats(db);
    expect(s.total).toBe(0);
    expect(s.byTask).toEqual([]);
    expect(s.oldestStartedAt).toBeNull();
    expect(s.newestStartedAt).toBeNull();
    expect(s.openAgentExecutionDetails).toBe(0);
  });

  it("reports totals + top tasks + range + open rows", () => {
    seedAttempt(db, { attemptId: "a1", taskId: "t1", startedAt: 1000, withAed: true });
    seedAttempt(db, { attemptId: "a2", taskId: "t1", startedAt: 2000 });
    seedAttempt(db, { attemptId: "a3", taskId: "t2", startedAt: 3000 });

    const s = attemptStats(db);
    expect(s.total).toBe(3);
    expect(s.byTask).toEqual([
      { task_id: "t1", attempts: 2 },
      { task_id: "t2", attempts: 1 },
    ]);
    expect(s.oldestStartedAt).toBe(1000);
    expect(s.newestStartedAt).toBe(3000);
    // aed row 'a1' was seeded with ended_at = null (writer default), so it
    // counts as open.
    expect(s.openAgentExecutionDetails).toBe(1);
  });
});
