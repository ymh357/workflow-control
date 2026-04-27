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

- Step 7-9 (real pipeline run; secret-gate; inventory equip) is
  blocked by Bug 1. Will retest after the catalog fix lands.
- pipeline-modifier real-LLM dogfood (still mocked-only).
- secret-gate first-run UX with real envKey-bearing entry.

## Artifacts (this session)

- `01-gate-fullpage.png` — full gate screen
- `02-gate-viewport.png` — first-viewport-only (shows the scroll problem)
- `ux-findings.md` — UX writeup
- `findings.md` — this file
