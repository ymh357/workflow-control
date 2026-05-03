# Forge — Session Mining (Claude Code → Pipeline)

**Status**: design ready, not implemented
**Date**: 2026-05-04
**Continuation**: c12+ (post pipeline export/import 1.28)
**Branch**: `session-mining` (worktree `/Users/minghao/workflow-control-session-mining`)

---

## Problem

Today the user has to *think* about what work is repeatable enough to
deserve a pipeline. The path is:

1. user notices a manual chore feels repetitive
2. user describes it to `pipeline-generator`
3. pipeline-generator emits an IR
4. user reviews + adopts

Step 1 is the bottleneck. Repetitive work goes unnoticed because the
user is in flow. As a result, hand-built pipelines under-cover the
real "things I keep doing" surface, and `pipeline-generator` only ever
sees the small fraction of tasks the user *consciously* labels as
"this is reusable".

The real working signal — *what the user actually does in Claude Code
day-to-day* — is already captured by Claude Code itself in
`~/.claude-personal/projects/<encoded-cwd>/<session-id>.jsonl`. Every
turn, every tool call, every result lands in that JSONL with full
fidelity. We have an exhaustive log of "what the user did" but
nothing turns it into "what the user could automate."

## Goal

**Forge** mines Claude Code session logs continuously and surfaces
*adopt-ready pipelines* the user can run with one click. Concretely:

- A user finishes a session in Claude Code (anywhere on their machine,
  in any project).
- The session JSONL is automatically ingested into a Forge index.
- A distillation agent reads the session and extracts zero, one, or
  several **episodes** — coherent task units with intent + steps +
  outcome.
- Episodes are embedded and clustered. When ≥ N similar episodes
  appear across multiple distinct sessions and ≥ M distinct days,
  Forge fires a synthesis run.
- Synthesis hands the cluster's collected episodes to
  `pipeline-generator` and produces a `PipelineCandidate` (full IR +
  prompts + dry-run results).
- The user opens `/forge` in the dashboard, reviews the candidate's
  IR / sample inputs / dry-run output, edits if desired, and clicks
  **Adopt**. Adopt routes through `submit_pipeline` and the candidate
  becomes a real, runnable pipeline — same as anything else in the
  system.

The user never has to *think* "should I make a pipeline of this." The
system makes the proposal; the user just decides yes/no.

## Non-goals

- **No auto-adoption**. Forge produces candidates. Promotion to
  `pipeline_versions` always requires explicit user approval.
- **No real-time monitoring of active sessions**. Forge processes a
  session only after it has been *quiescent* for ≥ 5 minutes
  (heuristic for "session over").
- **No multi-user / cross-machine mining**. Forge is local-only,
  reads one user's `~/.claude-personal/projects/`. Cross-user pipeline
  sharing keeps using the 1.28 export/import path.
- **No third-party LLM agents**. Distillation runs through
  kernel-next as a builtin pipeline (`forge-distill`) — same engine,
  same audit, same cost tracking.
- **No replay-based pipeline extraction** (i.e., reconstructing the
  IR from raw tool calls). Distillation is *interpretive* (LLM
  summarizes intent + structure) not *mechanical* (replay the
  recorded tool sequence verbatim).

  > Rationale: tool calls in a session are full of dead ends, retries,
  > and "let me check first" detours. A literal replay would produce a
  > pipeline that re-does all the user's mistakes. Interpretive
  > distillation lets the LLM recognize "the user meant to do X" and
  > emit a clean IR for X.

- **No automatic deletion of session JSONL files** by Forge. We index,
  we don't garbage-collect Claude Code's data.

## Architecture overview

```
Claude Code (per-project session JSONL)
        │
        ▼
File watcher  ──►  jsonl tail (resumable offset)
        │
        ▼
Parser + Redactor  ──►  forge.db (sessions, session_events)
        │
        ▼ debounce 5 min idle
Daemon queue
        │
        ▼
forge-distill builtin pipeline (kernel-next runtime)
        │
        ▼
Episode extractor  ──►  forge.db (session_episodes, episode_signatures)
        │
        ▼
Embedding + clusterer  ──►  forge.db (episode_clusters)
        │
        ▼  cluster threshold met
candidate-builder  ──►  pipeline-generator (kernel-next runtime)
        │
        ▼
PipelineCandidate (forge.db) — IR + prompts + dry-run output
        │
        ▼  user clicks Adopt at /forge
promote → submit_pipeline → pipeline_versions  (existing path, unchanged)
```

Every arrow above is one module with one responsibility (file
breakdown in §Module organization).

## Storage: `forge.db`

A new SQLite file, **physically separate** from `kernel-next.db`.
Rationale: Forge's data is high-volume (every JSONL line a row),
short-TTL (we don't need historical events forever), and its schema
will evolve faster than kernel-next's. Mixing them would couple
release cadence and complicate `prune-records`.

Path: `${data_dir}/forge.db` (alongside `kernel-next.db`).

### Tables

```sql
-- 1. The set of sessions Forge has seen.
CREATE TABLE sessions (
  session_id        TEXT PRIMARY KEY,         -- Claude Code's UUID
  cwd               TEXT NOT NULL,            -- project path (decoded)
  jsonl_path        TEXT NOT NULL,
  byte_offset       INTEGER NOT NULL DEFAULT 0,  -- tail resume cursor
  first_seen_at     INTEGER NOT NULL,
  last_event_at     INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK(status IN
    ('active','quiescent','distilled','distillation_failed','skipped')),
  event_count       INTEGER NOT NULL DEFAULT 0,
  -- Reasons we skip a session up-front (e.g., < 3 turns, all sidechain,
  -- explicit user opt-out). NULL when not skipped.
  skip_reason       TEXT
);

CREATE INDEX idx_sessions_status ON sessions(status, last_event_at);

-- 2. Per-line events. We persist a normalized projection of the JSONL,
-- not the raw line, because (a) raw lines can carry secrets and (b)
-- the storage cost of full JSONL doubles disk usage for negligible
-- analytic benefit. The original JSONL stays on disk; we are an index.
CREATE TABLE session_events (
  session_id    TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,           -- monotonic per session
  ts            INTEGER NOT NULL,
  role          TEXT NOT NULL CHECK(role IN ('user','assistant','tool_use','tool_result','system')),
  -- Brief, redacted text content (≤ 4 KB). We deliberately do NOT
  -- store full tool I/O; long content is hash-only with the offset
  -- preserved so distillation can re-read on demand.
  text_excerpt  TEXT,
  text_hash     TEXT,                       -- sha256 of full original text
  text_length   INTEGER,                    -- full original length
  tool_name     TEXT,                       -- tool_use only
  tool_args_excerpt TEXT,                   -- tool_use, redacted, ≤ 1 KB
  PRIMARY KEY (session_id, seq)
);

CREATE INDEX idx_session_events_role ON session_events(session_id, role);

-- 3. Distillation output: episodes (a session can yield 0..N).
CREATE TABLE session_episodes (
  episode_id        TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  -- Range within the session this episode covers.
  start_seq         INTEGER NOT NULL,
  end_seq           INTEGER NOT NULL,
  intent            TEXT NOT NULL,          -- 1-sentence "what the user wanted"
  outcome           TEXT NOT NULL CHECK(outcome IN
    ('completed','abandoned','partial','exploratory')),
  -- Structured "steps" produced by the distillation agent.
  -- JSON array of { stage_kind: "agent"|"tool"|"decision",
  --                 description: string,
  --                 inputs?: string[], outputs?: string[],
  --                 tool_calls?: string[] }
  steps_json        TEXT NOT NULL,
  -- Free-form rationale: why this is or isn't pipeline-able.
  rationale         TEXT NOT NULL,
  pipeline_able     INTEGER NOT NULL,        -- 0/1; LLM verdict
  created_at        INTEGER NOT NULL
);

CREATE INDEX idx_episodes_pipeline_able ON session_episodes(pipeline_able);

-- 4. Embeddings for similarity search. Stored as BLOB (Float32 LE).
CREATE TABLE episode_signatures (
  episode_id      TEXT PRIMARY KEY REFERENCES session_episodes(episode_id) ON DELETE CASCADE,
  embedding       BLOB NOT NULL,            -- Float32 vector
  embedding_model TEXT NOT NULL,            -- e.g. 'voyage-3'
  embedding_dim   INTEGER NOT NULL,
  -- Cheap pre-filter signature: top-3 nouns / verbs from intent +
  -- canonicalized tool-name set. Used as cluster invariant key.
  signature_key   TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE INDEX idx_signatures_key ON episode_signatures(signature_key);

-- 5. Clusters: a set of episodes the system considers "the same kind
-- of work". A cluster is membership-only; merging logic in code.
CREATE TABLE episode_clusters (
  cluster_id      TEXT PRIMARY KEY,
  centroid_blob   BLOB NOT NULL,            -- mean of member embeddings
  centroid_model  TEXT NOT NULL,            -- must match members'
  member_count    INTEGER NOT NULL,
  distinct_session_count INTEGER NOT NULL,
  distinct_day_count     INTEGER NOT NULL,
  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  -- Lifecycle:
  --   forming  : not yet at threshold, may grow
  --   ripe     : threshold met, awaiting synthesis
  --   synthesized : a candidate has been generated for this cluster
  --   adopted  : user adopted; cluster locks (further episodes still tracked)
  --   dismissed: user dismissed candidate; cluster suppressed for 14 days
  status          TEXT NOT NULL CHECK(status IN
    ('forming','ripe','synthesized','adopted','dismissed')),
  suppressed_until INTEGER                  -- nullable; epoch ms
);

CREATE TABLE cluster_members (
  cluster_id    TEXT NOT NULL REFERENCES episode_clusters(cluster_id) ON DELETE CASCADE,
  episode_id    TEXT NOT NULL REFERENCES session_episodes(episode_id) ON DELETE CASCADE,
  added_at      INTEGER NOT NULL,
  cosine        REAL NOT NULL,              -- similarity at admission
  PRIMARY KEY (cluster_id, episode_id)
);

CREATE INDEX idx_cluster_members_episode ON cluster_members(episode_id);

-- 6. Pipeline candidates: synthesis output awaiting user adoption.
CREATE TABLE pipeline_candidates (
  candidate_id    TEXT PRIMARY KEY,
  cluster_id      TEXT NOT NULL REFERENCES episode_clusters(cluster_id) ON DELETE RESTRICT,
  -- The IR + prompts produced by pipeline-generator. Stored as JSON
  -- so the user can preview, edit, and re-dry-run in the UI without
  -- another synthesis round-trip.
  ir_json         TEXT NOT NULL,
  prompts_json    TEXT NOT NULL,            -- {promptRef: content}
  -- Dry-run: forge runs the candidate against one episode's inputs
  -- to surface "would this actually run?" diagnostics before the user
  -- is asked to adopt.
  dry_run_status  TEXT NOT NULL CHECK(dry_run_status IN
    ('pending','passed','failed','skipped')),
  dry_run_diagnostics_json TEXT,            -- nullable
  -- Synthesis provenance.
  synth_task_id   TEXT,                     -- the kernel-next task that ran pipeline-generator
  generated_at    INTEGER NOT NULL,
  -- Adoption / dismissal trail.
  adopted_version_hash TEXT,                -- set when user adopts
  adopted_at      INTEGER,
  dismissed_at    INTEGER,
  dismissed_reason TEXT
);

CREATE INDEX idx_candidates_cluster ON pipeline_candidates(cluster_id);
CREATE INDEX idx_candidates_status ON pipeline_candidates(dry_run_status, adopted_at, dismissed_at);
```

All Forge tables foreign-key into themselves; nothing in
`kernel-next.db` references Forge. The reverse — Forge's
`adopted_version_hash` referencing `pipeline_versions.version_hash` —
is intentionally a *loose* reference (no FK across DB files), checked
at adopt time only. This keeps the DBs decoupled.

## Components

### 1. Ingestion

**`apps/server/src/forge/ingestion/jsonl-tail.ts`** — given a session
path + last byte offset, reads new lines, returns parsed events +
new offset. Handles partial-line writes (line not yet terminated by
`\n`) by stopping at the last complete `\n` and reporting the offset
of the final byte consumed. Resumable: if the daemon restarts mid-tail,
the saved `byte_offset` in `sessions` lets us pick up where we left
off, never re-emit, never miss.

**`apps/server/src/forge/ingestion/watcher.ts`** — uses Node's
`fs.watch` (recursive on the projects dir) plus a 250 ms per-file
debounce. On a fired event, looks up or inserts a `sessions` row,
then dispatches a `tail` job to the daemon queue. Sets `status =
'active'`. A separate periodic sweep (every 60 s) flips `active →
quiescent` for sessions whose `last_event_at < now - 5 min`.

**`apps/server/src/forge/ingestion/parser.ts`** — pure function
`parseLine(raw: string): SessionEvent | null`. Returns `null` for
non-content lines (permission-mode, hook outputs we don't care about);
returns a `SessionEvent` for user/assistant/tool_use/tool_result.
Schema-validated by zod at the boundary.

**`apps/server/src/forge/ingestion/redactor.ts`** — pure function
`redact(text: string): { redacted: string, hits: RedactionHit[] }`.
Patterns: `ghp_[A-Za-z0-9]+`, `sk-[A-Za-z0-9-_]{20,}`, `xoxb-…`,
`AKIA[0-9A-Z]{16}`, `Bearer [A-Za-z0-9._~+/=-]{20,}`, plus all
known `SETTING_*` / known token env values present in `process.env`
at startup. Replacement format: `<REDACTED:<kind>>` so a downstream
reader can see *that* redaction occurred without seeing the value.
Redaction runs **before** any text touches `forge.db` and **before**
any text leaves the local server (to embedding API).

### 2. Distillation

**`apps/server/src/builtin-pipelines/forge-distill/pipeline.ir.json`**
— a new builtin pipeline. Three stages, single-session mode:

1. `chunkTriage` (agent) — given the session events, decides whether
   the session is worth distilling at all (≥ 3 user turns, contains
   at least one tool use, not pure exploratory chitchat). Outputs
   `{ proceed: bool, reason: string }`.
2. `episodeExtract` (agent) — receives the events; emits a JSON
   array of `Episode { intent, start_seq, end_seq, steps, outcome,
   pipeline_able, rationale }`. The agent is allowed to emit `[]`
   (nothing pipeline-worthy). Single agent call per session, single
   model.
3. `persistEpisodes` (script) — deterministic builtin script that
   writes the output to `session_episodes`. Pure transport, no LLM
   in the loop.

**`apps/server/src/forge/distillation/submit-distill.ts`** —
orchestrates "session quiescent → distill". Builds a transient
externalInputs payload from `session_events`, calls
`run_pipeline { name: 'forge-distill', seedValues: { … } }`, polls the
resulting task, on success reads the output port and parses episodes
into `session_episodes`. On failure flips the session row to
`distillation_failed` with the diagnostic.

The distillation prompt explicitly instructs the agent to:
- ignore tool retries / errors / debugging detours
- merge consecutive related turns into single conceptual steps
- name inputs in *abstract* terms (e.g. "the file path the user wants
  to refactor" rather than the literal path observed) — this is the
  abstraction step that makes downstream pipeline synthesis possible
- output the structured JSON only, no prose wrapper

### 3. Similarity + clustering

**`apps/server/src/forge/similarity/embedding-client.ts`** —
abstraction `EmbeddingClient { embed(texts: string[]): Promise<number[][]> }`.
Default impl: Voyage AI (`voyage-3`, 1024 dims). Fallback: OpenAI
`text-embedding-3-small`. Configured via SystemSettings:
`forge.embedding.provider` + corresponding env key
(`VOYAGE_API_KEY` or `OPENAI_API_KEY`). Failure to configure → Forge
distillation still runs but clustering is skipped (status stays at
`forming` with embedding-pending flag).

**`apps/server/src/forge/similarity/cluster.ts`** — pure function
`assignToCluster(newEpisodeEmbedding, existingClusters):
{ clusterId: string; cosine: number } | { newCluster: true }`.
Algorithm:
1. Linear scan over `episode_clusters` (we expect O(100) clusters at
   steady state; brute force is fine).
2. Compute cosine to each centroid.
3. If max cosine ≥ **0.85** → assign to that cluster, update centroid
   incrementally (running mean).
4. Else → create new cluster (status `forming`).
5. Recompute `member_count`, `distinct_session_count`,
   `distinct_day_count` after assignment.

**`apps/server/src/forge/similarity/threshold.ts`** — pure function
`evaluateThreshold(cluster): 'forming' | 'ripe'`. Ripeness rule:
`distinct_session_count ≥ 3 AND distinct_day_count ≥ 2 AND
suppressed_until is NULL or < now`. The suppression cooldown applies
when a previous candidate from this cluster was dismissed.

### 4. Synthesis

**`apps/server/src/forge/synthesis/candidate-builder.ts`** —
constructs the `pipeline-generator` input. Takes a ripe cluster,
fetches all member episodes, and assembles a *task description* that
generalizes:

```
Across N sessions on D days, the user repeatedly performed the
following kind of work:

- session 1 (date): {intent} — {steps summary}
- session 2 (date): {intent} — {steps summary}
- ...

Write a pipeline that, given parameterized inputs corresponding to
what varied across sessions, automates this work. The variations
across sessions are:
  {automatically diff'd parameters}

Output: a complete IR + prompts that captures the abstraction.
```

The "automatically diff'd parameters" is computed by aligning steps
across episodes and noting which strings differ (the variable parts
become external inputs).

**`apps/server/src/forge/synthesis/candidate-runner.ts`** — calls
`run_pipeline { name: 'pipeline-generator' }` with the description
and a flag indicating "this is a Forge synthesis run, emit IR
directly without the interactive analysis stage" (relies on
pipeline-generator's existing `submit_pipeline_passthrough` exit
script — produces `versionHash` of a *temporary* submission). The
candidate's IR + prompts are then read back from
`pipeline_versions` and copied into `pipeline_candidates.ir_json` /
`prompts_json`. The temp submission is **not** removed (kernel-next
keeps versions; the candidate row is the user-visible representation).

**`apps/server/src/forge/synthesis/promote.ts`** — `promote(candidateId): { versionHash }`.
Steps:
1. Validate candidate state (`dry_run_status === 'passed'` or user
   override flag set).
2. Re-run `KernelService.submit(ir, { prompts })` — yes, even though
   the IR is already in `pipeline_versions` from the synthesis temp
   submit. Re-submitting ensures canonical hash recompute (and is a
   no-op if hashes match).
3. Update `pipeline_candidates.adopted_version_hash` + `adopted_at`.
4. Mark cluster `status = 'adopted'`.
5. Return `versionHash` for caller (UI redirects to
   `/kernel-next/pipelines/<name>`).

### 5. Daemon

**`apps/server/src/forge/daemon/queue.ts`** — in-memory FIFO with
worker concurrency 1. Job kinds: `tail`, `distill`, `cluster`,
`synthesize`, `dryrun`. The queue persists pending jobs to a
`forge_jobs` table on shutdown (so a restart resumes; jobs are
deduplicated by `(kind, key)`). Workers run within the server
process — no separate daemon binary.

**`apps/server/src/forge/daemon/lifecycle.ts`** — `startForge()`
called from `apps/server/src/index.ts` after kernel-next init. It:
1. opens forge.db (creating + migrating schema)
2. starts the watcher
3. starts the worker
4. registers the periodic quiescence sweeper

`stopForge()` for tests + graceful shutdown.

### 6. API

```
GET  /api/forge/sessions                  paginated list
GET  /api/forge/sessions/:id              full session + events + episodes
GET  /api/forge/episodes/:id              one episode
GET  /api/forge/clusters                  list, filterable by status
GET  /api/forge/clusters/:id              cluster + members + candidate (if any)
GET  /api/forge/candidates                list pending
GET  /api/forge/candidates/:id            full IR + prompts + dry-run output
POST /api/forge/candidates/:id/dryrun     re-run dry-run (manual trigger)
POST /api/forge/candidates/:id/adopt      → returns { versionHash }
POST /api/forge/candidates/:id/dismiss    body: { reason }
POST /api/forge/clusters/:id/suppress     14-day cooldown manual trigger
GET  /api/forge/health                    daemon status, queue depth, last error
```

All routes are `Hono` handlers under
`apps/server/src/forge/api/routes.ts`, registered in
`apps/server/src/index.ts`.

### 7. Web UI

```
/forge                  — landing: pending candidates first, then ripe
                          clusters without candidates yet, then forming
                          clusters (collapsed)
/forge/candidates/[id]  — IR preview (PipelineGraph), prompts editor,
                          dry-run results, Adopt / Dismiss buttons
/forge/sessions         — debug-mode: raw session list with events
/forge/clusters/[id]    — cluster detail: member episodes, centroid,
                          status, suppression toggle
```

Components:
- `<CandidateCard>` — header with cluster size + days, IR stage count,
  dry-run status badge, Adopt / Dismiss / View buttons.
- `<EpisodeDetail>` — intent, steps, outcome, redacted excerpt link.
- `<RedactionBadge>` — small pill rendered next to any text excerpt
  that had redactions, hover shows kinds redacted.
- `<ClusterTimeline>` — sparkline of episode arrival times, makes
  "ripeness" visually obvious.

Top nav gets a new link **Forge** between "MCP catalog" and
"proposals".

## Data flow: end to end

1. User finishes a Claude Code session at 14:32. JSONL has 87 lines.
2. Watcher catches the last write at 14:32:14, debounces 250 ms, fires
   `tail(sessionId)`. Tail reads bytes 0..end, parses 87 events,
   writes to `session_events` (with redaction). `sessions.last_event_at`
   set to 14:32:14, status `active`.
3. At 14:33:14 the periodic sweeper checks: `now - last_event_at`
   = 60 s, < 300 s → leave as `active`.
4. At 14:38 nothing else has been written to that JSONL. Sweeper at
   14:38:14: `now - last_event_at` = 360 s ≥ 300 s → flip `active →
   quiescent`, enqueue `distill(sessionId)`.
5. Worker pops `distill` job, calls
   `run_pipeline { name: 'forge-distill', seedValues: { sessionId, events: [...] } }`.
   Kernel-next creates a task, runs the 3 stages.
6. `episodeExtract` agent emits 1 episode:
   `{ intent: "extract changelog from recent commits", steps: [...],
      pipeline_able: true, rationale: "..." }`.
7. `persistEpisodes` writes the row. Worker picks it up, computes
   embedding via Voyage, writes `episode_signatures`. Calls
   `assignToCluster`. Closest existing cluster has cosine 0.91 → assign;
   that cluster's `member_count` becomes 4, `distinct_day_count` becomes 3.
8. `evaluateThreshold` returns `ripe` (was `forming`). Worker enqueues
   `synthesize(clusterId)`.
9. Synthesis worker calls `candidate-builder.ts`, builds a description
   summarizing all 4 episodes and their varying parameters, runs
   `pipeline-generator`, gets back IR + prompts, stores as
   `pipeline_candidates` row with `dry_run_status = 'pending'`.
10. Worker enqueues `dryrun(candidateId)`. Dry-run picks one episode's
    abstracted inputs, runs the candidate IR end-to-end with
    `kernel-next.run_pipeline` against a *throwaway* taskId, captures
    diagnostics (or success), stores in `dry_run_diagnostics_json`,
    flips `dry_run_status` to `passed` or `failed`.
11. Web dashboard's SSE / polling shows the candidate. User opens
    `/forge`, sees "extract-changelog (4 sessions, 3 days, dry-run
    passed)". Clicks **View**, sees the IR graph, sample input form,
    sample output. Clicks **Adopt**. `promote.ts` runs `submit_pipeline`,
    cluster flips to `adopted`, redirect to `/kernel-next/pipelines/extract-changelog`.

## Failure modes + handling

| Failure | Where | Behavior |
|---|---|---|
| JSONL malformed line | parser | log, increment `sessions.skip_reason`, drop line |
| Tail offset > file size (file truncated) | jsonl-tail | reset offset to 0, re-tail from start; mark `sessions.note` |
| `forge-distill` timeout | submit-distill | session → `distillation_failed`; retry once after 1h backoff; thereafter manual via API |
| Embedding API down | embedding-client | episode written but `episode_signatures` row absent; daemon sweep periodically retries pending |
| `pipeline-generator` produces invalid IR | candidate-runner | candidate written with `dry_run_status='failed'` and the diagnostics; user can dismiss |
| Dry-run fails | dryrun worker | candidate stays at `dry_run_status='failed'`; user can still adopt explicitly |
| Adopt: hash collision with existing pipeline | promote | `KernelService.submit` returns same `versionHash`; treat as success (idempotent) |
| User dismisses candidate | API | suppress cluster 14 days; another similar episode arriving in that window joins cluster but doesn't re-trigger synthesis |

## Security / privacy

- **Redaction at boundary.** Every byte of session text passes through
  `redactor.ts` *before* persisting to `forge.db` or leaving the
  process for any external API (embedding, distillation if cloud-based).
  The kernel-next agent itself runs locally (Claude Code subprocess);
  distillation prompts include redacted excerpts, never raw.
- **forge.db is not exported.** The 1.28 export envelope is for
  pipelines, not session data. Forge data is per-machine.
- **Embedding provider is opt-in.** If no embedding API key is
  configured, distillation still runs (episodes captured) but
  clustering is paused — the user gets a clear UI banner instead of
  silent feature failure.
- **No secret leak via candidate IR.** The pipeline-generator's IR
  output is reviewed by the user before adoption. We don't auto-adopt
  any IR, so even a worst-case "the IR contains a redacted-but-sensitive
  string" scenario is human-gated.

## Observability

- `GET /api/forge/health` returns:
  ```json
  {
    "daemon": "running",
    "watcher": "running",
    "queue": { "depth": 3, "in_progress": 1 },
    "stats": {
      "sessions_total": 142,
      "sessions_distilled": 138,
      "sessions_failed": 1,
      "episodes_total": 271,
      "clusters_total": 47,
      "clusters_ripe": 2,
      "candidates_total": 18,
      "candidates_pending_review": 2,
      "candidates_adopted": 8,
      "candidates_dismissed": 8
    },
    "last_error": null
  }
  ```
- Each daemon job emits a kernel-next SSE event
  (`forge.job.started` / `forge.job.completed` / `forge.job.failed`)
  so the dashboard can show live activity.
- A `/forge/sessions` page (debug) shows raw event counts and the
  daemon-side processing trace per session.

## Module organization (full file list)

```
apps/server/src/forge/
  types.ts                                # SessionEvent, Episode, Cluster, Candidate
  db/
    schema.ts                             # DDL + migrations
    open.ts                               # singleton DB handle
    sessions.ts                           # CRUD
    episodes.ts                           # CRUD
    clusters.ts                           # CRUD + members
    candidates.ts                         # CRUD
  ingestion/
    jsonl-tail.ts
    watcher.ts
    parser.ts
    redactor.ts
  distillation/
    submit-distill.ts                     # orchestrator
    extract.ts                            # parse pipeline output → Episode[]
  similarity/
    embedding-client.ts
    cluster.ts
    threshold.ts
  synthesis/
    candidate-builder.ts
    candidate-runner.ts
    promote.ts
  daemon/
    queue.ts
    lifecycle.ts
  api/
    routes.ts
    types.ts
  __tests__/                              # mirror layout

apps/server/src/builtin-pipelines/forge-distill/
  pipeline.ir.json
  prompts/
    chunk-triage.md
    episode-extract.md

apps/web/src/app/forge/
  page.tsx
  candidates/[id]/page.tsx
  clusters/[id]/page.tsx
  sessions/page.tsx
apps/web/src/components/forge/
  candidate-card.tsx
  episode-detail.tsx
  cluster-timeline.tsx
  redaction-badge.tsx
```

Each file is one responsibility, small enough to hold in head, tested
in isolation. The module boundary every file lives behind is
specified in §Components above.

## Testing

- **Pure-data modules** (parser, redactor, cluster, threshold,
  candidate-builder): adversarial unit tests with edge cases — empty
  input, malformed input, boundary values around the 0.85 / 3 / 2
  thresholds, redaction patterns of every supported kind including
  overlap.
- **DB modules**: `:memory:` SQLite, full lifecycle round-trip per
  table.
- **Ingestion E2E**: spin up the watcher pointing at a temp dir, write
  a synthetic JSONL stream, assert events propagate through the
  pipeline.
- **Distillation E2E**: synthetic session events → run forge-distill
  → assert `session_episodes` populated. Uses
  `MOCK_EXECUTOR=true` so no real Claude SDK call is required at CI
  time; a separate `RUN_REAL_FORGE=1` smoke test exercises the real
  agent for prompt drift detection.
- **Synthesis E2E**: builds a synthetic ripe cluster, mocks
  `pipeline-generator` output, asserts candidate row + dry-run loop.
- **API**: hono `app.fetch(new Request(...))` against in-memory DB,
  every route covered by happy + error case.
- **Web**: RTL tests for each forge component + the three pages.
- **Adversarial**: redactor must not leak any of the configured
  patterns under input fuzzing; cluster invariants
  (`distinct_session_count ≤ member_count`,
  `distinct_day_count ≤ distinct_session_count`) hold across
  arbitrary admission sequences.

## Documentation impact

- **Whitepaper §1** gets a new sub-section **§1.4 Forge** describing
  the "session → pipeline" loop. Mirrored in zh.
- **Whitepaper visuals** gets one new diagram: the 11-step end-to-end
  data flow above.
- **`docs/product-intro.md`** §"Daily flow" gains a Forge bullet.
- **Roadmap** appends row 1.29.

## Out of scope (future work)

- **Auto-adoption.** Even after we've watched a user adopt 100
  candidates without edits, the verdict stays manual. If we want to
  flip that switch later, it's a separate spec.
- **Cross-machine cluster aggregation.** Two users with similar
  workflows could in principle pool clusters; today they share via
  1.28 export/import only.
- **Replay-based extraction.** Out per §Non-goals.
- **Multi-session episodes.** An "episode" here is bounded by one
  session. Cross-session continuations are detected as separate
  episodes that cluster together — which is the desired behavior, not
  a workaround.
- **Active-session intervention.** Forge is post-hoc only. A future
  "live coach" system that suggests pipelines mid-session is a
  different product.
