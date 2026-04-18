// Phase 2 / A2 — Canonical pipeline hash.
//
// Given a pipeline (YAML string or already-parsed object), produce a
// deterministic SHA-256 hex digest such that:
//
//   1. Two pipelines that differ only in key ORDER hash the same.
//   2. Two pipelines that differ only in WHITESPACE or COMMENTS hash the
//      same (the YAML parser discards those before we see the object).
//   3. Two pipelines that differ in any value, any array ORDER, or any
//      structural change hash differently.
//
// The algorithm is intentionally simple:
//   parse YAML (if given a string) → recursive canonicalize → JSON.stringify
//   → SHA256(hex). Canonicalize means: sort object keys, recurse into
//   values, leave arrays in their original order (array order carries
//   pipeline semantics — stages run in order, writes accumulate in order).
//
// Deep fragment hashing (so a fragment edit bumps the pipeline version)
// lives in ./deep-hash.ts — this module stays shape-only so the two
// concerns stay testable in isolation.

import { createHash } from "node:crypto";
import { parse as parseYAML } from "yaml";

/**
 * Canonicalize an arbitrary JSON-compatible value so JSON.stringify produces
 * a deterministic string. Object keys are sorted; arrays keep their order;
 * primitives pass through unchanged.
 */
export function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const k of keys) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/**
 * Produce the canonical JSON string for a pipeline object. Exported so
 * callers (e.g. `pipeline_versions` row writer) can persist the exact
 * bytes that the hash was computed over.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * SHA-256 hex digest of the canonical JSON. Callers can pass a raw YAML
 * string or an already-parsed object. Strings are parsed with the `yaml`
 * package so the hash matches the pipeline loader's view of the file.
 */
export function canonicalHash(input: string | unknown): string {
  const parsed = typeof input === "string" ? parseYAML(input) : input;
  const json = canonicalJson(parsed);
  return createHash("sha256").update(json, "utf8").digest("hex");
}
