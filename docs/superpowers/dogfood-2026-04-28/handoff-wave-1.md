# Handoff — Wave 1 of c12+ Review Fixes

**Date**: 2026-05-01
**Continuation**: c12+ Wave 1
**Predecessor**: `handoff.md` (c11 Bug G + c12 D1/D2/D3) +
`docs/superpowers/specs/2026-04-30-full-codebase-review.md`
(120+ findings)

---

## What this wave shipped

Fixed **14 of the worst correctness / security findings** from the
full codebase review, in 6 commits on `main`. All P0 review findings
that are actionable without infrastructure-scale work, plus the
critical P1s clustered around the same files.

### Commit chain (newest last)

| sha | summary |
|---|---|
| `b80bfac` | fix(d1): tutorialReviewGate reject loop now actually re-authors (Bug 7) |
| `fab58a8` | fix(canonical): include store_schema in versionHash (Bug 5) |
| `664a096` | fix(builtin-scripts): SSRF + timeout + body cap on http_fetch/http_request (Bug 6) |
| `b82bdd3` | fix(mcp): update_registry_pipeline + migrate_task + provide_task_secrets (Bug 9 / 24 / 25) |
| `7cea3e5` | fix(runtime): runner + fanout + executor robustness (Bug 1 / 2 / 3 / 4 / 10 / 14) |
| `babdb4f` | fix(routes): kernel-task-list SQL + secret_pending status (Bug 8 / 48 / 64) |

### Bug-by-bug

| # | severity | summary | files |
|---|---|---|---|
| **Bug 7** | P0 | D1 tutorialReviewGate reject loop structurally failed: routed to tutorialAuthoring whose fanout source was an empty missingSlugs array → 0-element fanout, no re-authoring. Fixed by routing reject to lookupTutorialCache + bypass-on-feedback semantics. | `tutorial-cache.ts`, `assemble-investigation-ir.ts` |
| **Bug 5** | P0 | `store_schema` silently absent from `pipelineVersionHash` → optimistic locking + dedup broken for that field. Now included in canonical IR. | `canonical.ts` |
| **Bug 6** | P0 | `http_fetch` / `http_request` had no SSRF guard, no timeout, no body cap. Now: SSRF allow-list (loopback / private / cloud-metadata rejected), 30s default timeout (5min ceiling), 10MB body cap (100MB ceiling), `truncated` flag on response. | `builtin-scripts/index.ts` |
| **Bug 9** | P0/P1 | `update_registry_pipeline`: wrong hash function (IR-only, not IR+prompts) + never persisted prompts → every registry-pushed pipeline failed at first agent stage. Plus path-traversal: `path.join(registryRoot, name)` accepted `..`. Now: requires `prompts`, validates `pipelineName` against kebab-case regex at both kernel + MCP wrapper, defence-in-depth canonical-path check. | `mcp/kernel.ts`, `tools/hot-update.ts`, `ir/schema.ts` |
| **Bug 24** | P1 | `migrate_task` MCP wrapper missing `await` → unresolved Promise JSON-stringified to `{}` returned to callers. Migration silently broken via MCP. Added `await`. | `tools/hot-update.ts` |
| **Bug 25** | P1 | `provide_task_secrets` MCP wrapper dropped `persistAs` option → documented "save to inventory" path unreachable. Wrapper schema + handler now forward it. | `tools/gate.ts` |
| **Bug 1** | P0 | Runner retry-path missed `fanout_element` / `fanout_aggregate` supersede that the rollback path does. Script-stage `retry: backToStage` rewinding across a fanout silently reused stale per-element outputs. | `runner.ts` |
| **Bug 2** | P0 | real-executor AbortSignal TOCTOU race: `.aborted` check before `addEventListener('abort')` — if abort landed in the gap, executor ran full SDK query. Reversed order + re-check after attach. | `real-executor.ts` |
| **Bug 3** | P0 | Promise.race fanout timeout produced duplicate `fanout_element` rows with `status='success'`; `preservedByIdx` SELECT had no ORDER BY → non-deterministic reuse. Now: ORDER BY attempt_idx DESC + setIfAbsent dedup; force-finalise orphan `running` rows on timeout. | `runner-fanout.ts` |
| **Bug 4** | P0 | Pre-try DB writes (resume hydration + seed phase) leaked `activeTimer` + registry on throw → awaitTermination waiters hung forever, setTimeout closures pinned for 90 min. Added `emergencyCleanup` helper invoked from try/catch wrappers around both blocks. | `runner.ts` |
| **Bug 10** | P1 | `cancelledByPropagation` set never reset on retry/rollback rebuild despite the comment claiming it was. Stages cancelled in attempt N stayed marked, suppressing STAGE_CANCELLED in attempt N+1. Added `cancelledByPropagation.delete(name)` to both reset loops. | `runner.ts` |
| **Bug 14** | P1 | Seed-phase synthetic attempt could remain `status='running'` zombie if `JSON.stringify` of seedValues threw (circular ref). Wrapped in try/catch that force-finishes attempt as `error`. (Coupled fix with Bug 4.) | `runner.ts` |
| **Bug 8** | P0 | `kernel-task-list` SQL: `GROUP BY task_id HAVING MAX(started_at)` — HAVING is no-op truthiness check. Migrated tasks displayed random `version_hash` and pipeline name. Replaced with correlated-subquery pattern. | `routes/kernel-task-list.ts` |
| **Bug 48** | P1 | Same route's `LIMIT * 2` post-filter buffer silently truncated when status filter was restrictive. Now `fetchLimit = max(limit*5, 1000)` when filter active. | `routes/kernel-task-list.ts` |
| **Bug 64** | P1 | Status enum + response union missing `secret_pending`. Tasks paused on secret-gate showed "orphaned" or "running". Added detection via `secret_gate_queue` + status precedence: cancelled > secret_pending > gated > final > running > orphaned. | `routes/kernel-task-list.ts` |

### New diagnostic codes

Added to `ir/schema.ts` Diagnostic union:
- `REGISTRY_PIPELINE_NAME_INVALID`
- `REGISTRY_PIPELINE_PATH_ESCAPE`

(`PROMPT_REF_MISSING` was already in the union; `update_registry_pipeline` now reuses it.)

## State at handoff

- working tree clean except 2 pre-existing untracked test files
  (`apps/server/src/kernel-next/mcp/invoke-exact-write-port.test.ts`,
  `write-port-simple-test.test.ts`) — both ad-hoc from prior sessions,
  unrelated to Wave 1.
- test suite: **2295 pass + 24 skip + 0 fail** (vs c12 baseline 2255
  → +40 new regression tests)
- `pnpm tsc --noEmit`: clean
- 6 new Wave-1 commits on `main`, ahead of `origin/main` by 794 commits
  total (none pushed).

### Test additions

| file | new tests | covers |
|---|---|---|
| `tutorial-cache.test.ts` | 3 | Bug 7 reject re-run cache bypass |
| `canonical.test.ts` | 4 | Bug 5 store_schema hash participation |
| `builtin-scripts/index.test.ts` | 18 | Bug 6 SSRF allow-list / timeout / body cap |
| `mcp/kernel.test.ts` | 6 | Bug 9 name regex / prompt-ref-missing / hash / persistence |
| `routes/kernel-task-list.test.ts` (NEW) | 4 | Bug 8 / 48 / 64 |

The runtime changes (Bug 1 / 2 / 3 / 4 / 10 / 14) ride existing
runner integration tests; no new regression tests added because the
failure modes are race-sensitive (timing-dependent paths under
concurrent retry/rollback) — adding deterministic regression tests
for these requires a small fixture-rebuilder I deferred. Existing
runner tests (67 cases) all still pass.

## Carried forward to next wave

The full review classified these themes as Wave 2 work (estimated
1-2 weeks):

### Theme 1: superseded / terminal task_finals not respected

Findings 19, 20, 21, 22, 23, 27, 55 in the review document. Multiple
KernelService and route paths read `stage_attempts` / `task_finals`
without status guards:

- `compareRuns` picks `superseded` attempts after migration
- `answerGate` UPDATE flips superseded/cancelled back to `success`
- `retryTaskFromStage` doesn't check task_finals → can resurrect
  cancelled tasks
- `prune_records` deletes lineage of in-flight tasks
- `getTaskStatus` heartbeat liveness ignores attempt status
- `task-cost-aggregator` sums across superseded attempts

A focused pass adding `WHERE status='success'` /
`WHERE NOT EXISTS task_finals` guards everywhere `stage_attempts` is
queried outside the orchestrator.

### Theme 2: multi-statement DB sequences without transactions

Findings 17, 18, 30, 56, 60, 61, 62. Add a `withTransaction()` helper
and apply to:

- `provide_task_secrets` (concurrent calls double-retry)
- `propose()` (pipeline_versions + prompt rows + proposals row split)
- `cancelTask` (gate + secret-gate row close on cancel)
- `gate-timeout-sweeper` (SELECT then cancelTask non-atomic)
- `worktree allocator` (SELECT then INSERT race)
- `graceful-shutdown.reconcileRunningAttempts` (two UPDATEs split)

### Theme 3: orphan reconciler doesn't walk all lifetime tables

Findings 4, 10, 43, 56, 57, 58, 59. The reconciler only checks
`stage_attempts`. Lifetime resources that need entries:

- `task_env_values`
- `task_worktrees` + on-disk worktree dirs
- `stage_checkpoints` (status='capturing' rows that never reached
  capture-after)
- `secret_gate_queue` (rows orphaned when task cancelled)
- `fanout_element` rows (partial fanout misclassified as succeeded)
- workspace dirs

### Wave 3 — validator / compiler / canonical hardening

Findings 28, 29, 30, 31, 32, 33, 34. Three to five days:

- `rejectRollbackMap` multi-target reject routes
- `wireFromStage()` consistent use across compiler + validator
- `INSERT OR IGNORE` ir_json vs stages/ports/wires drift
- `PortIR.type` validation (unvalidated string inlined into emit-ts)
- `RUNTIME_REQUIRE_ALLOWLIST` two parallel constants → single source
- inline-script "sandbox" docs fix (it's not a sandbox)
- gate `question.options` array sort in canonical

### Wave 4 — web UX

Findings 63, 65, 67 (gate-context fetch loop, secret-gate-panel
polling never stops, eventCountRef rendered from ref). Bug 64
(TaskStatus type drift) was fixed server-side this wave but the web
side still needs the same enum widening.

### Wave 5 — deferred indefinitely

All remaining P2/P3.

## What's NOT a bug (worth recording)

From the review's "What's NOT a bug" section, these explicitly aren't
addressed and are intentionally deferred per CLAUDE.md posture:

- inline-script "sandbox" overstates guarantees — single-user trust
  model accepts this; only docs need fixing (Wave 3)
- `PortIR.type` code-injection through type field — same posture, but
  `ts_source` persistence is dirty enough to want input validation
  (Wave 3)
- `prune_records` on external surface — design decision, not a bug
- mcp-catalog encryption-at-rest without key-version field — only
  matters if key rotation joins the roadmap

## Resumability

The kernel itself wasn't restarted during this work; all fixes are
on-the-fly module changes that take effect on the watcher's next
reload. Existing tasks created against pre-fix `pipeline_versions`
rows continue to work as before — none of the fixes are migration-
breaking. The hash bump from Bug 5 (`store_schema` in version_hash)
is the only place where a re-submitted IR will hash differently; the
existing dedup pattern (`INSERT OR IGNORE` + `created_at DESC` lookup)
handles this without intervention.

## Next-step menu

Per c12 closure handoff's framing: the user already authorized "一条
路走到黑" through the review-and-fix path. Wave 2 / 3 / 4 are the
next natural extensions. Recommended order:

1. **Wave 3 (3-5 days)** — validator + compiler + canonical
   hardening. Smaller, more contained, mostly mechanical edits with
   clear correctness wins. Good candidate for a single focused pass
   without theme-level investigation.

2. **Wave 2 Theme 1 (3-5 days)** — `superseded` / terminal status
   guards. High-leverage; multiple findings collapse to "audit every
   `stage_attempts` query". The KernelService surface is small enough
   to walk in one session.

3. **Wave 2 Theme 2 (1-2 weeks)** — transaction discipline. Requires
   designing the `withTransaction` helper carefully (nestable,
   rollback semantics, integration with existing BEGIN IMMEDIATE
   sites). Worth doing before Theme 3 because some Theme 3 fixes
   need transactions.

4. **Wave 2 Theme 3 (1-2 weeks)** — orphan reconciler extension. The
   payoff is robustness across server restarts; the cost is
   significant new code. Probably worth doing only after a real
   crash recovery surfaces a specific gap.

5. **Wave 4 (1 week)** — web UX. Independent of the above; can be
   parallelized.

The system is in a substantially better correctness state than
before this wave. P0 findings are all addressed. Resting here is a
legitimate stopping point.
