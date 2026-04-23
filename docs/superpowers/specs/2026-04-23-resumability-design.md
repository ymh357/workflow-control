# Resumability — Design

> **Date**: 2026-04-23
> **Scope**: server restart / crash / graceful shutdown — every in-flight
> task survives, gates answer, SSE reconnects, agent SDK sessions resume
> where possible.

## 1. Problem

Workflow-control is a local, single-user product. One server process
serves one user. But server lifetime << task lifetime.

- Pipeline runs: minutes to hours (PG ~9 min, research tasks longer).
- Gate waits: arbitrary real time (human on/off the machine).
- Routine interruptions: dev iteration restarts, laptop sleep/power, OS
  update reboots, graceful `Ctrl+C`.

Today every one of those events kills the task. `task_finals` stays
`NULL`, the process-local `taskRegistry` empties, and the dashboard
hangs on a gate that nobody can answer.

Without resumability, M2 ("朋友持续用") is unreachable: a 10-minute
research task cannot survive a 5-second dev restart.

## 2. Scope

In:
- Stage-level resume: already-success stages keep their port values.
- Agent cost preservation via Claude Agent SDK `options.resume`.
- Gate persistence across restart (including the "answered but not yet
  forwarded to the machine" window).
- SSE reconnect with monotonic event ids and `Last-Event-ID`.
- Graceful SIGTERM/SIGINT → DB flush → resume on next boot.
- Single-server mutex via PID file.
- Existing hot-update migration `resumeFrom` path continues to work and
  takes priority when startup scan finds a pending migration.

Out (explicit non-goals):
- Multi-instance active-active (contradicts product positioning).
- Cross-machine resume.
- Byte-exact agent terminal output replay after reconnect (use SDK
  session resume to rebuild the conversation).
- Persisting full XState machine snapshots.
- WORM audit log (existing `hot_update_events` + `task_finals.reason`
  cover observability).

## 3. Architecture

Five components, each testable in isolation:

### 3.1 `orphanReconciler` — DB-side state cleanup

Runs once at startup, before HTTP routes mount.

```
input:  db, broadcaster, startPipelineRun
effect: identifies orphan tasks, reconciles stale stage_attempts rows,
        dispatches resume invocations
```

Algorithm:

1. Select `task_id` from `stage_attempts` WHERE `task_id` NOT IN
   (SELECT `task_id` FROM `task_finals`) — candidates.
2. For each candidate, inspect stage_attempts:
   - If every attempt is either `success` or a non-terminal kind already
     finalized elsewhere, and no pending reachable stage exists, this
     task is actually terminal but lost its `task_finals` write (WAL
     synchronous=NORMAL edge). Write `task_finals(state='completed',
     reason='natural', detail='recovered_no_finals_row')`. Skip resume.
   - Otherwise: UPDATE `stage_attempts` SET `status = 'superseded'`
     WHERE `task_id = ?` AND `status = 'running'`. Mirror into
     `agent_execution_details` SET `termination_reason = 'interrupted'`,
     `ended_at = <now>` WHERE `attempt_id` matches a superseded
     running attempt and `ended_at IS NULL`.
3. Look up the latest row in `hot_update_events` for this task. If its
   `started_at` is newer than the max `stage_attempts.started_at` and
   its `status = 'success'`, use its `rerun_from_stage` as `resumeFrom`.
   Otherwise `resumeFrom` = first non-success stage in the pipeline's
   wire-order traversal (deterministic).
4. Resolve the last agent attempt's `session_id` from
   `agent_execution_details` if the resume-from stage is an agent stage.
5. Call `startPipelineRun({ taskId, versionHash, resumeFrom,
   resumeSessionId })`. Do not block — startPipelineRun is fire-and-forget.
6. Emit a `orphan_resumed` structured log line with
   `{taskId, resumeFrom, reason, resumeSessionId?}`.

All candidates are resumed in parallel (local SDK + SQLite serialize
naturally — there is no thundering herd).

### 3.2 `gateAuthorizedHydration` — in-runner extension

Extends the existing `resumeFrom` hydration at `runner.ts:362-412`. On
`isRetryRebuild=true`:

- Already: hydrate `persistentFinalizedStages` from success attempts,
  `persistentPortValues` from port_values.
- New: query `gate_queue` WHERE `task_id = ?` AND `answered_at IS NOT
  NULL`. For each row:
  - Look up the gate stage in the IR.
  - Translate the stored `answer` via `gateStage.config.routing.routes`
    to the target stage(s).
  - Append to `persistentGateAuthorized`.
  - Also add the gate stage to `persistentFinalizedStages` with
    `outcome='done'` so the existing L1299 synthetic-answer loop
    fires.

Without this, the window "gate_queue.answer written, runner never
dispatched GATE_ANSWERED" loses the answer on resume.

### 3.3 SSE monotonic event ids

Wire change:

- `KernelNextSSEEvent` gains `seq: number` assigned at publish time by
  the broadcaster (per-task counter, starts at 1).
- `sse/http.ts` emits `id: <taskId>:<seq>` before every `data:` frame.
- Broadcaster keeps `nextSeq` per channel; ring buffer already keeps
  ordered events — we add `seq` on the event object, not a parallel
  index.
- HTTP handler honours `Last-Event-ID` header: on subscribe, skip
  history items with `seq <= lastSeq`; `controller.enqueue` only the
  newer subset + live.

Reconnection semantics:
- Event with `seq <= lastSeq` → dropped (already delivered).
- Gap between `lastSeq` and the oldest retained `seq` → client SHOULD
  call `GET /api/kernel/tasks/:id/state` for a DB snapshot of
  stage_attempts + port_values. Documented, not server-pushed. SSE does
  not guarantee replay for events older than the ring (~100).

### 3.4 `gracefulShutdown` — SIGTERM / SIGINT handler

```
1. Log "shutting down; N tasks in flight".
2. Stop accepting new HTTP requests. Return 503 for inbound.
3. For each taskId in taskRegistry:
     UPDATE stage_attempts
        SET status = 'superseded'
      WHERE task_id = ? AND status = 'running';
     UPDATE agent_execution_details
        SET termination_reason = 'interrupted', ended_at = <now>
      WHERE attempt_id IN (<superseded attempt_ids>) AND ended_at IS NULL;
4. Do NOT write task_finals — the task is not terminal.
5. db.close(); release PID file; exit 0.
```

The "don't write task_finals" is the contract the reconciler relies on.

### 3.5 `serverLock` — PID-file mutex

At startup, before any DB work:

- Path `{DATA_DIR}/kernel-next.lock`.
- Open with `O_CREAT | O_EXCL | O_WRONLY`; write current pid, fsync,
  close.
- If `EEXIST`: read existing pid, probe liveness with
  `process.kill(pid, 0)`. If alive → fail-fast with a clear error
  ("another server instance is running, pid=X"). If ESRCH → unlink and
  retry once.
- On graceful shutdown: unlink the lock.
- On crash: OS does not unlink the file; the next startup treats the
  stale pid as dead and takes over.

Not using `flock(2)` — unreliable on NFS. README gains a line stating
`DATA_DIR` must be local disk for correctness.

### 3.6 Claude Agent SDK session resume

`real-executor.ts` currently `import { query } from
"@anthropic-ai/claude-agent-sdk"` at module scope — untestable for
session-resume paths. Change:

- Constructor accepts an optional `queryFn` defaulting to the SDK's.
  Tests inject a stub that records `options.resume`.
- Resume flow when `runPipeline` is invoked with `resumeSessionId` for
  the given stage:
  - Pass `options.resume = resumeSessionId`.
  - Clamp `maxTurns` via
    `remainingTurns = Math.max(1, configuredMaxTurns - priorNumTurns)`.
    `priorNumTurns` = sum of `num_turns` values parsed from the prior
    `agent_stream_json` for this taskId+stage. (We store it, but only
    inside the stream JSON; the reader parses the last `result` message
    to extract it.)
  - Any SDK error during resume (session file missing, corrupt, SDK
    version mismatch) → log, fall back to a fresh session.

### 3.7 File touch list

| File | Change |
|---|---|
| `apps/server/src/index.ts` | install server lock before any DB work; call `orphanReconciler` after builtin seeding; register SIGTERM / SIGINT handlers |
| `apps/server/src/kernel-next/runtime/orphan-reconciler.ts` | **new** — pure function + DB scan |
| `apps/server/src/kernel-next/runtime/server-lock.ts` | **new** — PID file mutex |
| `apps/server/src/kernel-next/runtime/graceful-shutdown.ts` | **new** — SIGTERM handler |
| `apps/server/src/kernel-next/runtime/runner.ts` | extend resume hydration to read `gate_queue` answered rows |
| `apps/server/src/kernel-next/runtime/real-executor.ts` | accept injectable `queryFn`; wire `options.resume`; clamp maxTurns |
| `apps/server/src/kernel-next/sse/broadcaster.ts` | per-channel `nextSeq`; stamp each published event |
| `apps/server/src/kernel-next/sse/types.ts` | `KernelNextSSEEvent` gains `seq: number` |
| `apps/server/src/kernel-next/sse/http.ts` | emit `id:` line; honour `Last-Event-ID` header |

No DB migrations. Verified CHECK constraints (`sql.ts`):
- `stage_attempts.status` ∈ `('running','success','error','superseded')`.
  We reuse `superseded` for "runner was interrupted; this attempt is no
  longer live". Hot-update migrations already use this value; adding
  crash/shutdown is the same semantics at a higher scope. The
  `termination_reason` column distinguishes causes.
- `agent_execution_details.termination_reason` ∈
  `(NULL,'natural_completion','interrupted','error','superseded')`.
  Crash/shutdown path uses `'interrupted'`.

## 4. Failure modes

| Mode | Behavior |
|---|---|
| Agent session file deleted/corrupt | SDK errors → log → fresh session for that stage attempt |
| Missing `versionHash` (GC'd) | reconciler logs, writes `task_finals(state='failed', reason='error', detail='version_gc')` |
| Concurrent `answer_gate` during resume | The new runner's registration happens inside `startPipelineRun`. Before it completes, `answer_gate` returns the same "task not found in registry" it does today; the client retries. After registration, normal path. Gate's already-committed answer is hydrated via §3.2, so a stale answer is not lost. |
| `Last-Event-ID` beyond current seq | Client sent a stale id (e.g. from an older task). Replay entire history (treat as seq=0). |
| Many tasks crashed at once (100+) | Parallel `startPipelineRun` calls. Each opens a lazy dispatcher; they contend on SQLite writes but correctness is preserved. Acceptable for local single-user. |
| PID file on NFS | Documented: `DATA_DIR` must be local disk. |

## 5. Test strategy

- **Unit** (no real API): `orphanReconciler` against an in-memory
  SQLite fixture with hand-crafted rows; assert `startPipelineRun` is
  called with correct `resumeFrom` / `resumeSessionId`.
- **Unit**: `serverLock` — spawn two processes, second fails fast; fake
  stale PID takeover works.
- **Unit**: `gracefulShutdown` — in-flight rows transition to crashed;
  no `task_finals` written.
- **Unit**: SSE broadcaster — events gain monotonic `seq`; ring
  preserves order; `Last-Event-ID` filters correctly.
- **Integration**: runner resume with synthetic `gate_queue.answer` row
  → machine reaches `done` without re-asking.
- **Integration (mocked `queryFn`)**: RealStageExecutor passes
  `options.resume = sessionId` when `resumeSessionId` set; clamps
  maxTurns.
- **Adversarial**: resume with corrupt session id (SDK throws) →
  fallback branch covered.
- **Adversarial**: hot-update migration `rerun_from_stage` wins over
  `firstNonSuccess` when both apply.

No tests shell out to the real Claude API; the existing `MockStageExecutor`
pattern + the new `queryFn` injection cover every path.

## 6. Milestones

Each milestone ships independently and leaves the server working.

1. **M-R1** — server lock + graceful SIGTERM shutdown (no reconciler
   yet; running tasks die cleanly, DB is consistent). Commits: ~3.
2. **M-R2** — orphanReconciler: scan, reconcile stale rows, dispatch
   resumes. Does not touch gate hydration. Manual test: start PG, kill
   server mid-analyzing, restart, confirm resume. Commits: ~4.
3. **M-R3** — runner gate-queue hydration extension. Integration tests
   for the window. Commits: ~2.
4. **M-R4** — SSE monotonic seq + `Last-Event-ID`. Tests for
   broadcaster + http layer. Commits: ~3.
5. **M-R5** — Claude Agent SDK `options.resume` + queryFn injection +
   maxTurns clamp. Commits: ~3.
6. **M-R6** — hot-update integration: reconciler honours
   `hot_update_events.rerun_from_stage`. Commits: ~2.
7. **M-R7** — smoke on real API: dogfood run that crashes mid-stage
   and observes real resume (counts as M1 data point + validates M-R5).
   Commits: ~1 (docs).

Total estimate: ~18 commits across ~2.5-3 weeks (assuming autonomous
execution with TDD discipline).

## 7. Decision log

| Decision | Rationale |
|---|---|
| No `resume_events` table | Structured log + `hot_update_events` + `task_finals.reason` cover audit. Adding a table is overfit. |
| PID file, not flock | NFS reliability. |
| Parallel resume on startup, not sequential | Local SQLite + SDK serialize naturally. 500ms stagger was theater. |
| Don't persist XState snapshot | Too invasive; stage-level resume is sufficient because port_values is the actual state machine's external state. |
| Store seq on the event object (not a parallel index) | Keeps broadcaster one-data-structure. Cost is 8 bytes/event. |
| Reuse `status='superseded'` | Hot-update supersede already uses this value; crash/shutdown is the same "this attempt is no longer live" semantics at a different trigger. `termination_reason='interrupted'` distinguishes cause from hot-update's `'superseded'` reason. No schema migration. |
| Clamp maxTurns, not subtract | SDK reset turns on resume can emit its own system turns; subtraction can go negative. Clamp at 1. |
