# Stage 6 — Execution Record Sidecar — Completion Handoff

Date: 2026-04-24
Branch: main

## Milestone results

7 sequential commits (6 plan tasks + 1 zombie CLI follow-up):

| Task | SHA | Subject |
|---|---|---|
| 1 | `dadf286` | agent_execution_details DDL |
| 2 | `c7bfa41` | execution-record-writer module |
| 3 | `c73b98e` | RealStageExecutor integration |
| 4 | `4f7ee82` | debug-queries migrated to kernel-next |
| 5 | `3a50333` | delete legacy lib/execution-record/ + execution_records DDL |
| 5 follow-up | `baa7635` | zombie CLI cleanup (cli/execution-record.ts + cli/lib/prune-execution-records.ts) |
| 6 | this commit | docs + handoff |

## What changed

**New:**
- Table `agent_execution_details` in kernel-next.db with FK to stage_attempts + prompt_contents.
- Module `kernel-next/runtime/execution-record-writer.ts` + types.
- RealStageExecutor writes one row per attempt (open + buffered flush + close).

**Deleted:**
- `apps/server/src/lib/execution-record/` (7 files: writer, types, build-prompt-blob, workflow-version + tests).
- `apps/server/src/cli/execution-record.ts` + `apps/server/src/cli/lib/prune-execution-records.ts` (zombie CLI + helper + tests).
- `CREATE TABLE execution_records` + 4 indexes + schema-drift check in `lib/db.ts`.

**Migrated:**
- `lib/debug-queries.ts` + tests — now joins stage_attempts + agent_execution_details in kernel-next.db.
- `lib/debug-mcp.ts` — no-op (passes through).
- `cli/debug.ts` — no-op.

## Not in scope

- `worktree_diff` column — requires checkpoint infra (separate milestone).
- `scratch_pad_snapshot` — kernel-next multi-session default, not needed.
- `script_execution_details` sidecar — no user-authored script stages yet.
- Orphan reaper CLI — manual cleanup for now.
- Enhanced analyze_task_failure logic — signature preserved only.

## Test deltas

| Phase | Tests passed | Delta |
|---|---|---|
| Baseline (post Stage 4b) | 1499 | — |
| Task 1 | 1502 | +3 |
| Task 2 | 1509 | +7 |
| Task 3 | 1510 | +1 |
| Task 4 | 1512 | +2 |
| Task 5 | 1455 | −57 (legacy module + assertion helper tests removed) |
| Zombie CLI cleanup | 1436 | −19 (execution-record CLI + prune helper tests removed) |
| Task 6 | 1436 | 0 (docs only) |

## Invariants preserved

- Server `tsc --noEmit` 0 errors at every task.
- Server `vitest run` 0 failures at every task.
- Web `tsc --noEmit` 0 errors (no web touches).
- kernel-next runtime behavior unchanged outside RealStageExecutor (writer is side-effect only).
- All 4 builtin pipelines still register + seed correctly.

## Follow-ups

- Stage 5: B-series hot-update productionization.
- worktree_diff capture once git checkpoint infra arrives.
- script_execution_details table if/when user authors a script stage.
- Orphan reaper + CLI for sidecar row cleanup.
- Enhanced analyze_task_failure logic that uses tool_calls_json / agent_stream_json.
