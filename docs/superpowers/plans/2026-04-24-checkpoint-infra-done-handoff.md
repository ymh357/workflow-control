# Checkpoint Infrastructure — Completion Handoff

**Date:** 2026-04-24
**Milestone:** Phase 4.5 Step 1
**Roadmap coverage:** §6.1 A1 field #7 (worktree diff)
**Branch:** main

## Milestone results

Landed as 9 task commits plus 4 plan-refinement commits, 1 clean-tree
follow-up, and 2 final-review follow-ups (I1 / I2). Task commits
implement functionality; plan-fix commits amend the plan file only.

| Task | SHA | Subject |
|---|---|---|
| 1 | `220010f` | stage_checkpoints DDL + FK + status CHECK |
| 2 | `d6d2ea4` | types module — status enum + config + row shape |
| 2.5 | `0612ec9` | rename stashCreateMs -> snapshotMs; switch spec/types to scratch-index snapshot |
| 3 | `4306f97` | git-commands over spawnWithTimeout (snapshotWorkTree + gitDiff + ...) |
| plan fix | `75a991a` | plan-only: Task 3 uses scratch-index snapshotWorkTree |
| 4 | `57f1b18` | captureBefore / captureAfter with DI + never-throw |
| 5 | `058b12c` | integration tests with real tmp git repos (5 cases) |
| 6 | `5761ab1` | PortRuntime AttemptHooks |
| plan fix | `f08cdcc` | plan-only: Task 7 uses diamondIR helpers |
| 7 | `a091cf0` | runner.checkpointConfig — wire hooks + drain on teardown |
| clean-tree fix | `b050dd3` | snapshotWorkTree short-circuits on clean tree |
| plan fix | `293b798` | plan-only: Task 8 uses existing run-pipeline test pattern + camelCase |
| 8 | `a19a682` | mcp run_pipeline accepts checkpointConfig |
| 9 | `243f9ab` | docs + handoff (initial) |
| review fix (I2) | `eae057b` | default enabled=false when workdir is not explicit |
| review fix (I1) | `96064d2` | suppressHooks for synthetic + gate attempts |

## What changed

**New:**
- `apps/server/src/kernel-next/runtime/checkpoint/` (5 files, ~700 LOC):
  `types.ts`, `git-commands.ts`, `checkpoint.ts`, `checkpoint.test.ts`,
  `checkpoint.integration.test.ts`
- `stage_checkpoints` table in kernel-next.db (Task 1 DDL)
- `checkpointConfig` input on MCP `run_pipeline` tool (camelCase,
  consistent with the existing tool's other optional fields)

**Modified:**
- `PortRuntime` constructor gains 5th optional arg (`AttemptHooks`)
- `RunnerOptions` + `StartPipelineRunInput` gain `checkpointConfig`
- `runPipeline` awaits `Promise.allSettled(checkpointInFlight)` before
  task teardown so `after` SHAs land before `run_final`

**Deleted:** none.

## Design notes (post-implementation)

- **Snapshot mechanism.** `snapshotWorkTree` uses the scratch-index
  pattern (`read-tree HEAD` + `add -A` + `write-tree` + `commit-tree`
  under `GIT_INDEX_FILE=<tmp>`), NOT `git stash create -u`. The
  currently shipped git's `stash create` does not honour `-u`, so
  untracked files would be missed. Scratch-index avoids mutating any
  ref and captures untracked.
- **Clean-tree short-circuit.** When the scratch tree equals
  `HEAD^{tree}` (no changes), `snapshotWorkTree` returns empty stdout
  and `resolveSha` falls back to `rev-parse HEAD` for a stable ref —
  keeps `before_sha` / `after_sha` meaningful even when a stage
  touches nothing.
- **Fire-and-forget.** Capture is scheduled from `onAttemptStarted` /
  `onAttemptFinishing` hooks and never blocks the stage. All errors
  land in the `diagnostic` column or `logger.warn`; a checkpoint
  failure never fails a stage (hard invariant).
- **Drain on teardown.** The runner awaits in-flight capture promises
  via `Promise.allSettled` before emitting `run_final`, so tests (and
  B9 consumers) see stable DB state.

## Review fixes (post-Task-9)

Milestone-level code review surfaced two integration-scale issues
that per-task reviews individually missed. Both were fixed before
closing the milestone:

- **I1 — dangling `capturing` rows for synthetic + gate attempts.**
  The `__external__` seed attempt and `fanout_aggregate` attempt open
  and close synchronously; between them, `captureBefore`'s async
  INSERT landed too late for `captureAfter` to observe, leaving rows
  stuck at `status='capturing'`. Gate attempts were worse: they are
  finalised via raw SQL in `KernelService.answerGate`, bypassing
  `finishAttempt` entirely, so `onAttemptFinishing` never fires for
  them. **Fix:** `StartAttemptArgs.suppressHooks?: boolean`. The three
  synthetic callers opt into suppression so no checkpoint row is ever
  inserted for them — `captureAfter`'s existing "missing row → no-op"
  guard handles the rest cleanly.

- **I2 — `process.cwd()` fallback is the wrong default.** Silently
  falling back to the server's cwd captures the server repo's state,
  not the agent's subject repo. **Fix:** `resolveCheckpointConfig`
  defaults `enabled: true` only when `workdir` is explicitly provided;
  otherwise defaults to `false`. Callers that want checkpointing must
  tell the runner where to capture from.

Both fixes have dedicated regression tests (`port-runtime.test.ts`
`"suppressHooks=true skips onAttemptStarted..."`, `checkpoint.test.ts`
`resolveCheckpointConfig` block).

## Invariants preserved

- Server `tsc --noEmit`: 0 errors.
- Server `vitest run`: 0 failures.
- Checkpoint failures never fail a stage (every path swallows).
- Existing `agent_execution_details` surface unchanged.
- Existing runner lifecycle timings unchanged (hooks are
  fire-and-forget; only teardown waits).

## Out of scope / follow-ups

- B9 (Phase 5C): "git reset to before_sha + write old diff to
  StageMemory" — reads this table, no schema change.
- A4 `replay_stage` tool — uses `before_sha` via
  `git worktree add <tmp> <sha>`.
- `workflow prune-checkpoints` CLI — pending Step 3 prune rebuild.
- Fanout per-element attempts: run through a silent `PortRuntime`
  constructed without hooks, so they already produce no checkpoint
  rows (by design — element attempts are orchestration internals,
  not observable work). If per-element capture is wanted in future,
  wire hooks into the silent runtime and remove `suppressHooks` on
  the aggregate.
- Migration supersede / rollback paths (`migration-orchestrator.ts`)
  mark running attempts `superseded` via raw SQL and leave any
  open checkpoint row at `status='capturing'`. That row is a
  legitimate "interrupted mid-flight" marker and matches spec §3's
  hard-crash semantics; query tools should treat `capturing` as
  "incomplete" regardless of cause.

## Next step

**Phase 4.5 Step 2: Session memory infra (scratch pad + PreCompact
trigger capture)**. Completes A1 field #8, unlocks B12 (single-session
hot-update summary injection).
