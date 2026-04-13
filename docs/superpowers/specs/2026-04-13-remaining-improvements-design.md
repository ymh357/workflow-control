# Remaining Improvements Design Spec

> Date: 2026-04-13
> Status: Ready for implementation in a new session
> Prerequisites: All Phase 1-2 changes committed (see git log)

This document covers the 5 remaining improvements that were deferred during the initial implementation session. Each is designed without cost shortcuts -- the "right way" to do it.

---

## Overview

| # | Feature | Priority | Est. Files | Dependency |
|---|---------|----------|-----------|------------|
| R1 | Intelligent Context: Cross-Pipeline Memory | High | 6 new + 3 modify | None |
| R2 | Intelligent Context: Dynamic Fragment Selection | High | 2 modify | R1 |
| R3 | Stage Execution Timeout + Heartbeat | High | 4 modify + 1 new | None |
| R4 | Parallel Group Transactional Store | Medium | 2 modify | None |
| R5 | DAG Scheduling (depends_on) | Medium | 3 modify | R4 recommended |

Recommended execution order: R1 → R2 → R3 → R4 → R5

---

## R1: Cross-Pipeline Memory (Production Side)

### Problem

Every pipeline run starts from zero context. The 100th run of `linear-dev-cycle` injects the exact same fragments as the 1st. Project-specific patterns discovered during execution (naming conventions, preferred libraries, architectural decisions, common failure modes) are lost when the pipeline completes.

### Design

**Memory extraction pipeline**: After a pipeline completes, a lightweight LLM call extracts key discoveries from the execution history and agent outputs, appending them to a persistent memory store.

**Data model**:

```
{projectRoot}/.workflow/memory/
  discoveries.jsonl          # append-only, one discovery per line
  entity-stats.json          # file/module access frequency across runs
```

**Discovery schema**:

```typescript
interface Discovery {
  id: string;                    // ulid or similar
  pipelineName: string;
  taskId: string;
  extractedAt: string;           // ISO timestamp
  category: "pattern" | "convention" | "decision" | "failure_mode" | "dependency";
  content: string;               // 1-3 sentences
  relevance: string[];           // keywords for matching (e.g., ["testing", "vitest"])
  confidence: number;            // 0-1, LLM self-assessed
}
```

**Entity stats schema**:

```typescript
interface EntityStats {
  entities: Record<string, {
    type: "file" | "module" | "api" | "pattern";
    accessCount: number;
    lastAccessed: string;
    stages: string[];            // which stages accessed this entity
  }>;
}
```

**Extraction trigger**: Register a new side-effect handler for `wf.slackCompleted` (already exists, just extend). After completion notification, fire async extraction:

```typescript
// New file: apps/server/src/agent/memory-extractor.ts

export async function extractMemory(taskId: string, context: WorkflowContext): Promise<void> {
  // 1. Collect inputs for extraction:
  //    - context.executionHistory (what stages ran)
  //    - context.store (all stage outputs)
  //    - context.stageTokenUsages (cost data)
  //    - events.jsonl for this task (decision timeline)

  // 2. Build extraction prompt:
  //    "Given this pipeline execution, extract 3-5 key discoveries..."
  //    Include: stage outputs (truncated), error history, retry patterns

  // 3. Call Anthropic API with haiku/sonnet (cost-efficient):
  //    - model: claude-haiku-4-5-20251001
  //    - max_tokens: 500
  //    - Structured output: array of Discovery objects

  // 4. Append discoveries to .workflow/memory/discoveries.jsonl

  // 5. Update entity stats:
  //    - Parse store keys to identify files/modules referenced
  //    - Increment access counts in entity-stats.json
}
```

**Entity tracking**: During stage execution, track which files the agent reads/writes. The stream processor already emits `agent_tool_use` events with tool names like `Read`, `Edit`, `Glob`. Parse these to build entity access patterns:

```typescript
// In stream-processor.ts, within the message iteration loop:
// When tool_use is "Read" or "Edit", extract file path from input
// Accumulate in a per-stage file access set
// After stage completes, pass to entity tracker
```

**Integration with side-effects.ts**:

```typescript
actor.on("wf.slackCompleted", (event) => {
  // existing notification code...
  
  // Async memory extraction (fire-and-forget)
  const actor = getWorkflow(event.taskId);
  if (actor) {
    const context = actor.getSnapshot().context;
    extractMemory(event.taskId, context).catch(err => {
      taskLogger(event.taskId).warn({ err }, "memory extraction failed (non-blocking)");
    });
  }
});
```

### Files

| File | Action | Description |
|------|--------|-------------|
| `apps/server/src/agent/memory-extractor.ts` | Create | Core extraction logic + Anthropic API call |
| `apps/server/src/agent/memory-store.ts` | Create | Read/write discoveries.jsonl + entity-stats.json |
| `apps/server/src/agent/memory-extractor.test.ts` | Create | Tests with mocked LLM responses |
| `apps/server/src/agent/memory-store.test.ts` | Create | JSONL append/read + entity stats CRUD |
| `apps/server/src/machine/side-effects.ts` | Modify | Wire extraction on pipeline completion |
| `apps/server/src/agent/stream-processor.ts` | Modify | Track file access entities during execution |

### Edge Cases

- **First run**: discoveries.jsonl doesn't exist yet, created on first write
- **Extraction failure**: LLM call fails silently, logged as warning, no impact on pipeline
- **Large stores**: Extraction prompt truncates store values to 2000 chars per key
- **Concurrent pipelines**: JSONL append is safe for concurrent writes on same file
- **Memory growth**: Add configurable retention (default: last 100 discoveries, FIFO eviction)

---

## R2: Dynamic Fragment Selection (Consumption Side)

### Problem

Fragments are currently matched by static keywords declared in YAML frontmatter. A fragment about "vitest testing patterns" only activates if the pipeline designer explicitly adds `testing` to `enabledSteps`. The memory system (R1) produces discoveries, but there's no mechanism to inject them into future pipeline runs.

### Design

**New fragment source type**: `memory`

```yaml
# Pipeline YAML
knowledge_fragments:
  - coding-standards            # existing: static fragment reference
  - source: memory              # NEW: dynamic from memory store
    max_tokens: 500
    strategy: recent            # recent | relevant | hot_entities
```

**Resolution strategies**:

- `recent`: Last N discoveries from discoveries.jsonl, FIFO, token-limited
- `relevant`: Match discovery `relevance` keywords against current stage's `enabledSteps` and pipeline name
- `hot_entities`: From entity-stats.json, list most-accessed files/modules as context

**Integration point**: `resolveFragmentsFromSnapshot()` in prompt-builder.ts.

Currently, this function only resolves fragments from the pre-loaded snapshot. Extend it to also resolve memory-based fragments:

```typescript
// In prompt-builder.ts, after standard fragment resolution:

function resolveMemoryFragments(
  stageName: string,
  enabledSteps: string[] | undefined,
  memoryConfig: { source: "memory"; max_tokens: number; strategy: string },
  worktreePath: string | undefined,
): { id: string; content: string }[] {
  if (!worktreePath) return [];
  
  const memoryDir = join(worktreePath, ".workflow", "memory");
  
  if (memoryConfig.strategy === "recent") {
    const discoveries = loadRecentDiscoveries(memoryDir, memoryConfig.max_tokens);
    return [{ id: "__memory_recent", content: formatDiscoveries(discoveries) }];
  }
  
  if (memoryConfig.strategy === "relevant") {
    const discoveries = loadRelevantDiscoveries(memoryDir, enabledSteps, memoryConfig.max_tokens);
    return [{ id: "__memory_relevant", content: formatDiscoveries(discoveries) }];
  }
  
  if (memoryConfig.strategy === "hot_entities") {
    const entities = loadHotEntities(memoryDir, memoryConfig.max_tokens);
    return [{ id: "__memory_entities", content: formatEntities(entities) }];
  }
  
  return [];
}
```

**Formatted output injected into tier-1 context**:

```
## Project Memory (auto-accumulated from previous runs)

- [pattern] This project uses vitest with describe/it style, not test() (confidence: 0.9)
- [convention] API routes follow /api/v1/{resource} naming (confidence: 0.85)
- [decision] Chose Hono over Express for REST API due to edge runtime support (confidence: 0.95)
```

### Files

| File | Action | Description |
|------|--------|-------------|
| `apps/server/src/agent/prompt-builder.ts` | Modify | Add memory fragment resolution after standard fragments |
| `apps/server/src/agent/context-builder.ts` | Modify | Inject memory context into tier-1 if configured |

### Dependency

R1 must be implemented first (provides the memory data that R2 consumes).

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
