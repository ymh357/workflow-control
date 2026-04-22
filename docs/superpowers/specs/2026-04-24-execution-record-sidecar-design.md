# Execution Record Sidecar — Stage 6 Design

> **Date:** 2026-04-24
> **Status:** Draft — awaiting user approval
> **Goal-tier:** Stage 6 of the 7-stage Y-direction path. Unlocks AI self-diagnosis.
> **Related:**
>   - `docs/kernel-next-terminal-design.md` §8 (lineage + sidecar model), §9 (MCP surface)
>   - `docs/product-roadmap.md` §6.1 A1 (执行记录 / StageMemory)
>   - `docs/execution-record-design.md` (legacy design — to be updated as part of this milestone)

## 1. Goal & Success Criteria

**Goal:** Give kernel-next a sidecar layer capturing what an agent actually did during each stage attempt: full prompt text, tool-call stream, agent text/thinking stream, cost/tokens, lifecycle timing. Without this, `analyze_task_failure`-class debug tools have no data source in kernel-next; with it, AI self-diagnosis and hot-update proposals have grounded inputs.

**Success criteria:**

1. New SQLite table `agent_execution_details` in `kernel-next.db` holds one row per agent-stage attempt (one-to-one with `stage_attempts` rows where `kind` indicates an agent-executed attempt).
2. `RealStageExecutor.executeStage` opens a row at stage start and closes it at stage end with `termination_reason` set. Mid-stage SDK messages (text, thinking, tool_use, tool_result) append to JSONL fields.
3. Writer is a new module in `kernel-next/runtime/`; legacy `lib/execution-record/` module deleted.
4. Legacy `execution_records` table in `workflow.db` / `lib/db.ts` deleted along with its DDL and schema-drift warnings.
5. `lib/debug-queries.ts`, `lib/debug-mcp.ts`, and `cli/debug.ts` read the new `agent_execution_details` table in kernel-next.db. Their public signatures unchanged.
6. No feature flag. Sidecar writes on every agent stage attempt unconditionally.
7. No worktree diff capture in this milestone (deferred — requires checkpoint infra).
8. No scratch-pad field. kernel-next runs multi-session per stage; scratch pad was a legacy single-session concept.
9. Manual end-to-end: run `smoke-test` via `POST /api/kernel/tasks/run`; `SELECT * FROM agent_execution_details WHERE attempt_id IN (SELECT attempt_id FROM stage_attempts WHERE task_id = '<id>')` returns one row per agent attempt with non-null `prompt_content`, non-empty `tool_calls_json` / `agent_stream_json` (at least an empty array), populated `cost_usd` / token counts.
10. Server `tsc --noEmit` clean. Server `vitest run` 0 failures. Web `tsc --noEmit` clean.

## 2. Scope & Non-Goals

**In scope:**
- New DDL: `agent_execution_details` table + 2 indexes in `kernel-next.db`.
- New module: `kernel-next/runtime/execution-record-writer.ts` + types + tests. Writer opens/appends/closes a sidecar row with SQLite-backed buffered writes.
- Wire `RealStageExecutor` to construct, feed, and close a writer per attempt.
- Migrate 3 debug-tool files (`lib/debug-queries.ts`, `lib/debug-mcp.ts`, `cli/debug.ts`) to the new table in the new database.
- Delete `lib/execution-record/` directory (7 files).
- Delete legacy `execution_records` table DDL + migrations in `lib/db.ts`.
- Delete schema-drift warning referencing legacy table.
- Update docs: `docs/execution-record-design.md` rewritten; CLAUDE.md Retired areas append; roadmap Phase 1 A1 status update; terminal-design Appendix A confirmation.

**Out of scope (deferred):**
- `worktree_diff` capture — requires stage-boundary git checkpoint infra; separate milestone.
- `scratch_pad_snapshot` / PreCompact hooks — kernel-next default multi-session makes them unneeded; if future single-session scenarios emerge, revisit.
- `script_execution_details` sidecar — script stages have different semantics (stdout/stderr/exit_code); separate milestone when first user-authored script stage appears.
- Automatic pruning / GC CLI — future milestone. SQLite row size is unbounded by design; operators delete old task data manually.
- `writes_parsed` / `writes_committed` fields — legacy-design concept; kernel-next derives the same info by joining `tool_calls_json` (agent's write_port calls) with `port_values` (kernel's actual commits).
- Enhanced `analyze_task_failure` logic — migrates the existing query surface only. Smarter analysis is a future milestone.

**Non-goals (rejection):**
- **NOT** feature-flagging the writer. kernel-next-design §8.3 says sidecar is best-effort but always emitted; the per-process off-switch was a legacy-staged-rollout artifact.
- **NOT** maintaining cross-database consistency between `workflow.db` and `kernel-next.db`. `workflow.db` loses `execution_records`; that database is increasingly a residual holding-pen after Stage 4a and will be fully evaluated in a future cleanup milestone.
- **NOT** recovering any historical legacy `execution_records` rows. Zero writers existed for that table post-Stage-4a. Table body is 0 rows at deletion time.

## 3. Architectural Justification

**Why sidecar instead of blowing up lineage tables?** kernel-next-design §8.1 splits executor-agnostic (lineage) from executor-owned (sidecar). `stage_attempts` + `port_values` are schema-stable across any future executor type (Claude today, potentially different LLMs tomorrow, script stages alongside). Shoving Claude-specific fields like `tool_calls_json` and `cost_usd` into `stage_attempts` welds the kernel to Claude.

**Why not extend the legacy `lib/execution-record/` writer?** That writer is in a module orphaned by Stage 4a. Its `getDb()` returns `workflow.db` — the wrong database. Its feature flag is the wrong policy. Its prompt_blob shape (`tier1`, `invariants`, `fragments`) encodes userland prompt-assembly layers that kernel-next doesn't have (DbPromptResolver returns a single resolved string). Shoehorning is more work than rewriting.

**Why always-on write?** Per kernel-next-design §8.3: "Sidecar is best-effort: written incrementally during execution by the executor. A crashed executor may leave a sidecar row incomplete; queries must tolerate this." That's the discipline — not "toggleable". The writer never throws into the executor; it logs and continues on failure.

## 4. Database Schema

Added to `apps/server/src/kernel-next/ir/sql.ts` alongside `stage_attempts`:

```sql
CREATE TABLE IF NOT EXISTS agent_execution_details (
  attempt_id           TEXT PRIMARY KEY
                       REFERENCES stage_attempts(attempt_id) ON DELETE RESTRICT,

  -- prompt context
  prompt_ref           TEXT NOT NULL,
  prompt_content_hash  TEXT NOT NULL
                       REFERENCES prompt_contents(content_hash) ON DELETE RESTRICT,
  prompt_content       TEXT NOT NULL,
  model                TEXT NOT NULL,
  sub_agents_json      TEXT,

  -- agent activity (append-only JSON arrays)
  tool_calls_json      TEXT NOT NULL DEFAULT '[]',
  agent_stream_json    TEXT NOT NULL DEFAULT '[]',

  -- cost & metadata
  cost_usd             REAL,
  token_input          INTEGER,
  token_output         INTEGER,
  session_id           TEXT,
  duration_ms          INTEGER,

  -- lifecycle
  started_at           INTEGER NOT NULL,
  ended_at             INTEGER,
  termination_reason   TEXT
                       CHECK (termination_reason IS NULL
                              OR termination_reason IN
                              ('natural_completion','interrupted','error','superseded')),
  last_heartbeat_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_aed_prompt_hash
  ON agent_execution_details(prompt_content_hash);
CREATE INDEX IF NOT EXISTS idx_aed_open
  ON agent_execution_details(last_heartbeat_at)
  WHERE ended_at IS NULL;
```

**Design notes:**

- `attempt_id` is PK AND FK → `stage_attempts.attempt_id` with `ON DELETE RESTRICT`. Enforces 1-to-1 with an existing lineage row. Attempts that should NOT have sidecar (script, gate, fanout_aggregate, external) simply never get a row inserted — caller opts in.
- `prompt_content` is duplicated from `prompt_contents.content` (keyed by `prompt_content_hash`) so a sidecar row is self-contained. A future `GC prompts` pass can delete from `prompt_contents`; the sidecar row retains the bytes.
- `tool_calls_json` / `agent_stream_json` are JSON arrays serialized in full each update (not incremental JSONL at disk layer). Writer buffers in memory and rewrites the array per flush. SQLite text updates are O(text length); for typical stage 20 tool calls × 4KB each = 80KB rewrites per flush at 1Hz — fine.
- `duration_ms = ended_at - started_at` (absolute, not cumulative wall clock; includes any waiting-for-claude time). Computed at close, not dynamic.
- `last_heartbeat_at` lets an orphan reaper classify "stopped cleanly" (`ended_at` set) vs "orphaned" (`last_heartbeat_at` stale, `ended_at` null). Orphan reaper is out-of-scope for this milestone.

## 5. Writer Module

New module: `apps/server/src/kernel-next/runtime/execution-record-writer.ts`.

### 5.1 Types

```typescript
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

export type TerminationReason =
  | "natural_completion"
  | "interrupted"
  | "error"
  | "superseded";

export interface OpenWriterInput {
  attemptId: string;
  promptRef: string;
  promptContentHash: string;
  promptContent: string;
  model: string;
  subAgents?: unknown[] | null;  // AgentStage.config.subAgents if present
}

export interface CloseWriterInput {
  terminationReason: TerminationReason;
  costUsd?: number | null;
  tokenInput?: number | null;
  tokenOutput?: number | null;
  sessionId?: string | null;
}
```

### 5.2 Public API

```typescript
export interface ExecutionRecordWriter {
  readonly attemptId: string;

  appendToolCall(call: ToolCallRecord): void;
  completeToolCall(id: string, patch: Partial<ToolCallRecord>): void;
  appendAgentStream(event: AgentStreamEvent): void;
  updateCost(patch: { costUsd?: number | null; tokenInput?: number | null; tokenOutput?: number | null }): void;
  updateSessionId(sessionId: string | null): void;
  heartbeat(): void;
  close(input: CloseWriterInput): void;

  /** Test-only: force any pending buffered appends to flush synchronously. */
  __flushForTests(): void;
}

export function openExecutionRecordWriter(
  db: DatabaseSync,
  input: OpenWriterInput,
): ExecutionRecordWriter;
```

### 5.3 Buffering discipline

- Maintain in-memory mirrors of `tool_calls_json` and `agent_stream_json` as mutable arrays.
- On each mutation, schedule a debounced flush (1000ms) if not already scheduled.
- Flush = `UPDATE agent_execution_details SET tool_calls_json = ?, agent_stream_json = ?, last_heartbeat_at = ? WHERE attempt_id = ?`.
- `heartbeat()` flushes synchronously (updates `last_heartbeat_at`).
- `close()` flushes synchronously + performs the final close UPDATE with terminal fields.
- All database errors inside writer are caught and logged via `logger.error({ attemptId, err })`. Writer never throws — executor path must not be disturbed.

### 5.4 Open-at-start atomicity

`openExecutionRecordWriter` performs a single INSERT under try/catch. If FK violates (`stage_attempts` row missing), logger warns and returns a no-op writer so the executor proceeds. The implementation guarantees that RealStageExecutor has already called the insertPipelineVersion or equivalent stage_attempts row before opening.

Actual ordering: runner.ts inserts the `stage_attempts` row at attempt start; RealStageExecutor receives `attemptId` in `ExecuteStageArgs` after that insert. So FK is always satisfiable in practice.

## 6. RealStageExecutor Integration

`RealStageExecutor.executeStage(args: ExecuteStageArgs)`:

### 6.1 At entry (after stage.type/promptRef validation)

```typescript
const promptContent = this.promptResolver.resolve({ stage, taskId, attemptId, inputs });
const writer = openExecutionRecordWriter(this.db, {
  attemptId,
  promptRef: stage.config.promptRef,
  promptContentHash: await this.getContentHash(stage),   // see §6.5
  promptContent,
  model: this.model,
  subAgents: stage.config.subAgents ?? null,
});
```

Need `this.db` — add `db: DatabaseSync` to `RealStageExecutorOptions`. `startPipelineRun` / `registerLegacyPipeline`-style callers already have it; thread it through.

### 6.2 During SDK message stream

Inside the existing `stream-pump` / `sdk-adapter` consumption loop, on each message variant:

- `TextBlock` / thinking → `writer.appendAgentStream({ type, text, timestamp })`.
- `ToolUseBlock` → `writer.appendToolCall({id, name, input, startedAt: now, finishedAt: null, result: null, isError: false, tokenIn: null, tokenOut: null, durationMs: null})`.
- `ToolResultBlock` → `writer.completeToolCall(id, {result, isError, finishedAt: now, durationMs: finish - start})`.
- `CostInfoBlock` / cost update → `writer.updateCost({costUsd, tokenInput, tokenOutput})`.
- SDK `session_id` first seen → `writer.updateSessionId(id)`.

Exact event types come from `stream-pump.ts`'s current parsed events; the integration is one switch statement mapping existing events to writer calls.

### 6.3 At exit (success / error / interrupt)

```typescript
writer.close({
  terminationReason: resultStatus === "done" ? "natural_completion"
                   : resultStatus === "interrupted" ? "interrupted"
                   : "error",
  costUsd: finalCost,
  tokenInput: finalTokenIn,
  tokenOutput: finalTokenOut,
  sessionId: finalSessionId,
});
```

`superseded` is used in retry-rebuild context — set by runner when it stops an actor mid-attempt. Runner calls writer.close on the abandoned attempt's writer before standing up the retry. Requires runner to know the writer; see §6.4.

### 6.4 Writer lifetime across retry-rebuild

When runner rebuilds the actor for retry (C5 pathway in prior milestones), the currently-executing stage's attempt is abandoned; a new attempt starts. Old writer should close with `superseded`; new writer opens fresh.

Implementation: runner holds a reference to the active writer per attempt. When rebuild triggers, runner calls `writer.close({terminationReason: 'superseded'})` on the old reference before tearing the actor down. `RealStageExecutor` exposes the writer externally via a small additional return value from `executeStage` or via a closure captured in a writer registry keyed by `attemptId`.

**Simpler alternative**: writer pool keyed by `attemptId`, stored on `PortRuntime` (run-scoped singleton already threaded to MCP + runner). Any component with `PortRuntime` can close the writer on supersede. This is the chosen path — minimal plumbing change.

### 6.5 Prompt content hash lookup

DbPromptResolver knows `versionHash + promptRef`; it queries `pipeline_prompt_refs` to find `content_hash`. We want that `content_hash` in the sidecar without double-querying. Options:

**Option A**: `DbPromptResolver.resolve()` returns `{content: string, contentHash: string}` instead of plain string. Breaking change to PromptResolver interface; all implementations update.

**Option B**: Writer re-computes via `promptContentHash(content)` from canonical.ts (exists from Stage 1 prompts-in-sqlite). This is a pure hash of normalized content — equals the stored `content_hash` by construction.

**Selected: Option B.** Zero interface churn. One extra SHA256 per stage start is negligible. `promptContentHash` is already exported.

## 7. Debug Tools Migration

Three files migrate from `workflow.db.execution_records` → `kernel-next.db.agent_execution_details` + JOINs.

### 7.1 `lib/debug-queries.ts`

Current public exports (approximate — grep-verified before implementation):
- `getTaskAttempts(taskId)`: list attempts for a task
- `getStageExecutionRecord(taskId, stageName, attempt)`: single row
- `analyzeTaskFailure(taskId)`: diagnostic rollup
- `listTaskRecords(taskId)`: short listing
- `diffExecutions(recordIdA, recordIdB)`: compare 2 rows

New implementation:
- Switch `getDb()` import from `lib/db.ts` → `getKernelNextDb()` from `lib/kernel-next-db.ts`.
- Update all `SELECT ... FROM execution_records` to `SELECT ... FROM stage_attempts sa LEFT JOIN agent_execution_details aed ON aed.attempt_id = sa.attempt_id WHERE sa.task_id = ?`.
- Preserve column names in returned row shapes where possible; some fields change (e.g. `worktree_diff` → undefined; `scratch_pad_snapshot` → undefined; `writes_parsed`/`writes_committed` → derived from port_values JOIN).
- Public TypeScript shape of returned objects is preserved for external consumers — optional fields for removed ones.

### 7.2 `lib/debug-mcp.ts`

Calls `lib/debug-queries.ts` functions. No changes needed beyond those cascading from §7.1.

### 7.3 `cli/debug.ts`

Same as §7.2 — passes through to queries. Output formatting unchanged.

### 7.4 Tests

`lib/debug-queries.test.ts` currently seeds rows into `execution_records`. Rewrite to seed `stage_attempts` + `agent_execution_details` + `port_values` in kernel-next's schema, then run the same assertions. Test count approximately unchanged.

## 8. Deletion list

After Stage 6 lands:

**Deleted files:**
- `apps/server/src/lib/execution-record/types.ts`
- `apps/server/src/lib/execution-record/writer.ts`
- `apps/server/src/lib/execution-record/writer.test.ts`
- `apps/server/src/lib/execution-record/writer.adversarial.test.ts`
- `apps/server/src/lib/execution-record/build-prompt-blob.ts`
- `apps/server/src/lib/execution-record/build-prompt-blob.test.ts`
- `apps/server/src/lib/execution-record/workflow-version.ts`
- `apps/server/src/lib/execution-record/workflow-version.test.ts`
- (directory `lib/execution-record/` removed)

**Deleted DDL in `lib/db.ts`:**
- `CREATE TABLE IF NOT EXISTS execution_records` and its four indexes
- `PRAGMA table_info(execution_records)` drift warning block around line 160-170

**Retained (touched but not deleted):**
- `lib/db.ts` — keep the `workflow.db` helper (other tables still exist there: sse_messages, pending_questions, edge_slots were deleted by Stage 4a but left the file; audit confirms remaining tables)

### 8.1 workflow.db residuals

Audit task in Commit 3: after deleting `execution_records` from `lib/db.ts`, check what remains. If the file has only empty schema + helpers consumed nowhere, it joins the Stage 6 deletion list. If other tables are still needed, leave it.

## 9. Commit sequence

**Commit 1 — DDL + writer + types**:
- Add `agent_execution_details` table DDL to `kernel-next/ir/sql.ts`
- Add test verifying table schema, FK, indexes
- Add writer module + types + unit tests (database mocked at `:memory:`)

**Commit 2 — RealStageExecutor integration**:
- Add `db` to `RealStageExecutorOptions`
- Thread `db` through `startPipelineRun` (already has it)
- Hook SDK message stream to writer calls
- Close writer on success/error/interrupt
- Test: run a mock executor stage, assert row appears with populated fields
- Runner: integrate writer supersede path in retry rebuild

**Commit 3 — debug tools migration + legacy cleanup**:
- Rewrite `lib/debug-queries.ts` + its test to read kernel-next.db `agent_execution_details`
- Update `lib/debug-mcp.ts` and `cli/debug.ts` as needed
- Delete `lib/execution-record/` directory
- Delete `execution_records` DDL + drift check from `lib/db.ts`
- If `lib/db.ts` is now orphan after this + audit, delete it too (Stage 4a left it because of the table; no table = no reason)

**Commit 4 — docs update + handoff**:
- Rewrite `docs/execution-record-design.md` for kernel-next
- CLAUDE.md Retired areas: append `lib/execution-record/` + `execution_records` table
- product-roadmap.md Phase 1 A1: mark Done / Stage 6 2026-04-24
- kernel-next-terminal-design.md Appendix A: confirm §8 sidecar realized
- Create `docs/superpowers/plans/2026-04-24-execution-record-sidecar-done-handoff.md`

## 10. Testing Strategy

### 10.1 Unit

- Writer: open creates row; appendToolCall buffers then flushes; close updates terminal fields; heartbeat extends `last_heartbeat_at`; FK violation on open → no-op writer + logged warning.
- Types + JSON serialization round-trip.
- DDL creates table + indexes with correct constraints.

### 10.2 Integration

- Mock executor: `executeStage` with a fake SDK stream producing text + tool_use + tool_result → one row in `agent_execution_details` with correct JSON arrays, cost, termination_reason = natural_completion.
- Retry rebuild: attempt A fires one tool_use then gets superseded; row for A has termination_reason = superseded; row for attempt B opens fresh.

### 10.3 Debug tools regression

- `getTaskAttempts` / `getStageExecutionRecord` / `analyzeTaskFailure` / `listTaskRecords` return the expected shapes using seeded kernel-next rows.
- `diffExecutions` on two rows of the same stage with different attempts surfaces the JSON-level diffs.

### 10.4 Manual end-to-end

- Start dev server, POST `smoke-test` run, verify `agent_execution_details` rows populated.
- POST `pipeline-generator` with a 3-stage probe, verify all 5 stages' agent attempts have rows. (`awaitingConfirm` is a gate — no row. `persisting` is an agent — row.)

## 11. Non-Negotiables Check

- ✅ Kernel executor-agnostic — `stage_attempts` / `port_values` unchanged; sidecar is `agent_`-typed, future executors get their own tables.
- ✅ IR cannot encode policy — sidecar is orthogonal.
- ✅ MCP surface physical separation — sidecar does NOT go through MCP; it's an internal writer. `report_side_state` MCP tool from kernel-next-design §9 is NOT added by this milestone (future if ever needed for non-executor callers).
- ✅ Lineage synchronous — `stage_attempts` writes remain synchronous at stage boundaries.
- ✅ Sidecar async-best-effort — writer buffers, catches errors, never throws into executor.
- ✅ Hot-update never silently migrates — unchanged.
- ✅ No mutable global state — writer instances are per-attempt; no singletons.
- ✅ Zero legacy compatibility — legacy execution_records table deleted; writer rewritten; debug tools migrated rather than dual-read.

## 12. Risks & Mitigations

**12.1 Writer I/O contention on hot stages.** 20 tool_use/sec × JSON serialize + SQLite UPDATE could bog. Mitigation: 1Hz debounce; never flush per-event. SQLite in WAL mode (already set) tolerates multi-writer contention.

**12.2 attempt_id FK violation timing.** If RealStageExecutor opens writer before runner has inserted stage_attempts, FK fails. Mitigation: runner always inserts stage_attempts FIRST (current code invariant); if violated, no-op writer + log warning; executor proceeds.

**12.3 Interrupt / supersede writer close contention.** Runner supersede path and executor interrupt path could both try to close same writer. Mitigation: `close()` is idempotent — second call returns early if `ended_at` already set.

**12.4 Large prompt_content duplication.** 5KB-50KB prompts × rows-per-task = MB-level storage. Acceptable for single-machine tool; GC is future milestone. Not a blocker.

**12.5 Legacy workflow.db deletion blocking.** `lib/db.ts` might be consumed by routes or middleware not yet audited. Mitigation: audit in Commit 3 before deleting `lib/db.ts`; if consumers exist, keep the file and delete only the `execution_records` DDL.

## 13. Self-Review Checklist

- [ ] `agent_execution_details` table created with correct FK ON DELETE behavior
- [ ] Writer never throws; all failures logged
- [ ] `RealStageExecutor` opens + closes writer in all three exit paths (done/error/interrupt)
- [ ] Supersede close from runner tested
- [ ] Debug tools return shape-compatible results to external consumers
- [ ] Legacy `execution_records` table fully gone (no CREATE, no PRAGMA check, no writes, no reads)
- [ ] `lib/execution-record/` module + tests deleted
- [ ] Docs updated (execution-record-design.md rewritten; CLAUDE.md retired section appended)
- [ ] Server tsc + vitest green at every commit
- [ ] Web tsc unchanged
- [ ] Manual smoke-test run produces populated sidecar rows
