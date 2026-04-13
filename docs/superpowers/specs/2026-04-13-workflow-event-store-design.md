# Phase 1 Improvement: Workflow Event Log + Stage Git Checkpoint

> Date: 2026-04-13
> Origin: competitive-analysis-driven improvements (LangGraph checkpoint model, Temporal event sourcing)

Split into two independent specs after self-review identified scope creep in original design.

---

## Spec A: Workflow Event Log

### Problem

`executionHistory` only records stage completion/skip. Gate approvals, retries, store writes, errors are not persisted. Diagnosing pipeline failures requires reading SSE logs which are session-bound and not queryable.

### Solution

Append-only JSONL event log per task, written from side-effects handlers. Zero changes to the state machine core.

```
{dataDir}/tasks/{taskId}.json              # existing snapshot (unchanged)
{dataDir}/tasks/{taskId}/
  events.jsonl                              # NEW: append-only decision log
```

### Event Types

```typescript
interface WorkflowEvent {
  id: number;                    // monotonic, 1-indexed
  ts: string;                    // ISO 8601
  type: WorkflowEventType;
  stage?: string;
  payload?: Record<string, unknown>;
}

type WorkflowEventType =
  | 'stage_started'
  | 'stage_completed'
  | 'stage_failed'
  | 'stage_skipped'
  | 'retry'
  | 'retry_from'
  | 'gate_approved'
  | 'gate_rejected'
  | 'gate_feedback'
  | 'store_write'               // key names + byte sizes only, not values
  | 'cost_update'
  | 'task_interrupted'
  | 'task_cancelled';
```

### Write Strategy

All writes are async (non-blocking). Rationale: the event log is an audit tool, not a recovery mechanism. The existing snapshot remains the sole recovery path. Sync I/O for gate pre-write was considered and rejected -- the crash window in single-process XState is too small to justify the latency cost.

### Integration Point

Events are written in `side-effects.ts` handlers, NOT in state-builders.ts. This keeps the state machine logic untouched:

- `wf.status` handler: append `stage_started` (when status contains a stage name) or `stage_completed`/`stage_failed` (based on status value)
- `wf.costUpdate` handler: append `cost_update`
- `wf.slackGate` handler: append `gate_approved`/`gate_rejected`/`gate_feedback` (derive from the status transition that triggered the event)
- `wf.error` handler: append `stage_failed`

Event ID is a counter stored in memory per task, initialized from the last line of events.jsonl on first write (or 0 if file doesn't exist).

### Files to Modify

| File | Change | Risk |
|------|--------|------|
| `apps/server/src/machine/persistence.ts` | Add `appendEvent(taskId, event)`, `loadEvents(taskId)` | None (new functions only) |
| `apps/server/src/machine/types.ts` | Add `WorkflowEvent`, `WorkflowEventType` types | None (new types only) |
| `apps/server/src/machine/side-effects.ts` | In existing handlers, append corresponding events | Low (additive, async, no logic change) |
| `apps/server/src/routes/tasks.ts` | Add `GET /tasks/:id/events` | None (new endpoint) |

### Edge Cases

- **File doesn't exist**: created lazily on first `appendEvent` call
- **Existing tasks**: no events/ directory, `loadEvents` returns `[]`
- **Sub-pipelines/foreach**: child tasks get their own events.jsonl (keyed by childTaskId)
- **Disk**: ~100 bytes per event, 10-stage pipeline with retries = ~2KB total

### Success Criteria

1. `GET /tasks/:id/events` returns a complete timeline of decisions for any task
2. Zero performance impact (async writes, no state machine changes)
3. Existing pipelines work identically with or without the events directory

---

## Spec B: Stage Git Checkpoint + Compensation

### Problem

When a stage modifies code in the worktree and then fails, the code changes remain. There is no automatic way to restore the worktree to pre-stage state. Manual `git reset` is error-prone and requires knowing the correct commit.

### Solution

Record git HEAD at stage entry. On failure, optionally reset to that commit.

### Design

**1. Populate stageCheckpoints on stage entry**

The existing `stageCheckpoints?: Record<string, unknown>` field in WorkflowContext is currently unused. Write to it in each stage builder's entry action:

```typescript
interface StageMeta {
  gitHead?: string;        // git rev-parse HEAD at stage start
  startedAt: string;       // ISO timestamp
}
```

`gitHead` is best-effort: if worktreePath is unset or git fails, the field is omitted. The `execSync` call is wrapped in try/catch and runs in the stage entry action (which already does sync work like status emission).

**2. Compensation config in YAML**

```yaml
stages:
  - name: execute
    type: agent
    compensation:
      strategy: git_reset    # git_reset | git_stash | none (default)
```

**3. Compensation execution in error handler**

In `handleStageError`, when transitioning to the block state, if the stage has `compensation.strategy`:
- `git_reset`: `execSync('git reset --hard {gitHead}', { cwd: worktreePath })`
- `git_stash`: `execSync('git stash', { cwd: worktreePath })`

Best-effort: git failure is logged but doesn't prevent the block transition.

**4. RETRY_FROM enhancement**

When `RETRY_FROM` targets a stage with compensation configured, run the compensation before entering the stage. This ensures the worktree is clean before retry.

### Files to Modify

| File | Change | Risk |
|------|--------|------|
| `apps/server/src/machine/state-builders.ts` | All stage builders: entry action writes StageMeta to stageCheckpoints | Low (one assign action added per builder) |
| `apps/server/src/machine/helpers.ts` | `handleStageError` block path: run compensation | Low (additive action in existing transition) |
| `apps/server/src/machine/machine.ts` | RETRY_FROM handler: run compensation before entering stage | Low (additive action) |
| `packages/shared/src/types.ts` | `StageConfig.compensation` field | None (new field) |
| `packages/shared/src/pipeline-validator.ts` | Validate compensation.strategy values | None (new validation) |

### Edge Cases

- **No worktree**: stages without worktreePath skip gitHead recording and compensation
- **Foreach items**: each item's worktree has its own gitHead. Compensation applies per-item worktree.
- **Parallel groups**: each child stage records its own gitHead independently
- **git_reset after partial commits**: if the agent made multiple commits, reset goes back to the pre-stage HEAD, undoing all of them
- **Compensation + manual intervention**: if user manually fixed code before retrying, compensation would undo their fix. Document that compensation runs automatically -- users should use `compensation: none` if they want manual control.

### Success Criteria

1. Stage failure with `compensation: git_reset` leaves the worktree at the exact commit from before the stage started
2. `RETRY_FROM` with compensation configured starts with a clean worktree
3. Stages without compensation configured behave identically to current behavior
4. git command failures are logged but never block the error handling flow

---

## Implementation Order

1. **Spec A first** (Workflow Event Log) -- zero risk, pure additive, 4 files
2. **Spec B second** (Git Checkpoint + Compensation) -- low risk, 5 files, depends on understanding gained from Spec A
