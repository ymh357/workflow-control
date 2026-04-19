// SQLite DDL + prepared query helpers for kernel-next IR persistence.
// See docs/kernel-next-design.md §4.1 for schema rationale.
//
// Uses node:sqlite (Node 22+ built-in), same as the rest of the codebase.
// kernel-next has its own DB file (`{data_dir}/kernel-next.db`) during spike;
// merge with main workflow.db is a post-spike decision (§11 OQ #1).

import { DatabaseSync } from "node:sqlite";

export const KERNEL_NEXT_SCHEMA = `
CREATE TABLE IF NOT EXISTS pipeline_versions (
  version_hash   TEXT PRIMARY KEY,
  pipeline_name  TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  parent_hash    TEXT REFERENCES pipeline_versions(version_hash),
  ir_json        TEXT NOT NULL,
  ts_source      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stages (
  version_hash   TEXT NOT NULL REFERENCES pipeline_versions(version_hash),
  stage_name     TEXT NOT NULL,
  stage_type     TEXT NOT NULL,
  config_json    TEXT NOT NULL,
  PRIMARY KEY (version_hash, stage_name)
);

CREATE TABLE IF NOT EXISTS ports (
  version_hash   TEXT NOT NULL,
  stage_name     TEXT NOT NULL,
  port_name      TEXT NOT NULL,
  direction      TEXT NOT NULL CHECK (direction IN ('in','out')),
  type_signature TEXT NOT NULL,
  zod_schema     TEXT,
  PRIMARY KEY (version_hash, stage_name, port_name, direction),
  FOREIGN KEY (version_hash, stage_name)
    REFERENCES stages(version_hash, stage_name)
);

-- wires: port direction match (from=out, to=in) enforced by app validator,
-- not by FK (SQLite FKs can't reference literal columns).
CREATE TABLE IF NOT EXISTS wires (
  version_hash    TEXT NOT NULL,
  from_stage      TEXT NOT NULL,
  from_port       TEXT NOT NULL,
  to_stage        TEXT NOT NULL,
  to_port         TEXT NOT NULL,
  PRIMARY KEY (version_hash, to_stage, to_port)
);

CREATE TABLE IF NOT EXISTS stage_attempts (
  attempt_id     TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL,
  version_hash   TEXT NOT NULL,
  stage_name     TEXT NOT NULL,
  attempt_idx    INTEGER NOT NULL,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER,
  status         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sa_task_stage     ON stage_attempts(task_id, stage_name, attempt_idx DESC);
CREATE INDEX IF NOT EXISTS idx_sa_version_stage  ON stage_attempts(version_hash, stage_name);

CREATE TABLE IF NOT EXISTS port_values (
  value_id       TEXT PRIMARY KEY,
  attempt_id     TEXT NOT NULL REFERENCES stage_attempts(attempt_id),
  stage_name     TEXT NOT NULL,
  port_name      TEXT NOT NULL,
  direction      TEXT NOT NULL,
  value_json     TEXT NOT NULL,
  written_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pv_port    ON port_values(stage_name, port_name, direction, written_at DESC);
CREATE INDEX IF NOT EXISTS idx_pv_attempt ON port_values(attempt_id);

CREATE TABLE IF NOT EXISTS pipeline_proposals (
  proposal_id      TEXT PRIMARY KEY,
  base_version     TEXT NOT NULL REFERENCES pipeline_versions(version_hash),
  proposed_version TEXT REFERENCES pipeline_versions(version_hash),
  actor            TEXT NOT NULL,
  status           TEXT NOT NULL,
  diagnostic_json  TEXT,
  created_at       INTEGER NOT NULL
);
`;

export function initKernelNextSchema(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(KERNEL_NEXT_SCHEMA);
}

// --- Insert helpers for a complete pipeline version (full snapshot strategy,
//     see design doc §4.1 "Versioning 策略") ---

import type { PipelineIR } from "./schema.js";

export interface PersistedPipelineVersion {
  versionHash: string;
  parentHash?: string;
  tsSource: string;
}

export function insertPipelineVersion(
  db: DatabaseSync,
  ir: PipelineIR,
  meta: PersistedPipelineVersion,
): void {
  const now = Date.now();

  // Single transaction: pipeline_versions + stages + ports + wires.
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO pipeline_versions
       (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      meta.versionHash,
      ir.name,
      now,
      meta.parentHash ?? null,
      JSON.stringify(ir),
      meta.tsSource,
    );

    const insertStage = db.prepare(
      `INSERT INTO stages (version_hash, stage_name, stage_type, config_json)
       VALUES (?, ?, ?, ?)`,
    );
    const insertPort = db.prepare(
      `INSERT INTO ports
       (version_hash, stage_name, port_name, direction, type_signature, zod_schema)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertWire = db.prepare(
      `INSERT INTO wires
       (version_hash, from_stage, from_port, to_stage, to_port)
       VALUES (?, ?, ?, ?, ?)`,
    );

    for (const stage of ir.stages) {
      insertStage.run(meta.versionHash, stage.name, stage.type, JSON.stringify(stage.config));
      for (const p of stage.inputs) {
        insertPort.run(meta.versionHash, stage.name, p.name, "in", p.type, p.zod ?? null);
      }
      for (const p of stage.outputs) {
        insertPort.run(meta.versionHash, stage.name, p.name, "out", p.type, p.zod ?? null);
      }
    }
    for (const w of ir.wires) {
      insertWire.run(meta.versionHash, w.from.stage, w.from.port, w.to.stage, w.to.port);
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function getPipelineIR(db: DatabaseSync, versionHash: string): PipelineIR | null {
  const row = db.prepare(
    `SELECT ir_json FROM pipeline_versions WHERE version_hash = ?`,
  ).get(versionHash) as { ir_json: string } | undefined;
  if (!row) return null;
  return JSON.parse(row.ir_json) as PipelineIR;
}

export function listPipelineVersions(db: DatabaseSync, pipelineName?: string): string[] {
  const rows = pipelineName
    ? db.prepare(
        `SELECT version_hash FROM pipeline_versions WHERE pipeline_name = ?
         ORDER BY created_at DESC`,
      ).all(pipelineName)
    : db.prepare(
        `SELECT version_hash FROM pipeline_versions ORDER BY created_at DESC`,
      ).all();
  return (rows as Array<{ version_hash: string }>).map((r) => r.version_hash);
}
