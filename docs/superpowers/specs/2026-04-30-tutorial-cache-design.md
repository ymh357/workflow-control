# Cross-Task Tutorial Cache (D1)

**Status**: design ready, not implemented
**Date**: 2026-04-30
**Continuation**: c12 D1
**Roadmap reference**: `docs/superpowers/dogfood-2026-04-28/handoff.md` §c11+ Roadmap "方向 1: 跨 task tutorial 复用"

---

## Problem

The 17-stage investigation skeleton (D-path c9.6) authors a fresh
markdown tutorial per concept on every run, via the `tutorialAuthoring`
fanout. For commonly-investigated domains, the same concepts come up
repeatedly:

- `cross-chain-bridge-architecture`
- `merkle-patricia-trie`
- `optimistic-rollup-fraud-proof`
- `cosmos-cometbft-consensus`

Each tutorial is 200–600 words, with ≥2 authoritative source citations.
Per concept, fresh authoring costs ~30–60 seconds of agent time + a few
WebFetch calls + ~$0.05–$0.15 in tokens. A typical investigation has
8–15 concepts; running 5 investigations in the same domain incurs
roughly the same tutorial work 5×.

## Goal

Cache authored tutorials by `(slug, subjectDomain)` so a second
investigation in the same domain skips tutorial authoring for any
concept whose slug already has a fresh entry. Target hit rate at steady
state: **30–50% of concepts** for a power user iterating in one domain.

## Non-goals

- **Invalidation by content change**. Tutorials drift slowly (days to
  months). 30-day TTL is sufficient; we do not track upstream-doc
  changes.
- **Cross-domain dedup**. "merkle tree" in blockchain ≠ in git. Domain
  scoping is the simplest correct boundary.
- **Audience-aware variation**. Tutorial mostly varies by domain, not
  audience role. Audience differences are absorbed by the agent's
  reading style; the cached markdown stays neutral enough to reuse.

## Design

### Cache key

`(slug, subjectDomain)` — two-tuple primary key.

- `slug` is what `tutorialAuthoring` already emits (kebab-case, derived
  from concept name). Stable across runs by construction.
- `subjectDomain` is what `topicFraming` already emits (single string,
  e.g. "Ethereum L2", "Cosmos IBC", "Web3 frontend tooling").

Rationale for not including `audience.role`: audience differences
mostly affect *which* tutorials get authored (knowsAbout filters out
already-known concepts at `prereqExtraction`), not *how* a given
tutorial reads. The 200–600 word neutral-tutoring style works across
roles within a domain.

### TTL

30 days. Entries older than `now - 30d` are treated as misses by
`lookup_tutorial_cache`. Stale rows can be left in place — a future
`prune_records` pass can sweep them but it's not blocking.

### Storage

New SQLite table in `kernel-next.db`:

```sql
CREATE TABLE tutorial_cache (
  slug          TEXT NOT NULL,
  subject_domain TEXT NOT NULL,
  content_md    TEXT NOT NULL,
  sources_json  TEXT NOT NULL,  -- JSON array of {url, title?}
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (slug, subject_domain)
);

CREATE INDEX idx_tutorial_cache_created ON tutorial_cache(created_at);
```

- `content_md` is the authored markdown (the same string written via
  `Write` to disk by the fanout child).
- `sources_json` is the per-tutorial sources list — preserved so future
  reuses can re-cite without re-fetching.

### Builtin scripts

Three new modules in `apps/server/src/kernel-next/builtin-scripts/`:

#### 1. `lookup_tutorial_cache`

Inputs:
- `slugs: string[]` — the full set of slugs to author this run
- `subjectDomain: string`

Outputs:
- `cachedSlugs: string[]`
- `cachedContents: string[]` (parallel array)
- `cachedSources: Array<Array<{url:string,title?:string}>>` (parallel array)
- `missingSlugs: string[]` — the slugs the fanout still needs to author

Reads `tutorial_cache` rows where `subject_domain = ?` and
`slug IN (?, ?, ...)` and `created_at >= now - 30d`. Returns parallel
arrays for the hit set (so downstream `merge_tutorials` can consume
them directly) and lists the misses. Parallel-array layout is chosen
over a single object-array port because IR ports are simpler to wire
when each port is a flat-typed primitive array.

DB handle: factory-script style (`buildLookupTutorialCache(db)`),
same pattern as `submit_pipeline_passthrough`.

#### 2. `write_tutorial_cache`

Inputs:
- `slugs: string[]` — slugs the fanout actually authored this run
- `contents: string[]` — parallel array of authored markdown
- `sourcesPerTutorial: Array<Array<{url:string,title?:string}>>` — parallel
- `subjectDomain: string`

Output:
- `written: number` — count of upserted rows

Upserts per tuple via `INSERT … ON CONFLICT(slug, subject_domain) DO
UPDATE` — re-running over the same slug refreshes content and bumps
`created_at`.

Factory-script style.

#### 3. `merge_tutorials`

Inputs:
- `cachedSlugs: string[]`, `cachedContents: string[]`, `cachedSources: Array<Array<...>>`
- `freshSlugs: string[]`, `freshContents: string[]`, `freshSources: Array<Array<...>>`

Outputs:
- `slugs: string[]` — concat (cached then fresh)
- `contents: string[]` — concat (parallel order)
- `sources: Array<Array<...>>` — concat (parallel order)

Pure transform — no DB. Lives alongside other transform scripts in
`builtin-scripts/index.ts`.

### IR-template integration

Modify `assemble_investigation_ir.ts` so the investigation skeleton
inserts three new stages between `prereqExtraction` and `tutorialReviewGate`:

```
prereqExtraction
    ↓ tutorialOutline (string[]), subjectDomain (string)
    ↓
lookupTutorialCache (script)
    ↓ hits, missingSlugs
    ↓
tutorialAuthoring (agent fanout — over missingSlugs, NOT tutorialOutline)
    ↓ (fanout aggregate)
    ↓ tutorialSlugs (string[]), tutorialMarkdowns (string[]), sourcesPerTutorial
    ↓
writeTutorialCache (script — only over the freshly-authored set)
    ↓ written count (informational)
    ↓
mergeTutorials (script — cached + fresh)
    ↓ tutorialSlugs (merged), tutorialMarkdowns (merged), sources (merged)
    ↓
tutorialReviewGate (consumes merged outputs as before)
```

Wires:

| from | to | ports |
|---|---|---|
| `prereqExtraction.tutorialOutline` | `lookupTutorialCache.slugs` | `string[]` |
| `topicFraming.subjectDomain` | `lookupTutorialCache.subjectDomain` | `string` |
| `lookupTutorialCache.missingSlugs` | `tutorialAuthoring.concept` | fanout source array |
| `topicFraming.subjectDomain` | `writeTutorialCache.subjectDomain` | `string` |
| `tutorialAuthoring.tutorialSlugs` (aggregated) | `writeTutorialCache.slugs` | `string[]` |
| `tutorialAuthoring.tutorialMarkdowns` (aggregated) | `writeTutorialCache.contents` | `string[]` |
| `tutorialAuthoring.sources` (aggregated) | `writeTutorialCache.sourcesPerTutorial` | `Array<Array<...>>` |
| `lookupTutorialCache.cachedSlugs` | `mergeTutorials.cachedSlugs` | `string[]` |
| `lookupTutorialCache.cachedContents` | `mergeTutorials.cachedContents` | `string[]` |
| `lookupTutorialCache.cachedSources` | `mergeTutorials.cachedSources` | `Array<Array<...>>` |
| `tutorialAuthoring.tutorialSlugs` (aggregated) | `mergeTutorials.freshSlugs` | `string[]` |
| `tutorialAuthoring.tutorialMarkdowns` (aggregated) | `mergeTutorials.freshContents` | `string[]` |
| `tutorialAuthoring.sources` (aggregated) | `mergeTutorials.freshSources` | `Array<Array<...>>` |
| `mergeTutorials.slugs` | `tutorialReviewGate.tutorialSlugs` | `string[]` |
| `mergeTutorials.contents` | `tutorialReviewGate.tutorialMarkdowns` | `string[]` |
| `hypothesize.tutorialSlugs` ← `mergeTutorials.slugs` | (re-route from old direct wire) | `string[]` |
| `hypothesize.tutorialMarkdowns` ← `mergeTutorials.contents` | (re-route) | `string[]` |
| `evidenceGather.tutorialSlugs` ← `mergeTutorials.slugs` | (re-route) | `string[]` |
| `evidenceGather.tutorialMarkdowns` ← `mergeTutorials.contents` | (re-route) | `string[]` |

Note: `lookup_tutorial_cache` returns `hits` as an array of objects.
The IR's port-level type system represents this as a single port with
`Array<{slug, contentMd, sources}>` shape. `merge_tutorials` then
projects parallel arrays internally — no separate "projection script"
stage is needed; both scripts agree on the shape.

(Implementation note: parallel-array layout — `cachedSlugs[]`,
`cachedContents[]`, `cachedSources[]` — keeps each port a primitive
array, which is simpler to wire and matches the existing fanout
aggregate convention `tutorialSlugs[]` / `tutorialMarkdowns[]`.)

### Reject-rerun behaviour

On `tutorialReviewGate.reject`, the runtime currently re-runs
`tutorialAuthoring`. Post-cache:

- `lookupTutorialCache` is upstream of `tutorialAuthoring`. Reject from
  `tutorialReviewGate` re-runs from `tutorialAuthoring` (existing
  per-stage retry semantics) or from `prereqExtraction` (the
  `gate_routed_targets` for tutorialReviewGate.reject in the existing
  skeleton). Either way `lookupTutorialCache` re-runs, hits the same
  cached entries, and the fanout still skips them.

- This means rejected tutorials *never get re-authored* if their slug
  is in cache. Expected behaviour: if a cached tutorial was wrong, the
  reviewer rejects it, but the cache returns the same wrong content.
  **Fix**: on reject, the runtime should evict cached entries that the
  reviewer flagged. The reviewer feedback already names the offending
  concepts. Add to `tutorialAuthoring`'s rejection-feedback path: a
  pre-step that DELETEs `tutorial_cache(slug=?, subject_domain=?)` for
  each flagged slug before lookup re-runs.

  Implementation: extend `tutorialRejectionFeedback` schema to carry
  `flaggedSlugs: string[]`. The reject handler (or a dedicated
  `evict_flagged_tutorials` script stage upstream of
  `lookupTutorialCache`) reads this list and DELETEs matching rows.
  Empty `flaggedSlugs` means "evict nothing" — the fresh-run case.

  Alternative: skip eviction entirely and let the 30-day TTL handle
  it. A reviewer who rejects a tutorial can manually edit/delete the
  row via SQLite, or wait for TTL. **Decision**: ship without eviction
  in the first cut. The reject re-run will re-fetch the same content
  but the reviewer can iterate by editing the cached row directly. Add
  eviction in a follow-up only if dogfood reveals it as a real pain.

### versionHash impact

Adding 3 stages + rewiring the skeleton changes the deterministic
template inside `assemble_investigation_ir.ts`. Every D-path
investigation IR generated post-D1 will hash differently from
pre-D1 IRs. This is fine: pipeline-generator regenerates the IR per
task, so there's no migration issue. Historical IRs (already in
`pipeline_versions`) keep working — `lookup_tutorial_cache` is
specific to the new skeleton's stage layout, not a global runtime
dependency.

### Cache invalidation paths

| Event | Effect |
|---|---|
| Manual `DELETE FROM tutorial_cache WHERE slug=?` | row gone, next lookup misses |
| Row older than 30d | treated as miss; will be overwritten by `write_tutorial_cache` upsert |
| `tutorialReviewGate.reject` | (v1) no eviction; rejected slug returns from cache. (v2) optional eviction. |
| Schema migration | drop & recreate; cache empty after kernel-next upgrade |

## Testing

Unit tests:

1. `lookup_tutorial_cache.test.ts` — 5 cases:
   - all slugs in cache, fresh → empty `missingSlugs`, full cached arrays
   - all slugs in cache, expired (older than 30d) → all miss
   - partial overlap → correct split
   - empty `slugs[]` input → empty outputs (no error)
   - same slug different `subjectDomain` → independent

2. `write_tutorial_cache.test.ts` — 3 cases:
   - inserts new rows
   - upsert refreshes content + `created_at` on collision
   - empty input → no-op (returns 0)

3. `merge_tutorials.test.ts` — 2 cases:
   - cache hit (5) + fresh (3) → merged (8) parallel arrays
   - all-cache (no fresh) → output equals cached
   - all-fresh (no cache) → output equals fresh

Integration tests:

4. `tutorial-cache-skeleton.test.ts` — D-path skeleton sanity:
   - `assemble_investigation_ir({investigationType:"verify",...})` produces
     IR containing `lookupTutorialCache`, `writeTutorialCache`,
     `mergeTutorials` stages
   - All wires are valid (existing structural validator catches
     missing/dangling)
   - The hash differs from pre-D1 hash (sanity)

5. `tutorial-cache-e2e.test.ts` — runtime smoke (mock executor):
   - Run skeleton once with empty cache, verify all slugs flow through
     `tutorialAuthoring` fanout
   - Manually insert rows for half the slugs, run again, verify the
     fanout sees only the missing half, the merged outputs include
     both

## Test plan

- New tests added under `apps/server/src/kernel-next/builtin-scripts/`
  and `apps/server/src/kernel-next/builtin-scripts/__skeleton__/`.
- `pnpm vitest run src/kernel-next/builtin-scripts/` covers unit + e2e.
- Existing test suite (2235 passing in c11) must remain green.

## Out of scope (deferred)

- Cache hit telemetry. Would help measure ROI in dogfood. Not blocking
  for v1; can be added once `prune_records` learns to read this table.
- Manual cache-management CLI (list/clear). The user can `sqlite3` if
  needed.
- Cross-machine cache sharing (registry sync). Local-only is the
  product positioning per CLAUDE.md.
- Eviction on reject (covered above as v2 follow-up).

## Roll-out

1. SQL migration: new table + index. (single ALTER-equivalent — fresh
   `CREATE TABLE IF NOT EXISTS`, additive)
2. Three builtin scripts + factory wiring in `start-pipeline-run.ts`
3. `assemble_investigation_ir.ts` template update
4. Tests
5. Update `gen-skeleton.md` prompt to mention the cache stages exist
   (LLM doesn't generate them — `assemble_investigation_ir` does — but
   the prompt explains the 17-now-20-stage skeleton for reviewers)

Each step is independently shippable; intermediate states have a
working test suite.
