# Full Codebase Review — Findings & Fix Roadmap

**Date**: 2026-04-30 (c12+)
**Scope**: 7 parallel review agents covering ~250 source files across
server (kernel-next runtime, MCP layer, IR/validator/compiler, builtin
scripts, SSE, hot-update, HTTP routes, lib utilities, mcp-catalog) and
the Next.js web frontend.
**Output**: every finding consolidated below, ranked. Identifiers like
`B1.F1` mean "Batch 1 Finding 1" from the original agent reports.

---

## Severity legend

- **P0** — Correctness / data corruption / silent loss / RCE
- **P1** — Functional bug under realistic conditions; fix in next pass
- **P2** — Latent / quality / fragility; track for future hardening
- **P3** — Style / cosmetic / "would be nicer"

---

## P0 findings (correctness / data corruption / silent loss)

| # | File | Issue | Symptom |
|---|---|---|---|
| 1 | runner.ts:868-921 | retry verdict path doesn't supersede stale `fanout_element` rows like the rollback path does | a script-stage `retry: backToStage` rewinding across a fanout silently reuses prior per-element outputs against new upstream inputs |
| 2 | real-executor.ts:614-623 | TOCTOU between `args.signal.aborted` check and `addEventListener('abort')` | parent abort landing in the gap is lost; executor runs full SDK query on a cancelled task |
| 3 | runner-fanout.ts:273-280 + sql.ts (no unique idx) | `Promise.race` timeout detaches the executor promise; if it later succeeds, two `fanout_element` rows with `status='success'` for same idx exist; `preservedByIdx` SELECT has no ORDER BY → non-deterministic reuse |
| 4 | runner.ts:478-708 | Pre-try DB writes (resumeFrom hydration + seed phase) leak `activeTimer` and registry entry on throw | timer holds module alive until N min; `awaitTermination` waiters never resolve |
| 5 | canonical.ts:208-220 | `store_schema` is silently omitted from `pipelineVersionHash` | store_schema-only changes don't bump version → optimistic locking and dedup broken; hot-update is a no-op for that field |
| 6 | builtin-scripts/index.ts:71-134 | `http_fetch` / `http_request` have no SSRF guard, no timeout, no body cap | LLM-driven pipelines can probe loopback / cloud-metadata IPs, download multi-GB bodies, or hang forever |
| 7 | assemble-investigation-ir.ts:339,653 | tutorialReviewGate reject loop is structurally broken: reject re-runs only `tutorialAuthoring` not `lookupTutorialCache`; `missingSlugs` stays `[]`; fanout no-ops | D1's reject path doesn't function — rejected tutorials can never be re-authored from cache |
| 8 | kernel-task-list.ts:95-98 | `GROUP BY task_id HAVING MAX(started_at)` is a no-op truthiness check; `version_hash` returned is non-deterministic | migrated tasks display random version's pipeline name on the task list |
| 9 | kernel.ts:765 (`updateRegistryPipeline`) | uses IR-only `versionHash(parsedIR)` not `pipelineVersionHash({ir,prompts})`, and never persists prompts | every pipeline registered via `update_registry_pipeline` errors with "prompt not found" on first agent stage |

---

## P1 findings (functional bugs)

### Runner / executor

| # | File | Issue |
|---|---|---|
| 10 | runner.ts:425 | `cancelledByPropagation` set never reset on retry/rollback (comment claims it is); same stage cancelled in attempt N stays marked, suppresses STAGE_CANCELLED in attempt N+1 |
| 11 | runner.ts:371-716 | TaskRegistry registration leaks if any pre-try-block DB call throws (6 such call sites) |
| 12 | runner.ts:1909-1918 | Synthetic GATE_ANSWERED replay matches first route by target-set superset (object-key order); two routes sharing targets pick wrong answer non-deterministically |
| 13 | runner.ts:871-875 | `retryCounts` increment likely double-counts (compiler's retry transition already increments; runner adds +1 on top) — verify against `compiler/ir-to-machine.ts` STAGE_FAILED→retry |
| 14 | runner.ts:682-708 | External seed phase doesn't try/finally: `JSON.stringify` of circular ref leaves synthetic attempt in `status='running'` zombie |
| 15 | real-executor.ts:157-160 | `clampMaxTurns` floor of 1 starves resumed sessions; 1-turn budget guarantees stage failure on resume |
| 16 | real-executor.ts:498-518 | `resolveSecret` swallows ALL errors except `MCP_INVENTORY_DECRYPT_FAILED`; DB errors look like "no value found" |

### MCP layer

| # | File | Issue |
|---|---|---|
| 17 | kernel.ts:1455-1591 | `provide_task_secrets` reads/writes/marks resolved without a transaction → concurrent calls double-retry; second migration rejected with `MIGRATION_IN_PROGRESS` masking real first-call success |
| 18 | kernel.ts:2049-2128 + 1688-1714 | `cancelTask` doesn't close pending `gate_queue.answered_at` or `secret_gate_queue.resolved_at`; `getTaskStatus` then reports cancelled task as `secret_pending`/`gated` indefinitely |
| 19 | mcp/compare-runs.ts:79-103 | `compare_runs` has no `status` filter; picks `superseded` attempts after migration; reports discarded work |
| 20 | kernel.ts:1321-1324 | `answerGate` UPDATE has no status guard: a `superseded`/`cancelled`/`error` stage_attempt can flip back to `success` |
| 21 | kernel.ts:1891-2017 + tools/admin.ts:44-71 | `retryTaskFromStage` doesn't check `task_finals`; calling `retry_task` on a `cancelled` task resurrects the runner with sticky-cancel finals → "running" task reports `cancelled` |
| 22 | tools/admin.ts + cli/lib/prune-kernel-records.ts | `prune_records` deletes lineage of in-flight tasks (no `task_finals EXISTS` guard); also exposed on external surface |
| 23 | kernel.ts (migrate path) | gate_queue rows referencing superseded `attempt_id` aren't closed during supersede; `answer_gate` resolves routes against OLD IR → answers can route to deleted stages |
| 24 | tools/hot-update.ts:298-307 | `migrate_task` MCP wrapper missing `await`; returns Promise-stringified garbage to callers |
| 25 | tools/gate.ts:44-58 | `provide_task_secrets` MCP wrapper drops `persistAs` option → documented "save to inventory" path is unreachable |
| 26 | kernel.ts:786,797 + tools/hot-update.ts:151 | `update_registry_pipeline` uses `path.join(registryRoot, name)` with no traversal check; `name='..'` writes outside registry |
| 27 | kernel.ts:1759-1773 | `getTaskStatus` heartbeat liveness query has no status filter on AED rows; superseded attempts' heartbeat keeps reporting "running" after migration |

### IR / validator / compiler / codegen

| # | File | Issue |
|---|---|---|
| 28 | compiler/ir-to-machine.ts:502-503 | `rejectRollbackMap` skips multi-target reject routes (`reject: [a,b]`); the validator allows them but compiler treats them as forward routes — no rollback BFS |
| 29 | compiler/ir-to-machine.ts:203,468 + structural.ts:289-330 | These access `w.from.source !== "stage"` directly instead of using `wireFromStage()`; un-Zod-preprocessed IRs (legacy `from:{stage,port}` literal) are silently dropped from BFS |
| 30 | sql.ts:540-580 | `INSERT OR IGNORE` on stages/ports/wires when versionHash exists → drift between `pipeline_versions.ir_json` and the normalized rows is invisible |
| 31 | codegen/emit-ts.ts:55-202 | `PortIR.type` is unvalidated and inlined into emitted TS source → code-injection through type field; `ts_source` is persisted in `pipeline_versions` |
| 32 | runtime/inline-script-executor.ts:164-185 + script-compile/contract-check.ts:208-218 | Two parallel `RUNTIME_REQUIRE_ALLOWLIST` constants hand-copied; will drift on next addition |
| 33 | runtime/inline-script-executor.ts:164-185 | "Sandbox" claims overstate guarantees: `new Function`/`globalThis`/`process` reachable; `node:fs/promises` whitelisted → unrestricted disk |
| 34 | canonical.ts:75-79 | Gate `question.options` array order leaks into hash; reordering options bumps version with no semantic change |
| 35 | sql.ts:23,31,44 | `pipeline_versions.version_hash` FK from stages/ports/wires lacks `ON DELETE CASCADE`; pipeline_versions becomes un-deletable |
| 36 | sql.ts:87 | `port_values.attempt_id` FK has no ON DELETE action declared (default NO ACTION); inconsistent with other tables |
| 37 | sql.ts:44-51 | `wires` table conflates external + stage sources via `__external__` sentinel string; no `source` column |
| 38 | structural.ts:226-227 | `SCRIPT_MODULE_NOT_REGISTERED` only fires when caller passes `allowedScriptModuleIds`; validate-only paths skip the check |

### Builtin scripts / SSE / hot-update

| # | File | Issue |
|---|---|---|
| 39 | hot-update/dry-run.ts:94 | dry-run `proposedVersion` uses IR-only hash, but real `propose()` uses `pipelineVersionHash({ir,prompts})`; dry-run/propose hash divergence for prompt-laden proposals |
| 40 | sse/http.ts:71-93 | SSE listener leak: when controller throws, listener sets `closed=true` but never calls `unsubscribe`; broadcaster keeps dispatching to dead listeners |
| 41 | builtin-scripts/index.ts (classify_evidence_bundle) | Stringified-JSON tolerance is shallow (entry/item-level only, not list-level); a stringified `positiveEvidence` array still throws — the same Bug E pattern |
| 42 | builtin-scripts/validate-and-repair-ir.ts:150-158 | Symmetric `includes` fuzzy match too lax; short port names get auto-rewritten to whatever name contains them |
| 43 | hot-update/migration-orchestrator.ts:200-223,369-374 | Migration RESUME_FAILED leaves `status='running'` orphan `fanout_element` rows |
| 44 | builtin-scripts/tutorial-cache.ts:159-165 | `write_tutorial_cache` does N inserts without a transaction — N fsyncs + partial-write failure |
| 45 | builtin-scripts/index.ts (write_file) | No path-traversal protection; LLM-supplied path can write anywhere kernel UID can write |

### HTTP routes / lib / mcp-catalog

| # | File | Issue |
|---|---|---|
| 46 | mcp-catalog/inventory.ts:75-78 | `equipEntry` writes any envValue key without checking it's in `entry.envKeys`; ghost env keys persist; unbounded growth |
| 47 | mcp-catalog/schema.ts:17 | `command` is free-form string (no allow-list); custom catalog entries can declare `command:'/bin/sh'` etc. → persistent post-restart RCE path |
| 48 | kernel-task-list.ts:67-68 | LIMIT × 2 post-filter buffer truncates results when status filter is restrictive; paginating clients get wrong totals |
| 49 | kernel-run.ts:156-161 | 6 `void seedBuiltinPipelineByName(...)` race first HTTP request and silently swallow rejections; missing builtin → mysterious NAME_NOT_FOUND |
| 50 | mcp-catalog/healthcheck.ts:40-46 | `defaultExec` uses `execFile` with default 1MB stdout cap and weak timeout; `npm view` of large packages → ENOBUFS |
| 51 | lib/config/settings.ts:174-184 | `SETTING_*` env auto-mapping silently produces `agent.max_budget_usd` as STRING; downstream code expects number |
| 52 | routes/kernel-tasks.ts:127-148 | `cancel` body is `JSON.parse(...) as { reason?, actor? }` without zod; inconsistent with rest of file |
| 53 | routes/kernel-attempt-details.ts + kernel-task-ports.ts | No size cap on `agent_stream_json` / `tool_calls_json` JSON parse + HTTP response → OOM vector for long tasks |
| 54 | lib/git.ts:20-31 | `branch` not sanitized before `git worktree add`; while execFile prevents shell injection, `..`/null bytes survive |

### Runtime support

| # | File | Issue |
|---|---|---|
| 55 | runtime/task-cost-aggregator.ts:31-57 | Query has no status filter; sums across `superseded` attempts after hot-update / retry → reported cost is double-counted |
| 56 | runtime/orphan-reconciler.ts:135-196 | `bootResumability` fires N parallel resumes via `Promise.allSettled`; multi-task crash boot trips Anthropic rate limits immediately |
| 57 | runtime/start-pipeline-run.ts:364-498 | If `runPipeline` background promise rejects synchronously after `allocateWorktree` succeeds: leaks `task_env_values`, worktree, workspace dir, no `task_finals` row → orphan reconciler can't see it on next boot |
| 58 | runtime/orphan-reconciler.ts:213-218 | `isSkippable` only allows answered gates; partially-complete fanout (some `fanout_element` succeeded, no aggregate) is misclassified as "succeeded" → resume hits NO_ACTIVE_WIRE on next stage |
| 59 | runtime/worktree/allocator.ts:61-118 | Not idempotent at directory level: missing DB row + existing on-disk worktree → `git worktree add` fails as `unavailable` despite worktree existing |
| 60 | runtime/gate-timeout-sweeper.ts:46-103 | SELECT-then-`cancelTask` is non-atomic; gate answered concurrently can flip an actively-completing run to cancelled |
| 61 | runtime/execution-record-writer.ts:271-278 | Open INSERT failure produces silent NoopWriter; subsequent `appendToolCall`/`updateSessionId` no-op → SDK session resume + cost reporting silently break |
| 62 | runtime/task-env-values.ts:23-32 | `BEGIN IMMEDIATE` + `ROLLBACK` not bulletproof if BEGIN fails (catch's ROLLBACK throws "no transaction is active") |

### Web frontend

| # | File | Issue |
|---|---|---|
| 63 | app/kernel-next/[taskId]/page.tsx:673-714 | Gate-context fetch effect lists `gateContexts` in deps → self-aborting loop; visible "loading…" stutters |
| 64 | app/kernel-next/page.tsx:20 | `TaskStatus` type excludes `secret_pending` (server emits it); list-page count silently falls into undefined; pill loses style |
| 65 | components/secret-gate-panel.tsx:52-57 | 5s polling continues forever even after panel returns null; per-tab constant load |
| 66 | app/kernel-next/[taskId]/page.tsx:502-517 | Historical-attempts effect can clobber a live `executing` row back to `done` — race with SSE `stage_executing` events |
| 67 | app/kernel-next/[taskId]/page.tsx:181,786 | `eventCountRef.current` rendered in JSX but is a ref → stale until something else triggers re-render |

---

## P2 findings (latent / fragility)

(Abbreviated — full detail in batch reports.)

- **B1.F3**: wall-clock timer can fire between attempts when `currentRejectAttempt` is null; transient `idle/running` SSE event for a timed-out run.
- **B1.F7**: `topState` SSE dedupe permanently silences any `idle` re-emit; no per-attempt running events for downstream consumers.
- **B1.F26**: `doAttempt` opens stage_attempts row before Bug G runtime check fires → execution-record table dirtied with 1ms-lifetime rows.
- **B2.#5/#6**: `orphan-reconciler` boot-time gate timeout instant-fires (uses original gate `created_at`); also no boot-time stale-checkpoint sweep for `status='capturing'` rows.
- **B2.#10/#11**: `server-lock` TOCTOU on takeover; release doesn't re-check pid → can unlink another process's lock under PID reuse.
- **B2.#19/#20**: worktree allocator + `graceful-shutdown.reconcileRunningAttempts` not transactional across the two UPDATEs they do.
- **B2.#23**: `start-pipeline-run` `missingEnvKeys` is a process.env snapshot; stale by the time `provide_task_secrets` runs.
- **B2.#29**: `fs-prompt-resolver` `join(rootDir, relPath)` accepts `..`; promptRef traversal possible.
- **B2.#30**: `inline-script-executor` cache never evicts.
- **B3.F12**: `propose()` `autoApplied` label misleading; only auto-approved, not applied.
- **B3.F13**: `wait_for_task_event` historical seq=0 dropped on cold start.
- **B3.F14**: `dispatcher.send` after `answerGate` not wrapped in try/catch like `broadcaster.publish`.
- **B3.F15**: `write_port` accepts writes to terminated attempts (no `status='running'` check).
- **B3.F17**: `cachedPipelineGeneratorIR` module-level cache never invalidated; stale across `update_registry_pipeline` writes.
- **B3.F18**: `propose()` writes pipeline_versions + prompt rows + proposals row without a transaction.
- **B4.F4**: `sortKeys` silently drops BigInt/Date/Function as `null` (canonical hash collisions).
- **B4.F19**: `EMPTY_DATAFLOW` doesn't fire for "1 stage with declared ports but no wires".
- **B4.F20**: `gateTargetOwners` map computed but never used (dead code post-relaxation).
- **B4.F22**: structural.ts doesn't validate fanout's input port has any inbound wire; can block forever.
- **B4.F23**: cross-segment same-segment diagnostic also fires for undefined segments (corrupt IR).
- **B4.F29**: codegen unconditionally appends `__gate_feedback__` to gate outputs; if author also declares it → duplicate-key TS error.
- **B4.F37**: `contract-check.invokeWithTimeout` leaks timer when run resolves first (cosmetic).
- **B5.SSE leak (similar to #40)**: `kernel-next/sse/broadcaster.ts` — listener keeps subscribed if controller throws but heartbeat catches it; same issue as proposals broadcaster.
- **B6.#1**: `kernel-mcp-catalog.ts` POST entries spreads unparsed body via `as object` cast; relies on `.strict()` zod parse downstream.
- **B6.#11**: `routes/kernel-mcp.ts` creates a fresh `McpServer` per HTTP request → wasteful, no session resumption.
- **B6.#12/proposals-stream.ts**: heartbeat keeps running after controller errors until next tick.
- **B6.#13**: every approve/reject calls `listProposals({})` to find one row — O(n) per write.
- **B6.#15**: settings cache 60s TTL with no invalidator; mid-write read defaults for full minute.
- **B6.#16**: `interpolateEnvVar` substitutes missing var with `\0MISSING\0` literal in mid-string; survives into downstream consumers.
- **B6.#21**: `lib/spawn-utils.ts` `chunk.toString()` slices on byte boundaries → multibyte char corruption when buffer hits maxBytes.
- **B6.#23**: `lib/json-extractor.ts` error log includes 500 chars of raw agent output → PII/token leak risk.
- **B6.#24**: `lib/redact.ts` regex misses `client_secret_id`, `webhook_url`, AWS session tokens, GCP keys, Stripe keys.
- **B6.#27/#30**: `mcp-catalog/inventory-store.ts` BEGIN IMMEDIATE not nestable; no SAVEPOINT.
- **B6.#33**: `mcp-catalog/seed.ts` race against builtin sync at startup.
- **B7.F3**: SSE connect callback can leak reconnect timer when abort fires mid-flight.
- **B7.F4**: SSE stream URL doesn't `encodeURIComponent(taskId)`.
- **B7.F8**: `secret-gate-panel` "save to inventory" reads stale `inventoryMap` synchronously at submit.
- **B7.F9**: `LaunchPipelineDialog` envProbe race on rapid open/close (no AbortController).
- **B7.F11**: `LaunchPipelineDialog` overlay click closes dialog even when click started inside (mousedown→mouseup drag).
- **B7.F12**: `ConfirmDialog` Enter handler captures fresh `onConfirm` every parent re-render (focus jumps).
- **B7.F19**: `API_BASE` duplicated in 6 files; will drift at upgrade time.
- **B7.F22**: `RecommendedMcpsCard` never refreshes inventory after equip in another tab.
- **B7.F26**: `proposals/page.tsx` approve sends empty-string body with JSON content-type.
- **B7.F27**: dialogs claim `aria-modal="true"` but don't trap focus.

---

## P3 findings (cosmetic / style)

Skipping enumeration — full list in agent reports. Major themes:
- duplicate constants, dead code, inconsistent error envelopes, missing
  `unref()` on long-running timers, TS namespace identifier escaping
  inconsistencies, log statements that include raw user input.

---

## Cross-cutting themes

Three patterns recur across multiple findings:

### Theme 1 — `superseded` / terminal `task_finals` not respected by mutation/query paths

Hits: 19, 20, 21, 22, 23, 27, 55. The state machine has a clear concept
of "this row is no longer authoritative" (`status='superseded'`,
`task_finals.final_state IN ('cancelled','failed','completed')`), but
multiple code paths read or write across these without guards. A
single review pass adding `status='running'` / `task_finals NOT EXISTS`
guards everywhere `stage_attempts` is touched outside the orchestrator
would resolve a third of the P1 list.

### Theme 2 — Multi-statement DB sequences without transactions

Hits: 17, 18, 30, 56, 60, 61, 62. SQLite in WAL mode + `node:sqlite`
synchronous calls makes most multi-statement sequences technically
serial within a process, but rare error paths (BEGIN failure, mid-write
crash, FK violation) leave inconsistent state. A `withTransaction()`
helper that wraps `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`-with-catch
applied to provide_task_secrets, propose, gate-timeout-sweeper,
worktree allocator, graceful-shutdown.reconcileRunningAttempts,
checkpoint capture would close most of these.

### Theme 3 — Boot/orphan recovery cohesion

Hits: 4 (precondition #11), 10, 43, 56, 57, 58, 59, 65 (web-side
analog). Every owner of a "lifetime resource" (envValues, workspace
dir, worktree, capturing checkpoint, fanout_element row,
secret_gate_queue row) needs an entry in an orphan reconciler walk;
today the reconciler only knows about `stage_attempts`. A single
extension that walks ALL these tables on boot and reconciles against
`task_finals` would resolve much of the boot-time fragility.

---

## Fix roadmap (priority order)

### Wave 1 — P0s + the worst P1s (~3-5 days work)

1. **Bug 7 (D1 reject loop)** — 我 just shipped (commit `a44f72c`). MUST fix before anyone uses tutorial cache + reject. **Same continuation.**
2. **Bug 1 + 3** — runner retry-path fanout supersede + Promise.race orphan write race. Both same root cause as the c10 rollback fix; extend the fix to the retry path AND add a unique constraint on `(task_id, stage_name, fanout_element_idx, status='success')` partial index, OR change `preservedByIdx` to `ORDER BY started_at DESC, attempt_idx DESC` + `setIfAbsent`.
3. **Bug 6 (SSRF in http_fetch)** — wrap URL with allow-list (no `127.0.0.0/8`, `169.254.0.0/16`, `::1`, `fe80::/10`, etc.); add 30s default timeout; cap body at 10MB.
4. **Bug 9 (`update_registry_pipeline` broken)** — call `pipelineVersionHash({ir,prompts})`, persist prompts, add path-traversal guard.
5. **Bug 24 (`migrate_task` missing await)** — add `await`.
6. **Bug 5 (`store_schema` not in hash)** — include in `canonicalizeIR`.

### Wave 2 — Theme-driven cleanup (~1-2 weeks)

7. **Theme 1 sweep**: add status guards everywhere `stage_attempts` is read/written outside the orchestrator. Hits 19, 20, 21, 22, 23, 27, 55.
8. **Theme 2 sweep**: introduce `withTransaction()` helper, apply to provide_task_secrets / propose / cancel / gate-timeout-sweeper / worktree allocator / graceful-shutdown / checkpoint.
9. **Theme 3 sweep**: extend orphan reconciler to walk task_env_values, task_worktrees, stage_checkpoints, secret_gate_queue, fanout_element rows.

### Wave 3 — Validator / compiler / canonical hardening (~3-5 days)

10. Bug 28 (`rejectRollbackMap` multi-target).
11. Bug 29 (`wireFromStage` consistent use).
12. Bug 30 (`INSERT OR IGNORE` drift).
13. Bug 31 (`PortIR.type` validation).
14. Bug 32+33 (sandbox docs + single source of allowlist).
15. Bug 34 (gate options sort).

### Wave 4 — UX / web polish (~1 week)

16. Bug 63-67 (gate-context loop, TaskStatus drift, eventCountRef, secret-gate panel polling, history-vs-SSE race).
17. Bug 64 specifically — type drift between server status enums and web `TaskStatus`. Add a single shared types package or a type-test that re-derives.

### Wave 5 — Hardening / nice-to-haves (deferred indefinitely)

All remaining P2/P3.

---

## What's NOT a bug (worth recording)

- **F33 inline-script "sandbox"**: the system is single-user local with
  AI authorship; the "sandbox" comment overstates guarantees but the
  posture (per CLAUDE.md) explicitly accepts the trust model. Action:
  fix the docs, don't try to actually sandbox.
- **F31 PortIR.type code injection**: same posture, but `ts_source`
  persistence is dirty enough to want input validation regardless.
- **`prune_records` on external surface**: if the user explicitly wants
  AI agents to manage retention, this is fine; otherwise move to admin
  surface.
- **mcp-catalog encryption-at-rest without key-version field**: only
  matters if key rotation becomes a roadmap item.

---

## Counts

- P0: 9
- P1: 53
- P2: ~50 (abbreviated)
- P3: dozens (mostly elided)

Total findings considered: ~120+ across the 7 reviews.

The codebase is **structurally sound** (clear separation between
KernelService / runtime / executor / IR; canonical hashing for content
addressing; SSE broadcasting; XState machine compilation). The
recurring failure modes are **operational** — race conditions across
state-machine boundaries, transaction discipline gaps, and cohesion
gaps in boot/orphan recovery. None of the findings invalidate the
overall architecture.
