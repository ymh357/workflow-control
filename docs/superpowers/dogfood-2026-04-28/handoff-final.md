# Final Handoff — c12+ review fixes complete

**Date**: 2026-05-01
**Branch**: main (20 commits ahead of Wave 2/scattered closing point)
**Source spec**: `docs/superpowers/specs/2026-04-30-full-codebase-review.md`
**Predecessor**: `docs/superpowers/dogfood-2026-04-28/handoff-wave-2-and-scattered.md`

This pass cleared the last two buckets:

- **Wave 2 Theme 3** (boot/orphan recovery cohesion) — 5 bugs in
  reconciler / start-pipeline-run / worktree allocator.
- **Remaining scattered P1s** — 6 bugs in classify_evidence_bundle,
  mcp-catalog inventory + schema, kernel-run boot seeding,
  kernel-attempt-details OOM cap, execution-record-writer.

11 bugs total in 2 commits.

After this pass, **every P0 + P1 finding from the original review
spec is closed** except those explicitly deferred to P2/P3 cleanup
(catalog command allow-list edge cases, more shallow stringified-JSON
tolerance points, etc).

---

## Commit chain

| SHA | Title |
|---|---|
| `c1e615d` | `fix(runtime)`: orphan reconciler + boot recovery extensions (Bug 43 / 56 / 57 / 58 / 59) |
| `46a4755` | `fix(server)`: remaining scattered P1s (Bug 41 / 46 / 47 / 49 / 53 / 61) |

---

## Theme 3 — Boot/orphan recovery cohesion

### Bug 56 — bootResumability rate-limit storm
**File**: `apps/server/src/kernel-next/runtime/orphan-reconciler.ts`.

Replaced `Promise.allSettled` (N parallel resumes in one tick) with a
throttled queue. Defaults: `resumeConcurrency=4` in-flight,
`resumeStaggerMs=250` between dispatches. Both tunable per caller.
Multi-task crash recovery no longer hits Anthropic rate limits the
moment the server boots.

### Bug 57 — start-pipeline-run leak on synchronous reject
**File**: `apps/server/src/kernel-next/runtime/start-pipeline-run.ts`.

When `runPipeline` rejected synchronously after `allocateWorktree`
succeeded, the catch handler only published a synthetic SSE event —
leaving `task_finals` unwritten and `task_env_values` leaked, with
no orphan reconciler visibility on next boot. Now writes
`task_finals(failed)` + deletes env_values inside the catch handler
before the SSE publish.

### Bug 58 — partially-complete fanout misclassified as terminal
**File**: `apps/server/src/kernel-next/runtime/orphan-reconciler.ts`.

`classifyOrphan.successStages` admitted any `status='success'` row,
including `kind='fanout_element'`. A partially-complete fanout (some
elements succeeded, no aggregate row) advanced `resumeFrom` past the
fanout stage; downstream wires never saw the aggregated array and
resume hit NO_ACTIVE_WIRE permanently. Now scans the IR for fanout
stages and only counts a fanout stage as succeeded when its
`fanout_aggregate` row is success.

### Bug 59 — worktree allocator not idempotent at directory level
**File**: `apps/server/src/kernel-next/runtime/worktree/allocator.ts`.

Pre-fix, when the kernel crashed between `git worktree add` succeeding
and the `task_worktrees` INSERT, the disk worktree existed and git
knew about it but the DB row was missing. The next allocateWorktree
hit `fatal: '...' already exists` and recorded `unavailable` —
even though the workdir was perfectly usable. Now probes
`git worktree list --porcelain` first; matches with realpath to
tolerate macOS `/private` symlinks; adopts a pre-existing entry
into `task_worktrees` and returns `active`.

### Bug 43 — RESUME_FAILED orphan fanout_element rows
**File**: `apps/server/src/kernel-next/runtime/orphan-reconciler.ts`.

Migration RESUME_FAILED could leave fanout_element attempts tagged
`status='running'` even though their orchestrator was gone.
`reconcileRunningAttempts` only handled task-level attempts. Added
`reconcileFanoutElementOrphans` to bootResumability, called per
orphan task; supersedes any leftover running fanout_element rows +
closes their AED records.

---

## Remaining scattered P1s

### Bug 41 — classify_evidence_bundle list-level stringified JSON
**File**: `apps/server/src/kernel-next/builtin-scripts/index.ts`.

Pre-fix the entry-level and item-level scans tolerated stringified
JSON, but the list-level still rejected an
`evidence[i].positiveEvidence` that arrived as `"[{...}]"` (string)
rather than `[{...}]` (array). Added the same parse-once-then-validate
pattern at the list level.

### Bug 46 — equipEntry ghost env keys
**File**: `apps/server/src/kernel-next/mcp-catalog/inventory.ts`.

`equipEntry` wrote any envValue key to the secret store, including
keys NOT declared in `entry.envKeys`. Typos (CLAUDE_KEY vs
CLAUDE_API_KEY) leaked under both names; storage accumulated ghost
rows; audit was confused. Now rejects with `CATALOG_INVALID_ENTRY`
when any key is undeclared.

### Bug 47 — mcp-catalog command allowlist
**File**: `apps/server/src/kernel-next/mcp-catalog/schema.ts`.

`CatalogEntrySchema.command` was a free-form string. A custom catalog
entry could declare `command="/bin/sh"` and persist a post-restart
RCE vector. Restricted to a small set of package-runner / interpreter
binaries (npx, uvx, bunx, pnpx, yarn, bun, node, deno, python,
python3, uv, pipx). Schema rejects undeclared commands at parse time.

### Bug 49 — seedBuiltinPipeline race
**File**: `apps/server/src/routes/kernel-run.ts`.

The 6 `void seedBuiltinPipelineByName(...)` calls at module load
raced the first HTTP request. A request during boot got
NAME_NOT_FOUND for builtins whose INSERT hadn't committed yet.
Bundled into a `Promise.allSettled` exposed as
`seedBuiltinPipelinesPromise`; the POST /kernel/tasks/run handler
awaits it before resolving names. Per-seed errors still log
individually; one bad seed doesn't block the others.

### Bug 53 — kernel-attempt-details JSON.parse OOM cap
**File**: `apps/server/src/routes/kernel-attempt-details.ts`.

`safeParseArray` would `JSON.parse` arbitrarily large columns and
ship them in the HTTP response with no size cap. `agent_stream_json`
grows unbounded for long-running agents. Added a 5 MB cap; past the
cap returns an empty list rather than risk an OOM kill.

### Bug 61 — execution-record-writer NoopWriter silent break
**Files**: `runtime/execution-record-writer.ts`, `runtime/real-executor.ts`.

Open INSERT failure swapped in NoopWriter, distinguishable from
ActiveWriter only by the absence of side-effects. `updateSessionId`
silently no-op'd → SDK session resume on the next attempt found no
session_id; `updateCost` no-op'd → cost reporting stayed at $0.
Added `degraded: boolean` to the `ExecutionRecordWriter` interface;
real-executor logs an error when the writer it received is degraded
so operators see this as a real outage dimension. Open-failure log
level promoted from warn → error.

---

## State at handoff

```
Test files     253 passed |  3 skipped (256)
Tests        2332 passed | 24 skipped (2356)
Type-check   clean (server tsc --noEmit, 0 errors)
Branch       main, 20 commits ahead of Wave 2/scattered closing point
Working tree:
  - 5+ pre-existing untracked test/script files at apps/server root
    (mcp/{invoke-exact,write-port-simple,emit-stage,emit-with-*}
    .test.ts, plus three .mjs scripts). Not produced by these
    fixes; left in place for a future review pass to investigate
    provenance.
```

This pass delta vs Theme 2/scattered baseline (2329): **+3 regression
tests** for Theme 3.

**Cumulative across c12+ review: 56 bugs closed across 11 commits.**

| Wave | Commits | Bugs |
|---|---|---|
| Wave 1 (P0+worst P1s) | 6 | 14 |
| Wave 3 (validator/compiler/canonical/codegen) | 2 | 6 |
| Wave 4 (web UX) | 1 | 4 |
| Wave 2 Theme 1 (superseded/terminal guards) | 1 | 7 |
| Wave 2 Theme 2 (transactions) | 1 | 6 |
| Scattered (1st batch) | 1 | 7 |
| Wave 2 Theme 3 (boot/orphan recovery) | 1 | 5 |
| Scattered (2nd batch) | 1 | 6 |

Plus 6 handoff documents and 1 new helper (`withTransaction`).

---

## What's left (P2/P3 only)

The original review spec's P0 and P1 buckets are exhausted. The
remaining work is in the spec's P2 / P3 sections — latent fragility,
quality, stylistic items. Examples:

- **P2 cluster** (~30 findings):
  - `topState` SSE dedupe permanently silences any `idle` re-emit.
  - `inline-script-executor` cache never evicts.
  - `propose()` `autoApplied` label misleading; only auto-approved.
  - `wait_for_task_event` historical seq=0 dropped on cold start.
  - `dispatcher.send` after `answerGate` not wrapped in try/catch.
  - `EMPTY_DATAFLOW` doesn't fire for "1 stage with declared ports
    but no wires".
  - `gateTargetOwners` map computed but never used (dead code).
  - structural.ts doesn't validate fanout's input port has any
    inbound wire.
  - codegen unconditionally appends `__gate_feedback__` to gate
    outputs; if author also declares it → duplicate-key TS error.
  - `cachedPipelineGeneratorIR` module-level cache never invalidated
    across `update_registry_pipeline` writes.
  - `write_port` accepts writes to terminated attempts.
  - `propose()` pre-existing `_default` answer with same target as
    a user-supplied answer triggers GATE_TARGET_SHARED falsely.
  - `sortKeys` silently drops BigInt/Date/Function as null.
  - cross-segment same-segment diagnostic also fires for undefined
    segments.
  - Many more in batch reports B1-B7.

- **P3 cluster**:
  - Style / cosmetic / "would be nicer" findings.

These are deferred indefinitely. Worth a dedicated audit pass when
there's spare cycles, not blocking real operation.

---

## Recommended next step

**Stop and ship.** Every actionable correctness / data-loss / RCE /
silent-break finding from the c12+ review is closed. The remaining
P2/P3 work is genuinely low-priority (latent / fragility / cosmetic);
attacking it without a fresh dogfood signal would be busywork.

If a future pass is desired, the natural cycle is:
1. Run a fresh dogfood of pipeline-generator + investigation pipeline
   end-to-end on the Wave-3-cleaned codebase.
2. Compare what surfaces against the spec's P2 list to see which
   findings remain operational rather than hypothetical.
3. Cherry-pick the still-real ones for a focused hardening sprint.

This is a good resting point.
