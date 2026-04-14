import { createHash } from "node:crypto";

/**
 * Compute a stable content hash for any JSON-serializable value.
 * Uses sorted keys to ensure identical objects with different key insertion
 * order produce the same hash (e.g., after deserialization).
 * Returns a 16-char hex string (64 bits — collision probability ~1 in 10^18).
 */
export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k])).join(",") + "}";
}
