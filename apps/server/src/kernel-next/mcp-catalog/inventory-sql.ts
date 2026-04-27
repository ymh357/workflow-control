import type { DatabaseSync } from "node:sqlite";

export const INVENTORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS mcp_inventory (
  entry_id              TEXT PRIMARY KEY,
  status                TEXT NOT NULL CHECK(status IN (
    'not-equipped','pending-secret','equipped','unhealthy'
  )),
  last_status_change_at INTEGER NOT NULL,
  last_unhealthy_at     INTEGER,
  last_unhealthy_reason TEXT
);

CREATE TABLE IF NOT EXISTS mcp_inventory_secrets (
  entry_id        TEXT NOT NULL,
  env_key         TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  last_updated_at INTEGER NOT NULL,
  PRIMARY KEY (entry_id, env_key)
);

CREATE INDEX IF NOT EXISTS idx_mis_entry ON mcp_inventory_secrets(entry_id);
`;

export function initInventorySchema(db: DatabaseSync): void {
  db.exec(INVENTORY_SCHEMA);
}
