# Forge — Revised Direction (User-Triggered)

**Status**: revised spec; supersedes the daemon-based architecture in
`2026-05-04-forge-session-mining-design.md` for the user-facing flow.
Database schema and similarity / clustering primitives are retained.
**Date**: 2026-05-04 (same day as v1, course-corrected mid-build).

---

## What changed

The original spec assumed Forge runs as a **post-hoc background
daemon**: file watcher tails Claude Code JSONLs, distills sessions
once they're quiescent, clusters across many sessions, and only after
hitting a `≥ 3 sessions × 2 days` threshold proposes a candidate.

User feedback: that's wrong. The right ergonomics:

1. User finishes a Claude Code session and feels "I might want to
   automate this."
2. User clicks **Forge Now** in the dashboard (or hits an MCP
   endpoint from inside Claude Code itself).
3. Forge analyzes that one session and within seconds answers one
   of two things:
   - **"You already have a pipeline for this — `<existing-pipeline>`.
     Here's how to run it: ..."**
   - **"This isn't covered by any existing pipeline. Here's a
     proposed IR you could adopt as `<new-name>`. Click Adopt to
     submit it."**

The user is in the loop and gets an immediate, actionable answer.
There's no "wait three days for clustering threshold" semantics.

## What stays

- **forge.db** schema — every table still useful. Sessions / events /
  episodes / signatures / clusters / cluster_members /
  pipeline_candidates all still apply. Some columns are now optional
  for the manual flow (e.g. `forge_jobs` is unused; cluster ripeness
  threshold is no longer the gate).
- **Ingestion modules** — redactor, parser, jsonl-tail. The watcher
  module is deferred (no continuous monitoring); we'll re-introduce
  it for "show me everything I've done lately" debug pages but it's
  no longer the ingress for the main flow.
- **Similarity primitives** — cosine, assignToCluster,
  updateCentroidIncremental, evaluateThreshold are all still pure
  numerics that get reused. `clusterEpisode` (the operational glue)
  is retained for the optional historical-cluster signal but is no
  longer in the critical path.
- **Distillation pipeline** (`forge-distill` builtin) — still the
  core LLM step. We just trigger it on demand instead of from a
  daemon.

## New core: Pipeline Matcher

Before this revision, Forge produced a candidate by handing
distilled episodes to `pipeline-generator`. Now there's a step in
between:

```
distill → match against existing pipelines → branch
                                              │
                       cosine ≥ MATCH_THRESHOLD ─► recommend existing
                       cosine <  MATCH_THRESHOLD ─► synthesize new
```

### Embedding pipelines for matching

For every pipeline in `pipeline_versions`, compute an embedding from
its **descriptor**: `{ name, externalInputs, stages[].name +
stages[].config.promptRef text, store_schema }`. We don't embed
prompt content (too noisy); we embed the *contract* of the pipeline.

These embeddings live in a new table `pipeline_embeddings`
(forge.db, but keyed by `version_hash` from kernel-next.db — a
loose cross-DB reference, refreshed lazily on demand). Stale on
hot-update, but a one-line invalidation hook on `pipeline_versions`
write keeps it fresh.

### Matching rule

```
MATCH_THRESHOLD = 0.78    // intentionally lower than CLUSTER_THRESHOLD (0.85)
                          // because pipeline descriptor vs episode intent
                          // both summaries; less noise but still distinct vocabularies.
```

If best `cosine ≥ MATCH_THRESHOLD`, return that pipeline as
`recommendation: "use-existing"`. Otherwise → `recommendation:
"create-new"`.

## End-to-end flow (revised)

```
[user] click Forge Now (web) OR call MCP forge_analyze from inside Claude Code
   │
   ▼
POST /api/forge/analyze { sessionId }
   │
   ▼
1. Read session JSONL (resolve from sessions table or ad-hoc path)
   │
   ▼
2. Parse + redact events into forge.db
   │
   ▼
3. Run forge-distill builtin → SessionEpisode[]
   │
   ▼
4. For the primary episode (or aggregate of all episodes):
   - Embed via embedding-client (default: local-hash)
   - Look up pipeline_embeddings in forge.db (refresh stale)
   - Match
   │
   ▼ recommendation = "use-existing"          ▼ recommendation = "create-new"
   Return: {                                  5. Build description from episode
     kind: "use-existing",                       │
     pipelineName,                               ▼
     versionHash,                              6. Run pipeline-generator (or skip
     cosine,                                      to a deterministic IR-from-template
     why: "<reason>",                             path for known shapes)
     howToRun: { externalInputs, sample }       │
   }                                             ▼
                                              7. Insert pipeline_candidate row
                                                 (no clustering needed; this is
                                                 a one-shot)
                                                 │
                                                 ▼
                                              Return: {
                                                kind: "create-new",
                                                candidateId,
                                                proposedName,
                                                irPreview,
                                                whyNotExisting: "best match
                                                  was X at cosine 0.62, below 0.78"
                                              }
   │
   ▼
[user] sees recommendation in /forge/analyze page or MCP response
   │
   ▼ adopt-existing: open /kernel-next/pipelines/<name>?prefilledFrom=session
   ▼ adopt-new: candidate review page → submit_pipeline → real pipeline
```

## What we're cutting from the daemon-era spec

- **Daemon lifecycle** (`startForge` / `stopForge` / sweep timer)
  — not implemented. Forge is fully request-scoped.
- **Watcher** in the main flow — kept the module (tested, working)
  but unused at boot. Reserved for a future "live activity feed"
  debug page.
- **Job queue** (`forge_jobs` table) — unused. The manual-trigger
  flow is request-scoped: do everything inline within the HTTP
  handler, return when done. If distillation takes 30s, the user
  waits 30s on a spinner. That's fine for an explicit action.
- **Cluster ripeness as gate** — clusters are tracked for "I've done
  this N times before" UX hint, but not used to gate
  recommendation. A single session with a clear pattern is enough.
- **Cooldown / suppression** — irrelevant; the user is the one
  asking, every time.

## What's added

- **`pipeline_embeddings` table** in forge.db.
- **Pipeline matcher module** (`forge/matching/`).
- **`POST /api/forge/analyze`** endpoint (request-scoped, full
  inline pipeline; returns 200 with one of two recommendation
  shapes).
- **`forge_analyze` MCP tool** — same as the HTTP endpoint, callable
  from inside Claude Code. The user can finish their session by
  saying "tell me if this is automatable" and the agent runs
  `forge_analyze`. The MCP tool returns a structured recommendation
  the agent can present to the user.
- **`/forge` web page** redesigned: not a "list of candidates", but
  a single-button "Analyze current session" page + the recommendation
  view + a recents list of past analyses.

## Module layout (revised)

```
apps/server/src/forge/
  types.ts                                 # unchanged + AnalysisResult, Recommendation
  db/
    schema.ts                              # add pipeline_embeddings table
    open.ts                                # unchanged
    sessions.ts                            # unchanged
    episodes.ts                            # unchanged
    clusters.ts                            # unchanged (still used for history)
    candidates.ts                          # unchanged
    pipeline-embeddings.ts                 # NEW: pipeline-descriptor embeddings
  ingestion/
    redactor.ts / parser.ts / jsonl-tail.ts  # unchanged
    watcher.ts                             # kept but not booted
    session-loader.ts                      # NEW: read a JSONL on-demand into forge.db
  distillation/
    submit-distill.ts                      # NEW: run forge-distill inline, await result
    extract.ts                             # NEW: parse pipeline output → SessionEpisode[]
  similarity/
    embedding-client.ts                    # unchanged
    cluster.ts / threshold.ts              # unchanged (kept; threshold is "have I done this lately")
    cluster-episode.ts                     # unchanged (recorded, not gating)
  matching/                                # NEW directory
    pipeline-descriptor.ts                 # build embedding text from PipelineIR
    pipeline-matcher.ts                    # match episode → existing pipeline
  synthesis/
    candidate-builder.ts                   # unchanged structure
    candidate-runner.ts                    # invokes pipeline-generator
  api/
    routes.ts                              # POST /api/forge/analyze + small read-only routes
    analyze-handler.ts                     # NEW: orchestrates the full inline flow
  mcp/
    forge-analyze-tool.ts                  # NEW: MCP tool handler
```

The `daemon/` directory is **not implemented**. `forge_jobs` table is
present in schema (cheap to keep) but no code reads from it.

## Latency budget (per analyze call)

- Read JSONL + parse: ≤ 100 ms for typical session (≤ 500 events)
- forge-distill builtin (1 agent call, single-session): 5–20 s
  (Claude SDK turn time)
- Embedding the episode (local-hash): ≤ 5 ms
- Match against ≤ 100 pipelines (linear scan, cosine on 256-dim): ≤ 50 ms
- If create-new: pipeline-generator (one full pipeline run, multiple
  agent calls): 20–60 s

Total: 10–80 s. The user clicked "Forge Now" knowing this would
take a moment. We show a progress UI, not a fire-and-forget.

## Open questions resolved

- **Should we run distillation if a JSONL is huge (10k+ events)?**
  Truncate to last N events at ingestion (configurable; default 800)
  and tag the episode `truncated: true`. Distillation still works
  on the truncated tail.
- **What if the session has no real "task"?** forge-distill emits
  `[]` for episodes; analyze returns `kind: "no-pattern"` with a
  human-readable explanation.
- **Multi-episode session?** Take the **most recent / largest**
  episode by event-count for matching. Show others as "also
  detected" in the UI.
- **MCP tool security?** The MCP tool is exposed to the local user's
  agents only. No auth surface needed — it's the same trust
  boundary as `submit_pipeline`.

## Documentation updates (revised)

- Whitepaper §1.4 — describe Forge as the **user-triggered analysis
  surface**, with two-branch recommendation. Drop the "ambient
  daemon" framing.
- Roadmap row 1.29 records the user-triggered flow.
