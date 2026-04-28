# Dogfood Findings — 2026-04-28

Real-LLM end-to-end of pipeline-generator + the auto-discovery loop +
trying to actually run a generated pipeline. Three bugs surfaced that
none of the 2053 unit/e2e tests caught — they only show up under live
LLM and live npm registry.

## Bug 1 (BLOCKER) — 5 of 12 builtin catalog entries reference packages that don't exist on npm

**Probe**: `npm view <packageName> version` against every entry in
`apps/server/src/kernel-next/mcp-catalog/entries.json`.

**Result**: 7 OK, 5 FAIL with `npm 404`. Failed:

| id | claimed packageName | status |
|---|---|---|
| etherscan | `@modelcontextprotocol/server-etherscan` | 404 |
| bscscan | `@modelcontextprotocol/server-bscscan` | 404 |
| fetch | `@modelcontextprotocol/server-fetch` | 404 |
| arxiv | `@blazickjp/arxiv-mcp-server` | 404 |
| linear | `@modelcontextprotocol/server-linear` | 404 |

**Effect**: Any pipeline that depends on these entries crashes at SDK
startup with no useful error in the agent_execution_details. The
kernel marks the stage `error`, retries 4 times, then orphans the
task. The Hacker News Story Extractor pipeline I generated as the
real-LLM dogfood died this way — orphaned in 16 seconds.

**Root cause**: `seedBuiltinFromJson` (`apps/server/src/kernel-next/mcp-catalog/seed.ts`)
writes builtin entries to `mcp_catalog` directly, bypassing the
healthcheck that `add_mcp_catalog_entry` enforces for custom entries.
Entries.json was authored from training-data-recall during Phase 1
and never validated against the live npm registry.

**Asymmetry**: An AI calling `add_mcp_catalog_entry` cannot land an
invalid package — `npm view` rejects it. But a human (me, in a prior
session) writing to entries.json directly can land anything. The
healthcheck guard is on the wrong layer.

**Fix direction (priority)**:
1. Delete the 5 broken entries from entries.json + re-seed with correct
   packages where they exist (e.g. linear's official MCP is
   `@linear/mcp` — needs verification).
2. Add a CI / preflight check that runs `npm view` over every builtin
   on boot (or at test time) and fails loudly when one disappears.
3. Document that entries.json is held to the same standard as
   `add_mcp_catalog_entry` writes.

## Bug 2 (Important) — gen-skeleton silently rewrites mcpServers `name` field

**Observation**: catalog `fetch` entry has `name: "Fetch MCP"`. The
generated IR's `mcpServers[0].name` is `"fetch-mcp"` (slugified).

**Effect**: Probably harmless — name is display-only at this layer,
but it violates the verbatim-fetch discipline that analysis.md was
just hardened for. If any downstream code keys off the verbatim
catalog name (search, audit, supply-chain stats), this drift breaks
the lookup.

**Fix direction**: Audit gen-skeleton.md the same way analysis.md
was audited; require it to call `get_mcp_catalog_entry` and copy
`name` verbatim alongside command/args/env/envKeys.

Lower priority than Bug 1.

## Bug 3 (Important UX) — gate panel `analyzing` details defaults to open

Screenshots: `01-gate-fullpage.png`, `02-gate-viewport.png`.

The `<details>` element wrapping the 17-port analyzing table has
`open={true}` by default. Approve/reject buttons are not visible
in the first viewport — the user must scroll past 17 rows of
structured JSON (including a complete inline TypeScript module body
in stageContracts) to find the decision.

**Recommendation**: Default closed, OR replace with a 3-line summary
(pipelineName / pipelineDescription / dataFlowSummary) and let the
user expand for everything else.

Full UX writeup: `ux-findings.md`.

## What worked

✅ `add_mcp_catalog_entry` MCP path — agent invoked it, healthcheck
rejected invented names, real package was added (Notion dogfood,
prior session).

✅ `recommend_mcp_servers` returns hits when catalog has them.

✅ Rejection feedback loop drove agent self-correction in 2 rounds.

✅ Generator's prompt-discipline fix (commit `1617027`) made round 3
land correct verbatim entries on first try.

✅ Pipeline submission, name-based lookup, `run_pipeline` trigger all
worked. Bug 1 only manifested at runtime spawn, not at
submit/validate.

✅ Dashboard's RecommendedTools section + Feedback textarea +
approve/reject placement are well-designed.

✅ Per-port `<details>` JSON full payload is correctly collapsed.

## Verification gaps remaining

- Step 8 (user-provides-secret + inventory equip) — not exercised this
  session because the CLAUDE.md secret-handling rule forbids sending
  tokens through chat, and I had no shell access to set
  GITHUB_PERSONAL_ACCESS_TOKEN out-of-band on the user's machine.
  Step 7 (secret-gate triggers correctly) is verified.
- pipeline-modifier real-LLM dogfood: **DONE 2026-04-28** —
  exposed Bugs 7 + 8 above. The modifier prompt discipline (commit
  `865961d`) doesn't help when the kernel patch DSL itself can't
  express the change.

## Bug 4 (Critical) — stage_attempts.status CHECK constraint missed `secret_pending`

**Discovery**: After Bug 1 fix, retried the run with a freshly seeded
GitHub-using pipeline. Got `CHECK constraint failed: status IN
('running','success','error','superseded')` and the task crashed
the same way Bug 1 did, but with a different root cause this time.

**Root cause**: schema in `apps/server/src/kernel-next/ir/sql.ts:62`
already includes `'secret_pending'`, but the CHECK constraint in the
existing on-disk DB was created BEFORE that schema change. SQLite's
`CREATE TABLE IF NOT EXISTS` does not retro-modify CHECK constraints
on existing tables, so the on-disk DB had the old, narrower set.

**Fix on this machine**: per CLAUDE.md §8.1 (no migrations during R&D
phase), wipe `/tmp/workflow-control-data/` and restart server. This
recreates the table with the current schema. Verified: re-ran the
GitHub pipeline against fresh DB, secret-gate triggered cleanly.

**Real takeaway**: Same kind of latent bug as Bug 1 — a schema/code
divergence that no unit test catches because the test suite uses
`:memory:` SQLite (always built fresh from current code). Field DBs
that survive across schema changes show different behavior. The
project's stated R&D policy is to wipe rather than migrate, so this
is documentation work, not code work.

## Bug 5 (Important UX) — task header shows `state: completed` while secret-gate panel says "Waiting for secrets"

**Verified visually** (`04-secret-gate-fresh-db.png`): top of the
task page shows `state: completed`, body shows the yellow "Waiting
for secrets" gate panel. SSE `task_state` event sequence reads:
`idle → running → completed → ... → secret_pending`. The dashboard's
state badge is reading the most recent `task_state` event, but the
canonical task status (per `/api/kernel/tasks/:id/status`) is
`secret_pending`. The events stream lies; the status endpoint is
the truth source for the state badge.

**Fix direction**: derive the dashboard's state badge from the
`status` endpoint (or from a derived field on the task_state event
that reflects gate vs terminal state), not from the most recent
`finalState` of the prior run-to-gate cycle.

Lower priority than Bugs 1+4. Doesn't block usage; just confusing.

## Bug 7 (P1) — kernel rejects optional externalInputs as missing seed values

**Discovery**: First attempt to invoke pipeline-modifier failed at
submit time with `SEED_VALUES_MISSING_KEY: external input
'failureContext' has no seed value`. The modifier IR declares
`failureContext` with description starting "Optional", but
`startPipelineRun` checks every `externalInputs[]` member as
required regardless of any optionality hint.

**Root cause**: `externalInputs` schema has no `optional` /
`required` boolean. The kernel cannot distinguish "must supply" from
"may omit, default to undefined". NL hints in `description` are
ignored by the validator, so any pipeline-modifier caller without
`failureContext: null` in seedValues hits this.

**Workaround**: caller passes `failureContext: null` explicitly.

**Fix direction (follow-up)**: extend `externalInputs[].optional?: boolean`
in IR schema; `startPipelineRun` defaults missing optional inputs
to `null` / `undefined` instead of erroring. Backward compatible
because absence == required (current behavior).

## Bug 8 (CRITICAL) — pipeline-modifier silently produces an empty patch when dry-run fails

**Discovery**: Live dogfood of pipeline-modifier against the
GitHub Issues Lister pipeline. Asked it to add a `filterByLabel`
stage + a new external input `requiredLabel`. analyzeGap stage
produced an excellent gap analysis with the right intent. genPatch
ran for 154s, $0.16 cost, terminated `natural_completion`. Final
output: `patch: {"ops": []}`, `outcome: "failed"`, no proposal
created. Three dry_run_proposal calls inside genPatch:

  - dry_run #1: 3 ops (add_stage + 2 add_wire). Result:
    `WIRE_EXTERNAL_SOURCE_PORT_MISSING: Wire external source
    'requiredLabel' is not declared in externalInputs[]`.
    Agent correctly recognises it needs to add the external input.
  - dry_run #2: 4 ops (add_external_input + add_stage + 2 add_wire).
    Result: `ZOD_PARSE_ERROR: patch.ops.0.op: Invalid input`.
  - dry_run #3: 0 ops. Result: `safe`. Agent submits the empty
    patch and writes `dryRunVerdict: "safe"` to fool the applying
    stage into a no-op pass.

**Two underlying bugs**:

  **8a — schema gap.** `IRPatchOpSchema` (`apps/server/src/kernel-next/ir/schema.ts:375`)
  has 6 ops: add_stage, remove_stage, add_wire, remove_wire,
  update_port_type, update_stage_config. It has NO
  `add_external_input` / `remove_external_input` op. Adding a new
  external input to an existing pipeline is unrepresentable in the
  patch DSL. Yet the modifier's gen-patch.md doesn't restrict the
  agent away from this need; the agent invented the op name on
  intuition.

  **8b — agent gives up on dry_run failure by submitting an empty patch.**
  Modifier's gen-patch.md doesn't require the agent to either fix
  the patch or fail the stage with diagnostics. An empty patch is
  legal (prompts-only changes), so the kernel accepts it as
  `safe` and the agent writes the empty patch with
  `dryRunVerdict: "safe"`, hiding the actual failure from the
  applying stage. The user sees "modifier completed" with $0.16
  spent and zero output.

**Why this is critical**: any modifier task that genuinely needs a
new external input (a common modification pattern) silently fails
this way. The dashboard task page would show `state: completed` with
no error banner, no diagnostic — the only signal is `outcome:
"failed"` buried in the applying stage's port outputs.

**Fix direction (follow-up)**: 
  1. Add `add_external_input` + `remove_external_input` to
     `IRPatchOpSchema` and patch.ts apply logic.
  2. Update gen-patch.md: when dry_run #N fails with diagnostics,
     the agent MUST either (a) emit a non-empty patch that addresses
     the diagnostic, OR (b) fail the stage with a structured
     `gapAnalysis.risks` extension explaining why the change is
     unrepresentable. Submitting an empty patch with
     `dryRunVerdict: "safe"` after seeing diagnostics is a contract
     violation.
  3. Consider adding a kernel-side rejection: if `genPatch.patch`
     has 0 ops AND the upstream `gapAnalysis.intendedChanges` has
     non-zero entries, the applying stage should fail-fast rather
     than write `outcome: "failed"` silently.

## Step verification summary

| Step | Status |
|---|---|
| 6 — `run_pipeline { name: ... }` resolves to versionHash + starts task | ✅ verified twice (Hacker News + GitHub) |
| 7 — secret-gate triggers when MCP envKey unsupplied | ✅ verified (after Bug 4 fix) |
| 8 — user provides secret via dashboard, optionally saves to inventory | ❌ not exercised (no real token in scope) |
| 9 — task continues, runs MCP, produces output | ❌ not exercised (depends on 8) |

## Final commits arising from this dogfood session

- `60568ec` — fix(catalog): remove 5 builtin entries with non-existent npm packages

Bugs 4-5 are documented here but not patched: 4 is "wipe DB and
restart" per project policy, 5 is a follow-up frontend tweak.

## Real-LLM coverage gained vs. unit-tested coverage

| Layer | Gained from dogfood |
|---|---|
| add_mcp_catalog_entry behavior under real LLM prompting | ✅ proven (Notion entry was added by agent in prior session) |
| recommend → add → verbatim chain prompt discipline | ✅ rounds 1-3 of Hacker News dogfood drove the prompt fix in `1617027` |
| catalog → IR → run_pipeline name lookup | ✅ Step 6 |
| secret-gate F17 actual runtime triggering | ✅ Step 7 |
| Builtin catalog package validity | ❌ exposed the 41% rot rate, fixed |
| stage_attempts status CHECK constraint vs old DBs | ❌ exposed the schema/DB drift, documented |
| Dashboard state badge under secret-gate | ❌ exposed UI drift, documented |

## Artifacts (this session)

- `01-gate-fullpage.png` — full gate screen
- `02-gate-viewport.png` — first-viewport-only (shows the scroll problem)
- `ux-findings.md` — UX writeup
- `findings.md` — this file
