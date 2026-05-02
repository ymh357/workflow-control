# Dogfood-4 — Gate Rejection Path Bug 16

**Date**: 2026-05-02 (continuing from `handoff-dogfood-2026-05-02.md`)
**Branch**: main
**Predecessor**: 3 dogfoods + Bug 13/14/15 closed
**Goal**: validate gate-rejection rollback (untested by previous dogfoods)
**Outcome**: validated rollback semantics work correctly, **discovered Bug 16** — gate-rejection-then-approve leaves the runner wedged

This pass partially validated the rollback path AND surfaced a real
bug that none of the 78 prior fixes caught.

---

## What was validated (works correctly)

Reject path semantics are sound:
1. POST `/api/kernel/gates/:gateId/answer` with `{answer: "reject", comment: "..."}` accepted
2. Response: `{ok:true, kind:"rejected", targetStage:"topicFraming", affectedStages:[...]}` — includes 20 stage names (every transitive downstream of topicFraming)
3. `__gate_feedback__` port written on `framingGate` with the comment text (321 bytes)
4. `topicFraming` opened a fresh `attempt_idx=2`
5. New topicFraming agent ran with the rejection feedback **and incorporated the feedback** into its output:
   - idx=1 axes (without feedback): `package-exports-design`, `esm-to-cjs-require-semantics`, `node22-require-esm-flag-compatibility`, `typescript-dev-runner-selection`, `dual-package-hazard`, `conditional-exports-patterns`
   - idx=2 axes (with feedback explicitly asking for tooling-resolver-divergence + node 22 require-esm timeline): `tooling-resolver-divergence` ✓, `require-esm-compatibility-timeline` ✓, `exports-map-configuration`, `esm-requires-cjs-behavior`, `dev-runner-feature-comparison`, `monorepo-dual-package-hazard`
6. `framingGate` opened with `attempt_idx=2`, fresh `gate_queue` row, awaiting the second answer
7. The old `topicFraming idx=1` and `framingGate idx=1` rows stayed in DB at `status='success'` (lineage preserved; not superseded — superseded is reserved for migration).

**Conclusion**: Bug 28 (multi-target rollback), c12+ Theme 1 superseded/terminal guards, gate_queue cleanup (Theme 2 transactions), and the prompt-feedback-loop wire (`__gate_feedback__` → upstream input) all work correctly under the rollback path.

---

## Bug 16 — wedged runner after gate-rejection-then-approve

**Symptom**: After rejecting `framingGate idx=1`, retrying topicFraming, and **approving** `framingGate idx=2`, the runner never advances. No `prereqExtraction` stage_attempt opens. The actor sits in framingGate `executing` substate (or transitions silently somewhere else) without making progress.

**Repro state captured**:
```
__external__       success idx=1 dur=2ms
topicFraming       success idx=1 dur=65007ms     (initial)
framingGate        success idx=1 dur=115517ms    (rejected after 116s wait)
topicFraming       success idx=2 dur=43879ms     (re-ran with rejection feedback — correct)
framingGate        success idx=2 dur=155602ms    (approved — but runner did not advance)
                   ^ ended_at=1777727973356, no further attempts opened
```

After 60s of no heartbeat, status flips from `gated` to `orphaned`. But the server is **not** down (pid 76229 still listening on 3001, never restarted).

`POST /api/kernel/tasks/:id/retry` with `{fromStage:"framingGate"}` responds:
```json
{"ok":false,"diagnostics":[{"code":"MIGRATION_INTERRUPT_TIMEOUT",
  "message":"runner for task '...' did not terminate within 30000ms after INTERRUPT"}]}
```

This proves the runner IS alive (taskRegistry has its dispatcher; INTERRUPT was forwarded; the actor refused to terminate within 30s). So the actor is wedged in some state from which INTERRUPT also doesn't make it transition.

**Likely root cause area**:

The flow on second gate answer should be:
1. `kernel.answerGate(gateId, "approve")` updates DB ✓ (verified — gate_queue.answered_at is set)
2. `answer_gate` MCP handler dispatches `GATE_ANSWERED` to taskRegistry's dispatcher
3. Dispatcher forwards to `currentActor.send(...)` — should not throw (verified — no error response from approve)
4. Gate region's `executing.on.GATE_ANSWERED` transition fires (`gateAnsweredIsMe` matches: `event.stageName === "framingGate"`) → goes to `done`, runs `applyGateAnsweredContextAssign` action which adds `prereqExtraction` to `context.gateAuthorizedTargets`
5. `prereqExtraction` region is in `waiting` and its `on.GATE_ANSWERED` handler fires; the `target: "executing"` transition guard checks `event.targetStage === "prereqExtraction"` AND all inbound wires deliver. If both true → executing. Inbound wires are 3 ports from topicFraming all written by idx=2 with values in context.portValues.

Possible failure points:
- (a) The actor was stopped at some earlier point and `currentActor.send()` is silently going to a dead actor (XState v5 sends to a stopped actor are no-ops, no throw).
- (b) The rebuilt actor's PORT_WRITTEN handlers for topicFraming idx=2's writes did not update context.portValues for some reason — e.g. the port-write coming through the runner's PORT_WRITTEN dispatch races with the actor lifecycle.
- (c) The framingGate region's `executing.on.GATE_ANSWERED` ran but its target `done` is somehow blocked (unlikely — done is final).
- (d) The runner's outer-loop wait for actor completion / verdict has dual semantics for "rebuilt actor's gate answered" vs "first-attempt gate answered" that differ.

**Next-session repro recipe**:
1. Start fresh, recreate dogfood-2-payload-v2.json invocation against `08617d0a...` versionHash.
2. Reject framingGate with any comment.
3. Wait for topicFraming idx=2 success.
4. Approve framingGate idx=2.
5. Add server-side instrumentation to log every `dispatcher.send()` invocation (taskId, event.type, currentActor.getSnapshot().value if alive). The log should show whether GATE_ANSWERED was forwarded to a live actor or a stopped one.
6. Also instrument `actor.send()` failures via `try/catch` reporting.

**Alternate hypothesis**: the bug is in the rebuilt actor's `currentActor` reference. The closure at runtime is `let currentActor: Actor | null` (runner.ts:240) and the dispatcher.send forwards to `currentActor`. Each new attempt creates a new actor and assigns `currentActor = actor` (line 1662). On rebuild after rollback, the actor.start() and `currentActor =` assignment happen. **But maybe the rejected attempt's `runOneAttempt.finally` runs `currentActor.stop()` in the OLD `runOneAttempt` invocation between the new actor creation and the dispatcher's next forward**. That would set currentActor to a stopped actor right when an event was about to be dispatched.

Look at runner.ts:2086:
```ts
}).finally(() => {
  rejectHandler = null;
  if (currentActor) {
    try { currentActor.stop(); } catch { /* ignore */ }
  }
});
```

If `currentActor` here points to the NEW actor (because the new attempt already started), this `.finally` from the old attempt would stop the NEW one. There's a sequencing bug here.

This is the most likely culprit.

---

## State at end of dogfood-4

```
Branch: main, 33 commits ahead of c12+ closure (ad5bba6) — no new commits during this dogfood, NO CODE EDITS during run
Server: pid 76229, alive since 10:46AM, never restarted during this run
DB: dogfood-4 task in 'orphaned' status, no task_finals row
Test suites: not re-run since last handoff (still 250/3 + 2369/24 server, 13/61 web)
TSC: still clean
```

---

## Recommended next step

**Stop now**, write up Bug 16 as a known issue in the codebase review,
and move on rather than burn another LLM-cost cycle without instrumentation.
The repro is captured (DB rows + behavior), the hypothesis is concrete
(currentActor.stop() in old attempt's finally killing new attempt's actor),
and the fix is likely a small one once the path is confirmed:
- Either capture `thisActor` in the .finally closure and only stop the
  per-attempt actor (not the shared `currentActor` reference).
- Or guard `currentActor.stop()` with a check that this finally's
  attempt's actor matches `currentActor`.

Future dogfood paths still untested:
- secret_pending (any pipeline that needs an env-keyed MCP)
- cancel_task mid-run (POST /cancel during a long-running stage)
- hot-update migration (propose_pipeline_change + migrate_task on a running task)

These three are independent of Bug 16 and could be tested next.
