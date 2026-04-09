# Edge Execution Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 6 edge execution issues: slot keepalive/configurable timeout, lightweight schema tool, retry fromStage, submit downstream validation, and explore mode transparency.

**Architecture:** All changes are in `apps/server/src/edge/` and `apps/server/src/actions/`. The slot keepalive extends the existing `report_progress` MCP tool to reset slot timers. `get_stage_schema` is a new lightweight MCP tool. `retry fromStage` adds a `RETRY_FROM` event to the state machine. Submit validation adds a forward-looking check for foreach dependencies. Explore mode transparency filters condition-gated stages from `edgeStages`.

**Tech Stack:** TypeScript, Hono MCP server, XState v5 state machine, SQLite persistence

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `apps/server/src/edge/registry.ts` | Modify | Add `renewSlot()` function, make timeout configurable |
| `apps/server/src/edge/actor.ts` | Modify | Pass stage timeout from pipeline config |
| `apps/server/src/edge/mcp-server.ts` | Modify | Add `get_stage_schema` tool, extend `report_progress` with keepalive, enhance `submit_stage_result` validation, enhance `trigger_task` with stage filtering, add `fromStage` to `retry_task` |
| `apps/server/src/actions/task-actions.ts` | Modify | Add `fromStage` parameter to `retryTask()` |
| `apps/server/src/machine/types.ts` | Modify | Add `RETRY_FROM` event type |
| `apps/server/src/machine/state-builders.ts` | Modify | Handle `RETRY_FROM` event in blocked state |
| `apps/server/src/lib/config/types.ts` | Modify | Add `stage_timeout_sec` to `PipelineStageConfig` |

---

### Task 1: Slot keepalive via `renewSlot()` in registry

**Files:**
- Modify: `apps/server/src/edge/registry.ts:77-130` (createSlot) and new function

- [ ] **Step 1: Add `renewSlot()` function to registry.ts**

After the `rejectSlot` function (around line 188), add:

```typescript
/** Reset the timeout timer for an active slot. Returns true if renewed. */
export function renewSlot(taskId: string, stageName: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): boolean {
  const key = slotKey(taskId, stageName);
  const slot = slots.get(key);
  if (!slot) return false;

  clearTimeout(slot.timeoutTimer);
  slot.timeoutTimer = setTimeout(() => {
    slots.delete(key);
    db().prepare("DELETE FROM edge_slots WHERE task_id = ? AND stage_name = ?").run(taskId, stageName);
    slot.reject(new Error(`Edge slot timed out for ${stageName} (after renewal)`));
  }, timeoutMs);

  return true;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/server/src/edge/registry.ts
git commit -m "feat: add renewSlot() for edge slot keepalive"
```

---

### Task 2: Make slot timeout configurable via pipeline YAML

**Files:**
- Modify: `apps/server/src/lib/config/types.ts:123-150` (PipelineStageConfig)
- Modify: `apps/server/src/edge/actor.ts:7-35` (runEdgeAgent)

- [ ] **Step 1: Add `stage_timeout_sec` to PipelineStageConfig**

In `apps/server/src/lib/config/types.ts`, after the `verify_max_retries` field, add:

```typescript
  // Timeout in seconds for edge execution of this stage. Default: 1800 (30 min).
  stage_timeout_sec?: number;
```

- [ ] **Step 2: Pass configured timeout to createSlot in actor.ts**

In `apps/server/src/edge/actor.ts`, change the hardcoded timeout to read from stage config:

```typescript
const DEFAULT_EDGE_TIMEOUT_MS = 30 * 60 * 1000;

export async function runEdgeAgent(
  taskId: string,
  input: { stageName: string; runtime: AgentRuntimeConfig; context?: WorkflowContext; worktreePath: string; tier1Context: string; enabledSteps?: string[]; attempt: number; resumeInfo?: { sessionId: string; feedback?: string; sync?: boolean } },
): Promise<AgentResult> {
  // Read stage_timeout_sec from pipeline config if available
  const pipelineStages = input.context?.config?.pipeline?.stages;
  const stageConf = pipelineStages
    ? flattenStages(pipelineStages).find((s) => s.name === input.stageName)
    : undefined;
  const timeoutMs = stageConf?.stage_timeout_sec
    ? stageConf.stage_timeout_sec * 1000
    : DEFAULT_EDGE_TIMEOUT_MS;

  // ... existing SSE message logic ...

  return createSlot(taskId, input.stageName, timeoutMs);
}
```

Add the needed import at the top:
```typescript
import { flattenStages } from "../lib/config/types.js";
```

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/lib/config/types.ts apps/server/src/edge/actor.ts
git commit -m "feat: configurable edge slot timeout via stage_timeout_sec"
```

---

### Task 3: Wire keepalive into `report_progress` MCP tool

**Files:**
- Modify: `apps/server/src/edge/mcp-server.ts:303-338` (report_progress handler)

- [ ] **Step 1: Import renewSlot and call it in report_progress**

At the top of mcp-server.ts, find the existing imports from `./registry.js` and add `renewSlot`:

```typescript
import { ..., renewSlot } from "./registry.js";
```

In the `report_progress` handler (around line 303-338), after the SSE push logic and before the return, add slot renewal:

```typescript
      // Renew slot timeout on every progress report
      renewSlot(taskId, stageName);
```

The response should indicate renewal:

```typescript
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, slotRenewed: true }) }] };
```

- [ ] **Step 2: Commit**

```bash
git add apps/server/src/edge/mcp-server.ts
git commit -m "feat: report_progress auto-renews edge slot timeout"
```

---

### Task 4: Add `get_stage_schema` lightweight MCP tool

**Files:**
- Modify: `apps/server/src/edge/mcp-server.ts` (add new tool registration)

- [ ] **Step 1: Add the tool after `get_stage_context` registration**

After the `get_stage_context` tool handler (around line 197), add a new tool:

```typescript
  server.tool(
    "get_stage_schema",
    "Get lightweight schema for a stage — only outputSchema, writes, reads keys, and nonce. Use this instead of get_stage_context when you only need to know the output format.",
    {
      taskId: z.string(),
      stageName: z.string(),
      taskToken: z.string().optional(),
    },
    async ({ taskId, stageName, taskToken }) => {
      if (taskToken) {
        const err = validateTaskToken(taskId, taskToken);
        if (err) return err;
      }

      const context = getTaskContext(taskId);
      if (!context) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Task not found" }) }] };
      }

      const stageConf = findStageConfig(context.config?.pipeline?.stages, stageName);
      if (!stageConf) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Stage "${stageName}" not found in pipeline` }) }] };
      }

      const runtime = stageConf.runtime;
      const nonce = getSlotNonce(taskId, stageName);

      const schema = {
        stageName,
        writes: (runtime && "writes" in runtime) ? runtime.writes ?? [] : [],
        reads: (runtime && "reads" in runtime) ? Object.keys(runtime.reads ?? {}) : [],
        outputSchema: stageConf.outputs ?? null,
        nonce: nonce ?? null,
      };

      return { content: [{ type: "text", text: JSON.stringify(schema) }] };
    },
  );
```

Ensure `getSlotNonce` is imported from `./registry.js` (it should already be available since `getSlotNonce` is exported).

- [ ] **Step 2: Commit**

```bash
git add apps/server/src/edge/mcp-server.ts
git commit -m "feat: add get_stage_schema lightweight MCP tool"
```

---

### Task 5: Add `fromStage` to `retryTask` and state machine

**Files:**
- Modify: `apps/server/src/machine/types.ts:48-59` (WorkflowEvent)
- Modify: `apps/server/src/actions/task-actions.ts:119-176` (retryTask)
- Modify: `apps/server/src/edge/mcp-server.ts:469-493` (retry_task tool)
- Modify: `apps/server/src/machine/state-builders.ts` (blocked state RETRY_FROM handler)

- [ ] **Step 1: Add RETRY_FROM event to WorkflowEvent type**

In `apps/server/src/machine/types.ts`, add to the WorkflowEvent union:

```typescript
  | { type: "RETRY_FROM"; fromStage: string }
```

- [ ] **Step 2: Add fromStage parameter to retryTask()**

In `apps/server/src/actions/task-actions.ts`, change the `retryTask` function signature and the blocked-state handling:

```typescript
export function retryTask(
  taskId: string,
  opts?: { sync?: boolean; fromStage?: string },
): ActionResult<{ lastStage: string | undefined; statusAfter: string }> {
```

In the blocked-state branch (where `RETRY` event is sent), add a `fromStage` path:

```typescript
    // blocked state handling
    if (status === "blocked") {
      const lastStage = snap.context.lastStage;

      if (opts?.fromStage) {
        // Retry from a specific stage (not just lastStage)
        sendEvent(taskId, { type: "RETRY_FROM", fromStage: opts.fromStage });
        const after = actor.getSnapshot();
        const statusAfter = (after as any).value as string;
        if (statusAfter === "blocked") {
          return { ok: false, code: "INVALID_STATE", message: `Cannot retry from stage "${opts.fromStage}" — stage not found or not retryable` };
        }
        return { ok: true, data: { lastStage, statusAfter } };
      }

      // ... existing sync/normal retry logic unchanged ...
```

- [ ] **Step 3: Add fromStage to retry_task MCP tool schema**

In `apps/server/src/edge/mcp-server.ts`, in the `retry_task` tool registration (around line 469), add `fromStage` to the schema:

```typescript
  server.tool(
    "retry_task",
    "Retry a blocked or cancelled task. Optionally specify fromStage to retry from a specific stage instead of the last failed stage.",
    {
      taskId: z.string(),
      taskToken: z.string().optional(),
      sync: z.boolean().optional(),
      fromStage: z.string().optional().describe("Stage name to retry from. If omitted, retries from the last failed stage."),
    },
    async ({ taskId, taskToken, sync, fromStage }) => {
      if (taskToken) {
        const err = validateTaskToken(taskId, taskToken);
        if (err) return err;
      }
      const result = retryTask(taskId, { sync, fromStage });
      // ... rest unchanged ...
    },
  );
```

- [ ] **Step 4: Handle RETRY_FROM in state machine**

In `apps/server/src/machine/state-builders.ts`, find where the `blocked` state is defined (search for `"blocked"` state with `RETRY` event handler). Add a `RETRY_FROM` handler alongside:

The blocked state needs to handle `RETRY_FROM` by transitioning to the specified stage. The exact location depends on how the blocked state is built. Search for the `RETRY` event handling in the blocked state definition.

The blocked state likely has:
```typescript
on: {
  RETRY: { target: lastStageTarget, actions: [...] },
}
```

Add alongside:
```typescript
  RETRY_FROM: {
    target: undefined, // Dynamic — resolved by guard
    actions: assign(({ event, context }) => {
      const fromStage = (event as any).fromStage;
      return {
        status: fromStage,
        error: undefined,
        lastStage: fromStage,
      };
    }),
  },
```

Note: XState v5 dynamic targets require a different pattern. The implementation should use a guard-based approach or `always` transition. The exact pattern depends on how other dynamic transitions are done in the codebase (e.g., how `REJECT_WITH_FEEDBACK` targets different stages).

Read the blocked state definition carefully before implementing. The key insight is that `RETRY_FROM` needs to target the stage named in `event.fromStage`, which should be a valid state ID in the machine.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/machine/types.ts apps/server/src/actions/task-actions.ts apps/server/src/edge/mcp-server.ts apps/server/src/machine/state-builders.ts
git commit -m "feat: retry_task supports fromStage parameter for targeted stage retry"
```

---

### Task 6: Submit downstream dependency validation

**Files:**
- Modify: `apps/server/src/edge/mcp-server.ts:115-133` (validateStageOutput) and submit handler

- [ ] **Step 1: Enhance validateStageOutput with downstream foreach check**

In `apps/server/src/edge/mcp-server.ts`, modify `validateStageOutput()` to accept the full pipeline config and check downstream foreach dependencies:

```typescript
function validateStageOutput(
  stageConfig: PipelineStageConfig,
  resultText: string,
  pipelineConfig?: PipelineConfig,
): { valid: true } | { valid: false; missing?: string[]; reason: string } {
  const runtime = stageConfig.runtime;
  const writes = (runtime && "writes" in runtime) ? runtime.writes ?? [] : [];

  if (writes.length === 0) return { valid: true };
  if (!resultText) return { valid: false, reason: "Empty result text — expected JSON with fields: " + writes.join(", ") };

  let parsed: Record<string, unknown>;
  try {
    parsed = extractJSON(resultText);
  } catch {
    return { valid: false, reason: "Could not extract JSON from result text" };
  }

  const missingFields = writes.filter((field) => parsed[field] === undefined);
  if (missingFields.length > 0) {
    return { valid: false, missing: missingFields, reason: `Missing required output fields: ${missingFields.join(", ")}` };
  }

  // Check downstream foreach dependencies
  if (pipelineConfig?.stages) {
    const allStages = flattenStages(pipelineConfig.stages);
    const currentIdx = allStages.findIndex((s) => s.name === stageConfig.name);
    for (let i = currentIdx + 1; i < allStages.length; i++) {
      const downstream = allStages[i];
      if (downstream.type === "foreach" && downstream.runtime) {
        const foreachRuntime = downstream.runtime as ForeachRuntimeConfig;
        const itemsPath = foreachRuntime.items.startsWith("store.") ? foreachRuntime.items.slice(6) : foreachRuntime.items;
        // Check if this stage's writes contain the root key of the items path
        const rootKey = itemsPath.split(".")[0];
        if (writes.includes(rootKey)) {
          // This stage writes the key that the downstream foreach reads
          const value = getNestedValue(parsed, itemsPath);
          if (!Array.isArray(value)) {
            return {
              valid: false,
              reason: `Downstream foreach stage "${downstream.name}" expects "${foreachRuntime.items}" to be an array, but got ${typeof value}. Fix the output to include this field as an array.`,
            };
          }
        }
      }
    }
  }

  return { valid: true };
}
```

Add needed imports at the top: `ForeachRuntimeConfig` from config types, `getNestedValue` from config-loader.

- [ ] **Step 2: Update submit_stage_result to pass pipeline config**

In the `submit_stage_result` handler, where `validateStageOutput` is called, pass the pipeline config:

```typescript
      const validation = validateStageOutput(stageConfig, resultText, context.config?.pipeline);
```

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/edge/mcp-server.ts
git commit -m "feat: submit validates downstream foreach array dependencies"
```

---

### Task 7: Explore mode stage transparency in trigger_task

**Files:**
- Modify: `apps/server/src/edge/mcp-server.ts:389-434` (trigger_task handler)

- [ ] **Step 1: Filter condition-gated stages from edgeStages**

In the `trigger_task` handler, after computing `edgeStages` (around line 425), add logic to identify stages that are behind condition gates and mark them:

```typescript
      // Identify condition-gated stages for transparency
      const conditionGated = new Set<string>();
      const allStages = flattenStages(pipeline.stages);
      for (const s of allStages) {
        if (s.type === "condition" && s.runtime) {
          const condRuntime = s.runtime as ConditionRuntimeConfig;
          // All branch targets are potentially skippable
          for (const branch of condRuntime.branches) {
            if (!branch.default) {
              conditionGated.add(branch.to);
            }
          }
        }
      }

      // Annotate edge stages with condition-gated info
      const edgeStageDetails = edgeStages.map((name) => ({
        name,
        conditionGated: conditionGated.has(name),
      }));
```

Update the response to include annotated stages:

```typescript
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            taskId,
            taskToken: token,
            pipeline: args.pipeline,
            edgeStages,
            edgeStageDetails,
          }),
        }],
      };
```

- [ ] **Step 2: Commit**

```bash
git add apps/server/src/edge/mcp-server.ts
git commit -m "feat: trigger_task annotates condition-gated stages for explore mode transparency"
```

---

### Task 8: Type-check and verify

- [ ] **Step 1: Run TypeScript type-check**

```bash
cd ~/workflow-control
npx tsc --noEmit --project apps/server/tsconfig.json
```

Expected: 0 errors.

- [ ] **Step 2: Run tests**

```bash
pnpm --filter server test
```

Expected: all existing tests pass, no regressions.

- [ ] **Step 3: Fix any issues**

If type errors or test failures, fix them.

- [ ] **Step 4: Commit fixes if needed**

```bash
git add -A
git commit -m "fix: resolve type errors from edge execution improvements"
```
