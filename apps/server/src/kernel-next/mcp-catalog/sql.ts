import type { DatabaseSync } from "node:sqlite";

export const CATALOG_SCHEMA = `
CREATE TABLE IF NOT EXISTS mcp_catalog (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL CHECK(source IN ('builtin','custom')),
  entry_json    TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  deprecated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mc_source ON mcp_catalog(source);
CREATE INDEX IF NOT EXISTS idx_mc_deprecated ON mcp_catalog(deprecated_at);
`;

export function initCatalogSchema(db: DatabaseSync): void {
  db.exec(CATALOG_SCHEMA);
}
