# R1: Single-Session Compact Optimization

## Problem

Multi-stage pipelines in single-session mode share one SDK Query. As stages accumulate,
conversation history grows unbounded. When SDK auto-compact fires (~167k tokens on 200k
context), the generic summarization prompt discards pipeline-critical details:

- Store key values written by previous stages
- Stage-specific decisions that downstream stages depend on
- Scratch pad notes
- File modification context

## Solution

Leverage SDK's existing `PreCompact` hook to inject pipeline-aware compact instructions.
Keep single-session continuity (no close/resume). Add stage-boundary context enrichment.

## Verified SDK Behavior

- `autoCompactEnabled` defaults to `true`
- Auto-compact threshold ≈ `effectiveWindow - 13000` (167k on 200k context)
- `PreCompact` hook: callback's `systemMessage` return → `newCustomInstructions` →
  `rJ4(z)` "Additional Instructions" section in compact prompt
- Hook callback type path: `options.hooks.PreCompact` → `registerHookCallbacks` →
  `createHookCallback(id, timeout)` → IPC to CLI subprocess → callback execution →
  `output = L.systemMessage || ""` → `newCustomInstructions`
- `compact_boundary` message type is `system` with subtype `compact_boundary`

## Changes

### 1. SessionManager: mutable stage context fields

New private fields on `SessionManager`:

```
currentStageName: string
currentContext: WorkflowContext | null
currentScratchPad: string[]
```

Updated in `executeStage()` before any query interaction.

### 2. PreCompact hook registration (createQuery)

```typescript
hooks: {
  PreToolUse: [{ hooks: [pathHook] }],
  PreCompact: [{ hooks: [this.compactHook.bind(this)] }],
}
```

`compactHook()` reads `this.currentStageName`, `this.currentContext` to build
pipeline-specific compact instructions. Returns `{ systemMessage: instructions }`.

Instructions tell the compact LLM to preserve:
- Store keys and values written by each stage
- File paths modified and purpose
- Stage results affecting downstream stages
- Scratch pad notes
- Errors and resolutions

### 3. buildStagePrompt: always inject tier1Context

Current: non-first stages get only `stagePrompt`.
Changed: all stages get `tier1Context + stagePrompt`.

After compact, the old tier1 is summarized away. Re-injecting ensures agent
always has full task context. Cost: ~2-5k extra tokens per stage, acceptable.

### 4. consumeUntilResult: observe compact_boundary

Add logging + SSE push when `system.compact_boundary` message is received.
Not functionally required but critical for observability.

### 5. switchStageConfig: refresh store reader MCP unconditionally

Current: store reader MCP only refreshed when `mcpServiceKey` changes.
Problem: store content changes between stages but MCP list stays the same.
Fix: always recreate `__store__` MCP with fresh store/scratchPad data.

## Files Modified

- `apps/server/src/agent/session-manager.ts` — changes 1-5
- No other files need modification

## Side Effects

- R4 (stale tier1 on stage N+1) is fixed by change 3
- R2 (shared turn budget) is NOT fixed — remains separate issue
- No breaking changes to existing multi-session mode (`runAgent`)

## Risks

- Hook closure reads `this.*` fields — must verify no race between
  `executeStage` updating fields and auto-compact firing mid-stage
  → Safe: both run on the same event loop; `executeStage` sets fields
  synchronously before enqueueing the user message
- Compact instructions add ~500 tokens to compact prompt input
  → Negligible vs 167k threshold
- SDK may not call PreCompact hooks in all code paths (e.g., microcompact)
  → microcompact only clears tool results, does not summarize; acceptable
