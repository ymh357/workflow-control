# Dogfood 5+6 — Bug 16 root-caused and fixed

**Date**: 2026-05-02 (continuing from `handoff-dogfood-bug16.md`)
**Branch**: main
**Predecessor**: handoff-dogfood-bug16.md (Bug 16 captured but unfixed)
**Outcome**: Bug 16 root-caused, fixed in two iterations, validated
end-to-end via a fresh reject-rollback dogfood that ran to completion.

---

## Bug 16 — gate-rejection-then-approve wedged the runner

### Root cause (confirmed via debug instrumentation)

The runner had its own `buildInitialPortValuesRunner` that ONLY
seeded externalInputs into `persistentPortValues`. The compiler's
`buildInitialPortValues` additionally seeds every gate stage's
`__gate_feedback__` port with empty string so downstream wires
reading those ports can resolve before any gate has fired.

The two implementations had drifted apart. When a gate is rejected
and the actor is rebuilt with `isRetryRebuild=true`, the compile
path uses `initialContext.portValues = persistentPortValues`,
**bypassing the compiler's buildInitialPortValues entirely**.
Without the gate-feedback seeds, any downstream gate-routed stage
with a feedback wire from an unanswered gate (very common in
investigation pipelines — prereqExtraction has
`prereqGate.__gate_feedback__` wire, etc.) failed `wireDelivers`
and its `waiting.on.GATE_ANSWERED` transition guard returned false
even when the gate authorisation arrived. The actor wedged.

Status flipped to `orphaned` after 60s heartbeat timeout. INTERRUPT
couldn't unstick it (`MIGRATION_INTERRUPT_TIMEOUT`).

### Fix iteration 1 (cd81496)

- Exported `buildInitialPortValues` from compiler/ir-to-machine.ts.
- Runner imports it and uses it to initialize `persistentPortValues`,
  replacing the divergent local `buildInitialPortValuesRunner`.

This fixed the **resume hydration** path (when `opts.resumeFrom` is
set, e.g. when boot resumability picks up an orphan task). But it
did NOT fix the **fresh-task rollback** path, which was the actual
repro scenario.

### Fix iteration 2 (6c1bc1d)

The rollback verdict branch (line 864+) filters
`persistentPortValues` to drop entries for every affectedStage,
preserving only the rejected gate's `__gate_feedback__` (carrying
the user's rejection comment). It DROPS every other gate's
`__gate_feedback__` — even though the compiler's
`buildInitialPortValues` seeded them with "" on first compile.

After the filter, all those downstream gates' feedback ports were
undefined in the rebuilt actor's context, breaking the same
`wireDelivers` check.

Same pattern in the retry verdict path (line 1018+), which filters
by `toReset` instead of `affected`.

**Fix**: after each filter, iterate `ir.stages` and re-seed
`__gate_feedback__ = ""` for every affected/reset gate (skipping
`fromGate` in the rollback case, which keeps the rejection text).

---

## Dogfood-6 — full end-to-end validation

After v2 fix, ran the full reject-rollback path:

1. Launch fresh task on the generated pipeline (versionHash
   `08617d0a...`).
2. Wait for framingGate to open. **Reject** with feedback:
   "Add tooling-resolver-divergence axis explicitly..."
3. Verify topicFraming idx=2 ran and incorporated the feedback
   (the axes list now includes the explicitly-requested ones).
4. framingGate idx=2 opens. **Approve**.
5. **Verify**: prereqExtraction.idx=1 dispatches within seconds.
   (In dogfoods-4 and -5 v1, the actor wedged here permanently.)
6. Continue approving all 7 gates: prereqGate, tutorialReviewGate
   (16 fanout elements), primarySourceGate (13 evidence elements),
   findingsSynthesisGate, humanReviewGate, reportJudgeGate
   (with answer="accept").
7. **Final state**: `completed/natural`. 60KB report at
   reportAssembly.markdown.

### Run statistics

| Metric | Value |
|---|---|
| Wall time | ~75 min (lots of LLM stages + my approval delays) |
| Anthropic spend | **$9.57** |
| Input tokens | 52,678 |
| Output tokens | 235,427 |
| Stages | 20 (including the fanout aggregates) |
| Fanout aggregates | 3 (tutorialAuthoring 14, evidenceGather 11, findingsAuthoring 11) |
| Gates | 8 (framingGate twice — reject + approve, then 6 forward gates) |
| Stage errors | 0 |
| Superseded rows | 0 (lineage preserved) |
| Final state | `completed / natural` |

### What this validates

- Bug 28 (multi-target rollback) — affectedStages set correctly
  includes all 20 stages
- Bug 58 (fanout aggregate) — three aggregate rows landed
- Bug 14 (kind/fanout_element_idx surfaced) — diagnostics worked
- Bug 15 (rebuild context honors aggregate) — fanout stages
  re-entered cleanly across the reject-rebuild
- Bug 16 (this fix) — gate-feedback seeds preserved across rollback
- Theme 2 transactions — gate_queue + answer + feedback wire all
  consistent post-reject
- D1 tutorial cache — 16 rows persist across runs (this run's
  cache hit rate was 0% only because the LLM picked different slugs
  this time; the cache itself works)

---

## Cumulative

| Phase | Commits | Bugs |
|---|---|---|
| c12+ Waves 1-4 + Theme 1-3 + scattered (handoff-final) | 11 | 56 |
| Dogfood Bug 68 | 1 | 1 |
| P2 sweep (handoff-p2-sweep) | 26 | 18 |
| Fresh dogfood 2026-05-02 (handoff-dogfood-2026-05-02) | 3 | 3 |
| Dogfood-4 Bug 16 docs (handoff-dogfood-bug16) | 1 | 0 (doc) |
| **Dogfood 5+6 Bug 16 fix (this handoff)** | **2** | **1** |
| **Total** | **44** | **79** |

---

## Final state

```
Branch: main, ~36 commits ahead of c12+ closure (ad5bba6)
Server tests: 250 files pass + 3 skipped, 2369 tests + 24 skipped
Web tests: 13 pass, 61 tests
TSC: clean
Tasks ending in completed/natural: pipeline-generator (initial),
  dogfood-3 (validation), dogfood-6 (reject-rollback validation)
Generated pipeline: 08617d0a... still registered
Tutorial cache: 16+16=32 rows on subject_domain='nodejs.org' (some
  may be duplicates if slugs aligned)
```

---

## What's still untested

- secret_pending path (any pipeline with envKey-requiring MCPs)
- cancel_task mid-run
- Hot-update migration (propose_pipeline_change + migrate_task)
- Multi-target rollback (`reject: [a, b, c]`) — Bug 28's actual
  scenario; only single-target was exercised here

These remain on the dogfood-followup list but are decoupled from
Bug 16 and require separately-designed test pipelines.

---

## Recommended next step

**Stop and ship.** The reject-rollback path is now verified
end-to-end on a real pipeline. The Bug 16 fix is small (~20 lines
of compiler/runner changes) and surgical. Server suite is green.
The next dogfood should target the remaining untested paths
(secret_pending, cancel_task, hot-update) but each needs its own
deliberate scenario.
