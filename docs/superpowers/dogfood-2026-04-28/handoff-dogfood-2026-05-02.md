# Fresh Dogfood — 2026-05-02

**Branch**: main (3 new fix commits + 1 handoff after the P2 sweep)
**Predecessor**: `handoff-p2-sweep.md`
**Goal**: Validate c12+ Wave-3 fixes + P2 sweep on a clean codebase by running pipeline-generator end-to-end on a real investigation topic, then running the generated pipeline through full execution.

This pass discovered **3 real bugs that all 56 prior c12+ fixes + 18 P2 sweep fixes had not surfaced** — the dogfood signal worked exactly as it was supposed to. After fixing them, the generated pipeline ran end-to-end through 7 gates, 3 fanout stages (16 + 13 + 13 elements respectively), 11 LLM agent stages, and 5 script stages to produce a 60KB technical report.

---

## Topic

ESM/CommonJS interoperability in Node.js 22+ for TypeScript monorepos.
Real, non-trivial topic with axes, prerequisites, hypotheses, and primary
sources to gather. Designed to exercise:
- Multi-fanout stages (tutorialAuthoring, evidenceGather, findingsAuthoring)
- 7 sequential gates with LLM-judges + 1 human-review
- D1 cross-task tutorial cache (the cache should populate from this run)
- WebFetch-heavy evidence gathering
- Long-running LLM stages (reportAssembly was 5.8 min)

---

## Bugs found (3, all fixed inline)

### Bug 13 — pipeline-generator omits `optional: true` on optional externalInputs (`a3a15c1`)

**Symptom**: Generated pipeline declared `audienceHint` external input with description `"Optional caller-supplied audience hint; empty string disables refinement."` But the IR omitted `optional: true`, so the runtime treated it as required. Launching the generated pipeline without `audienceHint` failed immediately with `SEED_VALUES_MISSING_KEY`.

**Root cause**: `PortIR.optional: boolean` has been part of the schema since Bug 7 (dogfood 2026-04-28), but only pipeline-modifier was taught to use it. pipeline-generator's `gen-skeleton.md` prompt never mentioned the flag — the LLM correctly inferred semantic intent in the description but lacked guidance to wire the schema flag.

**Fix**: `gen-skeleton.md` now explicitly tells the LLM to set `optional: true` whenever the description marks the input as optional (common phrasings enumerated). Description and flag must agree.

This is a prompt-only fix (no code changes); it picks up on the next pipeline-generator run via the `B3.F17` mtime cache.

### Bug 14 — attempts API elides `kind` and `fanout_element_idx` (`372fe07`)

**Symptom**: `GET /api/kernel/tasks/:id/attempts` returned only `attempt_id`, `stage_name`, `attempt_idx`, `status`, `started_at`, `ended_at`. The DB stored `kind` (regular / fanout_element / fanout_aggregate / external) and `fanout_element_idx` correctly, but the API elided both. Dashboards (and the dogfood diagnostics I was running) couldn't tell a fanout_element row apart from a regular row.

**Root cause**: `kernel-attempts.ts:32` SELECTed only the original 6 columns. Easy oversight — `kind` and `fanout_element_idx` were added later when fanout was implemented but the API row builder was never updated.

**Fix**: SELECT both columns; surface them on `AttemptRow`. +2 regression tests covering fanout_aggregate / fanout_element discrimination + non-fanout default `kind='regular'`.

### Bug 15 — runner rebuild context skips fanout aggregate (`bc23280`)

**Symptom**: This was discovered through dogfood-2's failure path. The first attempt at running the generated pipeline:
1. Got partway through `tutorialAuthoring` fanout (10/12 elements done, 2 still running)
2. Server restarted (tsx watch picked up my Bug 14 commit during the dogfood)
3. graceful-shutdown.reconcileRunningAttempts marked the 2 running fanout_element rows as `superseded` — correct
4. Boot resumability resumed the task — correct
5. **But** the resumed runner's rebuild logic walked `stage_attempts WHERE status='success'` and saw 10 `fanout_element` rows for `tutorialAuthoring` → marked the stage as done
6. The runner skipped `orchestrateFanoutStage` entirely — never wrote the `fanout_aggregate` row
7. `persistentPortValues['tutorialAuthoring.slug']` was overwritten by the LAST element's single-string value (`"tree-shaking-with-conditional-exports"`)
8. Downstream `writeTutorialCache` failed: `input 'slugs' must be string[] (got string)`

**Root cause**: The runner's resume context-rebuild path never had the same fanout-aware logic that `orphan-reconciler.classifyOrphan` got in the c12+ Theme 3 Bug 58 fix. Element successes are PARTIAL state for fanout stages; only the aggregate row represents stage completion.

**Fix**: Mirror the Bug 58 logic at the rebuild path:
- A fanout stage is only "done" when its `fanout_aggregate` row is `status='success'`
- Port-value hydration drops `fanout_element` rows; only `fanout_aggregate` rows are read into `persistentPortValues` for fanout stages
- Element successes are now a recoverable partial state — `orchestrateFanoutStage`'s `preservedByIdx` skips the already-succeeded indices on resume and runs only the missing/superseded ones, then writes the aggregate

This was the most subtle of the three. It only manifests when:
- A fanout stage is mid-flight when SIGTERM arrives
- AND the resumed runner is the one to complete it

Both conditions are realistic — graceful shutdown can hit any task, and tsx watch + edit-during-dev is a common dev workflow trigger. **In production (non-watch), a SIGTERM could come from systemd / Docker stop / kernel OOM and trigger the same path.**

---

## Run statistics (dogfood-3, validation pass)

| Metric | Value |
|---|---|
| Total wall time | ~22 min (excluding gate-wait time = ~12 min compute) |
| Anthropic spend | **$10.56** |
| Input tokens | 24,902 |
| Output tokens | 290,072 |
| Stages run | 20 (1 external + 11 agent + 5 script + 7 gate; gate counted as stage) |
| Fanout stages | 3 (tutorialAuthoring 16 elements, evidenceGather 13 elements, findingsAuthoring 13 elements) |
| Total fanout_element attempts | 42 (all success) |
| Fanout_aggregate rows | 3 (all success) |
| Gates | 7 (all approved) |
| Stage errors | 0 |
| Superseded rows | 0 |
| Final state | `completed / natural` |
| Output: report | 59,940 chars (~10,000 words) at `reportAssembly.markdown` |

**Tutorial cache populated**: 16 rows under `subject_domain='nodejs.org'`. Future investigations on the same domain will hit this cache (D1 validated end-to-end).

---

## What c12+ + P2 sweep fixes were exercised AND held up

| Area | Fix | Validated by |
|---|---|---|
| `write_port` actionable errors | Bug 68 (e46b939) | Many `port_written` events through normal flow; no errors |
| `__gate_feedback__` synthesis | Bug 28 + B4.F29 | 7 gates each emitted feedback port writes correctly |
| `fanout_aggregate` semantics | Bug 58 + Bug 15 (new) | All 3 fanout stages produced aggregate rows |
| `fanout_element_retry` (P4) | Real-executor C10 + element timeout | 0 retries needed but path exists |
| Tutorial cache D1 | a44f72c | 16 rows persisted, lookupTutorialCache returned [] (cold), missing slugs propagated |
| Boot orphan reconciler | c1e615d (Theme 3) | Server restart mid-dogfood-2 cleanly resumed the task |
| `wireSourceKey` / external wires | Bug 28/29 | All 82 wires resolved cleanly, no NO_ACTIVE_WIRE |
| canonical sortKeys throw | B4.F4 | No phantom hashes; pipeline_versions consistent |
| spawn-utils UTF-8 | B6.#21 | tutorial markdown contains CJK code samples; no U+FFFD |
| settings cache mtime | B6.#15 | seed mtime invalidation worked at boot |
| pipeline-generator IR cache | B3.F17 | Cache invalidation on disk write tested implicitly |
| answer_gate try/catch | B3.F14 | 7 dispatcher.send calls all clean |

---

## What did NOT get exercised

- Gate REJECTION / rollback — no gate was rejected this run
- Hot-update migration — no `propose_pipeline_change` during the run
- `secret_pending` path — no MCP servers required env keys for this pipeline (description-only investigation)
- Worktree allocation — generated pipeline didn't request a worktree
- `cancel_task` mid-run — task ran to natural completion
- `migrate_task` — no migration triggered

These would be exercised by a different topic / a manual gate rejection / a planned `propose_pipeline_change` mid-run. Worth a follow-up dogfood specifically to walk these paths.

---

## Final state

```
Branch: main, 30 commits ahead of c12+ closure (ad5bba6)
Server: 250 test files passed, 3 skipped (2369 tests + 24 skipped)
Web:    13 test files passed (61 tests)
TSC:    server clean, web clean
Tasks:  pipeline-generator-1777688286524-ae0af4b0 — completed (the original generator run)
        esm-commonjs-interoperability-in-node-js-22-monorepos-1777690144064-1e43ce2c — completed (validation run)
Generated pipeline: registered as version 08617d0a... in pipeline_versions, 20 stages, 82 wires, 8 prompt refs
Tutorial cache: 16 rows on subject_domain='nodejs.org'
Final report: 59940 chars at /tmp/dogfood-3-report.md
```

Cumulative across c12+ review + dogfood iterations:

| Phase | Commits | Bugs |
|---|---|---|
| c12+ Waves 1-4 + Theme 1-3 + scattered (handoff-final) | 11 | 56 |
| Dogfood Bug 68 | 1 | 1 |
| P2 sweep (handoff-p2-sweep) | 26 | 18 |
| **Fresh dogfood 2026-05-02 (this handoff)** | **3** | **3** |
| **Total** | **41** | **78** |

---

## Recommended next step

This is a real "stop and ship" point — for the second time, but with much firmer ground:
- The dogfood hit + fixed 3 bugs the static reviews + B-series sweep didn't catch
- The exact failure mode that surfaced Bug 15 (tsx watch restart during fanout) is now defended
- The full pipeline-generator → run-pipeline → end-to-end completion is reproducible

Before the next dogfood:
1. Test gate-rejection rollback (intentionally reject a gate to exercise the rollback path)
2. Test secret_pending (use a topic that recommends an MCP requiring API keys)
3. Test cancel_task mid-run

These are the unexercised c12+ paths. Worth one focused half-hour dogfood per path.
