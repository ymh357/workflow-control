import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { withTransaction, TransactionRollbackError } from "./with-transaction.js";

describe("withTransaction", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  });

  it("commits on success and returns the body's value", () => {
    const out = withTransaction(db, () => {
      db.prepare("INSERT INTO t (id, v) VALUES (1, 'a')").run();
      db.prepare("INSERT INTO t (id, v) VALUES (2, 'b')").run();
      return "ok";
    });
    expect(out).toBe("ok");
    const rows = db.prepare("SELECT id, v FROM t ORDER BY id").all();
    expect(rows).toEqual([
      { id: 1, v: "a" },
      { id: 2, v: "b" },
    ]);
  });

  it("rolls back on throw and re-throws the body's exception", () => {
    expect(() =>
      withTransaction(db, () => {
        db.prepare("INSERT INTO t (id, v) VALUES (1, 'a')").run();
        throw new Error("body bombed");
      }),
    ).toThrowError("body bombed");

    const rows = db.prepare("SELECT COUNT(*) AS n FROM t").all() as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(0);
  });

  it("propagates SQLITE_BUSY-like errors from BEGIN without invoking the body", () => {
    // Open a second connection on the same in-memory DB? Memory DBs are
    // per-connection — we can't share them. Simulate the "BEGIN throws"
    // case by manually opening then forcing a second BEGIN within the
    // same connection: SQLite throws "cannot start a transaction within
    // a transaction".
    db.exec("BEGIN IMMEDIATE");
    try {
      let bodyCalls = 0;
      expect(() =>
        withTransaction(db, () => {
          bodyCalls += 1;
          return "should not run";
        }),
      ).toThrowError(/transaction/i);
      expect(bodyCalls).toBe(0);
    } finally {
      db.exec("ROLLBACK");
    }
  });

  it("supports nested return types", () => {
    const out = withTransaction(db, () => ({ insertedId: 42, ok: true }));
    expect(out).toEqual({ insertedId: 42, ok: true });
  });

  it("does not double-rollback when ROLLBACK also throws", () => {
    // Construct a scenario: monkey-patch db.exec to throw on ROLLBACK.
    // The helper must surface a TransactionRollbackError (not the original
    // body error directly) so observability tooling can see both.
    const origExec = db.exec.bind(db);
    let rollbackHits = 0;
    (db as unknown as { exec: typeof db.exec }).exec = ((sql: string) => {
      if (/^\s*ROLLBACK/i.test(sql)) {
        rollbackHits += 1;
        throw new Error("synthetic rollback failure");
      }
      return origExec(sql);
    }) as typeof db.exec;

    let caught: unknown;
    try {
      withTransaction(db, () => {
        throw new Error("body fault");
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TransactionRollbackError);
    if (caught instanceof TransactionRollbackError) {
      expect((caught.originalError as Error).message).toBe("body fault");
      expect((caught.rollbackError as Error).message).toBe("synthetic rollback failure");
    }
    expect(rollbackHits).toBe(1);

    // Restore so afterEach close doesn't trip.
    (db as unknown as { exec: typeof db.exec }).exec = origExec;
  });
});
