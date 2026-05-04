// Forge DB schema. Single function: initForgeSchema(db) - idempotent
// (uses CREATE TABLE IF NOT EXISTS). Foreign-key cascades enabled at
// open time (open.ts), not here, because PRAGMA is connection-scoped.

import type { DatabaseSync } from "node:sqlite";

const DDL_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS sessions (
    session_id        TEXT PRIMARY KEY,
    cwd               TEXT NOT NULL,
    jsonl_path        TEXT NOT NULL,
    byte_offset       INTEGER NOT NULL DEFAULT 0,
    first_seen_at     INTEGER NOT NULL,
    last_event_at     INTEGER NOT NULL,
    status            TEXT NOT NULL CHECK(status IN
      ('active','quiescent','distilled','distillation_failed','skipped')),
    event_count       INTEGER NOT NULL DEFAULT 0,
    skip_reason       TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status, last_event_at)`,
  `CREATE TABLE IF NOT EXISTS session_events (
    session_id    TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    seq           INTEGER NOT NULL,
    ts            INTEGER NOT NULL,
    role          TEXT NOT NULL CHECK(role IN ('user','assistant','tool_use','tool_result','system')),
    text_excerpt  TEXT,
    text_hash     TEXT,
    text_length   INTEGER,
    tool_name     TEXT,
    tool_args_excerpt TEXT,
    PRIMARY KEY (session_id, seq)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_session_events_role ON session_events(session_id, role)`,
  `CREATE TABLE IF NOT EXISTS session_episodes (
    episode_id        TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    start_seq         INTEGER NOT NULL,
    end_seq           INTEGER NOT NULL,
    intent            TEXT NOT NULL,
    outcome           TEXT NOT NULL CHECK(outcome IN
      ('completed','abandoned','partial','exploratory')),
    steps_json        TEXT NOT NULL,
    rationale         TEXT NOT NULL,
    pipeline_able     INTEGER NOT NULL,
    created_at        INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_episodes_pipeline_able ON session_episodes(pipeline_able)`,
  `CREATE TABLE IF NOT EXISTS episode_signatures (
    episode_id      TEXT PRIMARY KEY REFERENCES session_episodes(episode_id) ON DELETE CASCADE,
    embedding       BLOB NOT NULL,
    embedding_model TEXT NOT NULL,
    embedding_dim   INTEGER NOT NULL,
    signature_key   TEXT NOT NULL,
    created_at      INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_signatures_key ON episode_signatures(signature_key)`,
  `CREATE TABLE IF NOT EXISTS episode_clusters (
    cluster_id      TEXT PRIMARY KEY,
    centroid_blob   BLOB NOT NULL,
    centroid_model  TEXT NOT NULL,
    member_count    INTEGER NOT NULL,
    distinct_session_count INTEGER NOT NULL,
    distinct_day_count     INTEGER NOT NULL,
    first_seen_at   INTEGER NOT NULL,
    last_seen_at    INTEGER NOT NULL,
    status          TEXT NOT NULL CHECK(status IN
      ('forming','ripe','synthesized','adopted','dismissed')),
    suppressed_until INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS cluster_members (
    cluster_id    TEXT NOT NULL REFERENCES episode_clusters(cluster_id) ON DELETE CASCADE,
    episode_id    TEXT NOT NULL REFERENCES session_episodes(episode_id) ON DELETE CASCADE,
    added_at      INTEGER NOT NULL,
    cosine        REAL NOT NULL,
    PRIMARY KEY (cluster_id, episode_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cluster_members_episode ON cluster_members(episode_id)`,
  `CREATE TABLE IF NOT EXISTS pipeline_candidates (
    candidate_id    TEXT PRIMARY KEY,
    cluster_id      TEXT NOT NULL REFERENCES episode_clusters(cluster_id) ON DELETE RESTRICT,
    ir_json         TEXT NOT NULL,
    prompts_json    TEXT NOT NULL,
    dry_run_status  TEXT NOT NULL CHECK(dry_run_status IN
      ('pending','passed','failed','skipped')),
    dry_run_diagnostics_json TEXT,
    synth_task_id   TEXT,
    generated_at    INTEGER NOT NULL,
    adopted_version_hash TEXT,
    adopted_at      INTEGER,
    dismissed_at    INTEGER,
    dismissed_reason TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_candidates_cluster ON pipeline_candidates(cluster_id)`,
  `CREATE INDEX IF NOT EXISTS idx_candidates_status ON pipeline_candidates(dry_run_status, adopted_at, dismissed_at)`,
  `CREATE TABLE IF NOT EXISTS pipeline_embeddings (
    version_hash    TEXT PRIMARY KEY,
    pipeline_name   TEXT NOT NULL,
    descriptor_text TEXT NOT NULL,
    embedding       BLOB NOT NULL,
    embedding_model TEXT NOT NULL,
    embedding_dim   INTEGER NOT NULL,
    created_at      INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pipeline_embeddings_name ON pipeline_embeddings(pipeline_name)`,
  `CREATE TABLE IF NOT EXISTS forge_jobs (
    job_id          TEXT PRIMARY KEY,
    kind            TEXT NOT NULL CHECK(kind IN ('tail','distill','cluster','synthesize','dryrun')),
    job_key         TEXT NOT NULL,
    payload_json    TEXT NOT NULL,
    enqueued_at     INTEGER NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL CHECK(status IN ('pending','in_progress','completed','failed')),
    last_error      TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_forge_jobs_dedup ON forge_jobs(kind, job_key) WHERE status IN ('pending','in_progress')`,
  `CREATE INDEX IF NOT EXISTS idx_forge_jobs_status ON forge_jobs(status, enqueued_at)`,
];

export function initForgeSchema(db: DatabaseSync): void {
  for (const stmt of DDL_STATEMENTS) {
    db.prepare(stmt).run();
  }
}
