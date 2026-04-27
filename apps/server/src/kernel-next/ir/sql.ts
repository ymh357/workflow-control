// SQLite DDL + prepared query helpers for kernel-next IR persistence.
// See docs/kernel-next-design.md §4.1 for schema rationale.
//
// Uses node:sqlite (Node 22+ built-in), same as the rest of the codebase.
// kernel-next has its own DB file (`{data_dir}/kernel-next.db`) during spike;
// merge with main workflow.db is a post-spike decision (§11 OQ #1).

import { DatabaseSync } from "node:sqlite";
import { initCatalogSchema } from "../mcp-catalog/sql.js";

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
    CHECK (status IN ('running','success','error','superseded','secret_pending')),
  kind           TEXT NOT NULL DEFAULT 'regular'
    CHECK (kind IN ('regular','fanout_element','fanout_aggregate','external','replay','dry_run')),
  -- A4 replay_stage: points to the original attempt this replay
  -- reproduces. NULL for non-replay attempts. No FK enforcement to
  -- allow replaying an attempt that has since been pruned.
  replayed_from_attempt_id TEXT,
  -- B17 full: the 0-based element index this attempt represents
  -- inside its parent fanout stage. Only populated for fanout_element
  -- rows; CHECK below enforces non-NULL whenever kind='fanout_element'.
  -- Used by orchestrateFanoutStage to skip already-succeeded indices
  -- after a hot-update migration (Roadmap §7.4 B17 full version).
  fanout_element_idx INTEGER,
  CHECK (kind != 'fanout_element' OR fanout_element_idx IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_sa_task_stage     ON stage_attempts(task_id, stage_name, attempt_idx DESC);
CREATE INDEX IF NOT EXISTS idx_sa_version_stage  ON stage_attempts(version_hash, stage_name);
-- B17 full: hot path for "which element indices already succeeded for this
-- (task, stage)?" — used by orchestrateFanoutStage on migrated re-runs.
CREATE INDEX IF NOT EXISTS idx_sa_fanout_success
  ON stage_attempts(task_id, stage_name, fanout_element_idx)
  WHERE kind = 'fanout_element' AND status = 'success';

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
  status           TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  diagnostic_json  TEXT,
  created_at       INTEGER NOT NULL,
  -- A8 (§10.5 step 1): the stage name to rewind to when the proposal
  -- is approved + migrated. NULL means "apply to future work only;
  -- do not rewind". Populated by propose_pipeline_change.
  rerun_from       TEXT,
  -- A8 (§10.1): optional opt-in list of running taskIds to migrate.
  -- Stored as JSON — either "all" (string), "none" (string, default),
  -- or a JSON array of taskIds. kernel-next defaults to 'none' per
  -- §10.1; callers must explicitly opt in.
  migrate_running  TEXT
);
-- listProposals filters by status and orders by created_at DESC; this
-- composite index supports the "newest pending first" hot path.
CREATE INDEX IF NOT EXISTS idx_pp_status_created
  ON pipeline_proposals(status, created_at DESC);

-- gate_queue: one row per gate activation (terminal-design §3.3 / §8.1).
-- A gate is created when a gate-type stage enters its executing substate;
-- answer_gate fills in answer + answered_at and the machine advances.
CREATE TABLE IF NOT EXISTS gate_queue (
  gate_id         TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL,
  stage_name      TEXT NOT NULL,
  attempt_id      TEXT NOT NULL REFERENCES stage_attempts(attempt_id),
  question_json   TEXT NOT NULL,
  answer          TEXT,
  answered_at     INTEGER,
  created_at      INTEGER NOT NULL
);
-- listGates filters by task_id (and optionally answered/unanswered); this
-- index supports the get_task_status hot path.
CREATE INDEX IF NOT EXISTS idx_gq_task_answered
  ON gate_queue(task_id, answered_at);

-- secret_gate_queue (F17, 2026-04-26): one row per stage that paused waiting
-- for MCP envKey values. Mirrors gate_queue but for secrets — no routing,
-- no reject-rollback, just "stage X needs envKeys [Y]; resolved when all keys
-- are populated in task_env_values via provide_task_secrets MCP tool".
CREATE TABLE IF NOT EXISTS secret_gate_queue (
  secret_gate_id  TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL,
  stage_name      TEXT NOT NULL,
  attempt_id      TEXT NOT NULL REFERENCES stage_attempts(attempt_id),
  required_keys   TEXT NOT NULL,
  resolved_at     INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sgq_task_resolved
  ON secret_gate_queue(task_id, resolved_at);

-- hot_update_events (A8 / §10.8): audit trail for every forward and
-- rollback migration. Written on migrateTask; supports debugging
-- ("what changed when?") and meta-analysis ("which pipelines get
-- revised frequently"). Independent of the proposal row — one
-- proposal may drive multiple migrations across different tasks.
CREATE TABLE IF NOT EXISTS hot_update_events (
  event_id         TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL,
  from_version     TEXT NOT NULL,
  to_version       TEXT NOT NULL,
  actor            TEXT NOT NULL,
  proposal_id      TEXT REFERENCES pipeline_proposals(proposal_id),
  rerun_from_stage TEXT,
  status           TEXT NOT NULL CHECK (status IN ('success','failed','rolled_back')),
  started_at       INTEGER NOT NULL,
  finished_at      INTEGER,
  diagnostic_json  TEXT
);
CREATE INDEX IF NOT EXISTS idx_hue_task_started
  ON hot_update_events(task_id, started_at DESC);

-- migration_hints (B9): carries context from a superseded attempt to
-- its successor attempt after a hot-update migration. Written by the
-- migration orchestrator right after supersede; read (and marked
-- consumed) by RealStageExecutor when it opens the replacement attempt.
--
-- Primary value: the previous_diff_text column gives the successor
-- agent a view of what the superseded agent had changed on the
-- worktree so far, so it can incorporate or diverge intentionally.
-- Completion of full B9 (git reset to before_sha) requires task-worktree
-- lifecycle machinery which is out of scope here — see Phase 5C.
CREATE TABLE IF NOT EXISTS migration_hints (
  hint_id              TEXT PRIMARY KEY,
  task_id              TEXT NOT NULL,
  stage_name           TEXT NOT NULL,
  from_version         TEXT NOT NULL,
  to_version           TEXT NOT NULL,
  previous_attempt_id  TEXT,
  previous_diff_text   TEXT,
  previous_diff_bytes  INTEGER,
  note                 TEXT,
  created_at           INTEGER NOT NULL,
  consumed_at          INTEGER
);

-- Hot path: RealStageExecutor fetches the most recent unconsumed hint
-- for (task_id, stage_name) when opening an attempt.
CREATE INDEX IF NOT EXISTS idx_mh_task_stage_unconsumed
  ON migration_hints(task_id, stage_name)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS prompt_contents (
  content_hash TEXT PRIMARY KEY,
  content      TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pipeline_prompt_refs (
  version_hash TEXT NOT NULL REFERENCES pipeline_versions(version_hash) ON DELETE RESTRICT,
  prompt_ref   TEXT NOT NULL,
  content_hash TEXT NOT NULL REFERENCES prompt_contents(content_hash) ON DELETE RESTRICT,
  PRIMARY KEY (version_hash, prompt_ref)
);

CREATE INDEX IF NOT EXISTS idx_ppr_content
  ON pipeline_prompt_refs(content_hash);

CREATE TABLE IF NOT EXISTS agent_execution_details (
  attempt_id           TEXT PRIMARY KEY
                       REFERENCES stage_attempts(attempt_id) ON DELETE RESTRICT,

  prompt_ref           TEXT NOT NULL,
  prompt_content_hash  TEXT NOT NULL
                       REFERENCES prompt_contents(content_hash) ON DELETE RESTRICT,
  prompt_content       TEXT NOT NULL,
  model                TEXT NOT NULL,
  sub_agents_json      TEXT,

  tool_calls_json      TEXT NOT NULL DEFAULT '[]',
  agent_stream_json    TEXT NOT NULL DEFAULT '[]',
  compact_events_json  TEXT NOT NULL DEFAULT '[]',

  cost_usd             REAL,
  token_input          INTEGER,
  token_output         INTEGER,
  -- Prompt-cache token accounting from the Claude Agent SDK result
  -- message. SDK v0.2.63 + bundled CLI auto-enables prompt caching
  -- (verified 2026-04-25 probe: 5x cost drop warm vs cold, 1h TTL).
  -- These fields are the hard ground truth for cache hit rate; both
  -- nullable because they are only meaningful for agent stages that
  -- actually reached a result SDK message.
  cache_read_input_tokens     INTEGER,
  cache_creation_input_tokens INTEGER,
  session_id           TEXT,
  duration_ms          INTEGER,

  started_at           INTEGER NOT NULL,
  ended_at             INTEGER,
  termination_reason   TEXT
                       CHECK (termination_reason IS NULL
                              OR termination_reason IN
                              ('natural_completion','interrupted','error','superseded')),
  last_heartbeat_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_aed_prompt_hash
  ON agent_execution_details(prompt_content_hash);
CREATE INDEX IF NOT EXISTS idx_aed_open
  ON agent_execution_details(last_heartbeat_at)
  WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS stage_checkpoints (
  attempt_id          TEXT PRIMARY KEY
                      REFERENCES stage_attempts(attempt_id) ON DELETE CASCADE,
  workdir             TEXT NOT NULL,
  before_sha          TEXT,
  after_sha           TEXT,
  diff_text           TEXT,
  diff_bytes          INTEGER,
  status              TEXT NOT NULL CHECK (status IN (
                        'capturing',
                        'captured',
                        'before_failed',
                        'after_failed',
                        'not_a_repo',
                        'disabled',
                        'diff_too_large'
                      )),
  diagnostic          TEXT,
  captured_before_at  INTEGER NOT NULL,
  captured_after_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sc_status
  ON stage_checkpoints(status);
CREATE INDEX IF NOT EXISTS idx_sc_has_diff
  ON stage_checkpoints(attempt_id)
  WHERE diff_text IS NOT NULL;

-- Sidecar for script stage attempts. Parallel to agent_execution_details,
-- captures the execution trail of a ScriptStage attempt. Written by the
-- script-execution-record-writer module; read by debug / replay tooling.
--
-- stdout/stderr/exit_code are pre-provisioned for future script executor
-- modes (ctx.logger, child_process.spawn). Current TS-function ScriptModule
-- leaves them NULL. Do not remove these columns just because the current
-- executor does not populate them.
CREATE TABLE IF NOT EXISTS script_execution_details (
  attempt_id         TEXT PRIMARY KEY
                     REFERENCES stage_attempts(attempt_id) ON DELETE RESTRICT,

  module_id          TEXT NOT NULL,
  inputs_json        TEXT NOT NULL DEFAULT '{}',
  outputs_json       TEXT NOT NULL DEFAULT '{}',

  stdout             TEXT,
  stderr             TEXT,
  exit_code          INTEGER,

  error_message      TEXT,
  error_stack        TEXT,

  duration_ms        INTEGER,
  started_at         INTEGER NOT NULL,
  ended_at           INTEGER,

  termination_reason TEXT
                     CHECK (termination_reason IS NULL
                            OR termination_reason IN
                              ('natural_completion','error','module_not_found','superseded'))
);

CREATE INDEX IF NOT EXISTS idx_sed_module
  ON script_execution_details(module_id);
CREATE INDEX IF NOT EXISTS idx_sed_open
  ON script_execution_details(started_at)
  WHERE ended_at IS NULL;

-- Phase 5C worktree ownership contract (W1). One row per task that
-- has ever had a workdir allocated. PK on task_id: a single task
-- owns at most one workdir over its whole lifetime (migration /
-- resume reuse the same row, last_used_at bumped). status disting-
-- uishes active (worktree exists + usable), unavailable (git setup
-- failed, caller falls back to no-checkpoint mode), pruned (user
-- removed workdir; branch may or may not still exist).
CREATE TABLE IF NOT EXISTS task_worktrees (
  task_id       TEXT PRIMARY KEY,
  workdir       TEXT NOT NULL,
  base_branch   TEXT,
  branch_name   TEXT NOT NULL,
  status        TEXT NOT NULL
    CHECK (status IN ('active','unavailable','pruned')),
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER NOT NULL,
  diagnostic    TEXT
);
CREATE INDEX IF NOT EXISTS idx_tw_status
  ON task_worktrees(status);

-- Phase 6 P6-1: authoritative task-level final state.
--
-- Prior design derived task status from stage_attempts latest-per-stage.
-- That path silently mis-reports 'completed' when runPipeline exits
-- abnormally (timeout / thrown error) before every declared stage has
-- been visited — the DB only has rows for the stages that actually ran,
-- and "no running, no error" is indistinguishable from "all done".
--
-- task_finals is the single source of truth for "did this task reach a
-- terminal state, and if so which one". runner.finally writes exactly
-- one row per task_id on termination. getTaskStatus reads this table
-- first; the stage_attempts-derived path is the fallback for in-flight
-- tasks (no row yet) and for legacy rows written before this table
-- existed.
CREATE TABLE IF NOT EXISTS task_finals (
  task_id       TEXT PRIMARY KEY,
  version_hash  TEXT NOT NULL,
  final_state   TEXT NOT NULL
    CHECK (final_state IN ('completed','failed','cancelled')),
  reason        TEXT NOT NULL
    CHECK (reason IN ('natural','timeout','interrupted','error','thrown','cancelled')),
  detail        TEXT,
  ended_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tf_ended
  ON task_finals(ended_at DESC);

-- Phase 3 P3.3: per-task env variable values supplied at run_pipeline time.
-- Used to expand $\{VAR} placeholders in stage.config.mcpServers (P3.5).
-- Lifetime: populated on task creation (P3.4); deleted on task termination (P3.6).
-- task_id is a free-form key (no canonical tasks table); matches the convention
-- used by task_finals, task_worktrees, stage_attempts, etc.
CREATE TABLE IF NOT EXISTS task_env_values (
  task_id    TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, key)
);
CREATE INDEX IF NOT EXISTS idx_tev_task ON task_env_values(task_id);

-- Single-session mode observability (Task 11). Each row is one
-- continuous SDK segment: stages sharing one session_id within one task,
-- with their stage path and aggregate token usage. Excludes size-1
-- segments (multi-mode equivalent). Used to verify single-session
-- canaries are actually winning vs multi (run same workload twice,
-- compare segment_input_tokens). Per spec §9.
-- Use DROP+CREATE rather than CREATE IF NOT EXISTS so view evolution
-- (definition changes between releases) takes effect on next schema init
-- without needing manual db surgery. Views carry no state — re-creating
-- one is free.
DROP VIEW IF EXISTS v_segment_continuity;
CREATE VIEW v_segment_continuity AS
SELECT
  ordered.task_id                                 AS task_id,
  ordered.session_id                              AS session_id,
  COUNT(*)                                        AS stages_in_segment,
  GROUP_CONCAT(ordered.stage_name, '->')          AS stage_path,
  SUM(ordered.token_input)                        AS segment_input_tokens,
  SUM(ordered.cache_read_input_tokens)            AS segment_cache_reads,
  SUM(ordered.cache_creation_input_tokens)        AS segment_cache_creates
FROM (
  -- Inner subquery sorted by started_at so GROUP_CONCAT below produces
  -- the stage_path in chronological execution order. SQLite documents
  -- that GROUP_CONCAT preserves the input-row order from a sorted
  -- subquery (idiomatic; same pattern used elsewhere in this codebase
  -- for ordered aggregation).
  SELECT
    sa.task_id, aed.session_id, sa.stage_name,
    aed.token_input, aed.cache_read_input_tokens, aed.cache_creation_input_tokens,
    aed.started_at
  FROM agent_execution_details aed
  JOIN stage_attempts sa ON sa.attempt_id = aed.attempt_id
  WHERE aed.session_id IS NOT NULL
  ORDER BY aed.started_at
) AS ordered
GROUP BY ordered.task_id, ordered.session_id
HAVING COUNT(*) > 1;
`;

export function initKernelNextSchema(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  // B17 full: zero-historical-compat drop+rebuild trigger. If
  // stage_attempts exists but lacks fanout_element_idx, this is a
  // pre-B17 kernel-next.db (dev cache). Per CLAUDE.md §Retired areas,
  // kernel-next promises no task-data migration across schema evolutions
  // — wipe every kernel-next table so CREATE TABLE IF NOT EXISTS below
  // rebuilds from scratch with the current schema + CHECK constraints.
  //
  // Guarded by pragma check so fresh in-memory DBs used by unit tests
  // pay zero cost (no stage_attempts row → no columns to inspect).
  const saExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='stage_attempts'`,
  ).get() as { name: string } | undefined;
  if (saExists) {
    const cols = db.prepare(`PRAGMA table_info(stage_attempts)`).all() as Array<{ name: string }>;
    const hasFanoutIdx = cols.some((c) => c.name === "fanout_element_idx");
    if (!hasFanoutIdx) {
      // Drop in FK-dependency-safe order. foreign_keys=ON is set above;
      // disable temporarily so the drops don't cascade-reject.
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec(`
        DROP TABLE IF EXISTS task_finals;
        DROP TABLE IF EXISTS task_worktrees;
        DROP TABLE IF EXISTS script_execution_details;
        DROP TABLE IF EXISTS stage_checkpoints;
        DROP TABLE IF EXISTS agent_execution_details;
        DROP TABLE IF EXISTS pipeline_prompt_refs;
        DROP TABLE IF EXISTS prompt_contents;
        DROP TABLE IF EXISTS migration_hints;
        DROP TABLE IF EXISTS hot_update_events;
        DROP TABLE IF EXISTS secret_gate_queue;
        DROP TABLE IF EXISTS gate_queue;
        DROP TABLE IF EXISTS pipeline_proposals;
        DROP TABLE IF EXISTS port_values;
        DROP TABLE IF EXISTS stage_attempts;
        DROP TABLE IF EXISTS wires;
        DROP TABLE IF EXISTS ports;
        DROP TABLE IF EXISTS stages;
        DROP TABLE IF EXISTS pipeline_versions;
      `);
      db.exec("PRAGMA foreign_keys = ON");
    }
  }

  // F17: zero-historical-compat drop+rebuild trigger. If stage_attempts exists
  // but secret_gate_queue does not, this is a pre-F17 dev DB. Drop
  // secret_gate_queue (safe no-op) and stage_attempts (to pick up the new
  // 'secret_pending' value in the status CHECK — SQLite cannot ALTER a CHECK).
  // stage_attempts is re-created by db.exec(KERNEL_NEXT_SCHEMA) below.
  const sgqExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='secret_gate_queue'`,
  ).get() as { name: string } | undefined;
  if (saExists && !sgqExists) {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(`
      DROP TABLE IF EXISTS secret_gate_queue;
      DROP TABLE IF EXISTS stage_attempts;
    `);
    db.exec("PRAGMA foreign_keys = ON");
  }

  db.exec(KERNEL_NEXT_SCHEMA);
  initCatalogSchema(db);
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
      `INSERT OR IGNORE INTO pipeline_versions
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
      `INSERT OR IGNORE INTO stages (version_hash, stage_name, stage_type, config_json)
       VALUES (?, ?, ?, ?)`,
    );
    const insertPort = db.prepare(
      `INSERT OR IGNORE INTO ports
       (version_hash, stage_name, port_name, direction, type_signature, zod_schema)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertWire = db.prepare(
      `INSERT OR IGNORE INTO wires
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
      // Bridge: Task 1.2 introduced WireSource discriminated union. Task 1.3+
      // will add source-aware persistence (or a dedicated wires.source column).
      const fromStage = w.from.source === "external" ? "__external__" : w.from.stage;
      insertWire.run(meta.versionHash, fromStage, w.from.port, w.to.stage, w.to.port);
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

export function insertPromptContent(
  db: DatabaseSync,
  contentHash: string,
  content: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO prompt_contents (content_hash, content, created_at)
     VALUES (?, ?, ?)`,
  ).run(contentHash, content, Date.now());
}

export function insertPromptRefs(
  db: DatabaseSync,
  versionHash: string,
  refs: Record<string, string>,
): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO pipeline_prompt_refs (version_hash, prompt_ref, content_hash)
     VALUES (?, ?, ?)`,
  );
  for (const [ref, contentHash] of Object.entries(refs)) {
    stmt.run(versionHash, ref, contentHash);
  }
}

export function getPromptContent(
  db: DatabaseSync,
  contentHash: string,
): string | null {
  const row = db
    .prepare(`SELECT content FROM prompt_contents WHERE content_hash = ?`)
    .get(contentHash) as { content: string } | undefined;
  return row ? row.content : null;
}

/**
 * Return the full promptRef -> content map for a pipeline version.
 * Used by propose() to carry the base version's prompts forward onto
 * the newly proposed version when the caller doesn't supply their own
 * prompts map. Without carry, the DbPromptResolver on the new version
 * would raise "promptRef not found" at every resume / migrate
 * attempt.
 */
export function getPromptsByVersion(
  db: DatabaseSync,
  versionHash: string,
): Record<string, string> {
  const rows = db
    .prepare(
      `SELECT ppr.prompt_ref, pc.content
       FROM pipeline_prompt_refs ppr
       JOIN prompt_contents pc ON pc.content_hash = ppr.content_hash
       WHERE ppr.version_hash = ?`,
    )
    .all(versionHash) as Array<{ prompt_ref: string; content: string }>;
  const out: Record<string, string> = {};
  for (const r of rows) out[r.prompt_ref] = r.content;
  return out;
}

export function getLatestVersionHashByName(
  db: DatabaseSync,
  pipelineName: string,
): string | null {
  const row = db
    .prepare(
      `SELECT version_hash FROM pipeline_versions
       WHERE pipeline_name = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(pipelineName) as { version_hash: string } | undefined;
  return row ? row.version_hash : null;
}
