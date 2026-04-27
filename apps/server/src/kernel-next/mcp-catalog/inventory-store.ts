import type { DatabaseSync } from "node:sqlite";
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

export function writeInventoryStatus(
  db: DatabaseSync,
  entryId: string,
  status: InventoryStatus,
  opts: { unhealthyReason?: string } = {},
): void {
  const now = Date.now();
  const unhealthyAt = status === "unhealthy" ? now : null;
  const unhealthyReason = status === "unhealthy" ? (opts.unhealthyReason ?? null) : null;
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

export function unequipTransaction(db: DatabaseSync, entryId: string): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    deleteInventoryRow(db, entryId);
    deleteAllSecrets(db, entryId);
    db.exec("COMMIT");
  } catch (e) {
    // Wrap ROLLBACK so a "no transaction active" error doesn't mask the real one.
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}
