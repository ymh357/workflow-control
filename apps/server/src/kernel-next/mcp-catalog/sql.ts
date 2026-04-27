import type { DatabaseSync } from "node:sqlite";

export const CATALOG_SCHEMA = `
CREATE TABLE IF NOT EXISTS mcp_catalog (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL CHECK(source IN ('builtin','custom')),
  entry_json    TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  deprecated_at INTEGER  -- NULL = active; non-NULL = epoch ms when builtin removed from JSON
);

CREATE INDEX IF NOT EXISTS idx_mc_source ON mcp_catalog(source);
CREATE INDEX IF NOT EXISTS idx_mc_deprecated ON mcp_catalog(deprecated_at)
  WHERE deprecated_at IS NOT NULL;
`;

export function initCatalogSchema(db: DatabaseSync): void {
  db.exec(CATALOG_SCHEMA);
}
