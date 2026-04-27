import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CatalogEntrySchema, type CatalogEntry } from "./schema.js";
import { insertBuiltinEntry, markBuiltinDeprecated } from "./catalog-store.js";

const SeedFileSchema = z.object({
  schemaVersion: z.literal("1"),
  entries: z.array(CatalogEntrySchema.omit({ source: true, deprecatedAt: true })),
});

export type SeedResult =
  | { ok: true; inserted: number; updated: number; deprecated: number }
  | { ok: false; error: string };

/**
 * Sync builtin entries from a JSON file into the mcp_catalog table.
 *
 * - Entries in JSON: upsert (insert if new id, replace if existing builtin id)
 * - Builtin entries in DB but absent from JSON: mark deprecated_at
 * - Custom entries: untouched
 *
 * Failures (file missing, JSON invalid, entry invalid) return failure result
 * without throwing — caller decides whether to log/ignore.
 */
export function seedBuiltinFromJson(db: DatabaseSync, jsonPath: string): SeedResult {
  let raw: string;
  try {
    raw = readFileSync(jsonPath, "utf8");
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }

  const validated = SeedFileSchema.safeParse(parsed);
  if (!validated.success) {
    return { ok: false, error: `invalid seed file: ${validated.error.issues[0]?.message ?? "schema mismatch"}` };
  }

  const wantedIds = new Set<string>();
  let inserted = 0;
  let updated = 0;

  // Snapshot existing builtin ids before write
  const existingBuiltinIds = new Set<string>(
    (db.prepare("SELECT id FROM mcp_catalog WHERE source='builtin' AND deprecated_at IS NULL").all() as { id: string }[])
      .map((r) => r.id)
  );

  for (const partial of validated.data.entries) {
    const entry: CatalogEntry = { ...partial, source: "builtin" };
    wantedIds.add(entry.id);
    if (existingBuiltinIds.has(entry.id)) {
      updated += 1;
    } else {
      inserted += 1;
    }
    insertBuiltinEntry(db, entry);
  }

  let deprecated = 0;
  const now = Date.now();
  for (const id of existingBuiltinIds) {
    if (!wantedIds.has(id)) {
      markBuiltinDeprecated(db, id, now);
      deprecated += 1;
    }
  }

  return { ok: true, inserted, updated, deprecated };
}
