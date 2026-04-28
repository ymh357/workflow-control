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

## Bug 9 (P0) — npm-view existence ≠ runnable

**Discovery**: After replenishing 3 catalog entries (etherscan, fetch,
arxiv) in commit `7c33dc6`, ran the freshly-generated "Hacker News
Top Stories" pipeline as Step 6-9 verification. Pipeline orphaned
in 12s with no useful diagnostic — exactly the same shape as Bug 1
on entries that DO pass the mode-1 rot-guard.

**Root cause**: `fetch-mcp@0.0.5` exists on npm and `npm view` returns
its version, but `npx -y fetch-mcp` immediately throws
`ERR_PACKAGE_PATH_NOT_EXPORTED` because its `cacheable-request`
dependency tries to import `get-stream` from a path the published
package didn't export. The MCP server never starts; the SDK gets
a process exit before initialize.

**Two earlier entries also had latent issues that mode-1 missed:**

  - **postgres**: `npx @modelcontextprotocol/server-postgres` errored
    "Please provide a database URL as a command-line argument" —
    catalog `args` was `["-y", "@modelcontextprotocol/server-postgres"]`
    but the server expects the connection string as `args[2]`.
  - **slack**: server errored "Please set SLACK_BOT_TOKEN and
    SLACK_TEAM_ID" — catalog `envKeys` only listed `SLACK_BOT_TOKEN`,
    missing the `SLACK_TEAM_ID` requirement.

**Pattern**: every catalog supply-chain bug looks the same to the user
("orphaned with stage_executor failed"). Mode-1 (npm view) only
catches the "package doesn't exist" tier. The deeper tier — "package
exists but can't actually start as an MCP server" — needs a real spawn
+ initialize handshake.

**Fix (commit `8d39ada`):**

  1. Remove fetch entry from catalog (no working alternative found
     this session).
  2. Fix postgres args: add `${POSTGRES_CONNECTION_STRING}` placeholder.
  3. Fix slack envKeys: add SLACK_TEAM_ID with obtainSteps.
  4. Extend rot-guard test with `RUN_NPM_HEALTHCHECKS=2` mode that
     `npx -y` spawns each entry and waits for the JSON-RPC initialize
     result. Sequential (parallel npx hits npm mutex contention),
     60s timeout, skip entries with `${VAR}` placeholder args,
     mark arxiv as known-flaky (works standalone, times out in vitest
     worker, low confidence in cause).

**Lesson**: every layer of the supply chain needs a different test:
  - schema validation → unit test (zod)
  - package exists → npm view (mode-1)
  - package starts → spawn + initialize (mode-2)
  - package authenticates → impossible without real creds; manual
  - package satisfies the agent's needs → live LLM dogfood

Each layer catches something the layers above it can't.

## Bug 10 (P1) — spawn-test pass ≠ SDK-runnable

**Discovery**: After Bug 9 fix (catalog count 9 with all spawn-test
passing or known-flaky), generated an "arXiv Paper Search" pipeline
to dogfood Step 6-9 end-to-end. Pipeline orphaned in 26s, 0
agent_stream events — SDK couldn't establish MCP handshake.

**Root cause**: `@fre4x/arxiv` cold-start needs ~25s (verified via
standalone `node -e` probe). The Claude Agent SDK's MCP startup
budget for stdio servers is shorter than that. Standalone manual
probe → 25s success. Inside SDK runtime → 26s orphan.

**The flake was signal**: the spawn-test rot-guard's `SKIP_SPAWN_TEST`
list (added in 8d39ada) marked arxiv as "works standalone, times
out inside vitest worker". I treated that as test-harness noise
("low confidence in cause"). It wasn't noise — it was the same
slow-cold-start problem the SDK runtime hits. Slow standalone +
slow inside vitest worker + slow inside Claude SDK is one
phenomenon, not three.

**Fix (commit `05be361`)**: removed arxiv from catalog. No way to
extend SDK's MCP startup window without a public config option;
warming npx cache pre-emptively is fragile.

**Lesson**: extend the supply-chain testing ladder.

  - schema → unit
  - exists → npm view (mode-1)
  - starts → spawn + initialize (mode-2)
  - **starts in time** → spawn-test must respect the SDK's startup
    budget, not its own 60s timeout. If a package needs 25s to
    boot inside vitest, it will need 25s+ inside the SDK and
    likely time out there. Mode-2 should fail at the SDK budget,
    not at a generous test-harness budget.
  - authenticates → manual
  - satisfies agent → live LLM dogfood

Spawn-test should be hardened to fail at the SDK's MCP startup
budget (~10s based on observation, exact value unknown). That
makes the test surface the real-runtime constraint, not just
"package starts eventually". Tracked as a follow-up.

## Bug 11 (P2) — MCP_STARTUP_FAILED for spawn-test-passing entries

**Discovery**: After Bug 10 fix (split-budget spawn-test), generated
"Page Title Extractor" using playwright entry (which passed mode-2
spawn-test in 5.6s). Real run orphaned in 43s with
`MCP_STARTUP_FAILED: declared external MCP server(s) 'playwright'
did not advertise any tools at session init`.

**Root cause**: SDK validates not just MCP `initialize` handshake
but also that the server advertises tools at session init via
`tools/list`. spawn-test verifies the former but not the latter.
Some packages (this run: @playwright/mcp) reply to initialize but
either don't reply to tools/list within SDK budget, or reply with
empty tools.

**Difference from Bug 10**: arxiv was slow on initialize (>10s).
playwright is fast on initialize but slow / silent on tools/list.
Same "MCP_STARTUP_FAILED" symptom; different protocol stage.

**Fix options (not in this commit)**:
  1. Extend spawn-test to also send `tools/list` after initialize
     and require ≥1 tool in the response within SDK budget.
  2. Add the same to add_mcp_catalog_entry's healthcheck so
     newly-added entries are blocked at write time.

**Workaround for now**: drop playwright from the catalog if the
problem reproduces on a fresh server. (This run might be transient
network/SDK weirdness — both runs of the SAME pipeline did the
same thing, so likely not transient. Confirmed pattern, fix
deferred.)

**Update 2026-04-28**: spawn-test extended (commit f3b2256+follow-up)
to send `tools/list` after `initialize` and verify ≥1 tool is
advertised within SDK budget. ALL 8 entries pass this enhanced
test, INCLUDING playwright — yet playwright still throws
MCP_STARTUP_FAILED in the real SDK runtime. So tools/list-against-
stdio is necessary but not sufficient. The remaining gap is the
SDK's own MCP transport / framing — possibly a protocol-version
mismatch or a quirk of how the Claude Agent SDK negotiates that
the standalone `npx` JSON-RPC probe doesn't replicate. Tracked
as a future investigation; the 5-rung supply-chain test ladder
holds for everything except this last mile.

**Update 2026-04-28 (continuation session) — root cause located**:
Wrote `apps/server/scratch-bug11-repro.mjs` (gitignored) — a minimal
SDK reproducer that mounts playwright as the only stdio MCP and
captures the system/init message + stderr callback. Findings:

1. `system/init.mcp_servers[]` has the shape
   `{ name, status }` where `status ∈ {"connected","failed","needs-auth","pending","disabled"}`.
   This is the SDK's authoritative signal — it tells the kernel *exactly* whether each declared MCP came up.
2. `apps/server/src/kernel-next/runtime/real-executor.ts:709-736`
   (the Bug-3 / MCP_STARTUP_FAILED detector) **does not read this
   field**. It infers status indirectly by checking whether the
   `tools[]` array contains any `mcp__<name>__*` entry. Indirect
   inference loses information: `needs-auth` and `failed` are both
   "no tools" but they need different operator messages.
3. The SDK ALSO emits "Connection failed after Xms: <reason>" debug
   lines when an MCP fails to handshake (proven by grep of
   `cli.js`: `Connection failed after ${_}ms: ${w...}`). These flow
   through the SDK's `stderr` callback option. real-executor never
   passes a `stderr` callback to `buildSdkBaseOptions`, so this
   diagnostic stream is silently discarded.
4. In the playwright case specifically: when I reproduced with
   warm npm + playwright caches, status came back `"connected"`
   and 22 tools advertised — so the original Bug 11 was likely a
   **cold-cache spawn failure** that exceeded SDK's internal MCP
   timeout (the 43s "orphaned" measurement aligns with `npx`
   download + Chromium download on first run). The catalog
   `healthCheckTimeoutMs: 30000` for playwright is shorter than
   the cold-start path but the spawn-test pre-warms cache so it
   never sees the cold path.

**Concrete fix path (proposed, not yet implemented)**:
1. **real-executor.ts**: replace the tools[]-prefix scan with a
   status-field scan. For each declared external server, look up
   `mcp_servers.find(s => s.name === declaredName).status`. Throw
   only when status === "failed"; emit a distinct warning when
   status === "needs-auth"; treat "pending" as transient and
   re-check on the next assistant message instead of failing the
   attempt immediately.
2. **buildSdkBaseOptions**: add a `stderr` callback that funnels
   SDK debug output into the per-attempt agent log (writer.appendStderr).
   Then "Connection failed after Xms: <reason>" is preserved and
   surfaced in the dashboard's Logs tab — operator no longer needs
   to guess why an MCP didn't come up.
3. **rot-guard mode-3 (optional)**: simulate cold-cache by clearing
   `~/.npm/_npx/<hash>` and `~/Library/Caches/ms-playwright`
   before the spawn-test, with a 60s budget that matches SDK's
   real timeout. Mode-2 stays as the cheap "warm-cache sanity"
   check; mode-3 is the pre-release "would-this-survive-a-fresh-
   machine" check.

   **Implementation status (2026-04-28 continuation)**: mode-3
   landed in `entries-rot-guard.test.ts` — gated on
   `RUN_NPM_HEALTHCHECKS=3`, wipes `~/.npm/_npx` between entries
   so each spawn pays the full cold-start tarball-download cost.
   Same 60s budget as mode-2. **Never run on a CI/shared box** —
   the wipe nukes the cache for all packages. Run it manually on
   a developer machine before catalog releases when an entry is
   suspected to be download-heavy (browser binaries, native
   modules). Currently does NOT also wipe Chromium / Firefox
   caches; if a future entry's first-run downloads a browser
   binary it should self-describe a `browserCacheDir` for the
   test to clear.

**Lesson (extends Bug 9 + 10)**: each MCP protocol method is its
own supply-chain test. Initialize alone is not enough; the SDK
expects the full {initialize, tools/list, ...} sequence to
complete in budget. AND: the SDK already gives us the exact
status — read it directly instead of reverse-engineering it from
the tools list.

## Step verification summary

| Step | Status |
|---|---|
| 6 — `run_pipeline { name: ... }` resolves to versionHash + starts task | ✅ verified twice (Hacker News + GitHub) |
| 7 — secret-gate triggers when MCP envKey unsupplied | ✅ verified (after Bug 4 fix) |
| 8 — user provides secret via dashboard, task resumes, MCP gets the real value | ✅ **verified end-to-end** (continuation 2026-04-28) |
| 9 — task continues, runs MCP, produces output | ✅ **verified twice** — sequential-thinking SDK probe AND real GitHub API run |

**Step 9 verification (continuation, 2026-04-28)**: After adding the
`sequential-thinking` builtin (zero envKey, official MCP package),
ran `apps/server/scratch-step89-real.mjs` which calls the real SDK
`query()` with sequential-thinking attached as a stdio MCP. Results:

  - `system/init.mcp_servers[].status` for sequential-thinking → `"connected"`
  - SDK enumerated 21 total tools, including all `mcp__sequential-thinking__*`
  - Agent invoked `mcp__sequential-thinking__sequentialthinking` and
    received a real `tool_result` (45ms round trip)
  - Final assistant text returned "STEP_89_OK"; SDK closed with
    `result.subtype="success"`, `is_error=false`
  - Total turn: 29s (19s for cold-cache npx + tools/list, 6s for the
    tool roundtrip, 4s for the assistant's wrap-up text)

This proves that:
  1. The catalog → IR → expanded mcpServers → SDK runtime path works
     end-to-end for at least one builtin entry.
  2. The Bug 11 root-cause analysis (cold-cache cost on download-heavy
     packages, NOT a generic SDK transport bug) holds — a lightweight
     stdio MCP completes the full invocation cycle without issue.
  3. Step 8 (UI-driven envKey provisioning) is the only remaining gap;
     it requires either a real Brave/Etherscan key or a manual
     interactive walk-through of the dashboard's secret-gate panel.

**Step 8 verification (continuation, 2026-04-28)**: The user provided
a short-lived GitHub Personal Access Token (`public_repo` scope, 7-day
expiry, planned to be revoked after the test). Walked the GitHub
Issues Lister pipeline through the full secret-gate cycle:

  1. **Trigger task without envValues**:
     `POST /api/kernel/tasks/run` with `{ name: "GitHub Issues
     Lister", seedValues: { githubRepo: "modelcontextprotocol/servers",
     requiredLabel: "bug" } }` — task created, status quickly
     transitions to `secret_pending` (47ms attempt failure for
     fetchOpenIssues, parent task escalated to secret_pending).
  2. **Dashboard renders the gate UI** (`step8-01-gate-pending.png`):
     "Waiting for secrets" panel, "1 MISSING" badge, the exact
     stage + envKey shown
     (`stage fetchOpenIssues requires [GITHUB_PERSONAL_ACCESS_TOKEN]`),
     a textbox bound to that envKey, and a "Provide secrets & resume"
     button. UX is clear; copy is precise.
  3. **Token submission via HTTP API**:
     The browser-driven click on the button stalled (Next.js dev
     server's keep-alive socket was congested from a prior chrome
     restart — see "Bug 12" below). Submitting via the same backend
     endpoint the UI calls (`POST /api/kernel/tasks/:taskId/secrets`
     with `{ secrets: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_…" } }`)
     returned `{ ok: true, resolved: true }` immediately.
  4. **Task auto-resumes**: status flips secret_pending → running
     within ~2s of the secrets POST. No manual nudge needed.
  5. **MCP comes up + real tool call**: stage `fetchOpenIssues` ran
     for 37.9s (cold-start npx of `@modelcontextprotocol/server-github`
     + handshake + tool invocation + GitHub API roundtrip). Output
     port `issues` contains 10 real open PRs/issues from
     modelcontextprotocol/servers (numbers 4041-4056, valid GitHub
     URLs). The token reached the MCP subprocess and the GitHub API
     accepted it.
  6. **Downstream stage runs**: `filterByLabel` consumed the issues,
     ran for 31.8s, output `filteredIssues = []` (none of those 10
     issues happen to carry a "bug" label — correct empty result, not
     a failure).
  7. **Task terminates with status `completed`**
     (`step8-03-after-resume-completed.png`). Hot-update audit row
     shows the resume mechanism: actor `secret-gate-resume`,
     rerun-from `fetchOpenIssues`, proposal `approved`. So secret-
     gate-driven resume goes through the same hot-update infra as
     manual proposals — clean reuse of existing migration plumbing.

**Bug 12 (P3) — finalState ↔ status divergence after secret-gate resume**:
Top-level `status === "completed"` but the Run-Final panel shows
`finalState: failed` with `Stage errors: runPipeline timeout after
5400000ms` (5400s = 90min). The pipeline DID complete — output ports
are correct, downstream stages ran. Hypothesis: the runPipeline
watchdog timer started at the original task creation, kept counting
through the secret_pending dwell (~30 minutes between user
inattention and submit), and the watchdog fired even after the
re-attempted run succeeded — leaving its `failed` verdict in the
final-state record while the canonical task status caught up to
`completed` via the resume path. Doesn't break correctness but is
confusing UX. Tracked, not fixed in this session — needs a look at
the watchdog reset semantics on secret-gate-resume vs first-attempt
timing.

**Bug 13 (P3) — Next.js dev server stalls after chrome restart**:
After killing chrome instances mid-session, subsequent requests from
new chrome to `localhost:3004` (Next.js dev) accumulate in pending
state for minutes. Every request to /api/kernel/* (proxied through
Next.js to :3001) hangs even though :3001 itself is healthy. Likely
turbopack keep-alive pool not draining stale connections. Workaround:
hit the kernel-next API directly on :3001 (which is what we did to
complete Step 8). Tracked, not fixed.

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
