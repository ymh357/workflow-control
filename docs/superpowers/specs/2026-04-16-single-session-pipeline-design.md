# Single Session Pipeline Mode Design

## Goal

Enable pipelines to execute all agent stages within a single Claude SDK session, eliminating redundant context injection between stages and preserving full conversation history. Activated per-pipeline via `session_mode: "single"` in pipeline.yaml. Default behavior (`session_mode: "multi"` or omitted) is unchanged.

## Architecture

Uses V1 `query()` with `AsyncIterable<SDKUserMessage>` prompt to maintain a persistent session. Each stage yields a new user message into the same query process. XState state machine retains full control of stage flow, guards, retries, and transitions. A new `SessionManager` class manages the shared query lifecycle, while each stage's XState invoke calls into it rather than creating an independent query.

## Tech Stack

- Claude Agent SDK V1 `query()` with `AsyncIterable` prompt and runtime controls (`setModel`, `setMcpServers`, `setPermissionMode`, `interrupt`)
- XState (unchanged state machine structure)
- TypeScript

---

## 1. Configuration

### pipeline.yaml

```yaml
name: My Pipeline
session_mode: single           # optional, default: "multi"
engine: claude                  # required when session_mode: single
session_idle_timeout_sec: 7200  # optional, default: 7200 (2h). Query closed after this idle period.
stages: [...]
```

### PipelineConfig type

```typescript
export interface PipelineConfig {
  name: string;
  session_mode?: "multi" | "single";       // new, default "multi"
  session_idle_timeout_sec?: number;        // new, default 7200
  // ... rest unchanged
}
```

### Validation rules

- `session_mode: "single"` requires `engine: "claude"` (or omitted, defaulting to claude). Gemini/codex/mixed are not supported — pipeline validation rejects with a clear error.
- `session_idle_timeout_sec` only applies when `session_mode: "single"`. Ignored otherwise.
- All other pipeline.yaml fields are unchanged and optional as before.

---

## 2. Execution Architecture

### Current (multi session)

```
XState state A → invoke runAgent → query({prompt: string}) → result → onDone
XState state B → invoke runAgent → query({prompt: string}) → result → onDone
```

Each stage = independent query process = independent session.

### New (single session)

```
XState state A → invoke runAgentSingleSession → SessionManager.executeStage() → result → onDone
XState state B → invoke runAgentSingleSession → SessionManager.executeStage() → result → onDone
```

All agent stages share a single query process via SessionManager. XState still controls every stage transition, guard, retry, and action.

### Key invariant

`SessionManager.executeStage()` returns the same `AgentResult` shape as the existing `runAgent()`. Therefore all XState onDone guards and actions (writes validation, assertions, retry, back_to, verify_commands, cost accumulation) work without modification.

---

## 3. SessionManager

### Location

New file: `src/agent/session-manager.ts`

### Class structure

```typescript
class SessionManager {
  // Query lifecycle
  private query: Query | null = null;
  private queryIterator: AsyncIterator<SDKMessage> | null = null;
  private inputQueue: AsyncQueue<SDKUserMessage>;
  private sessionId: string | undefined;
  private queryClosed: boolean = false;

  // Cost/usage differential tracking
  private cumulativeCostUsd: number = 0;
  private cumulativeUsage: { input: number; output: number; cacheRead: number };

  // Stage-level soft limits
  private stageTurnCount: number = 0;

  // Incremental context tracking
  private knownStoreKeys: Set<string> = new Set();

  // Idle timeout
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly idleTimeoutMs: number;  // from pipeline config, default 2h

  // Pipeline config (for fragment superset, subagent pre-scan, etc.)
  private pipelineConfig: PipelineConfig;
}
```

### Core method: executeStage

```typescript
async executeStage(params: {
  taskId: string;
  stageName: string;
  tier1Context: string;
  stagePrompt: string;
  stageConfig: { model?; mcpServices; permissionMode; maxTurns; maxBudgetUsd; thinking };
  resumeInfo?: { feedback: string };
  worktreePath: string;
  interactive: boolean;
  runtime: AgentRuntimeConfig;
  context: WorkflowContext;
  parallelGroup?: ParallelGroupConfig;
}): Promise<AgentResult>
```

#### First call (query does not exist)

1. Build `Options`: systemPrompt (with fragment superset), mcpServers, model, canUseTool (always enabled), permissionMode, env, hooks, abortController.
2. Create `this.inputQueue = new AsyncQueue()`.
3. `this.query = query({ prompt: this.inputQueue, options })`.
4. Build full stage prompt (Tier 1 context + stage-specific prompt + output schema).
5. `this.inputQueue.enqueue(buildUserMessage(prompt))`.
6. `consumeUntilResult()` — returns AgentResult with differential cost.

#### Subsequent calls (query exists)

1. Dynamic config switching (only if changed from previous stage):
   - `await this.query.setModel(stageConfig.model)`
   - `await this.query.setMcpServers(newMcpConfig)`
   - `await this.query.setPermissionMode(stageConfig.permissionMode)`
2. Build **incremental** stage prompt (no Tier 1 repeat — only new store data from script/external sources + stage-specific prompt + output schema).
3. `this.inputQueue.enqueue(buildUserMessage(prompt))`.
4. `consumeUntilResult()` — returns AgentResult with differential cost.

#### Retry calls (resumeInfo exists, query active)

1. No config switching (same stage).
2. Build feedback prompt from `resumeInfo.feedback`.
3. `this.inputQueue.enqueue(buildUserMessage(feedbackPrompt))`.
4. `consumeUntilResult()` — returns AgentResult.

#### Idle timeout recovery (query was closed)

If the query was closed by idle timeout (e.g., during long human_confirm wait), the next executeStage call detects `this.queryClosed === true` and creates a new query with `resume: this.sessionId` to reload conversation history, then continues as a "first call" but with session continuity.

### consumeUntilResult

**Critical:** Must use manual `.next()` iteration, NOT `for await`. `for await ... break/return` calls the generator's `return()` method, which closes the transport and kills the session.

```typescript
private async consumeUntilResult(params: {
  taskId: string;
  stageName: string;
  maxTurns: number;
  maxBudgetUsd: number;
}): Promise<AgentResult> {
  if (!this.queryIterator) {
    this.queryIterator = this.query![Symbol.asyncIterator]();
  }

  this.stageTurnCount = 0;
  let resultText = "";

  while (true) {
    const { value: message, done } = await this.queryIterator.next();
    if (done) throw new Error("Query ended unexpectedly");

    // Reset idle timer on each message
    this.resetIdleTimer();

    // SSE event forwarding (same events as multi-session)
    this.emitSSE(params.taskId, params.stageName, message);

    // Session ID capture
    if (message.session_id && !this.sessionId) {
      this.sessionId = message.session_id;
    }

    // Process by message type
    switch (message.type) {
      case "assistant":
        // Extract text, tool_use, thinking — forward via SSE
        // Count tool_use for stage turn tracking
        break;
      case "result":
        // Differential cost calculation
        const stageCost = message.total_cost_usd - this.cumulativeCostUsd;
        this.cumulativeCostUsd = message.total_cost_usd;
        // Differential usage calculation (same pattern)
        return { resultText, sessionId: this.sessionId, costUsd: stageCost, ... };
      case "system":
        // Log system messages
        break;
    }

    // Soft turn limit check
    if (this.stageTurnCount >= params.maxTurns) {
      this.inputQueue.enqueue(buildUserMessage(
        "You have reached the turn limit for this stage. Output your current progress as JSON immediately."
      ));
      // If still running after grace, use this.query.interrupt()
    }
  }
}
```

### AsyncQueue

A simple async queue (equivalent to SDK's internal q4):

```typescript
class AsyncQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolve: ((value: IteratorResult<T>) => void) | null = null;
  private done = false;

  enqueue(item: T): void;
  finish(): void;
  [Symbol.asyncIterator](): AsyncIterator<T>;
}
```

---

## 4. SessionManager Registry

### Location

New file: `src/agent/session-manager-registry.ts`

```typescript
const managers = new Map<string, SessionManager>();

export function getOrCreateSessionManager(taskId: string, config: SessionManagerConfig): SessionManager;
export function getSessionManager(taskId: string): SessionManager | undefined;
export function closeSessionManager(taskId: string): void;
```

### Lifecycle

- **Created:** Lazily on first agent stage invoke for a single-session pipeline.
- **Active:** Entire workflow duration, including idle periods during human_confirm/script/condition stages.
- **Closed:** On workflow terminal state (completed/error/cancelled) via side-effects cleanup.

### Cleanup integration

`src/machine/side-effects.ts`:

```typescript
actor.on("wf.streamClose", (event) => {
  // ... existing cleanup ...
  closeSessionManager(event.taskId);  // new
});

actor.on("wf.cancelAgent", (event) => {
  // ... existing cleanup ...
  closeSessionManager(event.taskId);  // new
});
```

---

## 5. XState Integration

### machine.ts — new actor

```typescript
actors: {
  runAgent: loggedActor("agent", ...),              // unchanged
  runScript: loggedActor("script", ...),             // unchanged
  runEdgeAgent: loggedActor("edge-agent", ...),      // unchanged
  runAgentSingleSession: loggedActor("agent-single", // new
    (input) => runAgentSingleSession(input.taskId, input)),
}
```

### state-builders.ts — invoke src selection

```typescript
// buildAgentState
invoke: {
  src: resolveAgentSrc(stage, pipelineSessionMode),
  input: ({ context }) => ({ ... }),  // unchanged
  onDone: [ ... ],                    // unchanged
  onError: [ ... ],                   // unchanged
}

function resolveAgentSrc(
  stage: AgentStageConfig,
  sessionMode: "multi" | "single" | undefined,
): string {
  if (stage.execution_mode === "edge" || stage.execution_mode === "any")
    return "runEdgeAgent";
  if (sessionMode === "single")
    return "runAgentSingleSession";
  return "runAgent";
}
```

The `pipelineSessionMode` is threaded through from `buildPipelineStates` → `buildAgentState`. This requires adding a parameter to `buildAgentState` signature.

### pipeline-builder.ts — parallel group branching

```typescript
if (isParallelGroup(entry)) {
  if (pipeline.session_mode === "single") {
    states[entry.parallel.name] = buildSingleSessionParallelState(
      entry.parallel, nextStateName, prevAgentState, pipeline
    );
  } else {
    states[entry.parallel.name] = buildParallelGroupState(
      entry.parallel, nextStateName, prevAgentState
    );
  }
}
```

### Unchanged XState components

- `buildHumanGateState` — no changes. Human gates still wait for CONFIRM/REJECT events.
- `buildScriptState` — no changes. Scripts still invoke `runScript`.
- `buildConditionState` — no changes. Pure XState transitions.
- `buildLlmDecisionState` — no changes.
- All onDone guards and actions — no changes. AgentResult shape is identical.

---

## 6. Parallel Group in Single Session Mode

### Strategy

Single-session parallel groups generate a single invoke state (not XState parallel). The invoke calls `SessionManager.executeParallelGroup()`, which yields a prompt instructing the agent to dispatch subagents via the built-in Agent tool.

### buildSingleSessionParallelState

Generates a standard agent-like invoke state with combined writes from all child stages:

```typescript
function buildSingleSessionParallelState(group, nextTarget, prevAgentTarget, pipeline) {
  const combinedWrites = [];
  for (const stage of group.stages) {
    const runtime = stage.runtime as AgentRuntimeConfig;
    if (runtime?.writes) combinedWrites.push(...runtime.writes);
  }

  return {
    entry: statusEntry(group.name),
    invoke: {
      src: "runAgentSingleSession",
      input: ({ context }) => ({
        taskId: context.taskId,
        stageName: group.name,
        parallelGroup: group,
        worktreePath: context.worktreePath ?? "",
        tier1Context: buildTier1Context(context, { writes: combinedWrites }, ...),
        runtime: { engine: "llm", system_prompt: "", writes: combinedWrites },
        context,
      }),
      onDone: [
        // Reuse standard writes validation guards with combinedWrites
        // Retry reenter on missing writes
        // No back_to (not applicable for parallel groups)
      ],
      onError: handleStageError(group.name),
    },
  };
}
```

### SessionManager.executeParallelGroup

```typescript
private async executeParallelGroup(params): Promise<AgentResult> {
  // 1. Set MCP servers to union of all child stage MCPs
  const allMcps = new Set<string>();
  for (const stage of params.parallelGroup.stages) {
    for (const mcp of stage.mcps ?? []) allMcps.add(mcp);
  }
  await this.query!.setMcpServers(buildMcpConfig([...allMcps]));

  // 2. Build parallel dispatch prompt
  const prompt = buildParallelDispatchPrompt(params.parallelGroup);

  // 3. Yield prompt and consume until result
  this.inputQueue.enqueue(buildUserMessage(prompt));
  return this.consumeUntilResult(params);
}
```

### Parallel dispatch prompt

Instructs the agent to use the built-in Agent tool (`subagent_type: "general-purpose"`) to dispatch each child task in parallel (multiple Agent tool calls in a single message). Each subagent gets the child stage's full system prompt, relevant context, and output schema. The main agent combines all subagent results into a single JSON object matching the combined writes.

### MCP handling

Before dispatch: `setMcpServers` to union of all child MCPs (subagents inherit parent's MCP set).
After dispatch: next stage's `executeStage` will call `setMcpServers` again with its own MCP set.

### Writes validation

The combined JSON output flows through standard XState onDone guards. `combinedWrites` includes all child stages' write declarations, so the guard checks all keys are present. Retry on missing keys works as normal.

---

## 7. Human Confirm in Single Session Mode

### No code changes to human gate

`buildHumanGateState` is unchanged. It generates an XState state that waits for CONFIRM/REJECT/REJECT_WITH_FEEDBACK events.

### Session behavior during gate

- Query process idles (no pending user messages in inputQueue).
- SessionManager starts idle timer.
- If gate resolves within timeout: next agent stage calls `executeStage()`, session resumes.
- If gate exceeds idle timeout: SessionManager closes query. Next agent stage detects `queryClosed`, creates new query with `resume: sessionId`.

### REJECT_WITH_FEEDBACK

XState sets `resumeInfo: { sessionId, feedback }` and transitions to feedbackTarget. The target stage's invoke calls `SessionManager.executeStage()`, which detects resumeInfo and yields feedback as a new user message. Agent has full conversation history and can fix issues directly.

---

## 8. Incremental Prompt Construction

### First agent stage

Full content:
- Complete Tier 1 context (via `buildTier1Context`)
- Stage-specific system prompt
- Output schema (via `generateSchemaPrompt`)
- Fragments (superset for entire pipeline, included in systemPrompt.append at query init)

### Subsequent agent stages

Incremental content only:
- Stage transition header: `--- Stage: [name] ---`
- New store data (keys not in `knownStoreKeys`) — from script stages or external writes
- Stage-specific system prompt
- Output schema
- No Tier 1 repeat (already in conversation history)

### System prompt (systemPrompt.append)

Set once at query initialization. Contains the superset of all fragments the pipeline might need (resolved from all stage keywords). Subsequent stages do not modify systemPrompt — it is cached by the API for prompt cache efficiency.

---

## 9. SDK Constraints and Mitigations

### outputFormat cannot be changed dynamically

`Options.outputFormat` is set at query init and cannot be switched between stages. Different stages may have different output schemas.

**Mitigation:** Do not use SDK `outputFormat` in single-session mode. Output schema enforcement is done via prompt-level JSON schema instructions (already implemented via `generateSchemaPrompt`). Workflow-layer JSON parsing and writes validation provides the same correctness guarantee.

### maxTurns / maxBudgetUsd are session-level

Cannot set per-stage hard limits.

**Mitigation:**
- Set session-level maxTurns/maxBudgetUsd to the sum of all stages (or a large ceiling).
- SessionManager tracks per-stage turn count and cost via differential calculation.
- Soft limit: when a stage exceeds its configured limit, yield a "stop and report" message.
- Hard limit fallback: `query.interrupt()` to forcefully stop the current turn.

### setMcpServers only affects dynamically-added servers

Servers set via `Options.mcpServers` at init time cannot be removed by `setMcpServers`.

**Mitigation:** Initialize query with minimal MCP set (or empty). All stage-specific MCPs are added/removed via `setMcpServers` between stages.

---

## 10. File Change Summary

### New files

| File | Responsibility |
|------|----------------|
| `src/agent/session-manager.ts` | SessionManager class, AsyncQueue, prompt building |
| `src/agent/session-manager-registry.ts` | Per-task registry, lifecycle management |

### Modified files

| File | Change | Backward compatible |
|------|--------|-------------------|
| `src/lib/config/types.ts` | Add `session_mode?` and `session_idle_timeout_sec?` to PipelineConfig | Optional fields, defaults preserved |
| `src/lib/config/schema.ts` | Add session_mode and session_idle_timeout_sec to YAML validation | New optional fields |
| `src/machine/machine.ts` | Add `runAgentSingleSession` actor | New actor, existing untouched |
| `src/machine/pipeline-builder.ts` | Branch on session_mode for parallel groups | Multi-session path unchanged |
| `src/machine/state-builders.ts` | `buildAgentState` invoke src selection; add `pipelineSessionMode` param | Only affects src string; onDone/onError unchanged |
| `src/machine/side-effects.ts` | Add `closeSessionManager` to streamClose and cancelAgent | One-line additions |
| `src/agent/executor.ts` | Add `runAgentSingleSession` function | New export, existing functions untouched |

### Unchanged files

All existing pipeline.yaml files, stage-executor.ts, stream-processor.ts, query-options-builder.ts, context-builder.ts, prompt-builder.ts, all XState onDone guards/actions.

---

## 11. Backward Compatibility Guarantee

1. **No session_mode field** → default "multi" → all code paths unchanged → zero behavior change.
2. **XState guards/actions** → consume identical AgentResult shape → no modification needed.
3. **SSE events** → SessionManager emits same event types → frontend unaware of session mode.
4. **Session persistence** → same sessionId mechanism → resume from UI works.
5. **Cancel** → closeSessionManager added to cancel handler → clean shutdown.
6. **Cost tracking** → differential calculation produces per-stage cost matching existing contract.
7. **All existing pipelines** → no yaml changes needed, continue to work as-is.
