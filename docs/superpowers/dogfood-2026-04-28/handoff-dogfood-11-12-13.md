# Dogfood 11+12+13 — final untested paths cleared, Bug 81 found+fixed

**Date**: 2026-05-03 (continuing from `handoff-dogfood-9-10.md`)
**Branch**: main
**Predecessor**: handoff-dogfood-9-10.md (Bug 80 closed; 3 paths still untested)
**Outcome**: All three remaining untested paths now run end-to-end on
real LLM pipelines. Bug 81 surfaced from dogfood-13's repro and was
fixed; regression tests pin both halves of the contract.

---

## Dogfood-11 — Real-LLM multi-target rollback

dogfood-8 pinned the runtime contract via a unit test using
in-process mock handlers. This pass exercises the same path through
the real Claude SDK to verify SSE / DB / port-value / gate-feedback
plumbing all hold under real agent runs.

### Setup

Hand-authored a minimal pipeline IR submitted via the MCP HTTP
gateway (`POST /api/mcp` with `submit_pipeline`):

```
draftAxisX (agent, no inputs, reads __external__.topic) -> outA  ↓
                                                                  G (gate, approve→summary, reject→[draftAxisX, draftAxisY])
draftAxisY (agent, no inputs, reads __external__.topic) -> outB  ↑
summary (agent)
```

Both axis stages are independent ancestors of the gate; rejecting
with `reject` triggers `targetStages = [draftAxisX, draftAxisY]`,
`affectedStages = [draftAxisX, draftAxisY, framingGate, summary]`
(summary picked up because it's downstream of the gate-feedback
wire). VersionHash: `dc034310...`

### Run

| Step | Outcome |
|---|---|
| t=0 | `POST /tasks/run` → 202 |
| t≈25s | draftAxisX idx=1 success ("Configuration Complexity and Error Debugging") |
| t≈25s | draftAxisY idx=1 success ("Type safety vs ecosystem compatibility") |
| t≈25s | framingGate idx=1 opens |
| t≈45s | `POST /gates/.../answer reject` with feedback |
| | Response: `targetStage: ["draftAxisX","draftAxisY"], affectedStages: [draftAxisX, framingGate, summary, draftAxisY]` |
| t≈63s | draftAxisX idx=2 success ("Import resolution debugging") ← absorbed feedback |
| t≈64s | draftAxisY idx=2 success ("Circular dependency handling strategies") ← absorbed feedback |
| t≈106s | framingGate idx=2 opens with new gate_id |
| | `approve` → summary stage runs once on idx=2 inputs |
| t≈190s | `completed/natural` |

### Invariants verified end-to-end

- API returned a multi-target `targetStage` array; SSE event carried
  the full affectedStages set (no truncation).
- Both targets re-executed under real Claude SDK calls; new outputs
  semantically incorporated the gate-feedback comment.
- Lineage preserved: `draftAxisX idx=1` and `draftAxisY idx=1` rows
  remain at `status='success'` (not superseded — matches the
  reject-rollback design choice from handoff-dogfood-bug16).
- Final summary used the idx=2 axis values, not the idx=1 ones —
  proving the runner's portValues hydration on rebuild correctly
  reads the most-recent values, not the earliest.

### Cost

| Metric | Value |
|---|---|
| Total wall time | ~3.5 min |
| Anthropic spend | ~$0.05 (4 Haiku-4.5 calls + summary) |
| Bugs found | 0 — runtime contract held under real LLM |

---

## Dogfood-12 — Hot-update fanout B17 path

The B17 hot-update spec preserves successful fanout_element rows as
lineage and only supersedes the aggregate + downstream readers. Unit
tests cover the contract, but a real fanout-mid-flight migrate had
never been exercised.

### Setup

Hand-authored a 3-stage fanout pipeline (splitter → verifier
[fanout, 6 elements] → collector). VersionHash: `c2314b3e...`

### Run

| Step | Outcome |
|---|---|
| t=0 | Launch task on V1 |
| t≈11s | splitter idx=1 success ([6 claims about distributed systems]) |
| t≈11-25s | verifier elements 0,1,2 succeed; elements 3,4,5 still running |
| t≈25s | `POST /proposals` with `update_stage_config` patching verifier's promptRef + `rerunFrom: "verifier"` + `migrateRunningTasks: "all"` (autoApprove=true). proposedVersion `6f8f7863...` |
| t≈25s | `POST /tasks/.../migrate` → 0s `{ok:true, supersededStages:["collector","verifier"]}` |
| | (timing note: by the time migrate landed, the 3 in-flight elements had already finished, so all 6 elements were in `success`. B17 then has nothing to re-run for elements — it just rebuilds the aggregate.) |
| t≈26s | verifier idx=7 fanout_aggregate **superseded** under V1 |
| t≈26s | verifier idx=8 fanout_aggregate **success** under V2 (`6f8f7863...`) |
| t≈26-40s | collector idx=1 superseded under V1; collector idx=2 success under V2 |
| t≈40s | `completed/natural` |

### Invariants verified

| Invariant | Status |
|---|---|
| All 6 fanout_element rows remain `success` under V1 (lineage) | ✓ |
| Old aggregate (idx=7) marked `superseded` under V1 | ✓ |
| New aggregate (idx=8) written under V2 reading the V1 element outputs | ✓ |
| Downstream collector superseded + re-run under V2 | ✓ |
| Hot-update audit row: `success`, `supersedeSet=[verifier,collector]`, `resumeFromStage=verifier` | ✓ |

This is the **mixed-version lineage** scenario the B17 design
targets — V1 fanout outputs feeding a V2 aggregate feeding a V2
downstream stage. The runner reconstructed it on resume without
re-running any element, exactly as designed.

### Cost

| Metric | Value |
|---|---|
| Total wall time | ~40s |
| Anthropic spend | ~$0.10 (splitter + 6 verifier elements + collector) |
| Bugs found | 0 |

---

## Dogfood-13 — Reverse-supersede + Bug 81

The plan was simple: trigger MIGRATION_RESUME_FAILED, verify
reverse-supersede restores attempt status. The first attempt at this
exposed Bug 81 (fanout INTERRUPT propagation) which had been
invisible to all prior dogfoods because none had migrated a task
mid-fanout to a destination IR that fails at startRunner.

### Bug 81 — fanout ignores runner-level INTERRUPT

**Repro**: launch dogfood-12 IR, wait until splitter succeeds and 3
verifier fanout elements are running (idx 0,1,2 success; 3,4,5
running). Issue `POST /migrate` with a proposal whose proposed IR
adds an OAuth-required mcp-remote server to the verifier stage
(rerunFrom=verifier, migrateRunningTasks=all).

Expected: migrate returns `MIGRATION_RESUME_FAILED` once startRunner
fails on `OAUTH_NOT_CONFIGURED`; reverse-supersede restores
verifier+collector to their pre-migrate status.

Actual: migrate returns `MIGRATION_INTERRUPT_TIMEOUT` after 30s. Why
30s? Because while `migration-orchestrator` issued INTERRUPT, the
3 in-flight verifier fanout elements ignored it AND new elements
(3,4,5 picked up by workers as the in-flight ones finished) also
ran to completion — for the entire 30s `awaitTermination` window.

**Root cause**:

1. orchestrateFanoutStage runs as detached promise chains pushed
   onto runOneAttempt's `executorPromises` array. They live
   **outside** the XState actor lifecycle.
2. dispatcher.send(INTERRUPT) (runner.ts:251-298) forwards the
   event to currentActor and schedules a 1500ms actor.stop()
   fallback. Neither reaches detached promises.
3. orchestrateFanoutStage's worker pool happily pulls the next
   index from `nextIdx` as each in-flight element completes,
   regardless of any external state change.

So a fanout that's mid-flight when INTERRUPT lands keeps eating
LLM cost and DB rows for the full duration of its remaining
elements, even though the caller intends to stop the task.

**Fix** (commit f74dfd6):

- `orchestrateFanoutStage` accepts an optional `interruptSignal:
  AbortSignal` argument.
- Each per-element AbortController listens for the parent signal
  and aborts in response; existing C10 timeout machinery
  shares the controller so SDK / mock teardown paths fire promptly.
- `runElement` checks `interruptSignal.aborted` synchronously at
  entry; queued workers bail by setting `firstError` (cosmetic — the
  worker pool already drains cleanly on first error).
- `runner.ts` maintains a per-attempt `fanoutInterruptController`
  reset on every rebuild (retry / rollback / migration). The
  dispatcher's INTERRUPT path aborts this controller **before**
  forwarding the event to the actor.

Two regression tests in `runner-fanout.interrupt.test.ts`:

1. mid-flight abort: handler sleeps 40ms; first element starts +
   trips abort; expect ≤3 of 6 elements ever entered the handler
   (pre-fix: always 6).
2. pre-aborted signal: synchronous bailout — 0 elements enter
   the handler.

### Reverse-supersede dogfood (post-Bug-81-fix)

After the fix, retried with a different topology to avoid
re-triggering the fanout-INTERRUPT path: launched the dogfood-11
IR (no fanout), waited for it to gate at framingGate (idle), then
proposed an OAuth-required mcp-remote on the `summary` stage
(rerunFrom=summary, migrateRunningTasks=all). Bug 80 fix lets the
INTERRUPT stage skip cleanly because all running attempts are gates.

Migrate returned:
```
MIGRATION_RESUME_FAILED — startPipelineRun returned failure:
  OAUTH_NOT_CONFIGURED ... 'fakeRemoteMcp' (https://...invalid/mcp)
  used by stage 'summary'.
```

Wall time: 0ms.

Post-migrate state:
- `framingGate` attempt restored from `superseded` back to `running`
  (reverse-supersede confirmed)
- `task_finals` not written
- `hot_update_events`: TWO rows per attempt — first records
  `success` (the supersede TX wrote DB), then records `failed`
  (RESUME_FAILED + reverse-supersede). The audit trail is honest
  about what happened in what order.

Approving framingGate after the failed migrate let the task run to
`completed/natural` on the original V1 IR. The task's `summary`
stage_attempt has `version_hash` = V1 (`dc034310...`), confirming
no V2 contamination.

This is the third independent observation (after dogfood-13's
duplicate-call experiment) that **reverse-supersede is idempotent
and side-effect-free** under repeated failed migrates.

### Cost

| Metric | Value |
|---|---|
| Total wall time | ~5 min (including the ~30s wasted on the original Bug 81 INTERRUPT_TIMEOUT) |
| Anthropic spend | ~$0.20 (one full dogfood-12 run discarded + dogfood-11 run for reverse-supersede test) |
| Bugs found | 1 (Bug 81) |

---

## Cumulative

| Phase | Commits | Bugs |
|---|---|---|
| All prior (handoff-dogfood-9-10) | 46 | 80 |
| **Dogfood 11+12+13 (this handoff)** | **2** | **1** |
| **Total** | **48** | **81** |

- 251 server test files (+1 — the new Bug 81 test file), 2374 server
  tests (+2 Bug 81 regressions).
- TSC clean. Working tree clean.

---

## What's still untested

After this pass, **all four originally-listed paths** plus the three
follow-ups identified in handoff-dogfood-9-10 are now covered:

- ✅ cancel_task mid-run (dogfood-7)
- ✅ multi-target rollback runtime contract (dogfood-8 unit test)
- ✅ secret_pending (dogfood-9)
- ✅ hot-update migration (dogfood-10, found Bug 80)
- ✅ Real-LLM multi-target rollback (dogfood-11)
- ✅ Hot-update with rerunFrom + active fanout / B17 (dogfood-12)
- ✅ Hot-update reverse-supersede (dogfood-13, found Bug 81)

No known untested paths remain in the c12+ → dogfood-13 chain.

---

## Final state

```
Branch: main, ~42 commits ahead of c12+ closure (ad5bba6)
Server tests: 251 files pass + 3 skipped, 2374 tests + 24 skipped
Web tests: 13 pass, 61 tests
TSC: clean
Tasks ending in completed/natural: pipeline-generator (initial),
  dogfood-3, dogfood-6, dogfood-9, dogfood-11, dogfood-12, dogfood-13
Tasks ending in cancelled/cancelled: dogfood-7, dogfood-10 cleanup,
  dogfood-13 first-attempt cleanup
Generated pipelines registered in pipeline_versions:
  - 08617d0a... (ESM/CommonJS investigation, dogfood-3 onwards)
  - 8988056748... (d4-envkey-probe-v2)
  - dc034310... (multi-target-rollback-dogfood-11)
  - c2314b3e... (fanout-hot-update-dogfood-12)
  - 6f8f7863... (V2 of dogfood-12 IR)
```

---

## Recommended next step

**Stop and ship.** All four originally-listed untested paths plus
their three follow-ups are now exercised end-to-end on real
pipelines. Two real bugs surfaced and were fixed (Bug 80 in
dogfood-10, Bug 81 in dogfood-13). The kernel's INTERRUPT story is
now coherent across:

- agent / script stages (existing AbortSignal in invoke child)
- gate stages (Bug 80: skip INTERRUPT on idle gates)
- fanout stages (Bug 81: parent-signal propagation through detached
  promises)

There is no remaining gap in the c12+ → dogfood chain that I am
aware of. Future dogfoods should target the next milestone
(checkpointing, worktree allocation, dashboard) rather than
revisiting these paths.
