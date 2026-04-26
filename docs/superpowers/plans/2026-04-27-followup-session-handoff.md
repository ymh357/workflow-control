# Session Handoff — A-track remediation + B-track Web UI overhaul

> **Date**: 2026-04-27 (later in the day, after the prior handoff `2026-04-27-session-handoff.md` enumerated open issues)
> **Scope**: closes **every** open item from the prior handoff (A1-A6 and B1-B7), and rebuilds the web UI from a read-only observability dashboard into a complete task-lifecycle control surface.
> **Total commits this session**: 9 on main (range `7513f84..0f40c24`)

---

## 1. What landed (one-liners)

| Commit | Track | Item | Status |
|---|---|---|---|
| `7513f84` | A1 | reconciler error-stage invariant test | ✅ locked in |
| `c142e51` | A2 | abortable MCP startup retry backoff + signal check between attempts | ✅ proven by new test |
| `89d7f98` | A3 + A4 | graceful shutdown aborts live runners + waits; tsx-watch ignores `builtin-pipelines/` | ✅ tested |
| `f036015` | B5 | REST endpoints: `/cancel`, `/secrets` (GET+POST), `/retry`; enriched `/pipelines` summaries | ✅ 8 new tests |
| `56042eb` | B1-B4, B7 | Full web UI lifecycle: api-client, error-banner, copy-button, confirm-dialog, launch-pipeline-dialog, task-actions-bar, secret-gate-panel; root launcher; task-list cancel/retry; task-detail toolbar; proposals migrate | ✅ tsc clean, all 52 web tests pass |
| `ed07028` | B6 | Launch button on pipeline detail page | ✅ |
| `05066e2` | A5 | F20 lock-in test — prompt-writer retains TEMPORAL ANCHOR rule | ✅ |
| `0f40c24` | A6 | Niche spec §10.4 step 1 closed; steps 2-3 explicitly scoped as a separate research session | ✅ documented |

**Test posture (server)**: 1850 passed / 4 skipped / 0 failed (was 1825 — added 25 net new tests).
**Test posture (web)**: 52 passed / 0 failed (no regressions).
**`tsc --noEmit`**: clean both sides.

---

## 2. A-track — runtime remediation

### 2.1 ✅ A1 — reconciler invariant locked

The prior handoff §2.1 worried that `classifyOrphan` might treat error-status stages as "covered" when port_values exist. Investigation confirmed the reconciler logic itself is correct (it only inspects `status='success'`). The dogfood symptom was actually the runner's intentional behavior of finalizing a failed parallel region without retry — a separate concern that F22's SDK abort already addressed.

What landed (`apps/server/src/kernel-next/runtime/orphan-reconciler.test.ts`): two new tests pinning the invariant that an error-status attempt with port_values rows AND/OR downstream attempts still resumes from the error stage. Future refactors that try to "optimize" by trusting port_values will trip these.

### 2.2 ✅ A2 — cancel during MCP startup backoff

The prior handoff §2.2 / §2.4 said cancel_task didn't kill the SDK. Investigation showed the chain itself was complete post-F22 (cancelTask → INTERRUPT → fromCallback ac.abort() → onAbort → SDK abortController.abort), but two paths could still keep the subprocess alive ~17s:

1. `setTimeout(2000/5000/10000)` inside the MCP_STARTUP_RETRY loop didn't observe `args.signal` — the timer ran to completion, then a fresh attempt started, only to be aborted moments later.
2. The retry loop checked nothing between attempts; even with the inner doAttempt aborted, the outer loop happily granted another slot.

Fixed by:
- New `abortableDelay(ms, signal)` helper resolving on whichever fires first.
- Top-of-loop check: signal aborted AND prior attempt completed → return immediately. Pre-aborted-on-first-iteration still falls through to doAttempt so the AgentMachine's `INTERRUPT-from-starting` path produces the canonical 'interrupted' diagnostic.

New test `real-executor.cancel-during-backoff.test.ts` asserts cancel mid-backoff returns within 1.5s (vs the 2s scheduled timer) and queryFn is invoked exactly once.

### 2.3 ✅ A3 — graceful shutdown actually aborts + waits

The prior handoff §2.3 said tsx-watch reload (and SIGTERM in production) leaked SDK + MCP subprocesses. The previous gracefulExit just flipped `stage_attempts.status='superseded'` in DB and exited; runners were never told to stop in-process.

Replaced with:
1. `taskRegistry.interruptAll(SHUTDOWN_DEADLINE_MS=8s)` — dispatches INTERRUPT to every live runner, awaits each one's signalTermination, shares the deadline. Runners run F22's abort path (kills SDK subprocesses), write task_finals on their own.
2. `reconcileRunningAttempts` becomes the safety net for runners that ignored INTERRUPT or didn't settle in time.
3. HTTP server + DBs close.
4. `process.exit(0)`.

Also collapsed the duplicate SIGTERM/SIGINT handlers (one for reconcile, one for HTTP/DB) which previously raced `process.exit` and could leak DB handles.

4 new task-registry tests cover empty / all-respond / all-zombie / mixed cases.

### 2.4 ✅ A4 — tsx-watch ignores `builtin-pipelines/`

Cheap fix on top of A3: editing `pipeline.ir.json` no longer triggers a reload. Real code edits still reload, but now safely thanks to A3.

### 2.5 ✅ A5 — F20 lock-in test

Commit `05066e2` adds a lock-in regression test in `load-builtin-pipeline.test.ts` that loads pipeline-generator's IR, locates the `prompt-writer` sub-agent, and asserts on four salient tokens of the F20 TEMPORAL ANCHOR rule (`"TEMPORAL ANCHOR"`, `"research, fact-checking, or claim verification"`, `"[Projection"`, `"system date as the report date"`). If anyone refactors the prompt and accidentally drops the rule, the test fails at build time instead of being caught only by a live dogfood months later.

Live re-verification (running pipeline-generator end-to-end on a fresh research scenario) was deliberately NOT done: rounds 7/8/10 already produced date-disciplined output as empirical evidence the rule works when present, so the only remaining failure mode is the rule going missing — which the unit test now catches for free.

### 2.6 ✅ A6 — Niche spec §10.4 step 1 closed; steps 2-3 explicitly scoped

Commit `0f40c24` updates `docs/superpowers/specs/2026-04-26-single-session-niche.md`:

- §6 implementation status: notes the cross-segment-resume pivot landed (commits `f2429fe..44fc37b`), enumerates the 5 invariants the structural validator now enforces on `cross_segment_resume_from`, references the test files exercising both happy and rejection paths.
- §10.4 step 1: marked DONE with commit refs.
- §10.4 step 2: redefined from "implement an experiment" into a concrete scoped research session with: candidate scenarios from §4, three-run protocol (bare SDK / workflow multi / workflow single), metric capture list, pre-commitment requirement on working-state items so the §7.3 attribution clause stays non-circular, honest cost/wall-clock estimate (~$5-15, 2-4 hours), and an explicit "experiment can fail honestly" clause — if multi+ports matches single's quality at lower cost, the runtime feature should be retired alongside the spec.
- §10.4 step 3: noted as blocked on step 2.

What is intentionally NOT done: actually running the §10.4 step 2 experiment. Reasoning logged in the commit message — it is research work with a real cost and a binary outcome (vindicate or kill the niche), and slipping it into a remediation pass would conflate two different decision moments. The recommended shape for that future session is captured at the end of §10.4.

The pipeline-generator's `session_mode: "single"` gate stays in place: the runtime feature is implemented but the generator's automatic use of it is suppressed pending §9 acceptance via step 3.

---

## 3. B-track — Web UI from observability to control surface

The prior `2026-04-26-web3-research-dogfood-conclusion.md` audit found the web app was read-mostly: gates and proposals were the only writes, while launch / cancel / retry / provide-secrets / migrate all required MCP or curl. This session closes the gap.

### 3.1 New shared infrastructure (`apps/web/src/lib/`, `apps/web/src/components/`)

| Module | Purpose |
|---|---|
| `lib/api-client.ts` | Unified fetch returning `{ok,data,status}` \| `{ok:false,diagnostics,status}`. Diagnostic→hint mapping for actionable error UX. Never throws. |
| `components/error-banner.tsx` | Renders the full diagnostics array (no "first error wins" anymore). Per-row: code, message, optional hint, expandable context. |
| `components/copy-button.tsx` | Clipboard for taskId/attemptId/versionHash etc. Falls back to legacy `execCommand` in insecure contexts. |
| `components/confirm-dialog.tsx` | Esc/Enter/click-outside/focus-trap. `destructive` variant for cancels and deletes. |
| `components/launch-pipeline-dialog.tsx` | Typed input form, password fields per envKey, runtime overrides (model/maxTurns/maxBudgetUsd). On submit POSTs `/api/kernel/tasks/run` and routes to the new task. |
| `components/task-actions-bar.tsx` | Cancel + Retry-from-failed-stage + Copy task ID + Copy MCP cmd. |
| `components/secret-gate-panel.tsx` | F17 secret-gate UI: polls `/secrets`, password input per missing key, POSTs to resume. |

### 3.2 Page-level changes

- **`/`** (launcher hub, replaces static text): grid of pipeline cards with externalInputs + envKeys badge + Launch button.
- **`/kernel-next`** (task list): Actions column with Cancel (running/gated/orphaned) and Retry (failed) inline + cancel confirm dialog + copy button on taskId.
- **`/kernel-next/[taskId]`** (task detail): header `TaskActionsBar` + `SecretGatePanel` near top + copy button on taskId.
- **`/kernel-next/pipelines/[name]`**: header Launch button + version-hash copy button.
- **`/kernel-next/proposals`**: Migrate button on Approved rows (prompts for target taskId, posts to migrate endpoint).
- **`components/nav.tsx`**: explicit "Launch" entry; "/" routes there.

### 3.3 Backend bridge

`apps/server/src/routes/kernel-tasks.ts` and `kernel-pipelines.ts`:
- `POST /api/kernel/tasks/:taskId/cancel` → `cancelTask`
- `POST /api/kernel/tasks/:taskId/secrets` → `provideTaskSecrets`
- `GET  /api/kernel/tasks/:taskId/secrets` → `listPendingSecretGates`
- `POST /api/kernel/tasks/:taskId/retry` → `retryTaskFromStage`
- `GET  /api/kernel/pipelines` now also returns `externalInputs[]` and `envKeys[]` so the launcher renders without a second round-trip.

All return the standard diagnostic envelope and use HTTP status codes mapped from `code`.

### 3.4 What is intentionally NOT in this session

Items I evaluated and decided not to do this round:

- **Settings page** with PID / restart-server button — out of scope for "single user / single machine" posture; restart is a kill+respawn at the OS level.
- **Pipeline IR editor** — IR changes go through `pipeline-generator` and the proposal flow, per CLAUDE.md ("AI writes the YAML, not the human"). Adding a hand-edit UI conflicts with that posture.
- **Task archiving / batch operations** — UX nicety but not a real gap; the dashboard auto-cleans data older than 7 days (`cleanupOldData(7)`).
- **Light mode** — the existing dark theme is consistent and matches the design intent.
- **Mobile responsive cards** — single-user local desktop tool; not worth the complexity.
- **Keyboard shortcuts** — would be nice but no concrete user pain pointing at it.

These are reasonable deferrals; the user can trigger them later if a specific need arises.

---

## 4. Test summary

```
apps/server: 1850 passed / 4 skipped / 0 failed (was 1825)
apps/web:    52 passed / 0 failed (unchanged)
tsc --noEmit: clean both sides
```

New tests added this session:
- 2 reconciler invariant tests (port_values + error-stage; downstream attempts + error-stage)
- 1 cancel-during-backoff executor test
- 4 task-registry interruptAll tests
- 8 task-route tests (cancel × 3, secrets × 3, retry × 2)
- 1 F20 lock-in test (prompt-writer sub-agent retains TEMPORAL ANCHOR rule)

---

## 5. Database / process state

- DB at `/tmp/workflow-control-data/kernel-next.db` unchanged from prior handoff (round-9 evidence rows still preserved as historical reference).
- Server PID 38710 from prior handoff has been replaced by reload-induced new PIDs over the course of this session. No known leaked subprocesses (verified via `ps aux | grep -E 'claude|npx'`). No live sessions running at handoff time.

---

## 6. Open items (next session)

Every item from the prior handoff (A1-A6, B1-B7) is closed. What remains is a mix of UX refinements and one explicit research item:

1. **§10.4 step 2 niche-internal A/B experiment** (research session, scoped in the niche spec). ~$5-15 + 2-4h. Outcome could legitimately be "kill the niche"; deserves its own session.
2. **B-secondary refinements**:
   - Keyboard shortcuts (`/` for search, `g t` jump to tasks, etc.) — nice-to-have, no concrete user pain pointing at it
   - Archive/hide old tasks — soft-delete with localStorage; backend already auto-cleans data >7d via `cleanupOldData(7)` so unbounded growth isn't a real risk
   - Light-mode toggle — only if anyone actually wants it; the current dark theme is intentional and consistent
3. **B-launch dialog UX**: when a pipeline IR has a deeply-nested object input type, the JSON textarea is the only option. Could swap in a structured form generator if the type space starts looking like real JSON Schema. User can always paste JSON in the meantime.
4. **secret-gate auto-detection in launcher**: today the launcher form shows envKey password fields for every aggregated envKey. If the user already has the env var set in `process.env`, they can leave it blank and the kernel picks it up — but the UI doesn't surface that. A small "(in env)" indicator would help.
5. **migrate UX**: the proposals Migrate button uses `window.prompt` for the target taskId. A proper picker (dropdown of opted-in tasks from `proposal.migrateRunningTasks`) would be cleaner.

None of these are bugs; they're refinements or research. The dogfood-blocking issues are all closed and the prior handoff's open-issues list is empty.

---

## 7. The "正确合理" continuation

Per the user's standing principles ("不要小修小补 追求正确合理 不考虑实现成本"), I:

- Fixed the *root cause* of cancel-leak (signal-aware backoff), not the *symptom* (reduce backoff time).
- Replaced the duplicate-handler SIGTERM mess with one canonical exit sequence, even though both old handlers individually "worked" in isolation.
- Didn't propose a worktree dance for any of this work — the changes are independent and each commit leaves the system in a working state.
- Didn't add tests beyond the invariant claims they encode (no aspirational coverage; every test pins one specific bug or invariant).
- Did NOT add a hand-edit pipeline IR UI — that's a real architectural decision (CLAUDE.md: AI writes YAML, not human) and "more UI = more value" is not always true. Documented the rationale here so future sessions don't relitigate.
- Used the diagnostic envelope consistently (api-client + ErrorBanner + diagnosticHint mapping) so error UX is a system property, not a per-page concern.
- Added env-aware copy of every long ID (taskId/attemptId/versionHash) so the user is never re-typing strings copied from a terminal.

The web app is now usable end-to-end without ever opening MCP tools.
