# Dogfood 9+10 — secret_pending validated, hot-update Bug 80 found+fixed

**Date**: 2026-05-03 (continuing from `handoff-dogfood-7-8.md`)
**Branch**: main
**Predecessor**: handoff-dogfood-7-8.md (cancel + multi-target rollback closed)
**Outcome**: dogfood-9 validated the secret_pending path end-to-end on
a real envKey-requiring pipeline. dogfood-10 surfaced **Bug 80** —
hot-update migration timed out on a task idle at a human gate. Root-
caused, fixed, two regression tests added.

---

## Dogfood-9 — secret_pending path

### Setup

The registered `d4-envkey-probe-v2` pipeline declares one agent stage
(`queryEthBalance`) using an `etherscan` MCP server with
`envKeys: ["ETHERSCAN_API_KEY"]`. Launched a task without `envValues`
and traced both halves of the path.

### Path A — pre-flight surface

```
POST /api/kernel/tasks/run { name, versionHash, seedValues }
  (no envValues)

→ 202 { ok, taskId, versionHash,
        missingEnvKeys: ["ETHERSCAN_API_KEY"],
        hint: "POST /api/kernel/tasks/.../secrets ..." }
```

The pre-flight scan in `startPipelineRun` correctly surfaced the
missing key + an actionable hint pointing to both the HTTP and MCP
remediation paths. C10 Bug F2 (the missingEnvKeys+hint plumbing)
worked end-to-end.

### Path B — runtime gate

```
GET  /api/kernel/tasks/:id/status
→ { status: "secret_pending",
    pending: [{
      secretGateId, stageName: "queryEthBalance",
      requiredKeys: ["ETHERSCAN_API_KEY"],
      stillMissing:  ["ETHERSCAN_API_KEY"],
      createdAt
    }] }

GET /api/kernel/tasks/:id/attempts
→ { attempts: [
    { stage_name: "queryEthBalance", status: "secret_pending",
      attempt_idx: 1, kind: "regular" }
  ] }
```

The stage entered `status='secret_pending'` (the special CHECK
constraint state from F17), and `secret_gate_queue` carried a row
with `requiredKeys` matching the IR's declared `envKeys`. Dashboard
consumers can render this directly.

### Path B resolution

```
POST /api/kernel/tasks/:id/secrets
  { "secrets": { "ETHERSCAN_API_KEY": "FAKE_TEST_KEY" } }
→ { ok: true, resolved: true }

GET /api/kernel/tasks/:id/status (immediate)
→ { status: "running" }

GET /api/kernel/tasks/:id/attempts (5s later)
→ { attempts: [
    { stage_name: "queryEthBalance", status: "secret_pending",
      attempt_idx: 1, dur: 43ms },
    { stage_name: "queryEthBalance", status: "running",
      attempt_idx: 2, dur: <running> }
  ] }
```

Resolution semantics confirmed:

- POST /secrets returns immediately, runner unblocks within seconds.
- The original `secret_pending` attempt is preserved as lineage
  (idx=1, dur 43ms — the time spent detecting MCP_ENV_MISSING).
- A fresh attempt (idx=2) opens with the secret available.

The same lineage-preservation invariant we documented for reject-
rollback applies here.

### Final state

After Claude finished (etherscan returned an invalid-key error which
the agent reported back as its output):

```
task_finals: completed/natural
secret_gate_queue.resolved_at = <ms-since-secrets-POST>
task_env_values: 0 rows  ← P3.6 cleanup contract: plaintext keys
                          must never outlive the task
```

P3.6 honoured: the `ETHERSCAN_API_KEY` we provided was deleted from
`task_env_values` when the task ended. No plaintext token outlived
the task.

### Run cost

| Metric | Value |
|---|---|
| Wall time | ~50s including 5s pre-flight + 43s LLM call |
| Anthropic spend | <$0.10 (single agent stage) |
| Bugs found | 0 |

---

## Dogfood-10 — hot-update migration

### Bug 80: migrate timed out on a gated task

**Repro**: launch ESM pipeline (`08617d0a...`), let task reach
`framingGate` (gated). `POST /api/kernel/proposals` with a prompts-
only change (autoApprove + migrateRunningTasks: "all", baseVersion
matching the running task's version). `POST /api/kernel/tasks/:id/migrate`.

**Symptom**:
```
{ ok: false,
  diagnostics: [{
    code: "MIGRATION_INTERRUPT_TIMEOUT",
    message: "runner ... did not terminate within 30000ms after INTERRUPT"
  }] }
```

Wall time: 30 seconds (full INTERRUPT_WAIT_MS budget).

`hot_update_events` audit row: `failed/INTERRUPT_TIMEOUT, interruptWaitMs=30002`.

Repro is 100% reliable on any task whose only running attempt is a
gate stage.

### Root cause

Two facts collide:

1. A gate stage's attempt sits at `status='running'` in
   `stage_attempts` for its entire human-deliberation window. The
   runner uses this state to differentiate "open gate" from
   "answered gate" (success) or "rejected gate" (used to be
   superseded; now lineage-preserved per dogfood-8).
2. The compiler's gate region (`ir-to-machine.ts:878-898`) only
   registers `GATE_ANSWERED` on `executing.on`. There is **no
   `INTERRUPT` handler** because gate.executing has no executor
   running — it's idle by design, waiting on an external event.

Migration-orchestrator (line 134-143 pre-fix):

```ts
if (isRunning) {
  dispatcher.send({ type: "INTERRUPT" });
  const awaited = await taskRegistry.awaitTermination(taskId, 30_000);
  if (awaited.kind === "never_started") return MIGRATION_INTERRUPT_TIMEOUT;
}
```

The INTERRUPT delivered to a gate.executing actor is silently no-op
(XState v5 ignores events without matching `on:` handlers). The
runner never signals termination because the gate is correctly
waiting for a human. After 30s, awaitTermination returns
`never_started` and migration fails.

### Fix

Detect the gate-only case before issuing INTERRUPT:

```ts
let hasNonGateRunningAttempt = false;
if (isRunning) {
  const fromIR = loadIR(db, fromVersion);
  const gateStageNames = new Set(
    fromIR
      ? fromIR.stages.filter((s) => s.type === "gate").map((s) => s.name)
      : []
  );
  const runningRows = db.prepare(
    `SELECT stage_name FROM stage_attempts
     WHERE task_id = ? AND status = 'running'`
  ).all(taskId);
  hasNonGateRunningAttempt = runningRows.some(
    (r) => !gateStageNames.has(r.stage_name)
  );
}

if (isRunning && hasNonGateRunningAttempt) {
  // ... existing INTERRUPT + awaitTermination path
}
```

Migration's correctness rests on the supersede TX downstream of this
check. INTERRUPT is purely an optimisation to stop in-flight
executors before their writes become stale; gate attempts aren't
writing anything that needs stopping. The fix scopes the optimisation
to where it's actually needed.

### Validation

After fix (commit e51218b):

```
POST /migrate (same proposal + same gated task)
→ { ok: true, eventId, supersededStages: [], rerunFrom: null }
wall time: 0s

hot_update_events: success, dur_ms=1, supersedeSet=[],
  resumeFromStage=null, interruptWaitMs<50
```

The original `prompts-only` proposal had `rerunFrom: null`, so the
correct migration outcome is exactly what we now get: audit success,
no resume, task continues on V1 until cancelled or completed (the
prompts change applies only to new task submissions on V2 — designed
behaviour, see migration-orchestrator.ts:377-392).

### Regression tests

Two new tests added in `migration-orchestrator.test.ts`:

1. **idle-at-gate skips INTERRUPT**: builds a 3-stage IR
   (A→G→B), seeds A=success + G=running, registers a dispatcher
   that swallows INTERRUPT. Migration must complete in <50ms
   without ever dispatching INTERRUPT.
2. **mixed running still issues INTERRUPT**: same IR but seeds
   A=running AND G=running. Migration must NOT skip the wait
   (since A is a real executor); the dispatcher's swallowing
   INTERRUPT means the test correctly reaches
   MIGRATION_INTERRUPT_TIMEOUT, proving the guard is correctly
   scoped.

The second test is critical: the fix relaxes the orchestrator's
assumptions, and we want a regression to catch any future
over-relaxation.

### Cumulative delta

| Phase | Commits | Bugs |
|---|---|---|
| All prior (handoff-dogfood-7-8) | 44 | 79 |
| **Dogfood 9+10 (this handoff)** | **2** | **1** |
| **Total** | **46** | **80** |

---

## What's still untested

After this pass, three of the four originally-listed paths are now
exercised end-to-end on real pipelines:

- ✅ cancel_task mid-run (dogfood-7)
- ✅ multi-target rollback (dogfood-8 unit test)
- ✅ secret_pending (dogfood-9)
- ✅ hot-update migration (dogfood-10, found Bug 80)

Remaining:

- **Real-LLM multi-target rollback dogfood**: dogfood-8 pinned the
  runtime contract at unit-test level. An end-to-end with a
  pipeline-generator-emitted multi-target IR would also need teaching
  pipeline-generator to recognise multi-ancestor regeneration
  scenarios. Decoupled future work.
- **Hot-update with rerunFrom + active fanout** (B17 path): the unit
  tests cover this, but the dogfood path with a real running fanout
  + propose+migrate hasn't been exercised.
- **Hot-update reverse-supersede** (resume failure path): unit-test
  covered, no dogfood.

These each need scenario-specific setup; none are blockers for
shipping the c12+ → dogfood-10 chain.

---

## Final state

```
Branch: main, ~40 commits ahead of c12+ closure (ad5bba6)
Server tests: 250 files pass + 3 skipped, 2372 tests + 24 skipped
  (+2 from previous handoff: the two Bug 80 regression tests)
Web tests: 13 pass, 61 tests
TSC: clean
Tasks ending in completed/natural: pipeline-generator (initial),
  dogfood-3, dogfood-6, dogfood-9
Tasks ending in cancelled/cancelled: dogfood-7, dogfood-10 (cleanup)
Generated pipeline: 08617d0a... still registered, plus
  d4-envkey-probe-v2 (8988056748...)
```

---

## Recommended next step

**Stop and ship.** Three of the four originally-untested paths now
run end-to-end on real pipelines; multi-target rollback has a
runner-level unit test pinning its contract. Bug 80 was real and
common (anyone trying to do a hot-update on a task waiting at a gate
would have hit it), now found and fixed.

The remaining gaps are scenario-heavy and benefit from purpose-built
pipelines — they should each get their own focused session rather
than being retrofitted onto general dogfoods.
