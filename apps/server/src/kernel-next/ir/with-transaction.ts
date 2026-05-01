// Bug 17/18/56/60/61/62 (c12+ review Wave 2 Theme 2): a small wrapper
// around `BEGIN IMMEDIATE` / `COMMIT` / catch-`ROLLBACK` so the kernel
// stops scattering hand-rolled try/finally blocks (where one site
// invariably forgets the rollback or rolls back twice).
//
// Why `BEGIN IMMEDIATE` rather than the default `BEGIN DEFERRED`:
//   - DEFERRED only acquires a write lock when the first write
//     statement runs, which means concurrent writers can both pass
//     `BEGIN` and only collide on COMMIT — at which point one of them
//     hits SQLITE_BUSY and we need an outer retry harness anyway.
//   - IMMEDIATE acquires the write lock at BEGIN time. Concurrent
//     writers serialise predictably; the second BEGIN throws
//     SQLITE_BUSY synchronously, which is the failure mode the caller
//     can act on.
//
// Failure semantics:
//   - If `fn` throws, ROLLBACK runs; the original exception
//     propagates. If ROLLBACK also throws (rare — usually means the
//     connection is in a bad state), it's captured and chained as the
//     `cause` so observability tooling sees both.
//   - If `BEGIN IMMEDIATE` itself throws (database is locked, schema
//     migration in flight, etc.), `fn` is NOT invoked and no ROLLBACK
//     is attempted (there's no transaction to roll back). The original
//     BEGIN error propagates. Pre-helper code that did
//     `db.exec("BEGIN"); try { ... } catch { db.exec("ROLLBACK"); }`
//     would throw "no transaction is active" from the catch handler,
//     masking the real BEGIN failure. The helper avoids that.
//   - Nested calls are not supported. SQLite doesn't have nested
//     transactions; SAVEPOINT does, but no current call site needs
//     them. If a future caller does, that should be a separate helper.
//
// Usage shape:
//
//   withTransaction(db, () => {
//     db.prepare("UPDATE ...").run(...);
//     db.prepare("INSERT ...").run(...);
//     return someResult;        // becomes the helper's return value
//   });

import type { DatabaseSync } from "node:sqlite";

export class TransactionRollbackError extends Error {
  override readonly name = "TransactionRollbackError";
  constructor(
    message: string,
    public readonly originalError: unknown,
    public readonly rollbackError: unknown,
  ) {
    super(message);
  }
}

/**
 * Run `fn` inside a SQLite IMMEDIATE transaction. Commits on return;
 * rolls back on throw, then re-throws the caller's exception (with the
 * rollback error attached as `cause` if the rollback itself threw).
 *
 * Synchronous-only by design — `node:sqlite` is synchronous and the
 * write lock must not be held across an `await`. If a call site needs
 * to await something inside the txn, it should split the work: pre-tx
 * read/await, then a synchronous tx that reads + writes.
 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  let result: T;
  try {
    result = fn();
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackErr) {
      throw new TransactionRollbackError(
        `transaction body threw, ROLLBACK also threw: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
        err,
        rollbackErr,
      );
    }
    throw err;
  }
  db.exec("COMMIT");
  return result;
}
