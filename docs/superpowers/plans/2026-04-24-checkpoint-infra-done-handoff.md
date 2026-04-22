# Checkpoint Infrastructure — Completion Handoff

**Date:** 2026-04-24
**Milestone:** Phase 4.5 Step 1
**Roadmap coverage:** §6.1 A1 field #7 (worktree diff)
**Branch:** main

## Milestone results

Landed as 9 task commits plus 4 in-flight plan/refinement commits
(listed in order). Task commits implement functionality; plan-fix
commits amend the plan file only; the `b050dd3` follow-up patched a
clean-tree edge case discovered during Task 5 integration runs.

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
| 9 | (this commit) | docs + handoff |

## What changed

**New:**
- `apps/server/src/kernel-next/runtime/checkpoint/` (5 files, ~700 LOC):
  `types.ts`, `git-commands.ts`, `checkpoint.ts`, `checkpoint.test.ts`,
  `checkpoint.integration.test.ts`
- `stage_checkpoints` table in kernel-next.db (Task 1 DDL)
- `checkpointConfig` input on MCP `run_pipeline` tool (snake_case at
  the wire; camelCase internally)

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
- Fanout per-element attempt checkpoints: captured but may produce
  many rows per fanout stage; future filter/sampling policy optional.

## Next step

**Phase 4.5 Step 2: Session memory infra (scratch pad + PreCompact
trigger capture)**. Completes A1 field #8, unlocks B12 (single-session
hot-update summary injection).
