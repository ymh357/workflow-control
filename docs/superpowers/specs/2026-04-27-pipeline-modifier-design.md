# pipeline-modifier — Design

**Date:** 2026-04-27
**Status:** Draft → ready for plan
**Owner:** kernel-next builtin pipeline subsystem
**Roadmap anchor:** Phase 6 dogfood-readiness; closes the loop on B-series (B1–B22) by giving AI a way to *use* `propose_pipeline_change` in production.

## 1. Goal

Add a new builtin pipeline `pipeline-modifier` that lets an upstream agent (Claude Code main session, or another pipeline) hand off the task "modify pipeline X to do Y" and get back either an auto-applied hot-update or a proposalId waiting for human approval.

This is the *first production user* of Stage 5A/5B/5E (`propose_pipeline_change` / `approve_proposal` / `migrate_task`). Without it, the hot-update infrastructure is technically complete but never invoked autonomously.

## 2. Non-goals

- No UI for proposal review (B5 deferred to Phase 6 separately).
- No batch / multi-target modification — one pipeline per task.
- No automatic rollback — `rollback_hot_update` exists but stays opt-in, called by upstream when modifier reports a regression.
- No patch templates / cookbook — LLM derives patch from current IR, per roadmap §1.1 "AI-mediated DSL".
- No self-modification — pipeline-modifier rejects `targetPipelineName === "pipeline-modifier"`.

## 3. Why a new builtin (not extending pipeline-generator)

`pipeline-generator` today is creation-only (single externalInput `taskDescription`, terminal stage calls `submit_pipeline`). Forcing it to also handle modification means every stage's prompt branches on mode, and the design/test matrix doubles. Per CLAUDE.md "smaller focused files" and roadmap §10 "one step at a time independently shippable", a separate builtin is cheaper to build, prompt, and test.

Per roadmap §2.4, pipeline-ization is justified when the task is multi-stage + needs gates + needs replayability. Pipeline modification clears all three: read IR → analyze → human gate → patch → apply, with replayability mattering when an apply step fails and we need to retry just that stage.

## 4. External inputs

```typescript
{
  targetPipelineName: string;       // required — the pipeline to modify
  modificationGoal: string;         // required — natural-language description
  failureContext?: {                // optional — for failure-driven modification
    taskId?: string;
    failedStageName?: string;
    errorMessage?: string;
    executionRecordId?: string;
  };
}
```

`failureContext` enables the dogfood loop: when a pipeline run fails, the upstream agent passes `taskId` (minimum) and modifier's first stage queries execution_records / stage_attempts / lineage to assemble the analysis bundle itself. Without it, the upstream agent would need to re-narrate "why we want this change" each time, wasting tokens and losing fidelity.

## 5. Stages

```
loadCurrent (agent)
  → analyzeGap (agent)
  → awaitingConfirm (gate)
  → genPatch (agent)
  → applying (agent)
```

**Note on loadCurrent stage type:** Originally drafted as ScriptStage for determinism. Changed to AgentStage after investigation revealed `ScriptModuleContext` does not expose a database handle (apps/server/src/kernel-next/runtime/script-module-resolver.ts:29-43). Threading `db` into the script context would touch every script callsite — out of scope for this feature. AgentStage with a tightly-scoped prompt (call exactly N MCP tools, emit fixed schema) is the next-best deterministic surface.

### 5.1 `loadCurrent` (AgentStage)

Tightly-scoped agent stage. Prompt instructs the model to call a fixed sequence of MCP tools and emit a fixed-shape JSON via `write_port`. No room for "creative" exploration.

**Inputs:** `targetPipelineName`, `failureContext?`
**Outputs:** `currentVersionHash`, `currentIr`, `currentPromptsMap`, `failureBundle?`

**Required tool sequence (encoded in the system prompt):**
1. If `targetPipelineName === "pipeline-modifier"` → emit diagnostic `MODIFIER_SELF_MODIFY_REJECTED` via `write_port` to a `loadError` port and stop. (Stage marks itself failed via diagnostic.)
2. Call **`get_pipeline_definition({ name: targetPipelineName })`** (NEW MCP tool — see §7) → expect `{ ok, versionHash, ir, prompts }`. If `ok=false`, emit diagnostic `MODIFIER_TARGET_UNKNOWN` and stop.
3. Write `currentVersionHash`, `currentIr`, `currentPromptsMap` to ports.
4. If `failureContext?.taskId` is non-null:
   a. Call `get_task_status({ taskId })` to confirm task exists; if not, emit `failureBundle = null` and finish.
   b. Call `query_lineage({ taskId, versionHash: currentVersionHash, stage: failureContext.failedStageName ?? <auto-detect via get_task_status>, port: <each output port> })` to retrieve port previews.
   c. Call `wait_for_task_event({ taskId, events: ["stage_error", "terminal"], timeoutMs: 0 })` (timeoutMs=0 means non-blocking peek of latest event) — extract `stage`, `reason`, `message`.
   d. Assemble `failureBundle = { failedStage, errorMessage, lineagePreview }` and write to port.
5. If `failureContext` is null entirely → write `failureBundle = null`.

**Why an agent for what looks deterministic:** because step 4b/4c involve choosing which ports to query when `failedStageName` isn't given (need to look up failed stage from task status first, then enumerate its outputs). Pure script with hardcoded SQL would work but requires `db` access scripts don't have. Agent is the cheapest path that respects current contracts.

### 5.2 `analyzeGap` (AgentStage)

**Inputs:** `currentIr`, `currentPromptsMap`, `modificationGoal`, `failureBundle?`, `rejectionFeedback?` (loop-back from gate)
**Outputs:**
- `gapAnalysis`: structured `{ currentShapeSummary, intendedChanges[], affectedStages[], risks[] }`
- `proposedChangeOutline`: NL description of "what I plan to do"
- `expectedSafeRange`: `"safe" | "structural" | "unknown"` (agent's prediction; final verdict comes from dry-run in genPatch)

**Tools available via `__kernel_next__`:** `query_lineage`, `compare_runs`, `read_port`, `describe_pipeline` — used only when `failureBundle` is non-null to gather more context.

**Discipline rule in prompt:** **only intent, no IR patch yet.** The patch is genPatch's job. This separation means a rejected gate doesn't waste the patch-generation tokens.

### 5.3 `awaitingConfirm` (GateStage)

Mirrors pipeline-generator's gate. Binary: `approve` → genPatch | `reject` → re-route to analyzeGap with `rejectionFeedback`.

This is the mandatory human (or upstream agent) checkpoint. Per roadmap §2.4, "needs gate" is a defining criterion for pipeline-ization. AI-driven pipeline modification without an approval gate would be unsafe.

### 5.4 `genPatch` (AgentStage)

**Inputs:** `gapAnalysis`, `proposedChangeOutline`, `currentIr`, `currentPromptsMap`, `currentVersionHash`, `failureBundle?`
**Outputs:**
- `patch`: shape-compatible with `propose_pipeline_change.patch`
- `rerunFrom?`: stage name where re-execution should resume after migration; agent decides
- `migrateRunningTasks`: defaults to `"none"`. If `failureBundle?.taskId` present, defaults to `[failureBundle.taskId]`
- `prompts?`: prompt content map for any new/changed `promptRef`
- `dryRunVerdict`: `"safe" | "unsafe" | "structural"` from final dry-run

**Required tool flow in prompt:**
1. Construct draft patch.
2. Call `dry_run_proposal({ currentVersion: currentVersionHash, patch, rerunFrom, migrateRunningTasks })`.
3. Read returned `safeRange.verdict`:
   - `"safe"` → emit final `patch` + verdict
   - `"unsafe"` → revise patch (one self-correction loop), re-dry-run; if still unsafe, emit current patch + verdict (let applying decide)
   - structural → emit as-is + verdict (autoApprove will be ignored anyway)

### 5.5 `applying` (AgentStage)

**Inputs:** `patch`, `rerunFrom?`, `migrateRunningTasks`, `currentVersionHash`, `dryRunVerdict`
**Outputs:**
- `proposalId`
- `proposedVersion` (new version_hash returned from propose)
- `outcome`: `"auto-applied" | "pending-approval" | "applied-after-approval" | "rejected" | "failed"`
- `migrationResult?`: `{ migratedTaskIds: string[], errors: Array<{ taskId, message }> }`

**Flow:**
1. Call `propose_pipeline_change({ currentVersion, patch, actor: "pipeline-modifier-task-{taskId}", rerunFrom, migrateRunningTasks, autoApprove: true })`.
2. Inspect response:
   - `autoApplied === true`:
     - If `migrateRunningTasks` non-empty: for each taskId, call `migrate_task(taskId, proposalId)` — capture errors but do not retry (migrations are idempotent-unfriendly; double-supersede is worse than a left-over un-migrated task).
     - `outcome = "auto-applied"`. Done.
   - `autoApplied === false`:
     - Either structural patch or dry-run not safe.
     - `outcome = "pending-approval"`. Stage terminates successfully. Upstream agent / human takes over via `approve_proposal` + `migrate_task`.
3. If propose call itself fails (e.g. version conflict) → `outcome = "failed"`, error in diagnostic.

**Why split genPatch / applying:**
- Patch lands in `port_values` → audited, replayable via `replay_stage`.
- If applying fails (e.g. migrate_task error), retry just `applying` instead of re-spending tokens on patch generation.
- Aligns with CLAUDE.md "Store writes are final per stage" — patch is genPatch's commitment.

## 6. Error handling matrix

| Failure | Stage | Behavior |
|---|---|---|
| `targetPipelineName` unknown | loadCurrent | fail-fast, diagnostic `MODIFIER_TARGET_UNKNOWN` |
| `targetPipelineName === "pipeline-modifier"` | loadCurrent | fail-fast, diagnostic `MODIFIER_SELF_MODIFY_REJECTED` |
| `failureContext.taskId` not found | loadCurrent | `failureBundle = null`, continue as proactive-improvement |
| dry_run reports unsafe twice | genPatch | emit patch with `dryRunVerdict="unsafe"`, applying treats as pending-approval |
| structural patch | genPatch → applying | autoApprove=true ignored by kernel; `outcome="pending-approval"` |
| `propose_pipeline_change` returns version conflict | applying | `outcome="failed"` |
| `migrate_task` errors after auto-apply | applying | record in `migrationResult.errors`, `outcome="auto-applied"` (proposal still applied; migration is best-effort) |
| Gate rejection loop > N times | n/a | not defended this iteration; matches pipeline-generator current behavior |

## 7. MCP tool surface — one new tool required

### 7.1 New tool: `get_pipeline_definition`

`describe_pipeline` returns the IR shape but strips out prompt content (only returns `promptRef` names). For `loadCurrent` and `analyzeGap` to reason about the target pipeline's current behavior, the prompts' markdown text is essential — otherwise the agent has to guess what each stage actually does.

```typescript
{
  name: "get_pipeline_definition",
  inputSchema: {
    name: z.string().optional(),
    versionHash: z.string().optional(),
  },
  handler: returns
    | { ok: true; versionHash: string; ir: PipelineIR; prompts: Record<string, string> }
    | { ok: false; diagnostics: Diagnostic[] }
}
```

Resolution:
- If both `name` and `versionHash` given → `versionHash` wins.
- If only `name` → `getLatestVersionHashByName`, then `getPipelineIR`.
- Prompts: query `getPromptsByVersion(db, versionHash)` (already exists in `apps/server/src/kernel-next/ir/sql.ts:637-652`).
- Returned on `combined` and `external` surfaces.

### 7.2 Existing tools used (no changes)

- `get_task_status`, `query_lineage`, `wait_for_task_event` — failure context retrieval in `loadCurrent`
- `dry_run_proposal` — required pre-check in `genPatch`
- `propose_pipeline_change`, `migrate_task` — `applying` stage write path

## 8. Observability

`hot_update_events` rows from `propose_pipeline_change` / `migrate_task` carry `actor = "pipeline-modifier-task-{taskId}"`. B22 `query_hot_update_stats` already aggregates by actor → the dogfood metric "how often does the AI modify each pipeline" is automatic.

No new tables. No new metrics.

## 9. Tests

1. `pipeline.ir.test.ts` — IR parses, stage names match design (loadCurrent → analyzeGap → awaitingConfirm → genPatch → applying), externalInputs schema includes the three required fields. Loose-coupling smoke test.
2. `loadCurrent.test.ts` — script unit test with in-memory SQLite + seeded pipeline_versions + execution_records.
3. End-to-end: simple non-structural patch (e.g. add a field to existing port) → autoApprove → `outcome="auto-applied"`.
4. End-to-end: structural patch (add a new stage) → `outcome="pending-approval"` with proposalId surfaced.
5. End-to-end: failureContext with taskId → assertion that `migrate_task` was called and recorded migrated taskIds.
6. Fail-fast: `targetPipelineName="pipeline-modifier"` → `MODIFIER_SELF_MODIFY_REJECTED`.

## 10. Hard invariants honored

- `Task.pipelineSnapshot` semantics unchanged — modifier itself runs against its own pipelineSnapshot; the *target* pipeline gets a new version_hash row, never modifies existing rows.
- `reads`/`writes` are the only data flow — every stage declares its inputs/outputs in IR; no implicit cross-stage state.
- Append-only versioning preserved — `propose_pipeline_change` already appends to `pipeline_versions`.
- "Never regress already-executed information" — failureBundle is read-only on prior execution_records / port_values; the new modifier task creates its own attempts and lineage.

## 11. File layout (planning anchor)

```
apps/server/src/builtin-pipelines/pipeline-modifier/
├── pipeline.ir.json
├── pipeline.ir.test.ts
└── prompts/system/
    ├── load-current.md
    ├── analyze-gap.md
    ├── gen-patch.md
    └── applying.md

apps/server/src/kernel-next/mcp/tools/
└── get-pipeline-definition.ts                 (NEW MCP tool)

apps/server/src/kernel-next/mcp/tools/get-pipeline-definition.test.ts   (NEW)
apps/server/src/builtin-pipelines/pipeline-modifier/e2e.happy-path.test.ts          (NEW)
apps/server/src/builtin-pipelines/pipeline-modifier/e2e.structural.test.ts          (NEW)
apps/server/src/builtin-pipelines/pipeline-modifier/e2e.migrate-on-failure.test.ts  (NEW)
apps/server/src/builtin-pipelines/pipeline-modifier/e2e.self-modify-rejected.test.ts (NEW)

apps/server/src/routes/kernel-run.ts:135-139   (modify — append "pipeline-modifier")
apps/server/src/kernel-next/mcp/server.ts      (modify — register new tool on combined + external surfaces)
apps/server/src/kernel-next/ir/schema.ts       (modify — add MODIFIER_TARGET_UNKNOWN + MODIFIER_SELF_MODIFY_REJECTED to DiagnosticSchema enum)
```

## 12. Open question deferred to plan stage

- Exact shape of `failureBundle.lineageSummary` — should it inline last-N port_values or just stage-level traversal? Decide during plan when concrete loadCurrent.test.ts gets written.

## 13. Acceptance criteria

- A new builtin pipeline `pipeline-modifier` exists, seeds at server boot, runs via `run_pipeline { name: "pipeline-modifier" }`.
- All 6 tests in §9 pass.
- A manual dogfood scenario: trigger a failed `smoke-test` task → call `pipeline-modifier` with that taskId → either an auto-applied non-structural fix or a `pending-approval` proposalId is returned.
- `query_hot_update_stats({ actor: "pipeline-modifier" })` returns non-zero counts after the dogfood scenario.
- No new tables. **One new MCP tool** (`get_pipeline_definition` — see §7.1). No changes to existing pipelines except adding pipeline-modifier as a sibling under `builtin-pipelines/` and registering its name in `apps/server/src/routes/kernel-run.ts:135-139` alongside the existing 5 builtins.
