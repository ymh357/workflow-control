# ExecutionRecord Design (kernel-next)

> **Status:** Landed 2026-04-24 (Stage 6 milestone).
> **Replaces:** The earlier legacy-engine-targeted version of this document.
> **Spec:** `docs/superpowers/specs/2026-04-24-execution-record-sidecar-design.md`

## 1. Purpose

Capture what a kernel-next agent stage actually did during an attempt:
the full prompt it saw, the tool calls it made, the text and thinking
it emitted, the cost and tokens consumed, and the lifecycle timing.
This data grounds AI self-diagnosis (`analyze_task_failure`) and
hot-update proposals.

## 2. Where the data lives

Table `agent_execution_details` in `{data_dir}/kernel-next.db`. One row
per agent-stage attempt. `attempt_id` is PK + FK to `stage_attempts`.

Script stages, gate stages, fanout_aggregate attempts, and `__external__`
seeds do NOT write to this table; only agent executors do.

## 3. Fields

| Column | Type | Meaning |
|---|---|---|
| attempt_id | TEXT PK | FK to stage_attempts.attempt_id (ON DELETE RESTRICT) |
| prompt_ref | TEXT | Same as AgentStage.config.promptRef at exec time |
| prompt_content_hash | TEXT | FK to prompt_contents.content_hash |
| prompt_content | TEXT | Duplicated from prompt_contents so row is self-contained |
| model | TEXT | e.g. "claude-haiku-4-5" |
| sub_agents_json | TEXT? | JSON of AgentStage.config.subAgents if present |
| tool_calls_json | TEXT | JSON array of ToolCallRecord |
| agent_stream_json | TEXT | JSON array of {type: text\|thinking, text, timestamp} |
| cost_usd, token_input, token_output | REAL/INT | End-of-run totals |
| session_id | TEXT? | Claude SDK session identifier |
| duration_ms | INT | ended_at - started_at |
| started_at, ended_at | INT ms | Wall clock |
| termination_reason | TEXT? | one of: natural_completion, interrupted, error, superseded |
| last_heartbeat_at | INT ms | For orphan reaper (future) |

## 4. Lifecycle

1. RealStageExecutor.doAttempt calls portRuntime.startAttempt(...) → stage_attempts row inserted.
2. RealStageExecutor opens the writer → agent_execution_details row INSERT.
3. SDK stream events map to writer calls:
   - ASSISTANT_TEXT / ASSISTANT_THINKING → appendAgentStream
   - TOOL_USE_REQUESTED → appendToolCall
   - TOOL_RESULT_RECEIVED → completeToolCall(id, patch)
   - Cost/usage updates → updateCost
4. Writer debounces DB flushes at 1Hz.
5. On stage exit: writer.close(terminationReason, cost, tokens, sessionId) → final UPDATE with ended_at + duration_ms + termination_reason.

Writer never throws. On FK violation (stage_attempts row missing) or
runtime error, writer logs a warning and degrades to a no-op. Executor
path is never blocked.

## 5. Derived views

Fields NOT stored because they're derivable from other tables:
- `writes_parsed`: extract `{name: "write_port"}` tool_use entries from tool_calls_json.
- `writes_committed`: query port_values where attempt_id = ? and direction = 'out'.
- Wire reads at stage entry: query port_values where attempt_id = ? and direction = 'in'.

## 6. Not captured (out of scope for Stage 6)

- `worktree_diff` — requires stage-boundary git checkpoint infrastructure (future milestone).
- `scratch_pad_snapshot` / PreCompact events — legacy single-session concept; kernel-next defaults multi-session per stage.
- Intermediate retries that runner abandons: writer.close({terminationReason: "superseded"}) is intended but currently only fires on the outermost retry-rebuild path (C5). Intra-stage retries (maxRetries within doAttempt) overwrite the writer instance without explicit supersede close — that attempt's row stays open with ended_at=null until orphan reaper (future) sweeps it.

## 7. Relationship to SSE

kernel-next's SSE broadcaster continues to emit real-time events on top
of the same pipeline execution. Sidecar writes are independent — one
consumer of raw executor events writes to `agent_execution_details`, the
other publishes to subscribers. Both survive the same flush discipline.

## 8. Access patterns

Primary consumers:
- `lib/debug-queries.ts` → `analyze_task_failure` / `get_stage_execution_record` / `list_task_records` / `diff_executions`.
- `lib/debug-mcp.ts` exposes those via SDK MCP tools for in-pipeline self-diagnosis.
- `cli/debug.ts` exposes them to the CLI for human debugging.

All three use kernel-next.db + JOIN with stage_attempts + optional JOIN with port_values.

## 9. Pruning

No automatic GC. Operators delete old task data manually:

```sql
DELETE FROM agent_execution_details
WHERE attempt_id IN (
  SELECT attempt_id FROM stage_attempts WHERE task_id = ?
);
-- Then delete stage_attempts + port_values rows for the task.
```

Future milestone may add a CLI helper.
