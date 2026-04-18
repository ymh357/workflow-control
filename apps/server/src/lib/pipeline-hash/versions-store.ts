// Phase 2 / Step 2.5 — pipeline_versions table access.
//
// observePipelineVersion() upserts a row and bumps last_seen_at so the
// table acts as a hash-to-content index for every pipeline version any
// task on this machine has ever observed. Reads are by version_hash
// (direct PK lookup) or by pipeline_name (ordered listing).

import { getDb } from "../db.js";

export interface PipelineVersionRow {
  versionHash: string;
  pipelineName: string;
  canonicalJson: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface Raw {
  version_hash: string;
  pipeline_name: string;
  canonical_json: string;
  first_seen_at: string;
  last_seen_at: string;
}

function fromRow(raw: Raw): PipelineVersionRow {
  return {
    versionHash: raw.version_hash,
    pipelineName: raw.pipeline_name,
    canonicalJson: raw.canonical_json,
    firstSeenAt: raw.first_seen_at,
    lastSeenAt: raw.last_seen_at,
  };
}

/**
 * Record that a pipeline version has been observed (by a task creation,
 * migration, or replay). Upsert semantics: INSERT on first sight,
 * UPDATE last_seen_at on repeats. Returns `true` when the row is new,
 * `false` when it already existed.
 *
 * `canonicalJson` should be the exact bytes that went into the hash —
 * see canonicalJson() + collectPipelineFragmentDigest() in ./canonical.ts
 * and ./deep-hash.ts. That way the row's payload round-trips the hash.
 */
export function observePipelineVersion(input: {
  versionHash: string;
  pipelineName: string;
  canonicalJson: string;
}): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db
    .prepare(
      "SELECT version_hash FROM pipeline_versions WHERE version_hash = ?",
    )
    .get(input.versionHash) as { version_hash?: string } | undefined;
  if (existing) {
    db.prepare(
      "UPDATE pipeline_versions SET last_seen_at = ? WHERE version_hash = ?",
    ).run(now, input.versionHash);
    return false;
  }
  db.prepare(
    `INSERT INTO pipeline_versions (version_hash, pipeline_name, canonical_json, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    input.versionHash,
    input.pipelineName,
    input.canonicalJson,
    now,
    now,
  );
  return true;
}

export function getPipelineVersion(
  versionHash: string,
): PipelineVersionRow | null {
  const row = getDb()
    .prepare("SELECT * FROM pipeline_versions WHERE version_hash = ?")
    .get(versionHash) as Raw | undefined;
  return row ? fromRow(row) : null;
}

export function listPipelineVersions(options: {
  pipelineName?: string;
  limit?: number;
} = {}): PipelineVersionRow[] {
  const db = getDb();
  const limit = options.limit ?? 100;
  if (options.pipelineName) {
    const rows = db
      .prepare(
        `SELECT * FROM pipeline_versions
         WHERE pipeline_name = ?
         ORDER BY last_seen_at DESC
         LIMIT ?`,
      )
      .all(options.pipelineName, limit) as unknown as Raw[];
    return rows.map(fromRow);
  }
  const rows = db
    .prepare(
      `SELECT * FROM pipeline_versions
       ORDER BY last_seen_at DESC
       LIMIT ?`,
    )
    .all(limit) as unknown as Raw[];
  return rows.map(fromRow);
}

export function deletePipelineVersion(versionHash: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM pipeline_versions WHERE version_hash = ?")
    .run(versionHash);
  return (result.changes as number) > 0;
}
