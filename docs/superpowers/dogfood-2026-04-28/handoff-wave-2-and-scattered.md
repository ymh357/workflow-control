# Wave 2 Theme 2 + Scattered P1 Handoff — c12+ review fixes

**Date**: 2026-05-01
**Branch**: main (16 commits ahead of Wave 4 / Theme 1 closing point)
**Source spec**: `docs/superpowers/specs/2026-04-30-full-codebase-review.md`
**Predecessor**: `docs/superpowers/dogfood-2026-04-28/handoff-wave-4-and-theme-1.md`

This pass cleared two more buckets:

- **Wave 2 Theme 2** (multi-statement DB transactions) — withTransaction
  helper plus 7 application sites.
- **Scattered P1s** — 7 independent bounded fixes across builtin-scripts,
  hot-update, SSE, settings, routes, git lib.

14 bugs total in 2 commits.

---

## Commit chain

| SHA | Title |
|---|---|
| `6bc5294` | `fix(kernel+runtime)`: withTransaction helper + sweep across multi-statement DB sequences (Bug 17 / 18 / 60 / 62 / B2.#19/#20 / B3.F18) |
| `5b6fc2d` | `fix(server)`: scattered hardening — write_file traversal / cache atomicity / SSE leak / dry-run hash / settings types / cancel zod / git branch sanitize (Bug 39 / 40 / 44 / 45 / 51 / 52 / 54) |

---

## Theme 2 — Multi-statement DB transactions

### New helper
**File**: `apps/server/src/kernel-next/ir/with-transaction.ts` + test.

`withTransaction(db, fn)` — wraps `BEGIN IMMEDIATE` / `COMMIT` /
catch-`ROLLBACK` with proper error chaining via
`TransactionRollbackError`. IMMEDIATE mode so concurrent writers fail
synchronously (callers can detect SQLITE_BUSY) rather than only
colliding at COMMIT.

Key choice: synchronous-only by design. `node:sqlite` is synchronous
and the write lock must not be held across an `await`. Callers needing
async work split: pre-tx await, then synchronous tx.

### Bug 62 — task-env-values.storeTaskEnvValues
Pre-fix: hand-rolled BEGIN/ROLLBACK with the canonical "no transaction
is active" failure mode masking the real BEGIN error. Replaced with
`withTransaction` so the actual BEGIN failure surfaces.

### Bug 17 — provideTaskSecrets atomicity
Pre-fix: env_values upsert + having-keys re-read + secret_gate
resolved-at marks ran outside any transaction. Concurrent calls each
saw "still missing" between writes and triggered duplicate retries;
the second migration then masked the first call's success with
MIGRATION_IN_PROGRESS. The whole sync block now runs in one IMMEDIATE
transaction; the async `equipEntry` persistence stays outside (write
lock must not be held across an await).

### Bug 18 — cancelTask atomicity + gate/secret cleanup
Pre-fix: cancelTask wrote task_finals and deleted env_values without
closing pending `gate_queue` / `secret_gate_queue` rows.
`getTaskStatus` continued reporting the task as 'gated' or
'secret_pending' indefinitely (those checks run before task_finals is
consulted). Bundle task_finals INSERT + gate_queue close +
secret_gate_queue close + task_env_values delete into one transaction.
Pending gate rows get sentinel answer `'__cancelled__'`; pending
secret_gate rows get `resolved_at` set.

### Bug B2.#19/#20 — graceful-shutdown.reconcileRunningAttempts
Pre-fix: two UPDATEs (stage_attempts → superseded; AED →
interrupted) ran without a transaction. SIGTERM mid-sequence left an
inconsistent reconciliation for the next boot's orphan reconciler.
Both UPDATEs now in one transaction.

### Bug 60 — gate-timeout-sweeper race
Pre-fix: SELECTed unanswered gates, then proceeded to cancelTask
without re-checking. A concurrent answer between the SELECT and
cancelTask flipped an actively-completing task to cancelled. We can't
fully eliminate the cross-connection race, but we shrunk it to the
smallest possible window by re-confirming immediately before
cancelTask: gate is still answered_at IS NULL AND task_finals does
not exist — both checks issued in one prepared statement so they
share an instant.

### Bug B3.F18 — propose() prompt persistence atomicity
Pre-fix: per-prompt `insertPromptContent` + `insertPromptRefs` ran
without a wrapping transaction; mid-sequence error left a new
pipeline_versions row with no prompt rows, so retries hit
PROMPT_REF_MISSING. The prompt+refs writes are now bundled into one
transaction; partial state on error rolls back cleanly.
`insertPipelineVersion` is left standalone (already atomic via its own
BEGIN/COMMIT, and its retry is idempotent).

---

## Scattered P1 hardening

### Bug 45 — write_file path traversal
**File**: `apps/server/src/kernel-next/builtin-scripts/index.ts`.

write_file inlined any LLM-supplied `path` through `pathResolve()`. An
emitted pipeline could overwrite `/etc/cron.d/...`,
`~/.ssh/authorized_keys`, `~/.aws/credentials`, etc. Added
`assertWriteFilePathSafe()` with a deny-list of system roots and
user-sensitive home dirs. The OS tmpdir is allowed even though it sits
under `/var` on macOS so legitimate scratch use survives.

### Bug 44 — tutorial-cache N inserts atomicity
**File**: `apps/server/src/kernel-next/builtin-scripts/tutorial-cache.ts`.

`write_tutorial_cache` looped N upserts with no transaction; each was
its own implicit tx with its own fsync (slow), and a mid-loop failure
left a partial cache. Wrapped in `withTransaction`.

### Bug 39 — dry-run/propose hash divergence
**Files**: `apps/server/src/kernel-next/hot-update/dry-run.ts`,
`hot-update/types.ts`, `mcp/kernel.ts`.

`dryRunProposal` returned `proposedVersion` via `versionHash(ir)` but
`KernelService.propose` persists via `pipelineVersionHash({ir,prompts})`.
Any prompt-laden proposal got a phantom hash mismatch. Extended
`DryRunInput` with optional `prompts`; dry-run uses
`pipelineVersionHash` when prompts are supplied, `versionHash` when
not. `propose()` now passes `mergedPrompts` into the dry-run call.

### Bug 40 — SSE listener leak on disconnect
**File**: `apps/server/src/kernel-next/sse/http.ts`.

Pre-fix: when `controller.enqueue` threw (client gone), the catch
only set `closed=true` and waited for the next heartbeat to clean up.
The broadcaster kept dispatching every event to the dead listener.
Extracted `cleanup()` helper invoked the moment a write fails;
unsubscribes + clears the heartbeat immediately.

### Bug 51 — settings env auto-mapping types
**File**: `apps/server/src/lib/config/settings.ts`.

`SETTING_AGENT_MAX_BUDGET_USD=5` produced `agent.max_budget_usd` as
the string `"5"`; downstream comparisons silently broke. Now coerces
when the existing field on `merged` is number/boolean. String
fallback preserved so the schema validator surfaces a clean warning
for genuinely invalid values.

### Bug 52 — cancel route zod validation
**File**: `apps/server/src/routes/kernel-tasks.ts`.

`/tasks/:id/cancel` used `JSON.parse + cast` without zod, inconsistent
with every other route in the file. Added strict `CancelBodySchema`
with optional `reason`/`actor` strings (length-capped).

### Bug 54 — git branch sanitize
**File**: `apps/server/src/lib/git.ts` + adversarial test.

`createWorktree(branch)` flowed unsanitized into both `worktreePath`
(`join(base, branch.replace(/\//g, "-"))`) and the git argv. Null
bytes survived; `..` segments could escape `worktreesBase`; leading
`-` would parse as a git CLI flag. Added `assertValidBranchName()`
enforcing git refname rules + extra path-traversal / control-char
rejections.

---

## State at handoff

```
Test files     253 passed |  3 skipped (256)
Tests        2329 passed | 24 skipped (2353)
Type-check   clean (server tsc --noEmit, 0 errors)
Branch       main, 16 commits ahead of Wave 4/Theme-1 closing point
Working tree:
  - 5 pre-existing untracked test/script files NOT created by these
    fixes (mcp/{invoke-exact,write-port-simple,emit-stage,emit-with-*}
    .test.ts, plus two .mjs scripts at apps/server root). Left in
    place for a future review pass to investigate provenance.
```

This pass delta vs Theme 1 closing baseline (2314): **+15 tests
(+5 with-transaction unit tests, +10 hardening regression tests).**

Cumulative across c12+ review: **45 bugs closed across Wave 1 +
Wave 3 + Wave 4 + Theme 1 + Theme 2 + scattered P1s.**

---

## Carried forward to future waves

### Wave 2 Theme 3 — Boot/orphan recovery cohesion (~1-2 weeks)
Hits 43, 56, 57, 58, 59. Extend the orphan reconciler to walk every
"lifetime resource" table on boot and reconcile against `task_finals`:
`task_env_values`, `task_worktrees`, `stage_checkpoints`,
`secret_gate_queue`, fanout_element rows. Currently only walks
`stage_attempts` + `gate_queue`.

Specific components:
- **Bug 56**: bootResumability fires N parallel resumes via
  Promise.allSettled — multi-task crash boot trips Anthropic rate
  limits immediately. Throttle.
- **Bug 57**: start-pipeline-run leaks on synchronous reject after
  allocateWorktree succeeded. Wrap in try/finally with cleanup.
- **Bug 58**: orphan-reconciler.isSkippable misclassifies
  partially-complete fanouts as "succeeded" → resume hits
  NO_ACTIVE_WIRE on next stage.
- **Bug 59**: worktree allocator not idempotent at directory level —
  missing DB row + existing on-disk worktree → git worktree add
  fails despite worktree existing.
- **Bug 43**: migration RESUME_FAILED leaves status='running' orphan
  fanout_element rows.

### Remaining scattered P1s (~1-2 days, low priority)
- **Bug 41**: classify_evidence_bundle stringified-JSON tolerance is
  shallow (entry-level only).
- **Bug 42**: validate-and-repair-ir fuzzy match too lax.
- **Bug 46**: equipEntry writes any envValue without checking it's in
  entry.envKeys; ghost env keys persist.
- **Bug 47**: mcp-catalog command field is free-form string (no
  allow-list) → persistent post-restart RCE path for custom catalog
  entries.
- **Bug 49**: 6 `void seedBuiltinPipelineByName(...)` race the first
  HTTP request and silently swallow rejections.
- **Bug 50**: defaultExec uses execFile with default 1MB stdout cap;
  npm view of large packages → ENOBUFS.
- **Bug 53**: no size cap on `agent_stream_json` / `tool_calls_json`
  JSON parse + HTTP response → OOM vector for long tasks.
- **Bug 61**: execution-record-writer open-INSERT failure produces
  silent NoopWriter; subsequent appendToolCall / updateSessionId
  no-op → SDK session resume + cost reporting silently break.
- **Bug 66**: web historical-attempts effect can clobber a live
  'executing' row back to 'done' — race with SSE stage_executing.

### P2/P3 cleanup (deferred indefinitely)

---

## Recommended next step

**Wave 2 Theme 3 (boot/orphan recovery)** is the largest remaining
contained chunk and the most operationally impactful — every issue
in this bucket manifests as "task appears to be running but isn't"
or "task hangs on resume", both visible to the user. The remaining
scattered P1s are smaller cleanup items.

Resting here is again a legitimate stopping point: every P0 and the
overwhelming majority of P1s are now closed. The remaining work is
either (1) deeper architectural in Theme 3, or (2) low-frequency
edge cases in the scattered list.
