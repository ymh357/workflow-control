# Pipeline-Generator MCP Entry Design

> **Date:** 2026-04-24
> **Status:** Draft — awaiting user approval
> **Related:** `docs/superpowers/plans/2026-04-22-converter-extension-pipeline-generator-done-handoff.md` §10 follow-up #1

## 1. Goal & Success Criteria

**Goal:** Let an external Claude Code session or an internal workflow-control pipeline agent invoke the local workflow-control `pipeline-generator` builtin via two new MCP tools, and retrieve the generated pipeline YAML + prompts + paths without going through the web dashboard.

**Success criteria:**
1. External Claude Code session (configured with kernel-next MCP server) can call `start_pipeline_generator({ description })` and receive `{ taskId, versionHash }`.
2. Same session can call `wait_pipeline_result({ taskId })` and receive one of four terminal results (`done` / `gate_pending` / `running` / `error`).
3. `awaitingConfirm` gate is surfaced to caller transparently; caller uses existing `answer_gate` MCP tool to approve/reject, then resumes `wait_pipeline_result`.
4. Passing `description: "..."` flows as `__external__.taskDescription` seed → `analyzing` stage reads it as `description` port.
5. No regression in existing kernel-run HTTP route behavior for `pipeline-generator`.

## 2. Context

The converter-extension milestone (2026-04-22) made pipeline-generator runnable end-to-end via kernel-next converter + runner + real Claude SDK executor. That path is validated in the handoff §7 (pg-real-e2e-v5). However, the only trigger surface today is:

- `POST /api/kernel/tasks/run { pipeline: "pipeline-generator" }` (HTTP route `kernel-run.ts`)
- Web dashboard forms wired on top of that

For the roadmap §10 principle "作者就是金丝雀" (author is the canary), the primary daily use is an external Claude Code session asking "generate a pipeline for X". That needs a first-class MCP entry.

## 3. Scope

**In scope:**
- Two new MCP tools on the `external` (and therefore `combined`) surface of `createKernelMcp`:
  - `start_pipeline_generator`
  - `wait_pipeline_result`
- Shared loader extraction: `loadLegacyPipelineIR(pipelineDir)` helper so HTTP route and MCP tool share the YAML→IR path without duplication.
- Pipeline YAML change: add `external_inputs.taskDescription` to `pipeline-generator/pipeline.yaml`, map `analyzing.reads.description = taskDescription`.
- Minimal prompt adjustment in `prompts/system/analysis.md` if current text doesn't already treat the task description as a reads port.

**Out of scope:**
- Generic `run_pipeline` for arbitrary builtin pipelines (this milestone is pipeline-generator-specific; a generalized version is a separate follow-up).
- Streaming partial output back through MCP (single-shot terminal response only).
- Rate limiting, concurrent task caps (single-user local; concurrent runs are a valid use case).
- `task_triage` / system router (explicitly out per roadmap §5, D5 decision).
- HTTP route retirement (`kernel-run.ts` stays; web dashboard keeps working).

## 4. Consumers

Two kinds of consumers, both served by the same two tools:

1. **External Claude Code session** — User configures `kernel-next` MCP server in Claude Code, asks "make me a pipeline for X". Claude calls `start_pipeline_generator`, loops `wait_pipeline_result` until terminal, handles `gate_pending` by calling `answer_gate`, returns the final `yamlPath` + `promptDir` to the user.

2. **Internal workflow-control pipeline agent** — A stage in some other pipeline decides to invoke pipeline-generator to author a sub-pipeline. Calls the same two tools. (Note: this is not pipeline-generator calling itself — that recursion is disallowed by `in-pipeline` surface not including these tools, per roadmap §7.7.)

## 5. Tool Signatures

### 5.1 `start_pipeline_generator`

**Input:**
```typescript
{
  description: string;    // required; non-empty; natural language pipeline description
  taskId?: string;        // optional; defaults to randomUUID()
}
```

**Success output (MCP text content, JSON):**
```typescript
{
  ok: true;
  taskId: string;
  versionHash: string;
  pipelineDir: "pipeline-generator";
}
```

**Error outputs (MCP `isError: true`):**
- `{ ok: false, error: "INVALID_DESCRIPTION", reason: "empty" | "too_long" }` — description empty or > 8000 chars
- `{ ok: false, error: "CONVERT_FAILED", diagnostics: [...] }` — pipeline YAML failed converter (should never happen in practice; fail loud)
- `{ ok: false, error: "RUN_BOOTSTRAP_FAILED", reason: string }` — insertPipelineVersion or runPipeline kickoff threw

**Behavior:**
1. Validate `description`.
2. Call `loadLegacyPipelineIR("pipeline-generator")` (shared helper, §6) → `{ ir, promptRoot, yamlFilePath }`.
3. Compute `versionHash(ir)`.
4. `insertPipelineVersion(db, ir, { versionHash, tsSource: "" })` — idempotent on hash PK.
5. Construct `RealStageExecutor` with:
   - `mcpServerFactory = (_db, pr) => createKernelMcp(db, { surface: "in-pipeline", portRuntime: pr })`
   - `promptResolver = new FsPromptResolver({ rootDir: promptRoot })`
   - `model`, `maxTurns`, `maxBudgetUsd` from server config defaults (match `kernel-run.ts`)
6. Kick off `runPipeline({ db, ir, taskId, versionHash, handlers: {}, executor, seedValues: { taskDescription: description } })` without awaiting; broadcaster is the default singleton `kernelNextBroadcaster`.
7. Return `{ taskId, versionHash, pipelineDir: "pipeline-generator" }`.

Background promise rejection is logged via `logger.error`; it won't propagate into the MCP response (which already returned). `wait_pipeline_result` will observe the failure through broadcaster `stage_error` or absence of terminal event → timeout.

### 5.2 `wait_pipeline_result`

**Input:**
```typescript
{
  taskId: string;         // required
  timeoutMs?: number;     // default 30_000; clamped to [1_000, 300_000]
}
```

**Output (four terminal shapes):**

**done:**
```typescript
{
  ok: true;
  status: "done";
  taskId: string;
  result: {
    pipelineId: string;
    pipelineName: string;
    yamlPath: string;
    promptDir?: string;
    mcpsNeedingKeys?: Array<{ name: string; envVars: string[] }>;
    pipelineDesignSummary: string;  // first 500 chars of pipelineDesign.description
  };
}
```

**gate_pending:**
```typescript
{
  ok: true;
  status: "gate_pending";
  taskId: string;
  gateName: "awaitingConfirm";
  gateContext: {
    pipelineDesign: Record<string, unknown>;  // full design object from store
  };
  hint: "Call answer_gate to approve/reject, then wait_pipeline_result again.";
}
```

**running (timeout before terminal):**
```typescript
{
  ok: true;
  status: "running";
  taskId: string;
  currentStage: string | null;
  elapsedMs: number;
  hint: "Pipeline still running. Call wait_pipeline_result again to continue waiting.";
}
```

**error:**
```typescript
{
  ok: false;
  status: "error";
  taskId: string;
  error: string;
  failedStage?: string;
}
```

**Wait logic:**
1. Subscribe: `const unsub = kernelNextBroadcaster.subscribe(taskId, handleEvent)`. Broadcaster replays history events to new subscribers, so `wait` called after terminal event already fired still resolves immediately.
2. Race:
   - Event match → resolve with corresponding shape:
     - `run_final` success → query SQLite `latest_port_values` to assemble `done.result`
     - `run_final` failure → resolve `error`
     - `gate_pending` (emitted by runner when a gate stage becomes active) → read `pipelineDesign` from `latest_port_values`, resolve `gate_pending`
     - `stage_error` with `isFinalAttempt: true` → resolve `error`
   - Timeout → resolve `running`; `currentStage` from `SELECT stage_name FROM stage_attempts WHERE task_id=? ORDER BY attempt_at DESC LIMIT 1`; `elapsedMs` tracked from `start_pipeline_generator`'s task creation time (stored in a lightweight in-memory map keyed by taskId, fallback to `Date.now() - firstAttemptAt` from SQLite if map entry missing after restart).
3. `finally: unsub()`.

**Non-terminal events ignored:** `stage_executing`, `stage_done`, `port_written`, `stage_error` with `isFinalAttempt: false`, `task_state`.

## 6. Shared Loader

**File:** `apps/server/src/kernel-next/runtime/load-legacy-pipeline.ts` (new)

```typescript
export interface LegacyPipelineLoadResult {
  ir: PipelineIR;
  promptRoot: string;
  yamlFilePath: string;
}

export function loadLegacyPipelineIR(pipelineDir: string): LegacyPipelineLoadResult;
```

**Behavior:**
1. Resolve `yamlFilePath = join(__dirname, "..", "..", "builtin-pipelines", pipelineDir, "pipeline.yaml")`
2. `const yaml = readFileSync(yamlFilePath, "utf8")`
3. `const r = convertLegacyYaml(yaml, { yamlFilePath })` — throws if `!r.ok` with `CONVERT_FAILED` + diagnostics
4. Return `{ ir: r.ir, promptRoot: r.promptRoot!, yamlFilePath }`

**Consumers:**
- `apps/server/src/routes/kernel-run.ts` refactors `registerLegacyPipeline` to call this.
- New `start_pipeline_generator` MCP handler calls this directly.

## 7. Pipeline YAML Changes

**File:** `apps/server/src/builtin-pipelines/pipeline-generator/pipeline.yaml`

Add top-level `external_inputs`:
```yaml
external_inputs:
  taskDescription:
    type: string
    description: Natural language description of the pipeline to generate.
    required: true
```

Change `analyzing.reads`:
```yaml
# before
reads: {}
# after
reads:
  description: taskDescription
```

**Prompt adjustment:** `prompts/system/analysis.md` — if current text relies on an implicit task description (e.g. via Claude Code's task title context), switch to referring to the `description` reads port. Inspected at implementation time; change is text-only.

## 8. MCP Surface Wiring

Extend `apps/server/src/kernel-next/mcp/server.ts`:

- `EXTERNAL_TOOLS` gets `"start_pipeline_generator"` and `"wait_pipeline_result"`.
- `INTERNAL_TOOLS` and the `in-pipeline` surface do **not** include these.
- `combined` surface (legacy compat) includes them via the `external ∪ internal` union.

Two new tool definitions follow the existing pattern (`name`, `description`, `inputSchema` via zod, handler returning `jsonResponse(...)` or `errorResponse(...)`).

Handler dependencies (db, broadcaster) are already in scope: `createKernelMcp` has `db`; `kernelNextBroadcaster` singleton imported from `apps/server/src/kernel-next/sse/singleton.ts`.

## 9. Testing Strategy

**Unit — `start_pipeline_generator`:**
- Valid description → `loadLegacyPipelineIR`, `insertPipelineVersion`, `runPipeline` called with expected args; response shape correct
- Empty description → `INVALID_DESCRIPTION`
- Description > 8000 chars → `INVALID_DESCRIPTION`
- `loadLegacyPipelineIR` throws → `CONVERT_FAILED`
- `runPipeline` sync throw → `RUN_BOOTSTRAP_FAILED`
- `taskId` omitted → UUID generated; `taskId` passed → used as-is

**Unit — `wait_pipeline_result`:**
- Subscribe → `run_final` success event → `done` shape
- Subscribe → `gate_pending` event → `gate_pending` shape with pipelineDesign
- Subscribe → `stage_error` final-attempt → `error` shape
- Subscribe → no event within timeoutMs → `running` shape with currentStage from SQLite
- `timeoutMs` out of range → clamped
- Missing task in db → `error` with explanatory message

**Integration (mock runner, real broadcaster):**
- `start` → `wait` end-to-end for all four terminal paths using `MockStageExecutor` that synthesizes broadcaster events
- Two concurrent `start_pipeline_generator` calls → independent taskIds, independent wait subscriptions

**Not tested here:**
- Real Claude SDK path (covered by `pg-real-e2e-v5` in converter-extension milestone)
- HTTP route `kernel-run.ts` (existing tests cover; loader extraction preserves behavior)

## 10. Boundaries & Non-Goals

- **No recursive self-trigger:** pipeline-generator running a nested pipeline-generator is not supported. The `in-pipeline` surface does not expose these tools.
- **No stream:** wait returns a single terminal response. Callers needing real-time progress should use the SSE endpoint (`/api/kernel-next/tasks/:taskId/stream`); MCP stdio isn't the right transport for streaming.
- **No multi-user isolation:** single-user local tool; taskIds are UUIDs, no tenant scoping.
- **No persistence across server restart:** if the server restarts while a task is running, `wait_pipeline_result` will return `running` (broadcaster in-memory) or `error` depending on state; caller can consult SQLite via existing `get_task_status` tool to recover. Out of scope to improve here.

## 11. Self-Review Checklist

- [ ] §1 Success criteria 1 (external Claude Code end-to-end start)
- [ ] §1 Success criteria 2 (four terminal shapes)
- [ ] §1 Success criteria 3 (gate transparent, answer_gate usable)
- [ ] §1 Success criteria 4 (taskDescription seed wires correctly)
- [ ] §1 Success criteria 5 (HTTP route regression-free)
- [ ] Shared loader extracted, both consumers use it
- [ ] External surface includes new tools; internal/in-pipeline do not
- [ ] All four wait shapes unit-tested
- [ ] Concurrent start/wait integration test passes
- [ ] Pipeline YAML hash changes logged (new external_inputs changes versionHash — expected and fine)
