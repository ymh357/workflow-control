# Dogfood 7+8 — cancel mid-run + multi-target rollback validated

**Date**: 2026-05-03 (continuing from `handoff-dogfood-6.md`)
**Branch**: main
**Predecessor**: handoff-dogfood-6.md (Bug 16 closed)
**Outcome**: dogfood-7 validated cancel_task mid-run end-to-end on a
real LLM stage; dogfood-8 added a runner-level multi-target reject
test that pins Bug 28's runtime contract — both flows that were
listed as untested in the previous handoff.

---

## Dogfood-7 — cancel_task mid-run validation

### Setup

Re-used the existing `08617d0a...` ESM/CommonJS pipeline (registered
in dogfood-3, still alive in pipeline_versions). Launched a fresh
task and let `topicFraming` enter its LLM call, then issued
`POST /api/kernel/tasks/:taskId/cancel` while the agent was actively
running.

### Run timeline

| Time | Event |
|---|---|
| t=0 | `POST /api/kernel/tasks/run` → 202, `taskId=esm-...-227acfe3` |
| t≈3s | `__external__` succeeded; `topicFraming` `running` |
| t≈8s | Cancel request sent |
| t≈8s | `{ok:true, wasRunning:true, reason:"...(actor=dogfood)"}` |
| t≈25s | `topicFraming` attempt finalised at `status=error` (INTERRUPT propagated through Claude SDK) |
| t≈25s | task_finals row written: `cancelled / cancelled` |

Wall time from launch to terminal: ~25s. INTERRUPT propagation
through the Claude SDK takes most of that — the cancel HTTP call
itself returned immediately.

### Invariants verified

- `task_finals.final_state = cancelled`, `reason = cancelled`,
  `detail = "dogfood-7 mid-run cancel test (actor=dogfood)"` —
  the short-enum reason and free-form detail split (Bug 18) is
  honoured.
- `gate_queue` clean (0 rows) — task hadn't reached a gate yet.
- `task_env_values` empty — P3.6 plaintext-token-cleanup contract
  holds even when there are no envValues (the DELETE runs
  unconditionally inside cancelTask's transaction).
- `stage_attempts`: `__external__` `success`, `topicFraming`
  `error/regular dur=25318ms` — the in-flight stage was
  finalised, not left orphaned.
- Second cancel returned `TASK_ALREADY_TERMINAL` (409) — the
  guard at line 2326 in `kernel.ts` works on real cancel state,
  not just stub data.
- `GET /api/kernel/tasks?status=cancelled` lists the task with
  `attemptCount=2`, `endedAt` populated, all SSE-derived fields
  populated. Dashboard would render the cancelled state correctly.
- `taskRegistry.get(taskId)` returns undefined post-cancel — the
  runner's `finally` block actually ran and unregistered the
  dispatcher (Bug 16's diagnostic recipe relied on the OPPOSITE
  symptom; cancel does NOT exhibit the wedged-runner problem).

### What this validates

- The `dispatcher.send(INTERRUPT)` → runner-level `INTERRUPT`
  observation → graceful unwind → `finally`-block task_finals
  upsert race (cancel wins via `INSERT OR IGNORE` against the
  runner's `WHERE final_state != 'cancelled'` guard) all interlock
  correctly under a real Claude SDK call.
- C12+ Bug 18 (gate_queue + secret_gate_queue cleanup wrapped in
  one transaction) — gate_queue assertion was vacuous here (no
  rows existed) but path was exercised.
- C12+ Bug 52 (zod-validated cancel body) — exercised via
  `{reason, actor}` round-trip; `detail` field rendered correctly.

### Cost

Effectively $0 — Claude SDK was preempted before any meaningful
LLM work completed. Stage-attempt error had no recorded cost.

---

## Dogfood-8 — multi-target rollback runner test

### Why a unit test, not a real LLM run

The handoff-dogfood-6 untested-paths list includes
"Multi-target rollback (`reject: [a, b, c]`) — Bug 28's actual
scenario; only single-target was exercised here". The existing
`runner.reject-rollback.test.ts` covered single-target only; the
ESM pipeline registered in dogfood-3 has no multi-target reject
routes. Crafting a real LLM pipeline solely for a multi-target
test would burn LLM cost without exercising any code path beyond
what an in-process unit test already hits — the runtime contract
under test (compiler routes shape, runner rebuild, stage_attempts
lineage) is fully exercised by the in-memory runner harness used
by sibling tests in this file.

So I added the missing test directly in
`runner.reject-rollback.test.ts` rather than running another LLM
dogfood. This is the cheapest way to pin the contract for future
regressions.

### IR under test

```
A (agent, no inputs) -> outA
B (agent, no inputs) -> outB
G (gate, inputs: A.outA + B.outB; approve->final, reject->[A,B])
final (agent)
```

Both A and B are independent ancestors of G (validator's
"all-rollback OR all-forward" rule passes trivially because
both targets are ancestors). Reject answer triggers the
`rejectRollbackMap` path with `targetStages = ["A","B"]`,
`affectedStages = ["A","B","G"]`.

### Assertions

1. First pass: aCalls=1, bCalls=1, finalCalls=0; G opens at idx=1.
2. `dispatcher.send({ type: "GATE_REJECTED", targetStage: ["A","B"],
   affectedStages: ["A","B","G"] })` triggers rebuild.
3. SSE `stage_rolled_back` event published with the multi-target
   `affectedStages` set (no truncation to a single name).
4. After rebuild: aCalls=2, bCalls=2 — BOTH targets re-execute.
5. Second G opens with a different gate_id at idx=2.
6. `stage_attempts` has TWO `success/regular` rows for each of A
   and B (idx=1 from first pass + idx=2 from rerun). **Lineage is
   intentionally preserved** — `superseded` is reserved for hot-
   update migration, not reject-rollback (this is a deliberate
   design choice from handoff-dogfood-bug16.md and confirmed by
   reading runner.ts:840-972 which only supersedes fanout rows).
7. Both A and B have an attempt_idx=2 row in stage_attempts.
8. After second approve: finalCalls=1, run completes naturally.

### What this catches

- The runner's rollback path normalises `targetStage` to an array
  (the SSE event currently emits whatever `targetStage` value the
  dispatcher sent — string OR array). Future regressions that
  collapse multi-target to first-element-only will now break this
  test.
- Persistent state pruning honours the multi-target `affectedStages`
  set — this is what Bug 28 was about. If the prune iterated only
  the first element of `targetStages`, A would re-run but B's
  portValues would survive and B wouldn't get re-dispatched.
- Both targets get `gateAuthorizedTargets` re-cleared so neither
  short-circuits through the gate-skipped path on rebuild.

### What this did NOT catch

A misdiscovery I want to record: my first version of the test
asserted that A, B, G must have `status='superseded'` rows after
rebuild. That assertion failed with `expected undefined to be 1`,
which initially looked like a real Bug 28 runtime hole. **It is
not a hole** — runner.ts:840-972 deliberately leaves regular
`status='success'` rows in DB and only marks `kind IN
('fanout_element','fanout_aggregate')` rows superseded on the
rollback path. This matches the lineage-preservation invariant
documented in handoff-dogfood-bug16.md:

> "The old `topicFraming idx=1` and `framingGate idx=1` rows
>  stayed in DB at `status='success'` (lineage preserved; not
>  superseded — superseded is reserved for migration)."

The corrected test asserts the actual product contract: both
idx=1 and idx=2 are `success`; lineage is the union, not a
replacement.

---

## Cumulative

| Phase | Commits | Bugs |
|---|---|---|
| c12+ Waves 1-4 + Theme 1-3 + scattered (handoff-final) | 11 | 56 |
| Dogfood Bug 68 | 1 | 1 |
| P2 sweep (handoff-p2-sweep) | 26 | 18 |
| Fresh dogfood 2026-05-02 (handoff-dogfood-2026-05-02) | 3 | 3 |
| Dogfood-4 Bug 16 docs (handoff-dogfood-bug16) | 1 | 0 (doc) |
| Dogfood 5+6 Bug 16 fix (handoff-dogfood-6) | 2 | 1 |
| **Dogfood 7+8 cancel + multi-target rollback (this handoff)** | **2** | **0** |
| **Total** | **46** | **79** |

No new code bugs in this pass. Two new pieces of validation
infrastructure: cancel-during-LLM is now an exercised path, and
multi-target rollback has a regression test pinning runtime
behaviour.

---

## Final state

```
Branch: main, ~38 commits ahead of c12+ closure (ad5bba6)
Server tests: 250 files pass + 3 skipped, 2370 tests + 24 skipped
  (+1 from previous handoff — the new multi-target test)
Web tests: 13 pass, 61 tests
TSC: clean
Tasks ending in completed/natural: pipeline-generator (initial),
  dogfood-3 (validation), dogfood-6 (reject-rollback validation)
Tasks ending in cancelled/cancelled: dogfood-7 (cancel mid-run)
Generated pipeline: 08617d0a... still registered
```

---

## What's still untested

- `secret_pending` path (envKey-requiring MCPs)
- Hot-update migration (propose_pipeline_change + migrate_task)
- Real LLM-driven multi-target rollback dogfood (the IR contract
  is now pinned by a unit test; an end-to-end with an actual
  pipeline-generator-produced multi-target IR remains future work
  — pipeline-generator currently emits single-target reject routes
  exclusively, so this would also require teaching pipeline-generator
  to recognise scenarios where multiple ancestors should regenerate
  together)

These each remain on the dogfood-followup list, decoupled from the
runtime contracts pinned in dogfood 7+8. None are required for
the cancel + multi-target paths to ship.

---

## Recommended next step

**Stop and ship.** Cancel mid-run is verified against a real LLM
agent; multi-target rollback has a regression test that pins
runtime behaviour. The remaining untested paths (secret_pending,
hot-update) are scenario-heavy and benefit from purpose-built
pipelines rather than retrofitted dogfoods. They should each get
their own focused session.
