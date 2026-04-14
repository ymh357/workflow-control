# Remaining Improvements (R1-R5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 5 deferred improvements: store inheritance + semantic summary, incremental context diff on resume, stage execution timeout + heartbeat, parallel group transactional store, and DAG scheduling.

**Architecture:** Enhance the existing store + reads/writes mechanism rather than adding new memory layers. R1 adds cross-run store persistence and LLM-based summaries. R2 optimizes resume context injection. R3 adds absolute timeouts and heartbeats to web-mode agents. R4 buffers parallel child writes for atomic commit. R5 auto-generates parallel groups from dependency declarations.

**Tech Stack:** TypeScript, XState, Anthropic SDK (claude-agent-sdk), Zod, Vitest

**Spec:** `docs/superpowers/specs/2026-04-13-remaining-improvements-design.md`

---

## File Map

| File | Tasks | Action | Responsibility |
|------|-------|--------|----------------|
| `apps/server/src/lib/config/types.ts` | 1, 9 | Modify | Add `summary_prompt` to WriteDeclaration, `store_persistence` to PipelineConfig, `depends_on` to PipelineStageConfig |
| `apps/server/src/lib/config/schema.ts` | 1, 9 | Modify | Zod schemas for new fields |
| `apps/server/src/agent/semantic-summary.ts` | 2 | Create | LLM-based semantic summary generation |
| `apps/server/src/machine/actor-registry.ts` | 3 | Modify | Store inheritance in createTaskDraft |
| `apps/server/src/machine/state-builders.ts` | 4, 8 | Modify | Trigger semantic summary after writes; parallel staged writes |
| `apps/server/src/agent/context-builder.ts` | 5, 6 | Modify | Prefer `__semantic_summary`; incremental diff on resume |
| `apps/server/src/machine/types.ts` | 6, 8 | Modify | Extend StageCheckpoint with readsSnapshot; add parallelStagedWrites |
| `apps/server/src/machine/helpers.ts` | 6 | Modify | Capture readsSnapshot in statusEntry |
| `apps/server/src/agent/stage-executor.ts` | 7a | Modify | AbortController + absolute timeout |
| `apps/server/src/agent/stream-processor.ts` | 7b | Modify | Heartbeat interval + timeout warning |
| `apps/server/src/agent/query-options-builder.ts` | 7a | Modify | Pass abortSignal |
| `apps/server/src/machine/pipeline-builder.ts` | 9 | Modify | DAG analysis + auto parallel group generation |
| `packages/shared/src/pipeline-validator.ts` | 9 | Modify | depends_on validation + cycle detection |

---

## Task 1: Schema + Type Changes for R1 (Store Inheritance + Semantic Summary)

**Files:**
- Modify: `apps/server/src/lib/config/types.ts`
- Modify: `apps/server/src/lib/config/schema.ts`

- [ ] **Step 1: Add `summary_prompt` to WriteDeclaration type**

In `apps/server/src/lib/config/types.ts`, extend `WriteDeclaration`:

```typescript
// Current:
export type WriteDeclaration = string | { key: string; strategy?: "replace" | "append" | "merge" };

// Change to:
export type WriteDeclaration = string | { key: string; strategy?: "replace" | "append" | "merge"; summary_prompt?: string };
```

- [ ] **Step 2: Add `store_persistence` to PipelineConfig type**

In `apps/server/src/lib/config/types.ts`, add to the `PipelineConfig` interface:

```typescript
export interface PipelineConfig {
  // ... existing fields
  store_persistence?: {
    inherit_from: "last_completed" | "none";
    inherit_keys: string[] | "*";
  };
}
```

- [ ] **Step 3: Update Zod schema for WriteDeclaration**

In `apps/server/src/lib/config/schema.ts`, update `WriteDeclarationSchema`:

```typescript
const WriteDeclarationSchema = z.union([
  z.string(),
  z.object({
    key: z.string(),
    strategy: z.enum(["replace", "append", "merge"]).optional(),
    summary_prompt: z.string().optional(),
  }),
]);
```

- [ ] **Step 4: Add Zod schema for store_persistence**

In `apps/server/src/lib/config/schema.ts`, add before `PipelineConfigSchema`:

```typescript
const StorePersistenceSchema = z.object({
  inherit_from: z.enum(["last_completed", "none"]),
  inherit_keys: z.union([z.array(z.string()), z.literal("*")]),
});
```

Then add to `PipelineConfigSchema`:

```typescript
export const PipelineConfigSchema = z.object({
  // ... existing fields
  store_persistence: StorePersistenceSchema.optional(),
});
```

- [ ] **Step 5: Run type check**

Run: `cd apps/server && npx tsc --noEmit`
Expected: PASS (no errors from the new optional fields)

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/lib/config/types.ts apps/server/src/lib/config/schema.ts
git commit -m "feat(R1): add schema types for store_persistence and summary_prompt"
```

---

## Task 2: Semantic Summary Module

**Files:**
- Create: `apps/server/src/agent/semantic-summary.ts`
- Test: `apps/server/src/agent/semantic-summary.test.ts`

- [ ] **Step 1: Write tests for semantic summary**

Create `apps/server/src/agent/semantic-summary.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock Anthropic SDK
const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

import { generateSemanticSummary } from "./semantic-summary.js";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("generateSemanticSummary", () => {
  it("returns LLM-generated summary for a value with summary_prompt", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "5 tasks total, currently on task 3, overall approach is TDD" }],
    });

    const result = await generateSemanticSummary(
      "test-task",
      "tasks",
      { items: ["a", "b", "c", "d", "e"], current: 3 },
      "Summarize: how many tasks, current progress",
    );

    expect(result).toBe("5 tasks total, currently on task 3, overall approach is TDD");
    expect(mockCreate).toHaveBeenCalledOnce();
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe("claude-haiku-4-5-20251001");
    expect(callArgs.max_tokens).toBe(300);
    expect(callArgs.messages[0].content).toContain("Summarize: how many tasks, current progress");
  });

  it("truncates large values to 4000 chars", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "summary" }],
    });

    const largeValue = "x".repeat(10000);
    await generateSemanticSummary("test-task", "key", largeValue, "summarize");

    const callArgs = mockCreate.mock.calls[0][0];
    const content = callArgs.messages[0].content;
    expect(content.length).toBeLessThan(5000);
    expect(content).toContain("... [truncated]");
  });

  it("returns null when LLM call fails", async () => {
    mockCreate.mockRejectedValue(new Error("API error"));

    const result = await generateSemanticSummary("test-task", "key", { data: true }, "summarize");
    expect(result).toBeNull();
  });

  it("returns null when response has no text content", async () => {
    mockCreate.mockResolvedValue({ content: [] });

    const result = await generateSemanticSummary("test-task", "key", { data: true }, "summarize");
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/server && npx vitest run src/agent/semantic-summary.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement semantic-summary.ts**

Create `apps/server/src/agent/semantic-summary.ts`:

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { taskLogger } from "../lib/logger.js";

const MAX_VALUE_CHARS = 4000;

export async function generateSemanticSummary(
  taskId: string,
  storeKey: string,
  value: unknown,
  summaryPrompt: string,
): Promise<string | null> {
  const log = taskLogger(taskId);

  try {
    let serialized = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    if (serialized.length > MAX_VALUE_CHARS) {
      serialized = serialized.slice(0, MAX_VALUE_CHARS) + "\n... [truncated]";
    }

    const client = new Anthropic();
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: `${summaryPrompt}\n\nContent:\n${serialized}`,
        },
      ],
    });

    const text = response.content.find((b) => b.type === "text");
    if (!text || !("text" in text)) return null;

    log.info({ storeKey, summaryLength: text.text.length }, "Semantic summary generated");
    return text.text;
  } catch (err) {
    log.warn({ err, storeKey }, "Semantic summary generation failed (non-blocking)");
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/server && npx vitest run src/agent/semantic-summary.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent/semantic-summary.ts apps/server/src/agent/semantic-summary.test.ts
git commit -m "feat(R1): add semantic summary module with Haiku LLM call"
```

---

## Task 3: Store Inheritance in Actor Registry

**Files:**
- Modify: `apps/server/src/machine/actor-registry.ts`
- Modify: `apps/server/src/machine/persistence.ts` (if needed for listing tasks)
- Test: `apps/server/src/machine/actor-registry.test.ts` (add tests)

- [ ] **Step 1: Write test for store inheritance**

Add to or create `apps/server/src/machine/actor-registry.test.ts` — tests that verify `resolveInheritedStore` returns correct keys from a mock snapshot:

```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("./persistence.js", () => ({
  snapshotPath: vi.fn(),
  persistSnapshot: vi.fn(),
  flushSnapshotSync: vi.fn(),
  loadSnapshot: vi.fn(),
  pipelineFingerprint: vi.fn(),
}));

vi.mock("./machine.js", () => ({
  createWorkflowMachine: vi.fn(() => ({ id: "test" })),
}));

vi.mock("./side-effects.js", () => ({
  registerSideEffects: vi.fn(),
}));

vi.mock("./workflow-lifecycle.js", () => ({
  snapshotGlobalConfig: vi.fn(() => ({
    pipelineName: "test",
    pipeline: { name: "test", stages: [], store_persistence: { inherit_from: "last_completed", inherit_keys: ["requirements", "design"] } },
    prompts: { system: {}, fragments: {}, globalConstraints: "", globalClaudeMd: "", globalGeminiMd: "", globalCodexMd: "" },
    skills: [],
    mcps: [],
  })),
}));

import { resolveInheritedStore } from "./actor-registry.js";

describe("resolveInheritedStore", () => {
  it("returns empty object when inherit_from is none", () => {
    const result = resolveInheritedStore("test-pipeline", undefined);
    expect(result).toEqual({});
  });

  it("returns empty object when no store_persistence config", () => {
    const result = resolveInheritedStore("test-pipeline", undefined);
    expect(result).toEqual({});
  });
});
```

Note: Full integration test is complex due to filesystem dependency. The core logic is a pure function `resolveInheritedStore` that we extract and test.

- [ ] **Step 2: Implement resolveInheritedStore function**

In `apps/server/src/machine/actor-registry.ts`, add a new exported function and wire it into `createTaskDraft`:

```typescript
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

export function resolveInheritedStore(
  pipelineName: string,
  storePersistence: { inherit_from: string; inherit_keys: string[] | "*" } | undefined,
): Record<string, any> {
  if (!storePersistence || storePersistence.inherit_from === "none") return {};

  try {
    const settings = loadSystemSettings();
    const dataDir = settings.paths?.data_dir || "/tmp/workflow-control-data";
    const tasksDir = join(dataDir, "tasks");

    // Scan for most recent completed task with same pipeline
    const files = readdirSync(tasksDir).filter(f => f.endsWith(".json")).sort().reverse();

    for (const file of files) {
      try {
        const raw = JSON.parse(readFileSync(join(tasksDir, file), "utf-8"));
        const snap = raw?.persistedSnapshot ?? raw;
        const ctx = snap?.context;
        if (!ctx || ctx.status !== "completed") continue;
        if (ctx.config?.pipelineName !== pipelineName) continue;

        // Found the most recent completed task for this pipeline
        const sourceStore = ctx.store ?? {};
        if (storePersistence.inherit_keys === "*") return { ...sourceStore };

        const inherited: Record<string, any> = {};
        for (const key of storePersistence.inherit_keys) {
          if (sourceStore[key] !== undefined) {
            inherited[key] = sourceStore[key];
            // Also carry semantic summaries if they exist
            const summaryKey = `${key}.__semantic_summary`;
            if (sourceStore[summaryKey] !== undefined) {
              inherited[summaryKey] = sourceStore[summaryKey];
            }
          }
        }
        return inherited;
      } catch {
        continue;
      }
    }
  } catch (err) {
    taskLogger("system").warn({ err, pipelineName }, "Store inheritance scan failed");
  }

  return {};
}
```

- [ ] **Step 3: Wire inheritance into createTaskDraft**

In `createTaskDraft`, after `const config = snapshotGlobalConfig(pipelineName);`:

```typescript
// Store inheritance: pre-populate from last completed task
const inherited = resolveInheritedStore(
  pipelineName ?? config.pipelineName,
  config.pipeline.store_persistence,
);
const mergedInitialStore = { ...inherited, ...(options?.initialStore ?? {}) };
```

Then change the `actor.send` call to use `mergedInitialStore`:

```typescript
actor.send({
  type: "START_ANALYSIS",
  taskId,
  taskText,
  repoName,
  config,
  initialStore: mergedInitialStore,
  worktreePath: options?.worktreePath,
  branch: options?.branch,
});
```

- [ ] **Step 4: Add loadSystemSettings import if not present**

Check that `loadSystemSettings` is imported (it should be via config-loader).

- [ ] **Step 5: Run type check**

Run: `cd apps/server && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/machine/actor-registry.ts
git commit -m "feat(R1): add store inheritance from last completed task"
```

---

## Task 4: Semantic Summary Trigger in State Builders

**Files:**
- Modify: `apps/server/src/machine/state-builders.ts`

- [ ] **Step 1: Add async semantic summary trigger after store writes**

In `state-builders.ts`, in `buildAgentState`'s normal-path onDone actions, after the `assign` that merges store writes, add a fire-and-forget action that triggers semantic summaries:

```typescript
// After the existing assign action in the normal path (line ~384-460):
// Add a new action after the assign:
({ event, context }: { event: DoneEvent; context: WorkflowContext }) => {
  // Fire-and-forget: generate semantic summaries for writes with summary_prompt
  const writes = runtime.writes ?? [];
  for (const w of writes) {
    if (typeof w === "object" && w.summary_prompt) {
      const key = w.key;
      const value = context.store[key];
      if (value === undefined) continue;
      import("../agent/semantic-summary.js").then(({ generateSemanticSummary }) => {
        generateSemanticSummary(context.taskId, key, value, w.summary_prompt!).then((summary) => {
          if (summary) {
            // Mutate store in-place (safe because XState actions are synchronous
            // and this fires after the assign has completed)
            context.store[`${key}.__semantic_summary`] = summary;
          }
        }).catch(() => { /* non-blocking */ });
      }).catch(() => { /* non-blocking */ });
    }
  }
},
```

**Important**: This uses dynamic import to avoid circular dependency and is fire-and-forget. The summary is stored asynchronously — downstream stages that run immediately after may not have it yet, but retries and future runs will.

- [ ] **Step 2: Run type check**

Run: `cd apps/server && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Run existing state-builders tests to check for regressions**

Run: `cd apps/server && npx vitest run src/machine/state-builders.test.ts`
Expected: PASS (existing tests unaffected by the new fire-and-forget action)

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/machine/state-builders.ts
git commit -m "feat(R1): trigger semantic summary generation after store writes"
```

---

## Task 5: Prefer Semantic Summary in Context Builder

**Files:**
- Modify: `apps/server/src/agent/context-builder.ts`
- Test: Extend `apps/server/src/agent/context-builder.test.ts`

- [ ] **Step 1: Write test for semantic summary preference**

Add to `apps/server/src/agent/context-builder.test.ts`:

```typescript
describe("buildTier1Context - semantic summary preference", () => {
  it("uses __semantic_summary over __summary when both exist", () => {
    const ctx = makeContext({
      store: {
        plan: { tasks: ["a", "b", "c", "d", "e"], approach: "TDD" },
        "plan.__summary": "[object] tasks, approach (12345 chars)",
        "plan.__semantic_summary": "5 tasks using TDD approach, starting with unit tests",
      },
    });
    const runtime = { reads: { "Plan": "plan" } } as any;
    const result = buildTier1Context(ctx, runtime, 50); // tiny budget to force summary
    expect(result).toContain("5 tasks using TDD approach");
    expect(result).not.toContain("[object] tasks, approach");
  });

  it("falls back to __summary when __semantic_summary not available", () => {
    const ctx = makeContext({
      store: {
        plan: { tasks: ["a", "b", "c", "d", "e"], approach: "TDD", details: "x".repeat(10000) },
        "plan.__summary": "[object] tasks, approach, details (15000 chars)",
      },
    });
    const runtime = { reads: { "Plan": "plan" } } as any;
    const result = buildTier1Context(ctx, runtime, 50);
    expect(result).toContain("[object] tasks, approach, details");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/agent/context-builder.test.ts`
Expected: FAIL (semantic summary not yet preferred)

- [ ] **Step 3: Modify buildTier1Context to prefer semantic summary**

In `apps/server/src/agent/context-builder.ts`, in the object-value handling block (around line 58-77), modify the summary preference logic:

```typescript
// Replace the existing summary check block:
// Prefer semantic summary > mechanical summary > truncated preview
const semanticSummaryKey = `${storePath.split(".")[0]}.__semantic_summary`;
const mechanicalSummaryKey = `${storePath.split(".")[0]}.__summary`;

if (fullBlock.length > MAX_INLINE_CHARS || !addPart(fullBlock)) {
  if (store[semanticSummaryKey] !== undefined) {
    // Best: LLM-generated semantic summary
    parts.push(`\n### ${label} (semantic summary)\n${store[semanticSummaryKey]}\n> Full content: use get_store_value("${storePath}") for complete data`);
  } else if (store[mechanicalSummaryKey] !== undefined && fullBlock.length > MAX_INLINE_CHARS) {
    addPart(`\n### ${label} (compact summary)\n${store[mechanicalSummaryKey]}\n> Full content: use get_store_value("${storePath}") for complete data`);
  } else if (fullBlock.length > MAX_INLINE_CHARS) {
    parts.push(`\n### ${label} (preview, ${fieldParts.length} fields)\n${fieldParts.slice(0, 5).join("\n")}\n...\n> Full content: use get_store_value("${storePath}") for all ${fieldParts.length} fields`);
  } else {
    // Budget exceeded but value is small enough to summarize inline
    const entries = Object.entries(val);
    const summaryParts: string[] = [];
    for (const [k, v] of entries.slice(0, 20)) {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      summaryParts.push(`${k}: ${s.slice(0, 80)}${s.length > 80 ? "..." : ""}`);
    }
    if (entries.length > 20) summaryParts.push(`... and ${entries.length - 20} more fields`);
    parts.push(`\n### ${label} (summarized)\n${summaryParts.join("\n")}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/server && npx vitest run src/agent/context-builder.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent/context-builder.ts apps/server/src/agent/context-builder.test.ts
git commit -m "feat(R1): prefer semantic summary over mechanical summary in tier-1 context"
```

---

## Task 6: Incremental Context Diff on Resume (R2)

**Files:**
- Modify: `apps/server/src/machine/types.ts`
- Modify: `apps/server/src/machine/helpers.ts`
- Modify: `apps/server/src/agent/context-builder.ts`
- Test: Extend `apps/server/src/agent/context-builder.test.ts`

- [ ] **Step 1: Extend StageCheckpoint type**

In `apps/server/src/machine/types.ts`:

```typescript
export interface StageCheckpoint {
  gitHead?: string;
  startedAt: string;
  readsSnapshot?: Record<string, unknown>;
}
```

- [ ] **Step 2: Capture readsSnapshot in statusEntry**

In `apps/server/src/machine/helpers.ts`, find the `statusEntry` function. It currently returns entry actions that set `context.status` and emit events. Add a stage checkpoint capture that includes the reads snapshot.

Find where `stageCheckpoints` is populated (likely in the stage entry or in the git-checkpoint module) and extend it to capture the store values for the stage's declared reads:

```typescript
// In the entry action for stages that set stageCheckpoints:
// After setting gitHead and startedAt, add:
const stageConfig = findStageConfig(context.config?.pipeline?.stages, stageName);
const reads = (stageConfig?.runtime as any)?.reads as Record<string, string> | undefined;
let readsSnapshot: Record<string, unknown> | undefined;
if (reads) {
  readsSnapshot = {};
  for (const [, rawPath] of Object.entries(reads)) {
    const storePath = rawPath.startsWith("store.") ? rawPath.slice(6) : rawPath;
    const rootKey = storePath.split(".")[0];
    if (context.store[rootKey] !== undefined) {
      readsSnapshot[rootKey] = context.store[rootKey];
    }
  }
}
```

Note: The exact location depends on where `stageCheckpoints` is set. Search for `stageCheckpoints` assignment in helpers.ts or state-builders.ts and add `readsSnapshot` to the checkpoint object.

- [ ] **Step 3: Write test for incremental diff**

Add to `apps/server/src/agent/context-builder.test.ts`:

```typescript
describe("buildTier1Context - incremental diff on resume", () => {
  it("shows 'unchanged' for reads that match checkpoint", () => {
    const ctx = makeContext({
      store: {
        requirements: { summary: "build a todo app" },
        design: { architecture: "React + Node" },
      },
      resumeInfo: { sessionId: "sess-1", feedback: "fix the bug" },
      stageCheckpoints: {
        execute: {
          startedAt: "2026-04-13T00:00:00Z",
          readsSnapshot: {
            requirements: { summary: "build a todo app" },
            design: { architecture: "React + Node" },
          },
        },
      },
    });
    const runtime = {
      reads: { "Requirements": "requirements", "Design": "design" },
    } as any;
    const result = buildTier1Context(ctx, runtime, 8000, "execute");
    expect(result).toContain("Unchanged since previous attempt");
    expect(result).not.toContain("build a todo app");
  });

  it("shows full value for reads that changed since checkpoint", () => {
    const ctx = makeContext({
      store: {
        requirements: { summary: "build a todo app v2" },
        design: { architecture: "React + Node" },
      },
      resumeInfo: { sessionId: "sess-1", feedback: "fix the bug" },
      stageCheckpoints: {
        execute: {
          startedAt: "2026-04-13T00:00:00Z",
          readsSnapshot: {
            requirements: { summary: "build a todo app" },
            design: { architecture: "React + Node" },
          },
        },
      },
    });
    const runtime = {
      reads: { "Requirements": "requirements", "Design": "design" },
    } as any;
    const result = buildTier1Context(ctx, runtime, 8000, "execute");
    expect(result).toContain("build a todo app v2");
    // Design unchanged
    expect(result).toContain("Unchanged since previous attempt");
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd apps/server && npx vitest run src/agent/context-builder.test.ts`
Expected: FAIL (no diff logic yet)

- [ ] **Step 5: Implement incremental diff in buildTier1Context**

In `apps/server/src/agent/context-builder.ts`, modify the function signature to accept an optional `currentStage` parameter:

```typescript
export function buildTier1Context(
  context: WorkflowContext,
  runtime?: AgentRuntimeConfig,
  maxTokens: number = DEFAULT_TIER1_MAX_TOKENS,
  currentStage?: string,
): string {
```

Then, in the `runtime.reads` loop, before the existing value rendering, add diff detection:

```typescript
// After getting `val` for each read key:
if (context.resumeInfo && currentStage && context.stageCheckpoints?.[currentStage]?.readsSnapshot) {
  const prevSnapshot = context.stageCheckpoints[currentStage].readsSnapshot!;
  const rootKey = storePath.split(".")[0];
  const prevVal = prevSnapshot[rootKey];
  if (prevVal !== undefined && JSON.stringify(val) === JSON.stringify(prevVal)) {
    addPart(`\n### ${label}\n> Unchanged since previous attempt. Use get_store_value("${storePath}") if needed.`);
    continue; // Skip full rendering for this read
  }
}
```

- [ ] **Step 6: Update call sites to pass currentStage**

In `apps/server/src/agent/stage-executor.ts` line 100, update:

```typescript
const effectiveTier1 = buildTier1Context(context, runtime, undefined, stageName);
```

In `apps/server/src/machine/state-builders.ts`, the `buildTier1Context(context)` call in `buildAgentState` invoke input (line 145):

```typescript
tier1Context: buildTier1Context(context, undefined, undefined, stateName),
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd apps/server && npx vitest run src/agent/context-builder.test.ts`
Expected: PASS

- [ ] **Step 8: Run full type check**

Run: `cd apps/server && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/machine/types.ts apps/server/src/machine/helpers.ts apps/server/src/agent/context-builder.ts apps/server/src/agent/context-builder.test.ts apps/server/src/agent/stage-executor.ts apps/server/src/machine/state-builders.ts
git commit -m "feat(R2): incremental context diff on resume with readsSnapshot"
```

---

## Task 7a: Stage Execution Timeout (R3)

**Files:**
- Modify: `apps/server/src/agent/stage-executor.ts`
- Modify: `apps/server/src/agent/query-options-builder.ts`

- [ ] **Step 1: Add abortSignal parameter to buildQueryOptions**

In `apps/server/src/agent/query-options-builder.ts`, add `abortSignal?: AbortSignal` to the params interface:

```typescript
export function buildQueryOptions(params: {
  // ... existing params
  abortSignal?: AbortSignal;
}): Record<string, unknown> {
```

And in the options object construction, add:

```typescript
const options: Record<string, unknown> = {
  // ... existing fields
  ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
};
```

- [ ] **Step 2: Add AbortController in stage-executor.ts**

In `apps/server/src/agent/stage-executor.ts`, in the `executeStage` function, before the query creation block (line ~133, before `const canResume`):

```typescript
// Absolute execution timeout (applies to web mode; edge mode handles its own timeout)
const stageTimeoutSec = privateStage?.stage_timeout_sec ?? 1800;
const abortController = new AbortController();
const absoluteTimer = setTimeout(() => {
  taskLogger(taskId, stageName).error({ timeoutSec: stageTimeoutSec }, "Stage absolute execution timeout reached");
  abortController.abort(new Error(`Stage execution timeout after ${stageTimeoutSec}s`));
}, stageTimeoutSec * 1000);

// Timeout approaching warning at 80%
const warningTimer = setTimeout(() => {
  const remainingSec = Math.floor(stageTimeoutSec * 0.2);
  sseManager.pushMessage(taskId, createSSEMessage(taskId, "agent_progress", {
    phase: "timeout_approaching",
    remainingSeconds: remainingSec,
    message: `Stage will timeout in ${remainingSec}s`,
  }));
}, stageTimeoutSec * 0.8 * 1000);
```

- [ ] **Step 3: Pass abortSignal to Claude SDK query options**

In the Claude branch of stage-executor.ts (the `else` block, around line 213):

```typescript
const options = buildQueryOptions({
  // ... existing params
  abortSignal: abortController.signal,
});
```

- [ ] **Step 4: Wrap processAgentStream in try/finally for cleanup**

After the `processAgentStream` call (line ~230), wrap the result:

```typescript
let result: AgentResult;
try {
  result = await processAgentStream({
    taskId,
    stageName,
    agentQuery,
    resumeDepth: _resumeDepth,
    onResume: ({ sessionId, resumePrompt: rp }) =>
      executeStage(taskId, stageName, prompt, stagePrompt, {
        ...stageOpts, resumeSessionId: sessionId, resumePrompt: rp, _resumeDepth: _resumeDepth + 1,
      }),
  });
} finally {
  clearTimeout(absoluteTimer);
  clearTimeout(warningTimer);
}

return { ...result, cwd: effectiveCwd || cwd };
```

Note: For Gemini and Codex engines, the abort controller is not passed (they have their own timeout mechanisms). Only add it for the Claude path.

- [ ] **Step 5: Run type check**

Run: `cd apps/server && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/agent/stage-executor.ts apps/server/src/agent/query-options-builder.ts
git commit -m "feat(R3): add absolute stage execution timeout with AbortController"
```

---

## Task 7b: Heartbeat in Stream Processor (R3)

**Files:**
- Modify: `apps/server/src/agent/stream-processor.ts`

- [ ] **Step 1: Add heartbeat interval and progress tracking**

In `apps/server/src/agent/stream-processor.ts`, inside `processAgentStream`, after the inactivity timer setup (line ~56), add:

```typescript
const startTime = Date.now();
let lastToolUse: { name: string; timestamp: string } | undefined;

// Heartbeat: emit structured progress every 30 seconds
const heartbeatInterval = setInterval(() => {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  sseManager.pushMessage(taskId, createSSEMessage(taskId, "agent_progress", {
    phase: "heartbeat",
    toolCallCount,
    elapsedSeconds: elapsed,
    lastToolName: lastToolUse?.name,
    lastToolAt: lastToolUse?.timestamp,
  }));
}, 30_000);
```

- [ ] **Step 2: Track last tool use**

In the `tool_use` block (around line 93-99), update `lastToolUse`:

```typescript
if (block.type === "tool_use") {
  lastToolUse = { name: block.name, timestamp: new Date().toISOString() };
  sseManager.pushMessage(taskId, createSSEMessage(taskId, "agent_tool_use", { toolName: block.name, input: block.input as Record<string, unknown> }));
  toolCallCount++;
  sseManager.pushMessage(taskId, createSSEMessage(taskId, "agent_progress", {
    toolCallCount, phase: "working"
  }));
}
```

- [ ] **Step 3: Clean up heartbeat in finally block**

Update the existing `finally` block (line ~156-160) to also clear the heartbeat:

```typescript
} finally {
  clearTimeout(inactivityTimer);
  clearInterval(heartbeatInterval);
  if (!handledResume) {
    unregisterQuery(taskId);
  }
}
```

- [ ] **Step 4: Run existing stream-processor tests**

Run: `cd apps/server && npx vitest run src/agent/stream-processor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent/stream-processor.ts
git commit -m "feat(R3): add 30-second heartbeat with progress metrics in stream processor"
```

---

## Task 8: Parallel Group Transactional Store (R4)

**Files:**
- Modify: `apps/server/src/machine/types.ts`
- Modify: `apps/server/src/machine/state-builders.ts`

- [ ] **Step 1: Add parallelStagedWrites to WorkflowContext**

In `apps/server/src/machine/types.ts`:

```typescript
export interface WorkflowContext {
  // ... existing fields
  parallelStagedWrites?: Record<string, Record<string, unknown>>;
}
```

- [ ] **Step 2: Modify buildAgentState to buffer writes when inside parallel group**

In `apps/server/src/machine/state-builders.ts`, in the `buildAgentState` function's normal-path onDone assign action (line ~387), the store merge block:

The key indicator of being inside a parallel group is `opts?.statePrefix`. Currently `statePrefix` is `"#workflow"` for parallel children.

Modify the store-write block to conditionally buffer:

```typescript
// In the normal-path assign (line ~387):
assign(({ event, context }: { event: DoneEvent; context: WorkflowContext }) => {
  const isParallelChild = !!opts?.statePrefix;
  let store = context.store ?? {};
  let stagedWrites = context.parallelStagedWrites;

  if (runtime.writes?.length && event.output?.resultText) {
    try {
      const parsed = extractJSON(event.output.resultText);
      const writeStrategies = buildWriteStrategies(runtime.writes);
      const updates: Record<string, any> = {};
      for (const w of runtime.writes) {
        const field = typeof w === "string" ? w : w.key;
        if (parsed[field] !== undefined) updates[field] = parsed[field];
      }
      if (Object.keys(updates).length) {
        if (isParallelChild) {
          // Buffer writes for atomic commit on group completion
          const groupName = "parallel"; // Parallel children don't know group name from statePrefix alone
          stagedWrites = {
            ...stagedWrites,
            [stateName]: updates, // Key by child stage name; group onDone merges all
          };
        } else {
          applyStoreUpdates(store, updates, writeStrategies);
          // Generate summaries as before...
        }
      }
    } catch (err) {
      taskLogger(context.taskId).error({ err, stage: stateName }, "Failed to parse agent output for writes");
    }
  }
  return {
    ...(isParallelChild ? { parallelStagedWrites: stagedWrites } : { store }),
    retryCount: 0,
    // ... rest of existing return fields
  };
}),
```

Wait — the design spec keys by group name, but child stages don't have access to the group name via `statePrefix` alone (it's `"#workflow"`). Better approach: key the staging area by child stage name, and have the group onDone merge all children's staged writes.

- [ ] **Step 3: Modify buildParallelGroupState onDone to commit staged writes**

In `buildParallelGroupState`'s `onDone.actions`, modify the existing assign to also merge staged writes:

```typescript
onDone: {
  target: nextTarget,
  actions: [
    assign(({ context }: { context: WorkflowContext }) => {
      const { [groupName]: _, ...restParallelDone } = context.parallelDone ?? {};
      
      // Commit all staged writes from child stages
      const newStore = { ...context.store };
      const staged = context.parallelStagedWrites ?? {};
      const allChildWrites = group.stages.flatMap(s => {
        const runtime = s.runtime as Record<string, any> | undefined;
        return runtime?.writes ?? [];
      });
      const writeStrategies = buildWriteStrategies(allChildWrites);
      
      for (const childName of group.stages.map(s => s.name)) {
        const childUpdates = staged[childName];
        if (childUpdates) {
          applyStoreUpdates(newStore, childUpdates, writeStrategies);
        }
      }
      
      // Clean up staged writes for all children
      const newStaged = { ...staged };
      for (const s of group.stages) {
        delete newStaged[s.name];
      }
      
      return {
        store: newStore,
        retryCount: 0,
        stageRetryCount: {},
        resumeInfo: undefined,
        parallelDone: Object.keys(restParallelDone).length > 0 ? restParallelDone : undefined,
        parallelStagedWrites: Object.keys(newStaged).length > 0 ? newStaged : undefined,
      };
    }),
    emitTaskListUpdate(),
    emitPersistSession(),
  ],
},
```

- [ ] **Step 4: Handle reads from staged writes during parallel execution**

In `buildTier1Context` (context-builder.ts), when building tier-1 for a stage, merge staged writes into the store view. This requires passing `parallelStagedWrites` and the current stage name. The simplest approach: in `buildAgentState`'s invoke input, merge the staged writes into the store before passing to tier1:

```typescript
// In buildAgentState invoke input:
input: ({ context }: { context: WorkflowContext }) => {
  // Merge own staged writes into store view for tier-1 context
  const effectiveStore = opts?.statePrefix
    ? { ...context.store, ...(context.parallelStagedWrites?.[stateName] ?? {}) }
    : context.store;
  const effectiveContext = { ...context, store: effectiveStore };
  // ... rest of input building using effectiveContext
```

- [ ] **Step 5: Run type check**

Run: `cd apps/server && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Run existing state-builders and pipeline-builder tests**

Run: `cd apps/server && npx vitest run src/machine/state-builders.test.ts src/machine/pipeline-builder.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/machine/types.ts apps/server/src/machine/state-builders.ts
git commit -m "feat(R4): parallel group transactional store with deferred commit"
```

---

## Task 9: DAG Scheduling — depends_on (R5)

**Files:**
- Modify: `apps/server/src/lib/config/types.ts`
- Modify: `apps/server/src/lib/config/schema.ts`
- Modify: `apps/server/src/machine/pipeline-builder.ts`
- Modify: `packages/shared/src/pipeline-validator.ts`

- [ ] **Step 1: Add depends_on to PipelineStageConfig type**

In `apps/server/src/lib/config/types.ts`:

```typescript
export interface PipelineStageConfig {
  // ... existing fields
  depends_on?: string[];
}
```

- [ ] **Step 2: Add depends_on to Zod schema**

In `apps/server/src/lib/config/schema.ts`, add to `PipelineStageConfigSchema`:

```typescript
export const PipelineStageConfigSchema = z.object({
  // ... existing fields
  depends_on: z.array(z.string()).optional(),
});
```

- [ ] **Step 3: Add depends_on validation in pipeline-validator.ts**

In `packages/shared/src/pipeline-validator.ts`, add validation in the main `validatePipelineLogic` function:

```typescript
// At the top of the function, after collecting all stage names:

// Validate depends_on references
const usesDependsOn = stages.some(e => !isParallelGroup(e) && (e as StageConfig).depends_on?.length);
const usesParallelGroup = stages.some(e => isParallelGroup(e));

if (usesDependsOn && usesParallelGroup) {
  issues.push({
    severity: "error",
    message: "Pipeline cannot use both depends_on and parallel_group. They are mutually exclusive.",
  });
}

// Validate depends_on targets exist and detect cycles
if (usesDependsOn) {
  const depGraph = new Map<string, string[]>();
  for (const entry of stages) {
    if (isParallelGroup(entry)) continue;
    const stage = entry as StageConfig;
    if (stage.depends_on) {
      for (const dep of stage.depends_on) {
        if (!allStageNames.has(dep)) {
          issues.push({
            severity: "error",
            stageIndex: stages.indexOf(entry),
            field: "depends_on",
            message: `Stage "${stage.name}" depends_on "${dep}" which does not exist`,
          });
        }
      }
      depGraph.set(stage.name, stage.depends_on);
    }
  }

  // Cycle detection (DFS)
  const visited = new Set<string>();
  const inStack = new Set<string>();
  function hasCycle(node: string): boolean {
    if (inStack.has(node)) return true;
    if (visited.has(node)) return false;
    visited.add(node);
    inStack.add(node);
    for (const dep of depGraph.get(node) ?? []) {
      if (hasCycle(dep)) {
        issues.push({
          severity: "error",
          message: `Cycle detected in depends_on: ${node} -> ${dep}`,
        });
        return true;
      }
    }
    inStack.delete(node);
    return false;
  }
  for (const name of depGraph.keys()) {
    hasCycle(name);
  }
}
```

- [ ] **Step 4: Add DAG-to-parallel-group transformation in pipeline-builder.ts**

In `apps/server/src/machine/pipeline-builder.ts`, add a transformation function before `buildPipelineStates`:

```typescript
function transformDagToParallelGroups(pipeline: PipelineConfig): PipelineConfig {
  const hasDepends = pipeline.stages.some(
    e => !isParallelGroup(e) && (e as PipelineStageConfig).depends_on?.length
  );
  if (!hasDepends) return pipeline;

  // Build dependency graph
  const stages = pipeline.stages as PipelineStageConfig[];
  const depMap = new Map<string, Set<string>>();
  for (const s of stages) {
    depMap.set(s.name, new Set(s.depends_on ?? []));
  }

  // Topological sort into levels
  const levels: PipelineStageConfig[][] = [];
  const placed = new Set<string>();

  while (placed.size < stages.length) {
    const level: PipelineStageConfig[] = [];
    for (const s of stages) {
      if (placed.has(s.name)) continue;
      const deps = depMap.get(s.name) ?? new Set();
      if ([...deps].every(d => placed.has(d))) {
        level.push(s);
      }
    }
    if (level.length === 0) break; // cycle (should be caught by validator)
    for (const s of level) placed.add(s.name);
    levels.push(level);
  }

  // Convert levels to pipeline entries
  const newStages: PipelineStageEntry[] = [];
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    if (level.length === 1) {
      // Single stage at this level — keep as sequential
      newStages.push(level[0]);
    } else {
      // Multiple stages — wrap in parallel group
      newStages.push({
        parallel: {
          name: `__dag_group_${i}`,
          stages: level,
        },
      });
    }
  }

  return { ...pipeline, stages: newStages };
}
```

Then in `buildPipelineStates`, apply the transformation at the top:

```typescript
export function buildPipelineStates(pipeline: PipelineConfig): Record<string, StateNode> {
  const transformed = transformDagToParallelGroups(pipeline);
  const states: Record<string, StateNode> = {};
  // ... rest uses `transformed` instead of `pipeline`
```

- [ ] **Step 5: Run type check**

Run: `cd apps/server && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Run pipeline-builder and validator tests**

Run: `cd apps/server && npx vitest run src/machine/pipeline-builder.test.ts`
Run: `npx vitest run packages/shared/src/pipeline-validator.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/lib/config/types.ts apps/server/src/lib/config/schema.ts apps/server/src/machine/pipeline-builder.ts packages/shared/src/pipeline-validator.ts
git commit -m "feat(R5): DAG scheduling with depends_on and auto parallel group generation"
```

---

## Task 10: Full Verification

- [ ] **Step 1: Run full type check**

Run: `cd apps/server && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 2: Run full test suite**

Run: `cd apps/server && npx vitest run`
Expected: Same baseline as before (193 passed, 5 pre-existing failures)

- [ ] **Step 3: Run shared package tests**

Run: `cd packages/shared && npx vitest run`
Expected: PASS

- [ ] **Step 4: Review all changes**

Run: `git diff main --stat` to review the full change set.

---

## Execution Order Summary

| Task | Feature | Dependencies |
|------|---------|-------------|
| 1 | Schema types for R1 | None |
| 2 | Semantic summary module | Task 1 |
| 3 | Store inheritance | Task 1 |
| 4 | Semantic summary trigger | Task 2 |
| 5 | Semantic summary in context | Task 2, 4 |
| 6 | Incremental diff on resume (R2) | Task 1 |
| 7a | Stage execution timeout (R3) | None |
| 7b | Heartbeat (R3) | None |
| 8 | Parallel transactional store (R4) | None |
| 9 | DAG scheduling (R5) | Task 8 recommended |
| 10 | Full verification | All above |

Tasks 7a, 7b, and 8 are independent and can run in parallel with the R1/R2 track.
