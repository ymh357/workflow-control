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

## Session 2 final (2026-04-28 ~08:30 → 09:40)

**8 commits in this session**:
- `371c036` rot guard + gen-skeleton verbatim
- `a8a6766` dashboard state badge fix
- `805bdfd` gate card decision summary + collapse
- `f7ae92d` modifier dogfood + bugs 7-8 docs
- `0d86be9` add_external_input / remove_external_input patch ops
- `88c26a7` externalInputs.optional flag
- `eedd14a` canonical hash includes optional
- (this session's earlier `60568ec` and prior session)

**Bug fix score**: 7 fixed, 1 documented (Bug 4 per CLAUDE.md §8.1 wipe policy).

**End-to-end re-dogfood verification (2026-04-28 09:34→09:38)**:
After all fixes landed and server restarted with reseeded IR
(version_hash 9510456c..., new — old e851202f... had no `optional`
flag because canonical hash didn't include it), reran the same
modifier task that originally failed:

  Round 1 (broken): patch `{"ops": []}`, outcome `"failed"`,
                    proposalId `""`, 156s + $0.16 wasted.
  Round 2 (fixed):  patch with 4 ops (add_external_input + add_stage
                    + 2× add_wire), outcome `"pending-approval"`,
                    proposalId `868af035-...`, dryRunVerdict
                    `"structural"`, proposedVersion `75421c60...`.

Bug 7 + Bug 8a + Bug 8b all closed under live LLM. Modifier
end-to-end works.

## Session 2 progress (2026-04-28 ~08:30 → 09:00)

Continued the dogfood follow-ups + ran live-LLM modifier for the first time.

**3 commits added:**
- `371c036` — fix(mcp-catalog): rot guard + gen-skeleton verbatim discipline
- `a8a6766` — fix(dashboard): task header state badge reads canonical /status
- `805bdfd` — fix(dashboard): gate card decision summary + collapse 17-port table

**Bugs fixed:** 2 (catalog rot guard, gen-skeleton verbatim), 3 (gate UI density), 5 (state badge drift). All verified live in browser.

**New bugs surfaced:**
- **Bug 7** — kernel rejects optional externalInputs as missing seed values (modifier's `failureContext` only optional in description)
- **Bug 8** (CRITICAL) — pipeline-modifier silently emits empty patch when patch DSL can't express the need (`add_external_input` op missing from `IRPatchOpSchema`); agent then submits empty patch with `dryRunVerdict: "safe"` after seeing dry_run diagnostics, masking the failure

See `findings.md` for full bug 7+8 writeup.

## Open issues for next session (priority order)

### High value, can pick up immediately

0. **Bug 8 — patch DSL gap + agent silent empty-patch fallback** ✅ DONE
   `0d86be9`. Schema gets add_external_input / remove_external_input;
   patch.ts gets two new switch cases; gen-patch.md gets ops 7+8 plus
   a hard rule against submitting `ops: []` with `dryRunVerdict: "safe"`
   after a non-empty draft hit `ok: false`. Verified end-to-end above.

0b. **Bug 7 — externalInputs `optional` flag** ✅ DONE
    `88c26a7` + `eedd14a`. PortIR.optional ripples through three
    layers: schema, runner.ts seed validation, ir-to-machine.ts
    initial portValues, AND canonical.ts hash input. All four needed
    or the runtime fix never reaches a fresh boot. Verified via
    re-dogfood with hash 9510456c....

1. **Add boot-time / CI healthcheck for entries.json** ✅ DONE
   commit `371c036`. New
   `apps/server/src/kernel-next/mcp-catalog/entries-rot-guard.test.ts`
   uses `checkPackage` against every builtin. Default skipped; opt-in
   with `RUN_NPM_HEALTHCHECKS=1`. 7/7 surviving entries verified.

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

3. **Apply the verbatim-fetch discipline to `gen-skeleton.md`** ✅ DONE
   commit `371c036`. Step 1 marked REQUIRED non-negotiable; Step 2
   enumerates forbidden transformations on `name`. Not yet
   re-dogfooded (next generator run will reveal whether the slug
   rewrite is actually fixed under live LLM).

4. **Fix dashboard state badge** (Bug 5) ✅ DONE
   commit `a8a6766`. Status poller now drives topState; TopLevelState
   union extended to include gated/secret_pending/cancelled/orphaned.
   Verified live: header reads `state: secret_pending` matching gate
   panel.

5. **Default `<details open={false}>` + decision summary card** (Bug 3) ✅ DONE
   commit `805bdfd`. Decision summary card (pipelineName +
   pipelineDescription + dataFlowSummary, truncated 600 chars)
   rendered above the details wrapper for any upstream that emits
   the triple. Details `open={up.outputs.length <= 5}` — small
   upstreams stay open, fat ones (the 17-port analyzing) collapse.
   Verified live in browser.

6. **Dogfood pipeline-modifier under live LLM** ✅ DONE
   Surfaced Bugs 7 + 8 (see top of section). The modifier prompt
   discipline alone wasn't enough — kernel patch DSL is missing
   ops the modifier provably needs.

### Still open

7. **Replenish deleted catalog entries with verified packages**.
   Candidates from prior probing:
   - `etherscan` → `@everimbaq/etherscan-mcp@1.0.3`
   - `fetch` → `fetch-mcp@0.0.5`
   - `arxiv` → `@fre4x/arxiv@1.0.64`
   - `bscscan` → no plausible npm package found
   - `linear` → no plausible npm package found; `mcp-remote
     https://mcp.linear.app/mcp` works as a remote MCP per
     `mcp-remote-preflight.test.ts:224`
   Each candidate needs (a) `npm view` confirms (or use the new
   rot-guard test), (b) review the package's docs for envKeys + args
   + a working description, (c) write to entries.json, (d) reseed.

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
