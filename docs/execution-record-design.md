# ExecutionRecord — Design (Phase 1 / A1 / Step 1.1)

> **Status:** Design. No code yet. Implemented over Steps 1.2–1.7.
> Source-of-truth pointer: `docs/product-roadmap.md` §6.1 and §10 Phase 1.

## 1. Purpose

Today, what an agent actually *did* during a stage is scattered across
transient SSE messages (kept for ~500 entries per task in SQLite, mainly
for UI replay), task snapshot JSON (XState context only), and the
worktree file system. There is no single queryable record of:

- the full prompt the agent saw,
- the reads it was handed,
- the tool calls it made and what they returned,
- what it *said* (text + thinking) and what the pipeline actually
  committed to the store,
- the cost / token / timing,
- the worktree changes it produced,
- the scratch-pad state + any `PreCompact` events it went through.

ExecutionRecord closes that gap. Every stage attempt writes one durable
row with those 8 fields so that future AI — including the agent that
edits pipelines — can reason about real runs instead of hypothetical
ones.

## 2. Grain & identity

**One row per stage attempt.** A retry of the same stage is a separate
row with a new `attempt_id`. A hot-update that supersedes a running
stage closes out the current row (with a terminating reason) and opens
a new one. Parallel children each get their own row in multi-session
mode; in single-session parallel mode the group is one row whose
`stage_name` is the group name, with per-child breakdown inside
`parsed_writes`.

Primary identity:

```
attempt_id         TEXT PRIMARY KEY    -- ULID, monotonic
task_id            TEXT                -- FK to tasks/:id.json
stage_name         TEXT                -- camelCase stage or parallel-group name
attempt_index      INTEGER             -- 1-based, per (task_id, stage_name)
pipeline_version_hash TEXT             -- set by Phase 2 / A2; nullable in Phase 1
```

Foreign key to tasks is soft (task file on disk), not a DB FK — tasks
already live outside SQLite.

## 3. The eight fields

Field names in snake_case match DDL; the TS interface uses camelCase.

| # | Column | Shape | Notes |
|---|--------|-------|-------|
| 1 | `prompt_blob` | TEXT | JSON `{ tier1, systemPromptFull, stagePrompt, invariants, fragments: [{id,hash}], outputSchema }`. Full assembled content. |
| 2 | `reads_snapshot` | TEXT | JSON `{ <readKey>: <concreteValueAtStageStart> }`. Captures store state as agent saw it. |
| 3 | `tool_calls` | TEXT | JSONL appended at write time, wrapped into a JSON array on finalization. `[{id, name, input, result, tokenIn, tokenOut, durationMs, timestamp}]`. |
| 4 | `agent_stream` | TEXT | JSONL of `{type: "text"|"thinking", text, timestamp}`. Mirrors `agent_text` and `agent_thinking` SSE events. |
| 5 | `writes_parsed` / `writes_committed` | TEXT, TEXT | Two JSON blobs. `writes_parsed` = what the agent's last JSON answer declared. `writes_committed` = what the stage actually wrote to the store (post schema guard, post script post-processing). Drift here is a debugging signal. |
| 6 | `cost_usd`, `token_input`, `token_output`, `duration_ms`, `model`, `session_id` | REAL / INTEGER / TEXT | Flat columns — frequent filter targets. |
| 7 | `worktree_diff` | TEXT | `git diff` from stage entry commit to stage exit commit, truncated to `WORKTREE_DIFF_MAX_BYTES` (default 1 MiB). Truncation marker appended inline. |
| 8 | `scratch_pad_snapshot` | TEXT | JSON `{ openingNote, finalNote, precompactEvents: [{tokensAtTrigger, tier1ReInjectedBytes, timestamp}] }`. Single-session-only; null for multi-session stages. |

## 4. Termination

A row is open while the stage runs and is finalized at exit with a
`terminated_at` timestamp and a reason from a fixed enum:

```
natural_completion
interrupted_by_hot_update
interrupted_by_user
error_exceeded_retries
superseded_by_retry
superseded_by_hot_update
```

`superseded_by_*` rows close rows that the current attempt replaced but
which did not get a clean termination (e.g. the server was force-killed
mid-stage). A reaper on server start scans for open rows with no
heartbeat in the last N minutes and writes `error_exceeded_retries`.

## 5. SQLite DDL

Added to `lib/db.ts` alongside the existing tables:

```sql
CREATE TABLE IF NOT EXISTS execution_records (
  attempt_id              TEXT PRIMARY KEY,
  task_id                 TEXT NOT NULL,
  stage_name              TEXT NOT NULL,
  attempt_index           INTEGER NOT NULL,
  pipeline_version_hash   TEXT,

  started_at              TEXT NOT NULL,
  terminated_at           TEXT,
  termination_reason      TEXT,

  engine                  TEXT NOT NULL,
  model                   TEXT,
  session_id              TEXT,

  prompt_blob             TEXT NOT NULL,
  reads_snapshot          TEXT NOT NULL,
  tool_calls              TEXT NOT NULL DEFAULT '[]',
  agent_stream            TEXT NOT NULL DEFAULT '[]',
  writes_parsed           TEXT,
  writes_committed        TEXT,
  worktree_diff           TEXT,
  worktree_diff_truncated INTEGER NOT NULL DEFAULT 0,
  scratch_pad_snapshot    TEXT,

  cost_usd                REAL,
  token_input             INTEGER,
  token_output            INTEGER,
  duration_ms             INTEGER,

  last_heartbeat_at       TEXT NOT NULL,
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_exec_task
  ON execution_records(task_id);
CREATE INDEX IF NOT EXISTS idx_exec_task_stage_attempt
  ON execution_records(task_id, stage_name, attempt_index);
CREATE INDEX IF NOT EXISTS idx_exec_pipeline_hash
  ON execution_records(pipeline_version_hash);
CREATE INDEX IF NOT EXISTS idx_exec_open
  ON execution_records(last_heartbeat_at)
  WHERE terminated_at IS NULL;
```

Storage estimate: ~50 KiB–2 MiB per row depending on worktree diff size.
At ~100 stages/day × 1 MiB average that's ~36 GiB/year in the worst
case — acceptable for a single-machine tool, and the CLI pruner (§9)
keeps it in check.

## 6. Relationship to other stores

| Store | Role | Changes for A1 |
|---|---|---|
| `sse_messages` | Transient UI replay stream (capped at 500 entries/task) | **Unchanged.** Execution record writer is a *parallel consumer of the same source*, not a replacement. SSE keeps its retention and semantics. |
| `tasks/:id.json` | XState snapshot + lifecycle state | Unchanged in Phase 1. Phase 2 adds `pipelineSnapshot`. |
| `pending_questions` | Blocking human-gate questions | Unchanged. |
| `edge_slots` | Edge runner slot registry | Unchanged (and frozen). |

The writer receives the *same event objects* that the SSE manager
receives (one producer, two consumers), so there is no "which one is
authoritative" question — they cannot diverge unless one of them fails
to write. When the writer fails, the error is logged and swallowed:
SSE + the stage itself must not be held hostage by the record store.

## 7. Data flow

```
stage start
  ├─ ExecutionRecordWriter.open({taskId, stageName, attempt, prompt, readsSnapshot, engine, model})
  │    → INSERT row with started_at=now, last_heartbeat_at=now
  │
  ├─ agent events (from executeStage / session-manager):
  │    toolUse          → writer.appendToolCall({id, name, input, ...})
  │    toolResult       → writer.completeToolCall({id, result, tokens, duration})
  │    text             → writer.appendAgentStream({type:"text", text})
  │    thinking         → writer.appendAgentStream({type:"thinking", text})
  │    compact          → writer.recordPrecompact({tokensAtTrigger, ...})
  │    cost update      → writer.updateCost({costUsd, tokenIn, tokenOut})
  │    every 10s idle   → writer.heartbeat()
  │
  └─ stage exit
       writesCommitted, writesParsed, worktreeDiff already computed
       → writer.close({terminationReason, writesParsed, writesCommitted,
                       worktreeDiff, scratchPadSnapshot, costUsd, ...})
       → UPDATE row with terminated_at=now
```

Crash safety:

1. All appends are single prepared-statement UPDATEs with `JSON_INSERT` /
   concatenation, wrapped in a short transaction. `PRAGMA journal_mode
   = WAL` is already on, so we inherit WAL durability.
2. A row with `terminated_at IS NULL` after server restart is either
   still running (the live writer will find it by `attempt_id`) or
   orphaned. An orphan reaper queries `WHERE terminated_at IS NULL AND
   last_heartbeat_at < now() - 5 min` and marks them
   `error_exceeded_retries`.
3. Append-heavy fields (`tool_calls`, `agent_stream`) use JSON arrays
   but updates are batched at ≤1 Hz per row via an in-memory buffer
   flushed on a timer OR on heartbeat OR on close, to avoid hammering
   SQLite on chatty agents.

## 8. Feature flag

`ENABLE_EXECUTION_RECORD` (env var). Default **false** through Step 1.6.
Flipped to **true** in Step 1.7. When false, `ExecutionRecordWriter` is
a no-op facade (still constructed at stage boundaries, but all methods
return immediately), so the integration seams are identical whether the
flag is on or off — this is what lets us revert quickly if self-observation
flags a problem.

## 9. CLI pruner (Step 1.6)

```
workflow prune-execution-records --task-id=<id>
workflow prune-execution-records --older-than=30d
workflow prune-execution-records --dry-run           # always available
workflow prune-execution-records --yes               # skip confirmation
```

Retention is otherwise **permanent**. No periodic auto-cleanup (per
roadmap §6.1 "永久保留，手动清理"). The `startPeriodicCleanup` path in
`lib/db.ts` is unchanged; execution_records are *not* included.

## 10. Query use cases

Sample read patterns the surface is optimized for:

```sql
-- Every attempt of a given task, newest first
SELECT attempt_id, stage_name, attempt_index, termination_reason,
       cost_usd, duration_ms
FROM execution_records
WHERE task_id = ?
ORDER BY started_at DESC;

-- Debug one stage attempt
SELECT prompt_blob, reads_snapshot, tool_calls, agent_stream,
       writes_parsed, writes_committed, worktree_diff,
       scratch_pad_snapshot
FROM execution_records
WHERE attempt_id = ?;

-- Total cost of a task across all attempts
SELECT SUM(cost_usd) FROM execution_records WHERE task_id = ?;

-- Compare two runs of the same pipeline version on the same stage
SELECT attempt_id, task_id, cost_usd, duration_ms, termination_reason
FROM execution_records
WHERE pipeline_version_hash = ? AND stage_name = ?
ORDER BY started_at DESC
LIMIT 20;

-- Open rows (either running, or orphaned for the reaper to finalize)
SELECT attempt_id, task_id, stage_name, started_at, last_heartbeat_at
FROM execution_records
WHERE terminated_at IS NULL
  AND last_heartbeat_at < datetime('now', '-5 minutes');
```

## 11. Non-goals for A1

The following are **explicitly out of scope** and deferred:

- Per-tool-call cost attribution (needs SDK usage field we don't
  reliably get yet). Stored at row-level only.
- Cross-task aggregation views (Dashboard UI). A1 is the data layer;
  dashboards wait for A4.
- Diffing two runs. Also A4.
- Replaying a record to produce a new run. Also A4.
- Redaction of sensitive values inside `reads_snapshot` or
  `prompt_blob`. Not needed for single-user local; revisit if the
  registry ever gains cross-machine record sharing (not planned).

## 12. TypeScript interface

Added to `apps/server/src/lib/execution-record/types.ts` in Step 1.2.

```ts
export type TerminationReason =
  | "natural_completion"
  | "interrupted_by_hot_update"
  | "interrupted_by_user"
  | "error_exceeded_retries"
  | "superseded_by_retry"
  | "superseded_by_hot_update";

export interface ExecutionRecord {
  attemptId: string;
  taskId: string;
  stageName: string;
  attemptIndex: number;
  pipelineVersionHash: string | null;

  startedAt: string;
  terminatedAt: string | null;
  terminationReason: TerminationReason | null;

  engine: "claude" | "gemini" | "codex";
  model: string | null;
  sessionId: string | null;

  promptBlob: PromptBlob;
  readsSnapshot: Record<string, unknown>;
  toolCalls: ToolCallRecord[];
  agentStream: AgentStreamEvent[];
  writesParsed: Record<string, unknown> | null;
  writesCommitted: Record<string, unknown> | null;
  worktreeDiff: string | null;
  worktreeDiffTruncated: boolean;
  scratchPadSnapshot: ScratchPadSnapshot | null;

  costUsd: number | null;
  tokenInput: number | null;
  tokenOutput: number | null;
  durationMs: number | null;
}

export interface PromptBlob {
  tier1: string;
  systemPromptFull: string;
  stagePrompt: string;
  invariants: string[];
  fragments: Array<{ id: string; contentHash: string }>;
  outputSchema: unknown | null;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
  result: unknown;
  isError: boolean;
  tokenIn: number | null;
  tokenOut: number | null;
  durationMs: number | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface AgentStreamEvent {
  type: "text" | "thinking";
  text: string;
  timestamp: string;
}

export interface ScratchPadSnapshot {
  openingNote: string | null;
  finalNote: string | null;
  precompactEvents: Array<{
    tokensAtTrigger: number;
    tier1ReInjectedBytes: number;
    timestamp: string;
  }>;
}
```

## 13. Step-by-step implementation map

| Step | Produces |
|---|---|
| 1.1 (this doc) | Design |
| 1.2 | `lib/execution-record/{types,writer,db}.ts`, unit tests for writer (open/append/close/crash), DDL applied to `lib/db.ts` |
| 1.3 | Integration in `agent/executor.ts` (`runAgent`, `runAgentSingleSession`) and `agent/session-manager.ts`; dual-write tests verifying record ↔ SSE parity |
| 1.4 | `lib/git.ts` helper `captureStageDiff(worktreePath, baseRef)`, hooked into writer.close |
| 1.5 | Scratch pad + `PreCompact` hook wiring in `session-manager.ts` |
| 1.6 | `cli/commands/prune-execution-records.ts` + CLI route in `cli/index.ts` |
| 1.7 | Flip `ENABLE_EXECUTION_RECORD` default, observation period |

## 14. Open questions for Phase 1 implementation

These are the design decisions deferred to each sub-step. They are
deliberately narrow — the shape above should not shift.

- **Q1.2-a:** JSONL append vs. full-row UPDATE. Benchmark shows SQLite
  WAL on a single-machine workload handles ~1 kHz UPDATEs fine, but
  for bursty tool_calls (e.g. 200 tool calls in 3 s) we should still
  batch. Decision in Step 1.2.
- **Q1.3-a:** Event source. SSE manager's `pushMessage` already fans
  out to listeners. Easiest integration: add the writer as a listener.
  Downside: couples writer lifetime to SSE manager. Alternative:
  `executeStage` owns both. Decision in Step 1.3.
- **Q1.4-a:** Worktree diff base. The stage may start from a
  non-main branch in an existing worktree. Base is "HEAD at the
  moment `writer.open()` fires". Tests must cover clean, dirty-but-untracked,
  and submodule cases.
- **Q1.5-a:** Scratch pad format. Currently an opaque string owned by
  `session-manager`. Either serialize as-is (simplest) or parse into
  structured opening/final notes (needs a tiny parser). Start with
  opaque string + whatever `PreCompact` hook emits; refine in 1.5.
