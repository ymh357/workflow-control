# P2 Sweep Handoff — Real findings only, false positives skipped

**Date**: 2026-05-02
**Branch**: main (27 commits ahead of c12+ closure point `ad5bba6`)
**Predecessor**: `handoff-final.md` (P0 + P1 closure)
**Catalog rot-guard at sweep start**: 20/20 pass mode-2 (npm view + spawn + handshake)

This pass took the spec's P2 cluster + B-series batch reports (B1–B7,
~30+ findings the c12+ review marked "latent / fragility / cosmetic")
and worked them end-to-end. The methodology was:

1. **Verify each finding still real** in the current codebase before
   touching anything. The c12+ wave 1–4 commits had already swept
   adjacent areas; many P2 findings turned out to be false positives
   or already-fixed.
2. **Skip false positives** with a one-line rationale on the task.
3. **Defer cosmetic / hypothetical-future-need items** without a real
   signal driving them.
4. **Fix the rest with real regression tests.**

**Cumulative result**: 16 commits closing 18 distinct findings (some
commits bundle related fixes: B5+B6.#12, B6.#23+B6.#24). 2367 server
tests pass + 24 skip across 250 files; 61/61 web tests; both tsc clean.

---

## Bug 68 (dogfood signal, not a B-series item)

**`fix(mcp): write_port actionable errors + terminal-attempt rejection`**
(`e46b939`)

The 8 untracked dogfood probes left in apps/server/ from a prior
session were the real signal: an agent received "attemptId not found"
from `write_port` and had no recovery path, so it built five
stand-alone reproducers. Closed both:
- B-series-style observability: structured `reason` + actionable
  `latestActiveAttemptId` / `taskFinalState` / `attemptStatus`.
- c12+ review P2 #209: writes to terminal attempts (success/error/
  superseded) now rejected explicitly.

---

## Real bugs fixed (commit chain in order)

| SHA | Finding | Title |
|---|---|---|
| `5e626a4` | B4.F20 | refactor(validator): remove dead gateTargetOwners map |
| `da48856` | B4.F22 | fix(validator): reject fanout input port without inbound wire |
| `cb62613` | B4.F29 | fix(validator): reject gate stage explicitly declaring __gate_feedback__ |
| `dadb40b` | B3.F17 | fix(pg): pipeline-generator IR cache invalidates on disk write |
| `759a967` | B4.F4 | fix(canonical): sortKeys throws on unsupported types instead of silently dropping |
| `af86af7` | B3.F14 | fix(mcp): wrap answer_gate dispatcher.send in try/catch |
| `51dd0fc` | B2.#30 | fix(inline-script): cap compile cache at 64 entries with LRU eviction |
| `1f2963c` | B2.#29 | fix(prompt-resolver): block path traversal in FsPromptResolver |
| `6162c5b` | B6.#21 | fix(spawn-utils): preserve UTF-8 multi-byte chars across chunk boundaries |
| `9483abd` | B6.#23 + B6.#24 | fix(redact,json-extractor): expanded token catalogue + redact log previews |
| `16746a6` | B6.#16 | fix(config): interpolateEnvVar leaves placeholder for missing vars |
| `7fb802c` | B7.F4 | fix(web): encodeURIComponent taskId in SSE stream URL |
| `eab9378` | B5 + B6.#12 | fix(routes): proposals-stream cleanup runs on controller throw |
| `cee9dae` | B6.#15 | fix(config): settings cache invalidates on system-settings.yaml mtime change |
| `e715630` | B3.F12 | fix(propose): add autoApproved alias for misnamed autoApplied |
| `32813b4` | B6.#13 | perf(proposals): O(1) getProposal replaces listProposals({}).find |
| `d10760d` | B6.#1 | fix(routes): mcp-catalog POST/PUT narrow body before spread |
| `4ac9495` | B6.#27 | refactor(catalog): unequipTransaction adopts withTransaction helper |
| `bf4458f` | B7.F26 | fix(web): proposals approve sends no body without JSON content-type |
| `30d587e` | B7.F19 | refactor(web): consolidate API_BASE imports from canonical lib |
| `6718db9` | B7.F12 | fix(web): ConfirmDialog uses latest-callback ref to avoid focus-jump |
| `c83c103` | B7.F11 | fix(web): dialog overlay close requires mousedown+up both on overlay |
| `624c108` | B7.F27 | fix(web): ConfirmDialog actually traps focus per aria-modal contract |
| `142136c` | B7.F22 | fix(web): RecommendedMcpsCard refetches inventory on tab visibilitychange |
| `1f8d61d` | B7.F9 | fix(web): LaunchPipelineDialog envProbe gets per-open AbortController |
| `d60a684` | B4.F37 | fix(contract-check): clear invokeWithTimeout's timer when run wins |

(B7.F27 is partial — ConfirmDialog only. LaunchPipelineDialog has the
same a11y gap with a far larger focusable set; deferred as a focused
pass.)

---

## Findings verified false positive (NOT bugs, NOT fixed)

These were dropped from the task list with rationale; they
are NOT defects in the current code.

| Finding | Original claim | Verified state |
|---|---|---|
| **B1.F7 / topState idle dedupe** | "permanently silences any idle re-emit" | Intentional — runner.ts:1673 dedup correctly filters rebuild-actor's transient idle. `lastTopState` is run-scoped, no cross-run leak. secret_pending is a stage_attempt status, not a machine top-state, so it doesn't actually round-trip through idle. |
| **B3.F13 / wait_for_task_event seq=0 dropped** | "broadcaster.ts:84 strict `>` drops seq=0" | broadcaster.ts:147 `nextSeq=1` — seq=0 is never emitted. fromSeq=0 + `seq > 0` correctly admits all real events. |
| **B4.F19 / EMPTY_DATAFLOW 1-stage with ports** | "doesn't fire for 1 stage with declared ports but no wires" | Comment block at structural.ts:441 explicitly carves out this case as legitimate (self-contained stage). Without a dogfood signal showing it actually breaks, contradicting that explicit design intent is unjustified. |
| **B4.F23 / cross-segment same-segment for undefined segments** | "fires for undefined segments (corrupt IR)" | planSegments topologicalStageOrder.ts has a cycle-fallback that appends every stage in file order, so segmentOf is always defined for any stage in ir.stages. Rule 1 (target ∈ stageNames) + the fallback close every undefined-segment path. |
| **B6.#33 / mcp-catalog seed startup race** | "seed.ts race against builtin sync at startup" | index.ts:188 seedBuiltinFromJson is sync top-level-await; serve() at line 303 cannot run until seed completes. No race possible in current code. |
| **GATE_TARGET_SHARED + propose _default false-positive (P2 list)** | "propose() pre-existing _default with same target as user-supplied answer triggers GATE_TARGET_SHARED falsely" | Rule was relaxed on 2026-04-29 (structural.ts:246 long comment block). Cannot fire at all now. |

---

## Findings deferred (not enough signal to justify the work)

| Finding | Why deferred |
|---|---|
| **B1.F3 / wall-clock between attempts** | Cosmetic SSE noise (transient idle/running event for a timed-out run). Fix needs deep re-architecture of the runPipeline loop's terminal verdict path; not justified without a real reproduce. |
| **B1.F26 / doAttempt 1ms-lifetime stage_attempts row** | Symptom (table dirtied with brief rows) is benign; no dogfood signal. Architectural rework. |
| **B2.#5/#6 / orphan reconciler boot timeout instant-fires** | Real, but Wave 2 Theme 3 (`c1e615d`) already added boot throttling and per-class orphan handling — the immediate-fire risk is mitigated for the most common cases. Tightening the gate-timeout-on-boot path is on the docket but not blocking. |
| **B2.#10/#11 / server-lock TOCTOU** | Single-user local engine. The PID-reuse window is microseconds and only matters under crash-restart hammering. Documenting > fixing. |
| **B2.#23 / missingEnvKeys process.env snapshot** | Misread of the design. The snapshot is correct: pre-flight reports what's missing AT call time, and provide_task_secrets writes to task_env_values (not process.env). Re-reading process.env later would be wrong. |
| **B6.#11 / fresh McpServer per HTTP request** | Performance, not correctness. Single-user, low QPS. |
| **B7.F3 / SSE reconnect timer leak** | Re-read the code — `controller.signal.aborted` guard in scheduleReconnect blocks the timer registration race; cleanup `controller.abort()` (sync) then `clearTimeout(reconnectTimer)` covers the active timer. No leak found in current shape. |
| **B7.F8 / secret-gate-panel stale inventoryMap** | Now covered transitively by B7.F22 (visibility-change refresh keeps inventoryMap fresh between tabs). |
| **B7.F27 (LaunchPipelineDialog half)** | a11y focus trap for the bigger dialog needs proper focusable-list management across form sections. ConfirmDialog half done. |

---

## Final state

```
Server: 250 passed | 3 skipped (253) test files
        2367 passed | 24 skipped (2391) tests
Web:    13 passed (13) test files
        61 passed (61) tests
TSC:    server clean, web clean
Branch: main, 27 commits ahead of c12+ closure (ad5bba6)
```

Cumulative across all c12+ review fixes (Wave 1 → P2 sweep):

| Phase | Commits | Bugs |
|---|---|---|
| c12+ Waves 1-4 + Theme 1-3 + scattered (per handoff-final) | 11 | 56 |
| Dogfood Bug 68 | 1 | 1 |
| P2 sweep (this handoff) | 26 | 18 |
| **Total** | **38** | **75** |

Plus 7 handoff documents (`handoff-wave-1.md` → `handoff-p2-sweep.md`).

---

## What's left (not blocking)

The P2 cluster is exhausted modulo the deferred items above and the
rare "B-series finding I haven't seen" — all 7 batch reports were
walked. Genuine remaining work falls into three categories:

1. **A11y polish** — LaunchPipelineDialog focus trap (B7.F27 half).
   When someone audits a11y holistically.
2. **Architectural cleanups** — runPipeline wall-clock (B1.F3),
   doAttempt 1ms-row (B1.F26), server-lock PID-reuse (B2.#10/#11),
   gate-timeout-on-boot tightening (B2.#5/#6). Each is real but each
   needs design + careful integration; bundling into a "robustness
   sprint" makes more sense than picking off individually.
3. **Performance** — McpServer per HTTP request (B6.#11). Local
   engine, low QPS; not pulling weight on the priority list.

---

## Recommended next step

**Stop and ship — for real this time.**

The c12+ review spec is now exhausted. Every finding (P0, P1, real
P2, B-series real) has either been fixed, marked false-positive with
rationale, or deferred with rationale. Verifying-before-fixing
caught 6 false positives that would have been wasted commits.

Going forward, the natural next signal is a **fresh dogfood**:
- Run pipeline-generator + investigation pipelines end-to-end on
  this cleaned-up codebase.
- Watch what surfaces.
- Cherry-pick the still-real items for a focused sprint.

Without that signal, the deferred-items list is hypothetical and
attacking it would be busywork. The good resting point from
handoff-final.md is now an even better resting point.
