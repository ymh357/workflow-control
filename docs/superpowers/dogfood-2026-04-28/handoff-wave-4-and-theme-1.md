# Wave 4 + Wave 2 Theme 1 Handoff — c12+ review fixes (web UX + superseded/terminal guards)

**Date**: 2026-05-01
**Branch**: main (12 commits ahead of Wave 3 closing point)
**Source spec**: `docs/superpowers/specs/2026-04-30-full-codebase-review.md`
**Predecessor**: `docs/superpowers/dogfood-2026-04-28/handoff-wave-3.md`

This pass cleared two more buckets:

- **Wave 4** (web frontend hardening) — 4 bugs in the Next.js dashboard.
- **Wave 2 Theme 1** (superseded/terminal guards across query/mutation
  paths) — 7 bugs in kernel/runtime/cli around `stage_attempts.status`
  and `task_finals` existence checks.

Both were largely mechanical sweeps: small, self-contained edits with
clear correctness wins and minimal risk of regression. No new P0
findings remain unaddressed.

---

## Commit chain

| SHA | Title |
|---|---|
| `7f4fd1a` | `fix(web)`: kernel-next dashboard hardening (Bug 63 / 64-web / 65 / 67) |
| `97bcd0a` | `fix(kernel+runtime+cli)`: superseded/terminal guards across 7 query/mutation paths (Bug 19/20/21/22/23/27/55) |

Two commits, eleven bugs.

---

## Wave 4 — Web frontend hardening

### Bug 63 — gate-context fetch loop
**File**: `apps/web/src/app/kernel-next/[taskId]/page.tsx:673-748,656-680`.

**Symptom**: The gate-context fetch effect listed `gateContexts` in
deps so it could read `gateContexts.has(id)` to skip already-fetched
entries. But the effect body also called `setGateContexts(...)` for
both eviction and storing fetched data — every state write re-fired
the effect, aborting the in-flight fetch and starting a new one.
Visible symptom: persistent "loading…" stutter on the gate panel during
normal polling cycles.

**Fix**:
- Drop `gateContexts` from deps; use functional `setGateContexts((prev) => ...)`
  in the fetch response handler with a `prev.has(id)` short-circuit.
- De-dupe `pendingGateIds` writes from the 2s status poll so an
  unchanged pending list no longer bumps the array reference (which
  would re-fire the dependent fetch effect each tick even with the
  deps fixed).

### Bug 64-web — TaskStatus widening
**Files**: `apps/web/src/app/kernel-next/page.tsx:20`,
`apps/web/src/components/ui/status-pill.tsx`.

**Symptom**: The dashboard `TaskStatus` union excluded `secret_pending`,
yet the server emits it (Wave 1 Bug 64 server side). Result:
secret-paused tasks fell into undefined paths in the filter dropdown,
status-counts initial record, and the StatusPill variant lookup.

**Fix**: Add `secret_pending` everywhere — TaskStatus union,
`statusCounts` record initialiser, filter dropdown option, status-count
display string ("X secret-paused"), and StatusPill variant
(`warning`).

### Bug 65 — SecretGatePanel polling forever
**Files**: `apps/web/src/components/secret-gate-panel.tsx:18-71`,
`apps/web/src/app/kernel-next/[taskId]/page.tsx:860-871`.

**Symptom**: The panel's 5s polling effect kept running even after the
task reached a terminal state — it can never re-enter `secret_pending`
once finalised, so every poll wasted an HTTP round-trip.

**Fix**: Add `enabled` prop (default `true` for backward compat).
Parent passes `topState !== terminal` (where terminal ∈ completed /
failed / cancelled / orphaned). When disabled, the effect short-circuits
and clears `pending` to `[]` so the panel renders null without unmount.

### Bug 67 — eventCountRef stale render
**File**: `apps/web/src/app/kernel-next/[taskId]/page.tsx:181-186,348,790`.

**Symptom**: A `useRef(0).current` counter rendered in JSX never
triggered re-renders; the displayed event count stayed at the
last-render value until something else dirtied the component.

**Fix**: Switch to `useState`. SSE events fire inside React's
automatic batching boundary, so the counter increments produce one
render per macrotask flush — not a render storm. Remove the now-unused
`useRef` import.

---

## Wave 2 Theme 1 — superseded / terminal guards

The pattern: every code path that reads or writes `stage_attempts` had
to be checked for whether it respects the two non-authoritative
markers — `status='superseded'` (post-migration discarded prefix) and
`task_finals.final_state IN (cancelled, failed, completed)` (terminal
verdict). Pre-fix, several paths leaked non-authoritative rows into
live observation or mutation, producing "cancelled task reports
running" and "active task reports cancelled" cycles.

### Bug 19 — compare_runs status filter
**File**: `apps/server/src/kernel-next/mcp/compare-runs.ts:79-105`.

`compare_runs` picked the latest attempt-by-attempt_idx per stage
across `kind IN (...)` with no status filter. Post-migration, the
discarded prefix's `status='superseded'` rows had higher attempt_idx
than the post-migration successes — so the comparison reported
discarded work. Added `AND sa.status <> 'superseded'`.

### Bug 20 — answerGate status guard
**File**: `apps/server/src/kernel-next/mcp/kernel.ts:1419-1432`.

`answerGate`'s `UPDATE stage_attempts SET status='success'` had no
status guard. A concurrently-superseded or already-finalised attempt
could be flipped back to success by a stale gate answer. Added
`AND status='running'`.

### Bug 21 — retryTaskFromStage task_finals guard
**File**: `apps/server/src/kernel-next/mcp/kernel.ts:2049-2080`.

`retryTaskFromStage` didn't check `task_finals`. Calling retry on a
finalised task resurrected the runner — but the sticky `task_finals`
row stayed in place, so `getTaskStatus` reported the prior terminal
state even while the live runner was executing. Added a
`task_finals` existence check; refuses with `TASK_ALREADY_TERMINAL`.

### Bug 22 — prune_records terminal guard
**File**: `apps/server/src/cli/lib/prune-kernel-records.ts:61-92`.

`prune-kernel-records` deleted lineage rows for any attempt matching
the filter — including those of in-flight tasks. Worst case: a
long-running task whose first attempt was older than the threshold had
its early `stage_attempts` + AED + `port_values` nuked mid-run,
turning the live task into an orphan. Added
`EXISTS (SELECT 1 FROM task_finals tf WHERE tf.task_id = stage_attempts.task_id)`
to every prune select. Tasks still in flight, paused on a gate, or
paused on a secret-gate are now untouchable by `prune_records`.

### Bug 23 — supersede gate_queue cleanup
**File**: `apps/server/src/kernel-next/hot-update/migration-orchestrator.ts:237-272`.

`migration-orchestrator`'s supersede transaction closed
`stage_attempts` but left `gate_queue` rows referencing those
attempts open with `answered_at IS NULL`. A stale `answer_gate` call
between supersede and the new runner's fresh gate would resolve routes
against the OLD IR — and route to a stage that may no longer exist in
the new pipeline. Added a parallel `UPDATE gate_queue` that marks
unresolved rows as answered with sentinel
`'__superseded_by_migration__'` in the same transaction.

### Bug 27 — getTaskStatus heartbeat status filter
**File**: `apps/server/src/kernel-next/mcp/kernel.ts:1870-1900`.

Both heartbeat-liveness and started_at-fallback scans included
superseded attempts. Post-hot-update, the discarded attempts' AED rows
kept their `last_heartbeat_at` intact (the writer flushes one final
tick before being torn down) — so `getTaskStatus` reported "running"
for tasks whose post-migration runner had wedged or never started.
Added `AND sa.status <> 'superseded'` to both scans. Inter-stage
transition window (C10's fresh-success-as-liveness rule) preserved by
keeping `success`/`error` rows eligible — only `superseded` is
excluded.

### Bug 55 — task-cost-aggregator status filter
**File**: `apps/server/src/kernel-next/runtime/task-cost-aggregator.ts:31-70`.

`computeTaskCost` summed across every attempt's AED rows regardless of
`stage_attempts.status`. Post-migration the discarded prefix kept its
AED rows for forensics — so the live cost SSE event double-counted
across each supersede. Added
`AND sa.status IN ('success', 'error', 'running', 'secret_pending')`
so superseded / cancelled rows are excluded.

---

## State at handoff

```
Test files     249 passed |  3 skipped (252)
Tests        2314 passed | 24 skipped (2338)
Type-check   clean (server + web tsc --noEmit, 0 errors)
Branch       main, 12 commits ahead of Wave 3 closing point
Working tree clean (2 pre-existing untracked test files):
  - apps/server/src/kernel-next/mcp/invoke-exact-write-port.test.ts
  - apps/server/src/kernel-next/mcp/write-port-simple-test.test.ts
```

Wave 3 baseline: 2311 pass + 24 skip + 0 fail.
This pass delta: **+3 regression tests, 0 new failures**.
(Web tests: 61/61 still pass.)

Cumulative across c12+ review fixes: **31 bugs closed across Wave 1 +
Wave 3 + Wave 4 + Theme 1**.

---

## Carried forward to future waves

### Wave 2 Theme 2 — Multi-statement DB transactions (~1-2 weeks)
Hits 17, 18, 30 (done in Wave 3), 56, 60, 61, 62. Introduce a
`withTransaction(db, fn)` helper that wraps `BEGIN IMMEDIATE` /
`COMMIT` / catch-`ROLLBACK`. Apply to:
- `provide_task_secrets` (kernel.ts:1455-1591) — concurrent calls
  double-retry without a guard.
- `cancelTask` + secret/gate cleanup (kernel.ts:2049-2128 + 1688-1714).
- gate-timeout-sweeper (runtime/gate-timeout-sweeper.ts:46-103) —
  SELECT-then-cancelTask non-atomic; gate answered concurrently can
  flip an actively-completing run to cancelled.
- worktree allocator (runtime/worktree/allocator.ts:61-118) —
  not idempotent at directory level.
- `graceful-shutdown.reconcileRunningAttempts` —
  two non-transactional UPDATEs.
- `task-env-values.ts:23-32` — BEGIN IMMEDIATE + ROLLBACK not
  bulletproof if BEGIN fails.

### Wave 2 Theme 3 — Boot/orphan recovery cohesion (~1-2 weeks)
Hits 4 (precondition #11, done in Wave 1), 10 (Wave 1), 43, 56, 57,
58, 59. Extend the orphan reconciler to walk every "lifetime
resource" table on boot and reconcile against `task_finals`:
`task_env_values`, `task_worktrees`, `stage_checkpoints`,
`secret_gate_queue`, fanout_element rows. Currently only walks
`stage_attempts` + `gate_queue`.

### Wave 5 — P2/P3 cleanup (deferred indefinitely)
The latent / fragility findings in the spec's P2 / P3 sections.
Worth an audit pass when there's spare cycles.

---

## Recommended next step

**Wave 2 Theme 2** is the most contained remaining theme — adding a
`withTransaction` helper is mechanical, and the call sites are well
localised. Theme 3 is more intrusive (touches runtime startup) and
benefits from being done after Theme 2 since the reconciler will
also need transactional writes.

Resting here is again a legitimate stopping point: every P0 finding
is closed; every Theme 1 path that reads/writes stage_attempts now
respects authoritative-row markers; the web dashboard no longer
self-aborts or polls forever. The remaining work is all in
runtime cross-cutting concerns (Theme 2 / 3) where the cost/benefit
of "do now" vs "focused half-week" is more nuanced.
