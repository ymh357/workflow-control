# Handoff — Catalog Auto-Discovery Loop + Live LLM Dogfood (Full Session)

**Session window**: 2026-04-27 ~22:00 → 2026-04-28 ~11:30
**Branch**: `main` (734 commits ahead of `origin/main`, never pushed)
**Status**: clean tree, 2057+ tests passing locally except 3 known
cross-session flakes (`spawn-utils.adversarial`, `publish`,
`compile-inline-script` — all unrelated to this session's work)

This handoff replaces the earlier session-1 + session-2 partial
handoffs. It is self-contained.

## What this session shipped

A self-contained slice closing the AI-driven catalog discovery loop,
hardening it under live LLM, and building a 5-rung supply-chain test
ladder for catalog entries.

### Commit chain (16 commits this session, in order)

| sha | summary |
|---|---|
| `b793233` | feat(mcp-catalog): `add_mcp_catalog_entry` MCP tool |
| `1617027` | fix(generator): two-pass MCP discovery + verbatim-fetch |
| `865961d` | fix(modifier): same prompt discipline for gen-patch |
| `60568ec` | fix(catalog): delete 5 broken builtin entries |
| `3b78d10` | docs: augment findings with Bug 4–5 |
| `5ea2361` | docs: handoff session 1 (now superseded) |
| `371c036` | fix(rot-guard): boot/CI healthcheck + gen-skeleton verbatim |
| `a8a6766` | fix(dashboard): task header state badge reads /status |
| `805bdfd` | fix(dashboard): gate decision summary + collapse 17-port |
| `f7ae92d` | docs: modifier dogfood + Bugs 7–8 |
| `0d86be9` | fix(ir): add_external_input / remove_external_input ops |
| `88c26a7` | fix(ir): externalInputs[].optional flag (3 layers) |
| `eedd14a` | fix(canonical): include port.optional in version hash |
| `c9c9b97` | docs: session 2 mid-handoff (now superseded) |
| `7c33dc6` | feat(catalog): replenish etherscan + fetch + arxiv |
| `8d39ada` | fix(rot-guard): spawn-test mode-2 + slack/postgres args |
| `00d5355` | docs: Bug 9 (npm-view existence ≠ runnable) |
| `05be361` | fix(catalog): remove arxiv (Bug 10 SDK-too-slow) |
| `89503c7` | docs: Bug 10 |
| `f3b2256` | fix(rot-guard): split-budget spawn-test |
| `416ddcc` | fix(catalog): filesystem args + envKey |
| `4eb6c14` | fix(rot-guard): tools/list verification + Bug 11 |

(plus the 4 prior-session commits `be7de63 → 1614be7` that pre-existed
and that the first session built on)

## Bug score: 11 distinct, 10 fixed, 1 deeper

| # | Severity | What | Status |
|---|---|---|---|
| 1 | P0 | 5/12 builtin packages 404 on npm | **fixed** `60568ec` + rot-guard test `371c036` |
| 2 | P2 | gen-skeleton silently slug-rewrites mcpServers.name | **fixed** `371c036` (later refined: name uses entry.id, not entry.name) |
| 3 | P2 (UX) | gate `<details open>` + 17-port table off-screen | **fixed** `805bdfd` (decision summary card + collapse-when-large) |
| 4 | P1 | stage_attempts CHECK on legacy DBs missing `secret_pending` | **documented** — per CLAUDE.md §8.1 wipe DB, no migration |
| 5 | P2 (UX) | dashboard state badge reads SSE event, says "completed" while in secret-gate | **fixed** `a8a6766` |
| 6 | P1 prompt | analyzing agent skipped add-on-miss + hallucinated builtin packages | **fixed** `1617027` |
| 7 | P1 | externalInputs has no optional flag — modifier rejected with SEED_VALUES_MISSING_KEY | **fixed** `88c26a7` + `eedd14a` (3 code layers + canonical hash) |
| 8a | P0 | IRPatchOpSchema missing `add_external_input` / `remove_external_input` | **fixed** `0d86be9` |
| 8b | P1 | Modifier silently submits `ops:[]` with `dryRunVerdict:"safe"` after dry-run failure | **fixed** `0d86be9` (prompt rule) |
| 9 | P0 | npm-view existence ≠ runnable (fetch-mcp@0.0.5 broken imports; postgres args incomplete; slack envKeys incomplete) | **fixed** `8d39ada` + spawn-test mode-2 |
| 10 | P1 | spawn-test pass ≠ SDK-runnable (arxiv 25s init too slow) | **fixed** `05be361` (remove arxiv) + `f3b2256` (split-budget catches it) |
| 11 | P2 | tools/list-passing ≠ SDK-runnable (playwright fails MCP_STARTUP_FAILED in real SDK despite handshake passing) | **partially fixed** `4eb6c14` — tools/list check added; SDK-side gap deferred |

## The 5-rung supply-chain test ladder

The session's main meta-deliverable. Each rung catches what the previous can't:

| rung | test | catches |
|---|---|---|
| 1. schema | unit test (zod) | malformed entries.json fields |
| 2. npm view | mode-1 rot-guard (`RUN_NPM_HEALTHCHECKS=1`) | packages that 404 (Bug 1) |
| 3. spawn + initialize | mode-2 split-budget | broken module imports (Bug 9 fetch-mcp); too-slow startup (Bug 10 arxiv) |
| 4. spawn + tools/list | mode-2 enhanced | servers that handshake but advertise 0 tools |
| 5. SDK runtime | live LLM dogfood | the last mile — anything the standalone JSON-RPC probe doesn't replicate (Bug 11 playwright) |

## Live dogfood Step 6-9 verification

| Step | Status |
|---|---|
| 6 — `run_pipeline { name }` resolves to versionHash + starts task | ✅ verified across 4+ generator runs |
| 7 — secret-gate triggers when MCP envKey missing | ✅ verified (GitHub Issues Lister) |
| 8 — user provides secret + saves to inventory | ❌ not exercised — CLAUDE.md secret rule + no out-of-band shell |
| 9 — task continues, real MCP runs, output produced | ❌ tried twice (HN fetch-mcp Bug 9; playwright Bug 11) — both surfaced new supply-chain layers; eventual success blocked on Bug 11's deeper SDK gap |

## State at handoff

- **Catalog**: 8 entries, all pass rot-guard mode-1 + most of mode-2.
  - Public (no envKey): `playwright`, `puppeteer`
  - With envKey: `github`, `etherscan`, `brave-search`, `slack`,
    `postgres`, `filesystem`
- **Server / DB / Browser**: any leftover dev process can be killed
  with `pkill -f "tsx.*src/index.ts"`. DB `/tmp/workflow-control-data/`
  has the latest schema; wipe if you need a fresh boot. Chrome devtools
  MCP profile at `/tmp/chrome-e2e-profile` may have stale Singleton
  locks — `rm /tmp/chrome-e2e-profile/Singleton*` to clear.
- **Test suite**: 2057 passing locally outside known flakes.
  - `RUN_NPM_HEALTHCHECKS=1` for fast catalog smoke (~20s).
  - `RUN_NPM_HEALTHCHECKS=2` for spawn + tools/list (~3min, sequential).

## Open issues for next session

### High value

1. **Bug 11 follow-through**: investigate why playwright passes
   spawn-test mode-2 (initialize + tools/list both ≤10s) but fails
   `MCP_STARTUP_FAILED` in real SDK runtime. Likely candidates:
   protocol-version negotiation, Claude Agent SDK's MCP transport
   framing differences vs raw JSON-RPC. May need to instrument
   `apps/server/src/kernel-next/runtime/real-executor.ts` SDK call
   site to log `tools/list` reply seen by SDK, OR build a closer
   approximation of the SDK's transport in spawn-test.

2. **Step 8-9 real verification**: needs a public no-envKey MCP
   that survives Bug 11. Options:
   - Find a different browser-automation MCP that passes the SDK
     (puppeteer is also untested in dogfood).
   - Use `brave-search` if the user can `export BRAVE_API_KEY=...`
     before server boot (CLAUDE.md secret rule allows this — it's
     out-of-band).
   - Use `etherscan` likewise (free-tier `ETHERSCAN_API_KEY`).

3. **Bug 8b kernel-side guard** — **investigated 2026-04-28 (continuation), deferred**:
   The naïve idea ("applying stage refuses empty patch when intent
   is non-empty") doesn't fit the current IR: applying's inputs are
   `{patch, rerunFrom, migrateRunningTasks, currentVersionHash, dryRunVerdict, prompts}`
   — gapAnalysis flows ONLY into analyzeGap → genPatch and never
   reaches applying, so applying can't compare ops vs. intent.

   Three possible paths, all heavier than expected:
   - **(a) Extend applying inputs**: add a wire
     `analyzeGap.gapAnalysis → applying.gapAnalysis`. Then applying's
     prompt could read both, but that's still prompt-level — not the
     kernel guard the handoff line implies.
   - **(b) Insert a script stage between genPatch and applying**:
     pure validator that reads {gapAnalysis, patch, dryRunVerdict}
     and either passes through or fails the pipeline. This is the
     real kernel-side guard — but it's a new stage in a builtin
     pipeline + new wires + IR migration.
   - **(c) Make `propose_pipeline_change` MCP tool reject the empty-
     ops + verdict-safe combo unconditionally**: simplest, but
     punishes the legitimate "no-op patch + verdict=safe" case
     (which IS valid in some workflows).

   Recommendation: do (b) when next adding any guard to a builtin
   pipeline (the IR-migration overhead amortises). Until then the
   prompt rule in `gen-patch.md` is the only line of defence; it
   has held across the dogfood sessions but is one prompt regression
   away from re-opening the bug. Tracked, not blocking.

### Medium

4. **Replenish more catalog entries**. After fetch-mcp removal we're
   down to 8. Candidates that would broaden coverage:
   - HTTP fetch (need a vendor-published MCP that actually works —
     spawn-test rejected fetch-mcp@0.0.5; investigate alternatives).
   - Notion (custom-add path verified during Notion → Linear
     dogfood; rot-guard now exists to vet candidates before
     committing).
   - Linear (was deleted; the official path is `mcp-remote
     https://mcp.linear.app/mcp` — different topology, schema
     supports it via the `mcp-remote` command pattern).
   Each new entry must pass rot-guard mode-2 with tools/list before
   landing.

5. **CI integration of rot-guard** — **N/A in this repo (2026-04-28)**.
   Repo has no CI: it's single-user / single-machine per
   `CLAUDE.md` ("local, single-user workflow engine. One engineer,
   one machine, one server process"). The mitigation is a
   developer-side pre-commit / pre-release habit:
   - `RUN_NPM_HEALTHCHECKS=1 npx vitest run src/kernel-next/mcp-catalog/entries-rot-guard.test.ts`
     before merging anything that touches `entries.json`. ~25s,
     catches the 41% rot rate that bit Bug 1.
   - `RUN_NPM_HEALTHCHECKS=2` before adding a NEW entry the first
     time — needed because "package exists on npm" is necessary
     but not sufficient (Bug 9).
   - `RUN_NPM_HEALTHCHECKS=3` only when new entry is download-heavy.
   If this repo ever grows to multi-user, drop a
   `.github/workflows/rot-guard.yml` running mode 1 on PRs that
   change `entries.json`.

### Lower priority

6. **Per-entry `obtainSteps` quality audit**. Many existing entries
   have rough Chinese-language obtainSteps copied from training
   data; should be reviewed for factual accuracy + bilingual
   consistency.

7. **Spawn-test cold-cache vs warm-cache distinction**. Currently
   the test pre-warms via the mode-1 `npm view` that always runs
   first, masking real first-run cold-start time. A separate "fresh
   user, no cache" smoke test could be useful but adds complexity.

## Things NOT to do

- **Do not** add YAML migration for the CHECK constraint drift.
  CLAUDE.md §8.1 explicitly says "no migrations during R&D; wipe
  data_dir." Bug 4 is the canonical instance.
- **Do not** restore deleted entries to `entries.json` without
  passing rot-guard mode-2 (`RUN_NPM_HEALTHCHECKS=2`). The
  test exists precisely so this rot doesn't recur.
- **Do not** propose to mutate IR via `propose_pipeline_change`
  to remove a `mcpServers` block as a workaround for missing
  envKey. Per CLAUDE.md, that corrupts pipeline-author intent.
  Secret-gate is the recovery path.
- **Do not** skip the verbatim-fetch discipline in any new
  prompt that writes IR `mcpServers` blocks. The session's
  hard lesson is that LLMs will slug-rewrite, hallucinate from
  training data, and silently swap field semantics whenever the
  prompt allows it. `entry.id` for `name`; everything else
  byte-equal from `get_mcp_catalog_entry`.

## Key files for fast onboarding

- **Catalog subsystem**: `apps/server/src/kernel-next/mcp-catalog/`
  - `entries.json` — the 8-entry source of truth
  - `entries-rot-guard.test.ts` — 5-rung ladder rungs 2–4
  - `seed.ts` / `catalog-store.ts` — DB bridge
  - `healthcheck.ts` — npm view + spawn helpers
- **MCP tools**: `apps/server/src/kernel-next/mcp/tools/`
  - `mcp-catalog.ts` — recommend / get
  - `add-mcp-catalog-entry.ts` — write path
- **Generator prompts**:
  `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/`
  - `analysis.md` — two-pass MCP discovery
  - `gen-skeleton.md` — verbatim-fetch + entry.id-as-name
- **Modifier prompts**:
  `apps/server/src/builtin-pipelines/pipeline-modifier/prompts/system/`
  - `analyze-gap.md` — produces patch outline
  - `gen-patch.md` — translates outline to IRPatchOp[] with
    discipline against empty-patch fallback
- **IR schema**: `apps/server/src/kernel-next/ir/schema.ts`
  - `IRPatchOpSchema` — 8 ops including the two new external-input
    ops
  - `PortIRSchema.optional` — Bug 7 flag
- **Canonical hash**: `apps/server/src/kernel-next/ir/canonical.ts`
  - includes `port.optional` (Bug 7c, eedd14a)
- **Dashboard**:
  - `apps/web/src/app/kernel-next/[taskId]/page.tsx` — task page,
    state badge reads /status (Bug 5)
  - `apps/web/src/components/gate-card.tsx` — decision summary +
    collapse-when-large (Bug 3)
- **Findings doc**:
  `docs/superpowers/dogfood-2026-04-28/findings.md` — full bug
  catalogue with reproduction details and remediation links

## The session's meta-lesson

Each dogfood iteration peeled one layer deeper. Counting unit
tests (none of which caught any of these 11 bugs) vs live LLM
runs (caught all 11):

| layer | what it produces | how many bugs in this session it caught |
|---|---|---|
| Unit test (in-memory SQLite + mocked SDK) | API contract + invariants | 0 |
| Static lint / TS check | structural drift | 0 |
| Spawn-test rot-guard (after building it) | 1 / 9 / 10 / part of 11 | 4 (after each new rung was built) |
| Live LLM dogfood | 6 / 7 / 8 / Bug 4 (DB) / Bug 5 (UX) / Bug 11 (last mile) | 6 |

The 6 dogfood-only bugs span: prompt drift (6, 8b), schema gap
(7, 8a), DB drift (4), UX inconsistency (5), and SDK runtime
opacity (11). None of them are unit-testable. None.

That's the case for dogfood. It's not optional.
