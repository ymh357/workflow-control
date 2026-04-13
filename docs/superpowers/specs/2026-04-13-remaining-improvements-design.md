# Remaining Improvements Design Spec

> Date: 2026-04-13
> Status: Ready for implementation in a new session
> Prerequisites: All Phase 1-2 changes committed (see git log)

This document covers the 5 remaining improvements that were deferred during the initial implementation session. Each is designed without cost shortcuts -- the "right way" to do it.

---

## Overview

| # | Feature | Priority | Est. Files | Dependency |
|---|---------|----------|-----------|------------|
| R1 | Store Inheritance + Semantic Summary | High | 4 modify + 1 new | None |
| R2 | Incremental Context Diff on Resume | High | 1 modify | R1 recommended |
| R3 | Stage Execution Timeout + Heartbeat | High | 4 modify + 1 new | None |
| R4 | Parallel Group Transactional Store | Medium | 2 modify | None |
| R5 | DAG Scheduling (depends_on) | Medium | 3 modify | R4 recommended |

Recommended execution order: R1 → R2 → R3 → R4 → R5

### Design Philosophy: Store IS the Memory

Competitive analysis revealed that CrewAI (4-layer memory + RAG), Mastra (observation compression), and CCW (wisdom accumulation) all build separate memory layers on top of their execution engines. But Workflow Control already has the most efficient session-to-session context transfer mechanism: **the store itself**.

Each stage's `reads` declares exactly what context it needs; `writes` declares what it produces. This is zero-noise, declarative, structured memory -- superior to vector search or LLM-extracted discoveries for the pipeline orchestration use case.

The real gaps are:
1. **Store doesn't persist across pipeline runs** (each run starts from empty)
2. **Resume injects full context** even when 99% hasn't changed since last attempt  
3. **Large store values have no semantic compression** (only mechanical `__summary` for >8KB values)

The improvements below address these three gaps by enhancing the existing store + reads/writes mechanism, NOT by adding a new memory layer.

---

## R1: Store Inheritance + Semantic Summary

### Problem

Every pipeline run starts with an empty store. The 100th run of `linear-dev-cycle` on the same project has zero context from the previous 99 runs. Meanwhile, the completed tasks' snapshots sit on disk with fully structured store data.

Additionally, store values passed between stages have no semantic compression. A `plan` with 15KB of markdown is passed wholesale to the `execute` stage's tier-1 context, even though the agent only needs "5 tasks, currently on task 3".

### Design

**1. Store Inheritance**

New pipeline-level YAML config:

```yaml
store_persistence:
  inherit_from: last_completed       # "last_completed" | "none" (default)
  inherit_keys:                      # which keys to carry forward
    - requirements
    - design  
    - conventions
  # Or: inherit_keys: "*" for all keys
```

When a new task launches with `inherit_from: last_completed`:
1. Scan `{dataDir}/tasks/` for the most recent completed task using the same `pipelineName`
2. Load that task's snapshot
3. Extract the declared `inherit_keys` from its `store`
4. Merge into the new task's initial store (before first stage runs)

This is implemented in `actor-registry.ts` `createTaskDraft()`, which already accepts an `initialStore` parameter. The inheritance simply pre-populates it.

**2. Semantic Summary (per-write)**

New optional field on writes declarations:

```yaml
stages:
  - name: plan
    runtime:
      writes:
        - key: tasks
          summary_prompt: "Summarize: how many tasks, what's the overall approach, current progress"
        - key: design          # no summary_prompt = no semantic summary
```

When a stage completes and writes a value with `summary_prompt`:
1. After the value is merged into store
2. Call Anthropic Haiku with `{summary_prompt}\n\nContent:\n{value_truncated_to_4000_chars}`
3. Store the result as `store.{key}.__semantic_summary`
4. Downstream stages' `buildTier1Context` uses `__semantic_summary` when the full value exceeds the token budget, instead of the mechanical field-name-list `__summary`

This replaces the current `__summary` mechanism (which just lists field names + char count) with an LLM-generated semantic compression. The LLM call is async and non-blocking -- if it fails, tier-1 falls back to the existing `__summary` or truncated preview.

**Cost control**: Only runs when `summary_prompt` is explicitly declared. Uses Haiku (cheapest model, ~$0.001 per summary). Cached in store -- regenerated only when the source value changes.

### Files

| File | Action | Description |
|------|--------|-------------|
| `apps/server/src/machine/actor-registry.ts` | Modify | `createTaskDraft`: load and merge inherited store |
| `apps/server/src/machine/state-builders.ts` | Modify | After store write, trigger semantic summary if configured |
| `apps/server/src/agent/semantic-summary.ts` | Create | LLM-based summary generation (Haiku call) |
| `apps/server/src/agent/context-builder.ts` | Modify | Prefer `__semantic_summary` over `__summary` in tier-1 |
| `apps/server/src/lib/config/types.ts` | Modify | Add `summary_prompt` to WriteDeclaration |

### Edge Cases

- **First run**: No previous completed task exists, inheritance skipped silently
- **Store key conflict**: Inherited keys are overwritten by stage writes (current run takes priority)
- **Summary generation failure**: Falls back to existing `__summary` mechanism
- **Sub-pipelines**: Do not inherit from parent pipeline's history (they have their own lifecycle)
- **Foreach items**: Individual items do not trigger semantic summary (only the collected result does)

---

## R2: Incremental Context Diff on Resume

### Problem

When a stage is retried (RETRY_FROM or automatic retry), `buildTier1Context` re-injects the full reads context. For a stage that reads `requirements` (5KB) + `design` (10KB) + `plan` (15KB), that's 30KB of context the agent has already seen. The only new information might be a 200-byte error message. This wastes tokens and dilutes the signal.

### Design

When `context.resumeInfo` exists (indicating a retry/resume), `buildTier1Context` should:

1. Load the preceding stage's checkpoint (from Phase 1 Spec A's event log, or from `stageCheckpoints`)
2. Compare current store values with checkpoint store values for each `reads` key
3. For unchanged values: inject only a one-line reference ("Requirements: unchanged since last attempt")
4. For changed values: inject the full value (or diff if both old and new exist)

```typescript
// In context-builder.ts, buildTier1Context:

if (context.resumeInfo && context.stageCheckpoints?.[currentStage]) {
  const prevStore = context.stageCheckpoints[currentStage].store ?? {};
  
  for (const [label, rawPath] of Object.entries(runtime.reads)) {
    const currentVal = getNestedValue(store, storePath);
    const prevVal = getNestedValue(prevStore, storePath);
    
    if (deepEqual(currentVal, prevVal)) {
      addPart(`### ${label}\n> Unchanged since previous attempt. Use get_store_value("${storePath}") if needed.`);
    } else {
      // Inject full new value (existing logic)
    }
  }
}
```

**Prerequisite**: This requires storing a snapshot of the store at stage entry time in `stageCheckpoints`. The current implementation (from Phase 1 Spec B) only stores `gitHead` and `startedAt`. Extend `StageCheckpoint` to optionally include a store snapshot of the reads keys:

```typescript
interface StageCheckpoint {
  gitHead?: string;
  startedAt: string;
  readsSnapshot?: Record<string, unknown>;  // store values at stage entry for diff comparison
}
```

The `readsSnapshot` is populated in `statusEntry()` by capturing the current store values for the stage's declared reads. This adds ~5-50KB to context per stage but enables precise diff detection on resume.

### Files

| File | Action | Description |
|------|--------|-------------|
| `apps/server/src/agent/context-builder.ts` | Modify | Diff-based injection when resumeInfo present |

### Dependency

Benefits from R1 (semantic summaries give better "unchanged" references), but can be implemented independently.

---

## R3: Stage Execution Timeout + Heartbeat

### Problem

Web mode agent stages have only a 10-minute **inactivity** timeout (in stream-processor.ts). There is no **absolute execution time limit**. If an agent is actively streaming but going in circles, it runs until the cost cap is hit -- which could be $20+ of wasted API calls. Edge mode has `stage_timeout_sec` but web mode doesn't.

Additionally, there is no progress heartbeat. The dashboard shows SSE messages streaming, but there's no structured "this agent has been running for 15 minutes, made 47 tool calls, spent $3.20" status update at regular intervals.

### Design

**1. Stage execution timeout (AbortController)**

Add a top-level `AbortController` to the Claude SDK invocation. Currently, `processAgentStream` in `stream-processor.ts` creates its own inactivity timer. Add a separate absolute timer:

```typescript
// In stage-executor.ts, before query creation:

const executionTimeoutSec = runtime.stage_timeout_sec ?? pipeline.default_stage_timeout_sec ?? 1800;
const abortController = new AbortController();
const absoluteTimer = setTimeout(() => {
  abortController.abort(new Error(`Stage execution timeout after ${executionTimeoutSec}s`));
}, executionTimeoutSec * 1000);

// Pass to query options:
const queryOptions = buildQueryOptions({
  ...existingParams,
  abortSignal: abortController.signal,
});

// Cleanup on completion:
try {
  const result = await processAgentStream(...);
  return result;
} finally {
  clearTimeout(absoluteTimer);
}
```

The `abortSignal` propagates through the Claude SDK's streaming, which respects `AbortSignal` natively. When aborted, `processAgentStream` will throw, which XState's `onError` handles normally (retry or block).

**2. Heartbeat with progress metrics**

In `stream-processor.ts`, add a periodic heartbeat that emits structured progress:

```typescript
// Inside processAgentStream, after registering the query:

const heartbeatInterval = setInterval(() => {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  sseManager.pushMessage(taskId, {
    type: "agent_progress",
    taskId,
    timestamp: new Date().toISOString(),
    data: {
      phase: "heartbeat",
      toolCallCount,
      elapsedSeconds: elapsed,
      tokensSoFar: currentTokenCount,
      costSoFar: currentCostUsd,
      lastToolName: lastToolUse?.name,
      lastToolAt: lastToolUse?.timestamp,
    },
  });
}, 30_000); // Every 30 seconds

// Cleanup:
try { ... } finally {
  clearInterval(heartbeatInterval);
}
```

**3. Timeout approaching warning**

When 80% of execution timeout has elapsed, emit a warning:

```typescript
const warningTimer = setTimeout(() => {
  sseManager.pushMessage(taskId, {
    type: "agent_progress",
    taskId,
    timestamp: new Date().toISOString(),
    data: {
      phase: "timeout_approaching",
      remainingSeconds: Math.floor(executionTimeoutSec * 0.2),
      message: `Stage will timeout in ${Math.floor(executionTimeoutSec * 0.2)}s`,
    },
  });
}, executionTimeoutSec * 0.8 * 1000);
```

**4. Unify timeout config**

Currently `stage_timeout_sec` only exists on `PipelineStageConfig` for edge mode. Make it work for web mode too:

```yaml
stages:
  - name: execute
    type: agent
    stage_timeout_sec: 900    # 15 minutes (applies to both web and edge mode)
```

No new fields needed -- `stage_timeout_sec` already exists in the schema, just not used in web mode.

### Files

| File | Action | Description |
|------|--------|-------------|
| `apps/server/src/agent/stage-executor.ts` | Modify | Add AbortController with configurable timeout |
| `apps/server/src/agent/stream-processor.ts` | Modify | Add heartbeat interval + timeout warning |
| `apps/server/src/agent/query-options-builder.ts` | Modify | Pass abortSignal through to Claude SDK |
| `apps/server/src/agent/stage-executor.test.ts` | Modify | Test timeout and abort behavior |

### Edge Cases

- **Timeout during tool execution**: AbortSignal cancels the HTTP request mid-flight. Claude SDK handles this gracefully (returns partial result or throws).
- **Resume after timeout**: Session ID is persisted before timeout. RETRY will resume the session with feedback about the timeout.
- **Sub-agents**: Each sub-agent inherits the parent stage's remaining timeout budget, not a fresh one.
- **Cost cap vs time cap**: Both can trigger independently. Whichever hits first stops the agent.

---

## R4: Parallel Group Transactional Store

### Problem

In a parallel group, if stage A succeeds and writes to store, but stage B fails, A's writes are already committed. RETRY_FROM targeting the group re-runs both stages, but A's stale output from the failed run remains in the store until overwritten.

This is rarely a problem in practice (writes don't overlap between parallel children -- already validated), but it violates the principle of atomicity: either all parallel stages succeed and their outputs are visible, or none are.

### Design

**Deferred commit pattern**: Instead of each parallel child stage writing directly to `context.store`, writes are buffered in a per-child staging area. Only when ALL children complete successfully does the parent group merge all staged writes into the real store.

**Implementation**:

1. **Add staging area to WorkflowContext**:

```typescript
// In types.ts
interface WorkflowContext {
  // ... existing fields
  parallelStagedWrites?: Record<string, Record<string, unknown>>;
  // groupName → { key: value, ... } accumulated from child stages
}
```

2. **Modify child stage store merge**:

In `state-builders.ts`, when a stage is inside a parallel group (detected by `opts?.statePrefix`), instead of merging to `context.store`, merge to `context.parallelStagedWrites[groupName]`:

```typescript
// In buildAgentState success path, if inside parallel group:
if (opts?.statePrefix) {
  const groupName = opts.statePrefix.replace(/^\./, "");
  return {
    ...otherUpdates,
    parallelStagedWrites: {
      ...context.parallelStagedWrites,
      [groupName]: {
        ...(context.parallelStagedWrites?.[groupName] ?? {}),
        ...updates,
      },
    },
  };
} else {
  return { ...otherUpdates, store: { ...store, ...updates } };
}
```

3. **Commit on group completion**:

In `buildParallelGroupState`'s `onDone` actions, merge all staged writes to the real store:

```typescript
// In onDone actions of parallel group:
assign(({ context }) => {
  const groupName = group.name;
  const staged = context.parallelStagedWrites?.[groupName] ?? {};
  const newStore = { ...context.store };
  applyStoreUpdates(newStore, staged, buildWriteStrategies(/* all child writes */));
  const newStagedWrites = { ...context.parallelStagedWrites };
  delete newStagedWrites[groupName];
  return {
    store: newStore,
    parallelStagedWrites: newStagedWrites,
  };
});
```

4. **Rollback on group failure**:

If any child fails, the group transitions to error/blocked. The staged writes for that group are simply discarded (never committed to store). The `parallelStagedWrites[groupName]` entry is deleted in the error handler.

**Reads during parallel execution**: Children need to read from both `context.store` (committed data from prior stages) AND `context.parallelStagedWrites[groupName]` (their own in-progress writes). Modify `buildTier1Context` to merge both sources when constructing stage input.

### Files

| File | Action | Description |
|------|--------|-------------|
| `apps/server/src/machine/types.ts` | Modify | Add `parallelStagedWrites` to WorkflowContext |
| `apps/server/src/machine/state-builders.ts` | Modify | Child stages write to staging area; group onDone commits |

### Edge Cases

- **Cross-child reads**: If child B needs to read what child A wrote (shouldn't happen in well-designed parallel groups, but possible), it reads from the staging area. This requires `buildTier1Context` to be staging-aware.
- **Nested parallel groups**: Not currently supported (pipeline-builder rejects them). If ever allowed, staging areas would need to be nested.
- **Compensation + transactions**: If a child has `compensation: git_reset`, the git reset runs but store writes are already in staging (not committed). No special handling needed.

---

## R5: DAG Scheduling (depends_on)

### Problem

Currently, parallelism must be explicitly declared via `parallel_group`. The pipeline designer must manually identify which stages can run concurrently and wrap them. This is error-prone and inflexible -- adding a new stage requires re-evaluating the entire parallel group structure.

### Design

**Add `depends_on` field to stage config**:

```yaml
stages:
  - name: analyze_frontend
    type: agent
    depends_on: [requirements]    # can run after requirements completes
    
  - name: analyze_backend
    type: agent
    depends_on: [requirements]    # can also run after requirements
    
  - name: design
    type: agent
    depends_on: [analyze_frontend, analyze_backend]  # waits for both
```

**Automatic parallel group generation**: `pipeline-builder.ts` analyzes the dependency graph and automatically groups stages that can run concurrently into `parallel_group` structures. The existing parallel group machinery handles execution.

**Algorithm**:

```
1. Build DAG from depends_on declarations
2. Topological sort to determine execution levels
3. Stages at the same level with no inter-dependencies form a parallel group
4. Generate parallel_group entries for groups with 2+ stages
5. Feed the transformed pipeline to existing buildPipelineStates()
```

**Compatibility**: If a pipeline uses both `depends_on` and explicit `parallel_group`, reject with a validation error. They are mutually exclusive approaches.

**Validation**:
- Cycle detection in dependency graph
- All `depends_on` targets must reference existing stage names
- A stage with no `depends_on` and no predecessor implicitly depends on the previous stage (preserving linear pipeline behavior for stages without explicit deps)

### Files

| File | Action | Description |
|------|--------|-------------|
| `apps/server/src/machine/pipeline-builder.ts` | Modify | DAG analysis + auto parallel group generation |
| `packages/shared/src/pipeline-validator.ts` | Modify | Validate depends_on references + cycle detection |
| `apps/server/src/lib/config/types.ts` | Modify | Add `depends_on` to PipelineStageConfig |

### Edge Cases

- **Linear fallback**: Stages without `depends_on` execute in declaration order (current behavior preserved)
- **Single-stage "groups"**: If only one stage is at a level, it runs as a normal sequential stage
- **condition + depends_on**: Condition stages can have depends_on. The condition evaluates after its dependencies complete.
- **human_confirm + depends_on**: Human gates are allowed with depends_on (they just wait for dependencies, then pause for approval)

---

## Implementation Notes for Next Session

### Context to Provide

When starting a new session to implement these, provide:
1. This spec file path: `docs/superpowers/specs/2026-04-13-remaining-improvements-design.md`
2. The technical deep dive: `docs/technical-deep-dive.md`
3. The competitive analysis origin: `docs/competitive-analysis.md`

### Key Code Locations

| Component | Path | Purpose |
|-----------|------|---------|
| Prompt assembly | `apps/server/src/agent/prompt-builder.ts` | 6-layer prompt, fragment resolution |
| Context building | `apps/server/src/agent/context-builder.ts` | Tier-1/tier-2 context, token budgeting |
| Fragment loading | `apps/server/src/lib/config/fragments.ts` | Registry, keyword matching, frontmatter |
| Stage execution | `apps/server/src/agent/stage-executor.ts` | Query creation, option building |
| Stream processing | `apps/server/src/agent/stream-processor.ts` | Message iteration, inactivity timeout |
| State builders | `apps/server/src/machine/state-builders.ts` | All stage type builders, store merge |
| Pipeline builder | `apps/server/src/machine/pipeline-builder.ts` | Pipeline → XState state machine |
| Side effects | `apps/server/src/machine/side-effects.ts` | Event handlers, notifications |
| Types | `apps/server/src/machine/types.ts` | WorkflowContext, StageCheckpoint |
| Config types | `apps/server/src/lib/config/types.ts` | Runtime configs, stage configs |
| Config schema | `apps/server/src/lib/config/schema.ts` | Zod validation schemas |
| Validator | `packages/shared/src/pipeline-validator.ts` | Pipeline logical validation |

### Test Baseline

As of 2026-04-13:
- Server tests: 193 files passed, 5 failed (pre-existing), 3401 individual tests passed
- Pre-existing failures are in `cli/lib/github.test.ts`, `cli/lib/fetch.test.ts`, `cli/commands/bootstrap.test.ts`, `cli/commands/publish.test.ts`, `agent/foreach-executor.test.ts`

### Already Completed (This Session)

| Feature | Commit | Files |
|---------|--------|-------|
| Workflow Event Log | `9bc15b9` | workflow-events.ts, event-emitter.ts, side-effects.ts, routes/tasks.ts |
| Git Checkpoint + Compensation | `7a1d340` | git-checkpoint.ts, helpers.ts, machine.ts, pipeline-validator.ts |
| Sub-pipeline Event Subscription | `d345a28` | pipeline-executor.ts |
| writes merge strategy | `42902dd` | state-builders.ts, pipeline-validator.ts, schema.ts, types.ts + 4 more |
| Configurable max_attempts | `98e3bd4` | helpers.ts, schema.ts, pipeline-validator.ts |
| LLM Decision Gate | `a7f6960` | decision-runner.ts, state-builders.ts, stage-registry.ts, machine.ts, pipeline-builder.ts + 4 more |
| Review Fixes (security + quality) | `3bdd3be` | git-checkpoint.ts, decision-runner.ts, event-emitter.ts + 8 more |
