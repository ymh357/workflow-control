import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "../ir/with-transaction.js";
import type {
  InventoryRow,
  InventoryStatus,
  InventorySecretReadout,
} from "./inventory-types.js";

type RawInventoryRow = {
  entry_id: string;
  status: string;
  last_status_change_at: number;
  last_unhealthy_at: number | null;
  last_unhealthy_reason: string | null;
};

function rowToInventory(r: RawInventoryRow): InventoryRow {
  const out: InventoryRow = {
    entryId: r.entry_id,
    status: r.status as InventoryStatus,
    lastStatusChangeAt: r.last_status_change_at,
  };
  if (r.last_unhealthy_at != null) out.lastUnhealthyAt = r.last_unhealthy_at;
  if (r.last_unhealthy_reason != null) out.lastUnhealthyReason = r.last_unhealthy_reason;
  return out;
}

export function readInventoryRow(db: DatabaseSync, entryId: string): InventoryRow | null {
  const row = db.prepare(
    `SELECT entry_id, status, last_status_change_at, last_unhealthy_at, last_unhealthy_reason
       FROM mcp_inventory WHERE entry_id = ?`,
  ).get(entryId) as RawInventoryRow | undefined;
  return row ? rowToInventory(row) : null;
}

export function readAllInventoryRows(db: DatabaseSync): InventoryRow[] {
  const rows = db.prepare(
    `SELECT entry_id, status, last_status_change_at, last_unhealthy_at, last_unhealthy_reason
       FROM mcp_inventory ORDER BY entry_id ASC`,
  ).all() as RawInventoryRow[];
  return rows.map(rowToInventory);
}

type WriteInventoryStatusArgs =
  | { status: "not-equipped" | "pending-secret" | "equipped" }
  | { status: "unhealthy"; unhealthyReason: string };

export function writeInventoryStatus(
  db: DatabaseSync,
  entryId: string,
  status: InventoryStatus,
  opts: Partial<{ unhealthyReason: string }> = {},
): void {
  if (status === "unhealthy" && !opts.unhealthyReason) {
    throw new Error("writeInventoryStatus: 'unhealthy' status requires opts.unhealthyReason");
  }
  // The discriminated union type is exported below for callers that want
  // compile-time enforcement of the reason on unhealthy writes; the existing
  // 4-arg signature remains the runtime contract for backwards compatibility.
  const now = Date.now();
  const unhealthyAt = status === "unhealthy" ? now : null;
  const unhealthyReason = status === "unhealthy" ? opts.unhealthyReason! : null;
  db.prepare(`
    INSERT INTO mcp_inventory
      (entry_id, status, last_status_change_at, last_unhealthy_at, last_unhealthy_reason)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(entry_id) DO UPDATE SET
      status                = excluded.status,
      last_status_change_at = excluded.last_status_change_at,
      last_unhealthy_at     = excluded.last_unhealthy_at,
      last_unhealthy_reason = excluded.last_unhealthy_reason
  `).run(entryId, status, now, unhealthyAt, unhealthyReason);
}

export type { WriteInventoryStatusArgs };

export function deleteInventoryRow(db: DatabaseSync, entryId: string): void {
  db.prepare("DELETE FROM mcp_inventory WHERE entry_id = ?").run(entryId);
}

export function writeSecret(
  db: DatabaseSync,
  entryId: string,
  envKey: string,
  encryptedValue: string,
): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO mcp_inventory_secrets (entry_id, env_key, encrypted_value, last_updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(entry_id, env_key) DO UPDATE SET
      encrypted_value = excluded.encrypted_value,
      last_updated_at = excluded.last_updated_at
  `).run(entryId, envKey, encryptedValue, now);
}

export function readSecretRow(
  db: DatabaseSync,
  entryId: string,
  envKey: string,
): { encryptedValue: string; lastUpdatedAt: number } | null {
  const row = db.prepare(
    `SELECT encrypted_value, last_updated_at
       FROM mcp_inventory_secrets WHERE entry_id = ? AND env_key = ?`,
  ).get(entryId, envKey) as { encrypted_value: string; last_updated_at: number } | undefined;
  if (!row) return null;
  return { encryptedValue: row.encrypted_value, lastUpdatedAt: row.last_updated_at };
}

export function listSecretReadouts(db: DatabaseSync, entryId: string): InventorySecretReadout[] {
  const rows = db.prepare(
    `SELECT env_key, last_updated_at
       FROM mcp_inventory_secrets WHERE entry_id = ? ORDER BY env_key ASC`,
  ).all(entryId) as { env_key: string; last_updated_at: number }[];
  return rows.map((r) => ({
    envKey: r.env_key,
    hasValue: true,
    lastUpdatedAt: r.last_updated_at,
  }));
}

export function deleteAllSecrets(db: DatabaseSync, entryId: string): void {
  db.prepare("DELETE FROM mcp_inventory_secrets WHERE entry_id = ?").run(entryId);
}

// B6.#27 (2026-04-30 review): adopt withTransaction so this site
// uses the same BEGIN IMMEDIATE / ROLLBACK / COMMIT pattern as the
// rest of kernel-next. The hand-rolled try/catch here was correct
// but easy to drift out of shape on the next edit; the helper
// centralises the rollback-also-throws case via
// TransactionRollbackError so observability tooling sees both
// errors.
//
// Nestability note: withTransaction does not nest (SQLite has no
// nested BEGIN). Current callers of unequipTransaction never run
// inside another transaction, so this is fine; if a future caller
// adds a nesting layer, the helper docstring explains the
// SAVEPOINT-based extension that would be needed.
export function unequipTransaction(db: DatabaseSync, entryId: string): void {
  withTransaction(db, () => {
    deleteInventoryRow(db, entryId);
    deleteAllSecrets(db, entryId);
  });
}
