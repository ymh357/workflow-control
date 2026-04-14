# Token Efficiency Optimizations Design Spec

> Date: 2026-04-14
> Status: Ready for implementation
> Prerequisites: R1-R5 committed (see git log)

9 surgical optimizations targeting token waste, redundant computation, and blocking I/O discovered during code review.

---

## Overview

| # | Optimization | Impact | Files |
|---|-------------|--------|-------|
| O1 | Eliminate double buildTier1Context | ~2000-8000 tokens/stage | 2 modify |
| O2 | Cache extractJSON in onDone guards | CPU: eliminate 3x redundant parse/stage | 1 modify |
| O3 | Per-stage fragment prefix (replace full superset) | ~4000 tokens/stage saved | 2 modify |
| O4 | readsSnapshot hash instead of deep copy | ~15KB/stage checkpoint reduction | 3 modify |
| O5 | appendPrompt cache on retry | CPU: skip rebuild on retry | 1 modify |
| O6 | Semantic summary via side-effect (fix context mutation) | Correctness + async timing | 2 modify |
| O7 | Pipeline index for store inheritance | Eliminate 3.5s worst-case blocking | 2 modify |
| O8 | Batch unchanged reads into single line | ~60 tokens/resume saved | 1 modify |
| O9 | AbortController only for Claude path | Eliminate dead timers | 1 modify |

Execution order: O9 -> O2 -> O8 -> O4 -> O5 -> O1 -> O3 -> O7 -> O6 (independent first, then dependent)

---

## O1: Eliminate Double buildTier1Context

### Problem

`state-builders.ts:149` calls `buildTier1Context(effectiveContext, undefined, undefined, stateName)` — passing `undefined` for runtime, which triggers the legacy fallback path that dumps the entire store. This result is passed as `prompt` to `executeStage`. Then `stage-executor.ts:100` calls `buildTier1Context(context, runtime, undefined, stageName)` with the correct runtime, producing the reads-aware version. In `buildEffectivePrompt` (line 253), the reads-aware version (`tier1Context`) wins over the legacy version (`prompt`) via `tier1Context || prompt`. The state-builders computation is wasted.

### Design

1. **state-builders.ts**: Pass `runtime` to `buildTier1Context`:
   ```typescript
   tier1Context: buildTier1Context(effectiveContext, runtime, undefined, stateName),
   ```

2. **stage-executor.ts**: Stop calling `buildTier1Context`. Use the tier1Context received from the invoke input (accessed as `prompt` parameter). Only append `checkpointContext`:
   ```typescript
   // Remove: const effectiveTier1 = buildTier1Context(context, runtime, undefined, stageName);
   // The prompt parameter already contains the reads-aware tier1Context from state-builders
   const effectiveTier1 = prompt; // prompt = tier1Context from invoke input
   ```

3. **executor.ts**: Already passes `tier1Context` as the `prompt` param to `executeStage`. No change needed.

### Edge Cases

- **Edge mode**: `runEdgeAgent` also receives `tier1Context` from invoke input. The edge executor (`edge/actor.ts`) uses it directly, doesn't call buildTier1Context. No change needed.
- **Gemini/Codex**: They concatenate `appendPrompt + effectivePrompt` where effectivePrompt uses tier1Context. Works the same.

---

## O2: Cache extractJSON in onDone Guards (WeakMap)

### Problem

`buildAgentState`'s onDone has 4 guard/action paths that each independently call `extractJSON(event.output.resultText)` on the same string. XState evaluates guards synchronously in order — same event object parsed up to 4 times.

### Design

Add a module-level `WeakMap<object, Record<string, unknown> | null>` in state-builders.ts. Create a helper:

```typescript
const parseCache = new WeakMap<object, Record<string, unknown> | null>();

function getCachedParse(event: { output: { resultText: string } }): Record<string, unknown> | null {
  if (parseCache.has(event.output)) return parseCache.get(event.output)!;
  try {
    const parsed = extractJSON(event.output.resultText);
    parseCache.set(event.output, parsed);
    return parsed;
  } catch {
    parseCache.set(event.output, null);
    return null;
  }
}
```

Replace all `extractJSON(event.output.resultText)` calls in guards and actions with `getCachedParse(event)`. The WeakMap keys on the event output object, so entries are GC'd when the event is no longer referenced.

Note: XState guards cannot use `assign` — guards are pure predicates that run before transition is confirmed. WeakMap is the only clean approach.

---

## O3: Per-Stage Fragment Prefix (Replace Full Superset)

### Problem

`buildStaticPromptPrefix` includes ALL fragments as a superset to ensure byte-identical prefix across stages for prompt cache hits. With 10 fragments averaging 500 tokens each, every stage injects ~5000 tokens but only uses ~1000. Net waste: ~4000 tokens/stage * 5 stages = 20,000 tokens per pipeline run.

### Design

Change `buildStaticPromptPrefix` to accept the resolved fragment IDs for the current stage. Only include those fragments. Stages with the same fragment set produce identical prefixes (cache hit). Stages with different sets get different prefixes (cache miss, but smaller prefixes).

```typescript
export function buildStaticPromptPrefix(
  privateConfig: any,
  engine: string,
  resolvedFragmentIds?: string[],
): string {
  const parts: string[] = [];
  const effectiveConstraints = privateConfig?.prompts.globalConstraints || DEFAULT_GLOBAL_CONSTRAINTS;
  parts.push(effectiveConstraints);

  if (privateConfig?.prompts.fragments) {
    if (resolvedFragmentIds) {
      // Only include resolved fragments for this stage
      for (const id of resolvedFragmentIds) {
        const content = (privateConfig.prompts.fragments as Record<string, string>)[id];
        if (content && !parts.includes(content)) parts.push(content);
      }
    } else {
      // Fallback: include all (backward compat)
      for (const content of Object.values(privateConfig.prompts.fragments as Record<string, string>)) {
        if (content && !parts.includes(content)) parts.push(content);
      }
    }
  }

  // Project instructions (unchanged)
  // ...
}
```

Caller change in `stage-executor.ts`:

```typescript
const resolvedFragmentIds = resolvedFragments.map(f => f.id);
const staticPromptPrefix = buildStaticPromptPrefix(privateConfig, stageConfig.engine, resolvedFragmentIds);
```

This requires `buildSystemAppendPrompt` to return resolved fragment IDs alongside the prompt string. Change its return type to `{ prompt: string; fragmentIds: string[] }`.

### Cache Impact Analysis

- 3-stage pipeline where all stages use same 2 fragments: 3 cache hits (same as before), each prefix ~2000 tokens smaller
- 5-stage pipeline with 3 stages sharing fragments, 2 different: 3 hits + 2 misses. Before: 5 hits. Net token change: save `5 * 4000 = 20,000` tokens, lose `2 * cache_creation_cost`. At Sonnet pricing, creation cost < 2000 tokens. Net positive.

---

## O4: readsSnapshot Hash Instead of Deep Copy

### Problem

`statusEntry` in `helpers.ts` does `JSON.parse(JSON.stringify(context.store[rootKey]))` for every reads key on every stage entry. Full deep copies (~15KB) are stored in stageCheckpoints, persisted to disk on every state transition. The copies are only used for `JSON.stringify(val) === JSON.stringify(prevVal)` comparison in context-builder — only the equality check matters, not the values.

### Design

Store content-hash instead of full values:

```typescript
import { createHash } from "node:crypto";

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}
```

In `helpers.ts`, `readsSnapshot` becomes `Record<string, string>` (key -> 16-char hex hash):

```typescript
readsSnapshot[rootKey] = stableHash(context.store[rootKey]);
```

In `context-builder.ts`, compare by computing hash of current value:

```typescript
const currentHash = stableHash(val);
if (prevHash === currentHash) {
  // unchanged
}
```

Update `StageCheckpoint.readsSnapshot` type in `types.ts` to `Record<string, string>`.

### Trade-off

Hash collision probability with 16 hex chars (64 bits): ~1 in 10^18. Acceptable. One `JSON.stringify` still needed per read per stage entry (for hashing), but we eliminate the `JSON.parse` deserialization and the ~15KB storage per checkpoint.

---

## O5: appendPrompt Cache on Retry

### Problem

`buildSystemAppendPrompt` is called on every execution including retries. Its output depends only on config (not on store or runtime state), so it's identical across retries of the same stage.

### Design

Module-level Map in `stage-executor.ts`:

```typescript
const appendPromptCache = new Map<string, string>();

// In executeStage:
const cacheKey = `${taskId}:${stageName}`;
let appendPrompt: string;
if (isResume && appendPromptCache.has(cacheKey)) {
  appendPrompt = appendPromptCache.get(cacheKey)!;
} else {
  appendPrompt = await buildSystemAppendPrompt({...});
  appendPromptCache.set(cacheKey, appendPrompt);
}
```

Cache entries are naturally evicted when the process restarts. For long-running processes, entries accumulate but each is only ~5-10KB string — 1000 entries = ~10MB, acceptable.

---

## O6: Semantic Summary via Side-Effect (Fix Context Mutation)

### Problem

Current implementation directly mutates `context.store` from inside an async callback fired from an XState synchronous action. This is an XState anti-pattern (bypasses immutability guarantees). Also, the async Haiku call (~1s) never completes before the next stage reads from store.

### Design

Replace the fire-and-forget mutation with a module-level cache:

```typescript
// New: apps/server/src/agent/semantic-summary-cache.ts
const cache = new Map<string, string>(); // `${taskId}:${storeKey}` -> summary

export function getCachedSummary(taskId: string, storeKey: string): string | undefined {
  return cache.get(`${taskId}:${storeKey}`);
}

export function setCachedSummary(taskId: string, storeKey: string, summary: string): void {
  cache.set(`${taskId}:${storeKey}`, summary);
}
```

In `state-builders.ts`, the fire-and-forget action stays but writes to the cache instead of mutating context:

```typescript
import("../agent/semantic-summary.js").then(({ generateSemanticSummary }) => {
  generateSemanticSummary(context.taskId, key, value, w.summary_prompt!).then((summary) => {
    if (summary) {
      setCachedSummary(context.taskId, key, summary);
      // Also write to store for persistence (non-blocking, eventual)
      context.store[`${key}.__semantic_summary`] = summary;
    }
  }).catch(() => {});
}).catch(() => {});
```

In `context-builder.ts`, check cache first:

```typescript
import { getCachedSummary } from "./semantic-summary-cache.js";

const cachedSummary = getCachedSummary(context.taskId, storePath.split(".")[0]);
const semanticSummary = cachedSummary ?? store[semanticSummaryKey];
```

This gives two benefits:
1. Same-process retries/downstream stages get the summary faster (from cache)
2. Cross-process (restart) still works via store persistence (eventual)

The context mutation for persistence is kept as a pragmatic choice — it's fire-and-forget and the value is non-critical (tier-1 falls back gracefully).

---

## O7: Pipeline Index for Store Inheritance

### Problem

`resolveInheritedStore` does `readdirSync` + `readFileSync` on potentially hundreds of task files. Worst case: 500 files * 7ms = 3.5s blocking the event loop.

### Design

Maintain a lightweight index file `{dataDir}/tasks/_pipeline_index.json`:

```json
{
  "linear-dev-cycle": { "taskId": "abc123", "completedAt": "2026-04-14T..." },
  "quick-fix": { "taskId": "def456", "completedAt": "2026-04-14T..." }
}
```

**Write path** (`side-effects.ts`): On `wf.streamClose`, if context.status is "completed", update the index:

```typescript
actor.on("wf.streamClose", (event) => {
  // existing code...
  // Update pipeline index for store inheritance
  const actor = getWorkflow(event.taskId);
  const ctx = actor?.getSnapshot()?.context;
  if (ctx?.status === "completed" && ctx.config?.pipelineName) {
    updatePipelineIndex(ctx.config.pipelineName, event.taskId);
  }
});
```

**Read path** (`actor-registry.ts`): `resolveInheritedStore` reads the ~1KB index, gets the target taskId, reads that single snapshot file.

```typescript
function resolveInheritedStore(...) {
  // Read index file (single readFileSync, ~1KB)
  const index = readPipelineIndex(dataDir);
  const entry = index[pipelineName];
  if (!entry) return {};
  // Read single snapshot file
  const snapshot = loadSnapshot(entry.taskId);
  // Extract keys...
}
```

### Edge Cases

- **Index file missing**: Falls back to current directory scan (first run ever)
- **Index points to deleted task**: Fall back to scan
- **Concurrent writes**: Use atomic write-rename pattern (write to tmp, rename)

---

## O8: Batch Unchanged Reads Into Single Line

### Problem

Each unchanged read injects `\n### {label}\n> Unchanged since previous attempt...` (~20 tokens). With 5 reads and 3 unchanged, that's 60 tokens of per-key boilerplate.

### Design

Accumulate unchanged keys during the loop, emit a single line after:

```typescript
const unchangedLabels: string[] = [];

for (const [label, rawPath] of Object.entries(runtime.reads)) {
  // ... existing logic ...
  if (isUnchanged) {
    unchangedLabels.push(label);
    renderedKeys.add(rootKey);
    continue;
  }
  // ... render changed values ...
}

if (unchangedLabels.length > 0) {
  addPart(`\n> Context unchanged from previous attempt: ${unchangedLabels.join(", ")}. Use get_store_value() for details.`);
}
```

Saves ~15 tokens per unchanged key (from ~20 per key to ~5 amortized).

---

## O9: AbortController Only for Claude Path

### Problem

AbortController + setTimeout timers are created unconditionally in `executeStage`, but the abortSignal is only passed to the Claude SDK path. For Gemini/Codex, the timers run uselessly and the abort fires into the void.

### Design

Move the AbortController creation, absolute timer, and warning timer inside the Claude `else` block. Wrap the `processAgentStream` call in a try/finally only in the Claude path.

For Gemini and Codex, rely on their native timeout mechanisms (Gemini has its own process timeout; Codex has sandbox timeout).

---

## Implementation Notes

### Dependencies Between Optimizations

- O1 depends on O3 (O3 changes buildSystemAppendPrompt return type, O1 needs the resolved fragments for the correct staticPromptPrefix)
- All others are independent

### Test Impact

- O1: Update `state-builders.test.ts` (invoke input now includes runtime-aware tier1Context), `stage-executor.test.ts` (remove buildTier1Context mock expectations)
- O2: Existing tests pass (behavioral change only in performance, not output)
- O3: Update `prompt-builder.test.ts` (buildStaticPromptPrefix signature change)
- O4: Update `context-builder.test.ts` (readsSnapshot is now hash map), `helpers.ts` tests
- O5: No test changes (cache is transparent)
- O6: Update any tests that check for context.store mutation
- O7: New test for pipeline index read/write
- O8: Update `context-builder.test.ts` (unchanged output format changes)
- O9: Update `stage-executor.test.ts` (AbortController only in Claude path)
