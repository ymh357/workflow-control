# Handoff — Catalog Auto-Discovery Loop + Live Dogfood

**Session window**: 2026-04-27 ~23:00 → 2026-04-28 ~00:40
**Branch**: `main` (724 commits ahead of `origin/main`, never pushed)
**Status**: clean tree, all tests passing locally except known flakes
unrelated to this work

## What this session shipped

A self-contained slice that closes the AI-driven catalog discovery
loop and validates it under live LLM, plus the bugs that surfaced.

### 5 commits, in order

| sha | summary |
|---|---|
| `b793233` | feat(mcp-catalog): `add_mcp_catalog_entry` MCP tool — close the auto-discovery loop |
| `1617027` | fix(pipeline-generator): force two-pass MCP discovery from dogfood findings |
| `865961d` | fix(pipeline-modifier): apply same dogfood-driven prompt discipline to gen-patch |
| `60568ec` | fix(catalog): remove 5 builtin entries with non-existent npm packages |
| `3b78d10` | docs(dogfood): augment findings with Bug 4-5 + Step 6-9 verification table |

### What changed

**1. `add_mcp_catalog_entry` MCP tool** (commit `b793233`):
- `apps/server/src/kernel-next/mcp/tools/add-mcp-catalog-entry.ts` (new)
- `apps/server/src/kernel-next/mcp/tools/add-mcp-catalog-entry.test.ts` (new, 6 tests)
- Wraps `upsertCustomEntry` + optional `npm view <pkg>` healthcheck
  via existing `checkPackage` helper
- Source forced to "custom"; cannot overwrite builtin ids
- Exposed on EXTERNAL surface; tool counts: 33→34 / 34→35

**2. Generator prompt discipline rewrite** (commit `1617027`):
- `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/analysis.md`
- Step 7 rewritten as a 4-substep procedure: recommend → add-on-miss
  → **verbatim-fetch (REQUIRED, non-negotiable)** → ordering rationale
- Discovery discipline rules 4-6 rewritten so "add" is a permitted
  path with discipline (real package only, healthcheck-gated, try
  one alternative on miss before giving up)
- Old rule 4 ("Never invent entries") flipped to "adding is supported"
  + new rule 5 ("never hand-write `recommendedMcps` rows from training
  data — go through recommend or add")

**3. Modifier prompt mirror** (commit `865961d`):
- `apps/server/src/builtin-pipelines/pipeline-modifier/prompts/system/gen-patch.md`
- "Catalog discovery" section added with the same 5-step chain plus
  one extra source (currentIr verbatim copy)

**4. Catalog rot fix** (commit `60568ec`):
- `apps/server/src/kernel-next/mcp-catalog/entries.json` — deleted 5 of 12 entries:
  - `etherscan`, `bscscan`, `fetch`, `arxiv`, `linear` — packages 404 on npm
- `apps/server/src/kernel-next/mcp-catalog/e2e.test.ts` — adjusted assertions
- `docs/superpowers/dogfood-2026-04-28/findings.md` (new)
- `docs/superpowers/dogfood-2026-04-28/ux-findings.md` (new)
- `docs/superpowers/dogfood-2026-04-28/01-gate-fullpage.png` (new)
- `docs/superpowers/dogfood-2026-04-28/02-gate-viewport.png` (new)

**5. Dogfood findings augmented** (commit `3b78d10`):
- Bug 4 (CHECK constraint old DB) + Bug 5 (header state badge) documented
- Step 6-9 verification table added
- Two more screenshots: `03-secret-gate-viewport.png`, `04-secret-gate-fresh-db.png`

## What still works after this session

```bash
cd /Users/minghao/workflow-control/apps/server
npx tsc --noEmit                 # clean
npx vitest run                   # 2053 passed / 4 skipped, no new fails
                                 #   (3-4 known flakes in spawn-utils,
                                 #    publish, start-pipeline-run.worktree
                                 #    are pre-existing)
```

## Live dogfood: 6 real bugs surfaced

Documented in `docs/superpowers/dogfood-2026-04-28/findings.md`. Quick
summary for the next session:

| # | Severity | What | Status |
|---|---|---|---|
| 1 | P0 (blocker) | 5/12 builtin catalog packages 404 on npm | **fixed** in `60568ec` |
| 2 | P2 | `gen-skeleton` slug-rewrites mcpServers.name (`Fetch MCP` → `fetch-mcp`) | **documented**, follow-up |
| 3 | P2 (UX) | gate panel `<details open>` defaults open → 17-port table dominates first viewport, approve/reject buttons off-screen | **documented**, follow-up |
| 4 | P1 | stage_attempts CHECK on legacy DBs missing `secret_pending` | **documented** — per CLAUDE.md §8.1 wipe DB, no migration |
| 5 | P2 (UX) | dashboard task header badge reads `state: completed` while body shows secret-gate panel | **documented**, follow-up |
| 6 (round 1) | P1 prompt | analyzing agent skipped add-on-miss + hallucinated builtin package names | **fixed** in `1617027` (prompt discipline rewrite) |

## Live dogfood Step 6-9 status

| Step | Status | Notes |
|---|---|---|
| 6 — `run_pipeline { name }` resolves to versionHash + starts task | ✅ | Verified twice (Hacker News attempt + GitHub Issues Lister) |
| 7 — secret-gate triggers when MCP envKey missing | ✅ | `requiredKeys=[GITHUB_PERSONAL_ACCESS_TOKEN]`, `stillMissing=[same]` |
| 8 — user provides secret + (optional) save to inventory | ❌ | Not exercised: CLAUDE.md secret rule forbids tokens in chat; no shell access to set `process.env` out-of-band |
| 9 — task continues, real MCP runs, output produced | ❌ | Blocked by 8 |

So real-runtime verification stopped at "secret-gate panel renders
correctly with `Save to inventory as <id>` checkbox". Steps 8-9 need
a session where the user exports a real `GITHUB_PERSONAL_ACCESS_TOKEN`
in their shell and starts the server, OR a fully scoped token
provided through `task_env_values` directly to `run_pipeline`.

## Open issues for next session (priority order)

### High value, can pick up immediately

1. **Add boot-time / CI healthcheck for entries.json**.
   Right now nothing prevents another rot. Smallest viable: a vitest
   that uses the real (mockable) `checkPackage` against every builtin
   entry, with a way to skip it in CI when offline. Even better: a
   preflight check at server boot that warns (not fails) on rot.
   Touches `apps/server/src/kernel-next/mcp-catalog/seed.ts` +
   a new test file.

2. **Repopulate the 5 deleted entries with real packages**.
   Initial probe found candidates:
   - `etherscan` → `@everimbaq/etherscan-mcp@1.0.3`
   - `fetch` → `fetch-mcp@0.0.5`
   - `arxiv` → `@fre4x/arxiv@1.0.64`
   - `bscscan` → no plausible npm package found (defer)
   - `linear` → no plausible npm package found, `mcp-remote
     https://mcp.linear.app/mcp` works as a remote MCP per
     `mcp-remote-preflight.test.ts:224` (different pattern)
   Each candidate needs (a) `npm view` confirms, (b) check the
   package's docs / repo for envKeys + args + a working
   description, (c) write to `entries.json`, (d) reseed DB.

3. **Apply the verbatim-fetch discipline to `gen-skeleton.md`**.
   Bug 2: skeleton silently slug-rewrites `mcpServers.name`.
   Mirror the `analysis.md` change: require `get_mcp_catalog_entry`
   call before placing any `mcpServers` block in the IR; copy
   `name`/`command`/`args`/`env`/`envKeys` verbatim. File:
   `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/gen-skeleton.md`.

4. **Fix dashboard state badge** (Bug 5). Read from `/api/kernel/tasks/:id/status`
   instead of the most recent `task_state` SSE event. Touches
   `apps/web/src/app/kernel-next/[taskId]/...` (find the component
   that renders the `state: <X>` line near the task header).

### Lower priority

5. **Default `<details open={false}>` for the gate analyzing port table**
   (Bug 3). Optional improvement: render a 3-line exec summary
   (pipelineName / pipelineDescription / dataFlowSummary) above the
   collapsed details so users have decision-relevant info without
   expanding.

6. **Dogfood pipeline-modifier under live LLM**. Modifier got the
   same prompt discipline as generator (commit `865961d`) but never
   ran against a real LLM. The modifier-specific bugs would only
   show up there.

## Server / dashboard state at handoff

- **Server**: pid varies, last started by `pnpm dev:server` against
  fresh DB after Bug 4 wipe. If you `pkill -f "tsx.*src/index.ts"` and
  restart, it'll reseed the 7 surviving builtin entries.
- **Dashboard**: pid varies, started with `pnpm dev:web` on port 3004.
- **DB**: `/tmp/workflow-control-data/kernel-next.db` — currently has
  the fresh post-wipe schema with `secret_pending` in the CHECK.
  Contains a few orphaned dogfood tasks; not critical.
- **Browser**: chrome-devtools-mcp instance was spawned during this
  session — if locks accumulate, `pkill -f "chrome-devtools-mcp"`
  + `rm /tmp/chrome-e2e-profile/Singleton*` clears them.

## Things NOT to do

- **Do not** propose adding a YAML migration for the CHECK constraint
  drift. CLAUDE.md §8.1 explicitly says "no migrations during R&D;
  wipe data_dir."
- **Do not** restore the 5 deleted entries to entries.json without
  first probing `npm view <pkg> version` and confirming a publisher.
  This is exactly the rot the dogfood caught.
- **Do not** propose to mutate IR via `propose_pipeline_change` to
  remove a `mcpServers` block as a workaround for missing envKey.
  Per CLAUDE.md, that corrupts pipeline-author intent. Secret-gate
  is the recovery path.

## Key files for fast onboarding

- `apps/server/src/kernel-next/mcp-catalog/` — catalog subsystem
- `apps/server/src/kernel-next/mcp/tools/` — every MCP tool, including
  the new `add-mcp-catalog-entry.ts`
- `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/` —
  the prompts dogfood drove changes into
- `docs/superpowers/dogfood-2026-04-28/findings.md` — the
  authoritative dogfood writeup; read this before working on the
  follow-ups
