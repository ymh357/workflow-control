import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  CatalogEntrySchema,
  type CatalogEntry,
  type CatalogDiagnosticCode,
} from "./schema.js";

// Local diagnostic type using catalog-specific codes (not IR Diagnostic,
// which has a closed enum that does not include catalog codes).
type CatalogDiagnostic = {
  code: CatalogDiagnosticCode;
  message: string;
  context?: Record<string, unknown>;
};

type WriteResult =
  | { ok: true; entry: CatalogEntry }
  | { ok: false; diagnostics: CatalogDiagnostic[] };

type DeleteResult =
  | { ok: true }
  | { ok: false; diagnostics: CatalogDiagnostic[] };

type ListOpts = {
  source?: "builtin" | "custom" | "all";
  includeDeprecated?: boolean;
};

type GetOpts = {
  includeDeprecated?: boolean;
};

export function listEntries(db: DatabaseSync, opts: ListOpts = {}): CatalogEntry[] {
  const conditions: string[] = [];
  const params: SQLInputValue[] = [];

  if (opts.source && opts.source !== "all") {
    conditions.push("source = ?");
    params.push(opts.source);
  }
  if (!opts.includeDeprecated) {
    conditions.push("deprecated_at IS NULL");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT entry_json FROM mcp_catalog ${where} ORDER BY id ASC`;
  const rows = db.prepare(sql).all(...params) as { entry_json: string }[];
  return rows.map((r) => CatalogEntrySchema.parse(JSON.parse(r.entry_json)));
}

export function getEntry(
  db: DatabaseSync,
  id: string,
  opts: GetOpts = {},
): CatalogEntry | null {
  const sql = opts.includeDeprecated
    ? "SELECT entry_json FROM mcp_catalog WHERE id = ?"
    : "SELECT entry_json FROM mcp_catalog WHERE id = ? AND deprecated_at IS NULL";
  const row = db.prepare(sql).get(id) as { entry_json: string } | undefined;
  if (!row) return null;
  return CatalogEntrySchema.parse(JSON.parse(row.entry_json));
}

export function upsertCustomEntry(db: DatabaseSync, entry: CatalogEntry): WriteResult {
  // Force source to 'custom' before validation.
  const parsed = CatalogEntrySchema.safeParse({ ...entry, source: "custom" });
  if (!parsed.success) {
    return {
      ok: false,
      diagnostics: [{
        code: "CATALOG_INVALID_ENTRY",
        message: parsed.error.issues[0]?.message ?? "invalid entry",
        context: { path: parsed.error.issues[0]?.path },
      }],
    };
  }

  // Reject if the id is already owned by a builtin row.
  const existing = db
    .prepare("SELECT source FROM mcp_catalog WHERE id = ?")
    .get(entry.id) as { source: string } | undefined;
  if (existing && existing.source === "builtin") {
    return {
      ok: false,
      diagnostics: [{
        code: "CATALOG_ENTRY_ID_CONFLICT",
        message: `id '${entry.id}' is already used by a builtin entry`,
        context: { id: entry.id },
      }],
    };
  }

  const finalEntry: CatalogEntry = parsed.data;
  const now = Date.now();
  db.prepare(`
    INSERT INTO mcp_catalog (id, source, entry_json, updated_at, deprecated_at)
    VALUES (?, 'custom', ?, ?, NULL)
    ON CONFLICT(id) DO UPDATE SET
      entry_json   = excluded.entry_json,
      updated_at   = excluded.updated_at,
      deprecated_at = NULL
  `).run(finalEntry.id, JSON.stringify(finalEntry), now);

  return { ok: true, entry: finalEntry };
}

export function deleteCustomEntry(db: DatabaseSync, id: string): DeleteResult {
  const existing = db
    .prepare("SELECT source FROM mcp_catalog WHERE id = ?")
    .get(id) as { source: string } | undefined;

  if (!existing) {
    return {
      ok: false,
      diagnostics: [{
        code: "CATALOG_ENTRY_NOT_FOUND",
        message: `entry '${id}' not found`,
        context: { id },
      }],
    };
  }
  if (existing.source === "builtin") {
    return {
      ok: false,
      diagnostics: [{
        code: "CATALOG_BUILTIN_NOT_WRITABLE",
        message: "builtin entries cannot be deleted via the API; modify entries.json instead",
        context: { id },
      }],
    };
  }

  db.prepare("DELETE FROM mcp_catalog WHERE id = ?").run(id);
  return { ok: true };
}

/**
 * Find an entry by exact command+args match. Used by other subsystems to
 * reverse-look-up an mcpServer declaration in a pipeline IR back to a
 * catalog entry. Returns null for deprecated entries.
 */
export function lookupEntryByCommand(
  db: DatabaseSync,
  command: string,
  args: string[],
): string | null {
  const argsJson = JSON.stringify(args);
  const rows = db
    .prepare("SELECT id, entry_json FROM mcp_catalog WHERE deprecated_at IS NULL")
    .all() as { id: string; entry_json: string }[];

  for (const row of rows) {
    const entry = CatalogEntrySchema.parse(JSON.parse(row.entry_json));
    if (entry.command === command && JSON.stringify(entry.args) === argsJson) {
      return entry.id;
    }
  }
  return null;
}

/**
 * Internal helper for seed.ts. Inserts or updates a builtin entry.
 * Not exposed via REST — use upsertCustomEntry for user-authored entries.
 */
export function insertBuiltinEntry(db: DatabaseSync, entry: CatalogEntry): void {
  const finalEntry: CatalogEntry = { ...entry, source: "builtin" };
  const now = Date.now();
  db.prepare(`
    INSERT INTO mcp_catalog (id, source, entry_json, updated_at, deprecated_at)
    VALUES (?, 'builtin', ?, ?, NULL)
    ON CONFLICT(id) DO UPDATE SET
      entry_json   = excluded.entry_json,
      updated_at   = excluded.updated_at,
      deprecated_at = NULL
  `).run(finalEntry.id, JSON.stringify(finalEntry), now);
}

/**
 * Internal helper for seed.ts. Marks a builtin row as deprecated rather
 * than deleting it, preserving history for getEntry(includeDeprecated=true).
 */
export function markBuiltinDeprecated(db: DatabaseSync, id: string, atMs: number): void {
  db.prepare(`
    UPDATE mcp_catalog SET deprecated_at = ?
    WHERE id = ? AND source = 'builtin'
  `).run(atMs, id);
}
