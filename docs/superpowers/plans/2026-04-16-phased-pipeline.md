# Phased Pipeline (A1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable pipeline phases to be generated at runtime based on actual execution data, breaking the planning-execution information asymmetry that degrades complex pipelines.

**Architecture:** Extend the existing pipeline-call mechanism to read pipeline definitions from the store instead of the filesystem. A planning-stage (regular agent stage) generates a validated pipeline definition into the store, then a pipeline-call stage with `pipeline_source: "store"` executes it as a sub-task. This reuses all existing sub-pipeline infrastructure (independent XState machine, store passing, timeout, cancellation).

**Tech Stack:** TypeScript, Zod v4, XState v5, YAML

**Spec:** `docs/superpowers/specs/2026-04-16-architecture-deep-review.md` Section 10

---

## Key Design Decisions

1. **Store-sourced pipelines carry inline prompts.** Since there's no filesystem directory for dynamically generated pipelines, the planning-stage must include system prompts as inline strings in the pipeline definition (a new `inline_prompts` field on PipelineConfig).

2. **Validation before execution.** Store-sourced pipeline definitions go through the same `validatePipelineConfig` + `validatePipelineLogic` validation as file-sourced ones. Invalid definitions cause the pipeline-call stage to error (not silently proceed).

3. **The planning-stage is a regular agent stage.** No new stage type needed. The agent outputs a JSON pipeline definition, the system validates it, then the next pipeline-call stage executes it.

4. **Config construction for inline pipelines.** `snapshotGlobalConfig` reads from filesystem. For store-sourced pipelines, we build the config object directly from the inline definition + parent's global config (fragments, constraints, claude_md, etc.).

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `apps/server/src/lib/config/types.ts` | Add `pipeline_source`, `pipeline_key` to PipelineCallRuntimeConfig; add `inline_prompts` to PipelineConfig |
| Modify | `apps/server/src/lib/config/schema.ts` | Zod schemas for new fields |
| Create | `apps/server/src/machine/inline-pipeline-config.ts` | Build WorkflowContext config from inline pipeline definition |
| Create | `apps/server/src/machine/inline-pipeline-config.test.ts` | Tests |
| Modify | `apps/server/src/agent/pipeline-executor.ts` | Handle `pipeline_source: "store"` — read pipeline from store, validate, build config |
| Modify | `apps/server/src/machine/actor-registry.ts` | Add `createTaskDraftFromConfig` variant that accepts pre-built config |
| Create | `apps/server/src/agent/pipeline-executor.test.ts` | Tests for store-sourced pipeline execution |

---

## Task 1: Type and Schema Extensions

**Files:**
- Modify: `apps/server/src/lib/config/types.ts`
- Modify: `apps/server/src/lib/config/schema.ts`

- [ ] **Step 1: Extend PipelineCallRuntimeConfig**

In `apps/server/src/lib/config/types.ts`, find `PipelineCallRuntimeConfig` (around line 80):

```typescript
// Before:
export interface PipelineCallRuntimeConfig {
  engine: "pipeline";
  pipeline_name: string;
  reads?: Record<string, string>;
  writes?: WriteDeclaration[];
  timeout_sec?: number;
}

// After:
export interface PipelineCallRuntimeConfig {
  engine: "pipeline";
  pipeline_name?: string;            // required when pipeline_source is "config" (default)
  pipeline_source?: "config" | "store";
  pipeline_key?: string;             // store key containing the pipeline definition (when source is "store")
  reads?: Record<string, string>;
  writes?: WriteDeclaration[];
  timeout_sec?: number;
}
```

- [ ] **Step 2: Add inline_prompts to PipelineConfig**

In `PipelineConfig` (around line 213), add:

```typescript
  inline_prompts?: Record<string, string>;  // stage_name -> system prompt content (for store-sourced pipelines)
```

- [ ] **Step 3: Update Zod schemas**

In `apps/server/src/lib/config/schema.ts`, update `PipelineCallRuntimeConfigSchema`:

```typescript
export const PipelineCallRuntimeConfigSchema = z.object({
  engine: z.literal("pipeline"),
  pipeline_name: z.string().min(1).optional(),
  pipeline_source: z.enum(["config", "store"]).optional(),
  pipeline_key: z.string().min(1).optional(),
  reads: z.record(z.string(), z.string()).optional(),
  writes: z.array(WriteDeclarationSchema).optional(),
  timeout_sec: z.number().optional(),
}).refine(
  (data) => {
    if (data.pipeline_source === "store") return !!data.pipeline_key;
    return !!data.pipeline_name;
  },
  { message: "pipeline_name required for config source; pipeline_key required for store source" }
);
```

Add `inline_prompts` to `PipelineConfigSchema`:

```typescript
  inline_prompts: z.record(z.string(), z.string()).optional(),
```

- [ ] **Step 4: Run type check and tests**

Run: `cd apps/server && npx tsc --noEmit`
Run: `cd apps/server && npx vitest run src/lib/config/schema.test.ts src/lib/config/schema.adversarial.test.ts`

- [ ] **Step 5: Commit**

```
git add apps/server/src/lib/config/types.ts apps/server/src/lib/config/schema.ts
git commit -m "feat: add pipeline_source/pipeline_key to PipelineCallRuntime and inline_prompts to PipelineConfig"
```

---

## Task 2: Inline Pipeline Config Builder

**Files:**
- Create: `apps/server/src/machine/inline-pipeline-config.ts`
- Create: `apps/server/src/machine/inline-pipeline-config.test.ts`

This module builds a `WorkflowContext["config"]` object from an inline pipeline definition (read from store) + the parent task's global config (fragments, constraints, etc.).

- [ ] **Step 1: Write tests**

```typescript
// apps/server/src/machine/inline-pipeline-config.test.ts
import { describe, it, expect } from "vitest";
import { buildInlinePipelineConfig } from "./inline-pipeline-config.js";
import type { PipelineConfig } from "../lib/config/types.js";
import type { WorkflowContext } from "./types.js";

describe("buildInlinePipelineConfig", () => {
  const parentConfig: WorkflowContext["config"] = {
    pipelineName: "meta-pipeline",
    pipeline: { name: "Meta", stages: [] },
    prompts: {
      system: {},
      fragments: { "frag-1": "Fragment content" },
      fragmentMeta: { "frag-1": { id: "frag-1", keywords: [], stages: "*", always: true } },
      globalConstraints: "Be careful",
      globalClaudeMd: "# Project",
      globalGeminiMd: "",
      globalCodexMd: "",
    },
    skills: [],
    mcps: ["notion"],
  };

  const inlinePipeline: PipelineConfig = {
    name: "Phase 1",
    engine: "claude",
    stages: [
      { name: "analyze", type: "agent", runtime: { engine: "llm" as const, system_prompt: "analyze" } },
    ],
    inline_prompts: {
      analyze: "You are analyzing the task. Be thorough.",
    },
  };

  it("builds config with inline prompts", () => {
    const config = buildInlinePipelineConfig(inlinePipeline, parentConfig);
    expect(config.pipelineName).toBe("Phase 1");
    expect(config.pipeline).toBe(inlinePipeline);
    expect(config.prompts.system.analyze).toBe("You are analyzing the task. Be thorough.");
  });

  it("inherits fragments from parent", () => {
    const config = buildInlinePipelineConfig(inlinePipeline, parentConfig);
    expect(config.prompts.fragments["frag-1"]).toBe("Fragment content");
  });

  it("inherits global constraints from parent", () => {
    const config = buildInlinePipelineConfig(inlinePipeline, parentConfig);
    expect(config.prompts.globalConstraints).toBe("Be careful");
  });

  it("inherits mcps from parent", () => {
    const config = buildInlinePipelineConfig(inlinePipeline, parentConfig);
    expect(config.mcps).toContain("notion");
  });

  it("works without inline_prompts", () => {
    const noPrompts = { ...inlinePipeline, inline_prompts: undefined };
    const config = buildInlinePipelineConfig(noPrompts, parentConfig);
    expect(config.prompts.system).toEqual({});
  });

  it("works without parent config", () => {
    const config = buildInlinePipelineConfig(inlinePipeline, undefined);
    expect(config.prompts.fragments).toEqual({});
    expect(config.prompts.globalConstraints).toBe("");
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// apps/server/src/machine/inline-pipeline-config.ts
import type { PipelineConfig } from "../lib/config/types.js";
import type { WorkflowContext } from "./types.js";
import { flattenStages } from "../lib/config/types.js";

/**
 * Build a WorkflowContext config from an inline pipeline definition.
 * Inherits fragments, constraints, and project instructions from the parent task config.
 * System prompts come from the pipeline's inline_prompts field.
 */
export function buildInlinePipelineConfig(
  pipeline: PipelineConfig,
  parentConfig?: WorkflowContext["config"],
): NonNullable<WorkflowContext["config"]> {
  // Build system prompts from inline_prompts
  const systemPrompts: Record<string, string> = {};
  if (pipeline.inline_prompts) {
    const toCamel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    for (const [key, content] of Object.entries(pipeline.inline_prompts)) {
      systemPrompts[toCamel(key)] = content;
    }
  }

  // Collect MCPs from pipeline stages + inherit from parent
  const pipelineMcps = new Set<string>(parentConfig?.mcps ?? []);
  for (const stage of flattenStages(pipeline.stages)) {
    if (stage.mcps) for (const m of stage.mcps) pipelineMcps.add(m);
  }

  return {
    pipelineName: pipeline.name,
    pipeline,
    prompts: {
      system: systemPrompts,
      fragments: parentConfig?.prompts.fragments ?? {},
      fragmentMeta: parentConfig?.prompts.fragmentMeta,
      globalConstraints: parentConfig?.prompts.globalConstraints ?? "",
      globalClaudeMd: parentConfig?.prompts.globalClaudeMd ?? "",
      globalGeminiMd: parentConfig?.prompts.globalGeminiMd ?? "",
      globalCodexMd: parentConfig?.prompts.globalCodexMd ?? "",
    },
    skills: pipeline.skills ?? parentConfig?.skills ?? [],
    mcps: [...pipelineMcps],
    sandbox: parentConfig?.sandbox,
    agent: parentConfig?.agent,
  };
}
```

- [ ] **Step 3: Run tests**

Run: `cd apps/server && npx vitest run src/machine/inline-pipeline-config.test.ts`

- [ ] **Step 4: Commit**

```
git add apps/server/src/machine/inline-pipeline-config.ts apps/server/src/machine/inline-pipeline-config.test.ts
git commit -m "feat: add inline pipeline config builder for store-sourced pipelines"
```

---

## Task 3: Extend createTaskDraft to Accept Pre-Built Config

**Files:**
- Modify: `apps/server/src/machine/actor-registry.ts`

Currently `createTaskDraft` calls `snapshotGlobalConfig(pipelineName)` to load config from filesystem. We need a variant that accepts a pre-built config object.

- [ ] **Step 1: Add inlineConfig option to createTaskDraft**

In `createTaskDraft` function (around line 270), add `inlineConfig` to the options parameter:

```typescript
export function createTaskDraft(
  taskId: string,
  repoName?: string,
  pipelineName?: string,
  taskText?: string,
  options?: {
    edge?: boolean;
    initialStore?: Record<string, any>;
    worktreePath?: string;
    branch?: string;
    inlineConfig?: NonNullable<WorkflowContext["config"]>;  // NEW: bypass filesystem config loading
  },
): WorkflowActor {
```

Then at line 285 (the `snapshotGlobalConfig` call), change to:

```typescript
  const config = options?.inlineConfig ?? snapshotGlobalConfig(pipelineName);
```

This is a one-line change in logic — when `inlineConfig` is provided, skip filesystem loading entirely.

- [ ] **Step 2: Run tests**

Run: `cd apps/server && npx vitest run src/machine/actor-registry.test.ts src/machine/actor-registry.adversarial.test.ts`

- [ ] **Step 3: Commit**

```
git add apps/server/src/machine/actor-registry.ts
git commit -m "feat: allow createTaskDraft to accept pre-built inline config"
```

---

## Task 4: Wire Store-Sourced Pipeline Execution

**Files:**
- Modify: `apps/server/src/agent/pipeline-executor.ts`

This is the core wiring: when `pipeline_source === "store"`, read the pipeline definition from the parent's store, validate it, build an inline config, and pass it to createTaskDraft.

- [ ] **Step 1: Read the current pipeline-executor.ts completely**

Understand the flow before editing.

- [ ] **Step 2: Add imports**

At the top of pipeline-executor.ts, add:

```typescript
import { validatePipelineConfig } from "../lib/config/schema.js";
import { validatePipelineLogic, getValidationErrors } from "@workflow-control/shared";
import { buildInlinePipelineConfig } from "../machine/inline-pipeline-config.js";
import type { PipelineConfig } from "../lib/config/types.js";
```

- [ ] **Step 3: Add store-sourced pipeline resolution**

In `runPipelineCall`, after the depth guard (line 33) and before the child store building (line 38), add:

```typescript
  // Resolve pipeline definition: from config directory or from store
  let resolvedPipelineName: string | undefined = runtime.pipeline_name;
  let inlineConfig: NonNullable<WorkflowContext["config"]> | undefined;

  if (runtime.pipeline_source === "store") {
    const pipelineKey = runtime.pipeline_key;
    if (!pipelineKey) {
      throw new Error(`Pipeline call in "${stageName}" has pipeline_source: "store" but no pipeline_key`);
    }
    const pipelineDef = getNestedValue(context.store, pipelineKey);
    if (!pipelineDef || typeof pipelineDef !== "object") {
      throw new Error(`Store key "${pipelineKey}" does not contain a valid pipeline definition`);
    }

    // Validate the inline pipeline
    const validation = validatePipelineConfig(pipelineDef);
    if (!validation.success) {
      const errMsg = validation.errors?.issues?.map((i: any) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Store-sourced pipeline "${pipelineKey}" failed schema validation: ${errMsg}`);
    }
    const validatedPipeline = validation.data as PipelineConfig;

    const logicIssues = validatePipelineLogic(
      validatedPipeline.stages as any,
      undefined,
      undefined,
      undefined,
      (validatedPipeline as any).store_schema,
    );
    const logicErrors = getValidationErrors(logicIssues);
    if (logicErrors.length > 0) {
      const errMsg = logicErrors.map((e) => `${e.field ? `[${e.field}] ` : ""}${e.message}`).join("; ");
      throw new Error(`Store-sourced pipeline "${pipelineKey}" failed logical validation: ${errMsg}`);
    }

    inlineConfig = buildInlinePipelineConfig(validatedPipeline, context.config);
    resolvedPipelineName = validatedPipeline.name;
    log.info({ pipelineKey, name: resolvedPipelineName }, "Resolved store-sourced pipeline");
  }
```

- [ ] **Step 4: Update createTaskDraft call to pass inlineConfig**

Change the `createTaskDraft` call (around line 59) from:

```typescript
  createTaskDraft(
    childTaskId,
    undefined,
    runtime.pipeline_name,
    context.taskText,
    {
      initialStore: childInitialStore,
      worktreePath: context.worktreePath,
      branch: context.branch,
      edge: isParentEdge,
    },
  );
```

To:

```typescript
  createTaskDraft(
    childTaskId,
    undefined,
    resolvedPipelineName ?? runtime.pipeline_name,
    context.taskText,
    {
      initialStore: childInitialStore,
      worktreePath: context.worktreePath,
      branch: context.branch,
      edge: isParentEdge,
      inlineConfig,
    },
  );
```

- [ ] **Step 5: Run type check**

Run: `cd apps/server && npx tsc --noEmit`

- [ ] **Step 6: Run tests**

Run: `cd apps/server && npx vitest run src/agent/pipeline-executor.test.ts src/agent/foreach-executor.test.ts`

- [ ] **Step 7: Commit**

```
git add apps/server/src/agent/pipeline-executor.ts
git commit -m "feat: support store-sourced pipeline execution in pipeline-executor"
```

---

## Task 5: Integration Test with Inline Pipeline

**Files:**
- Create: `apps/server/src/agent/pipeline-executor-store-source.test.ts`

- [ ] **Step 1: Write integration test**

This test verifies the full flow: store contains a pipeline definition, pipeline-call stage reads it, validates it, and would execute it. We mock the actor-registry to avoid actual XState execution.

```typescript
// apps/server/src/agent/pipeline-executor-store-source.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock actor-registry before importing pipeline-executor
vi.mock("../machine/actor-registry.js", () => ({
  createTaskDraft: vi.fn().mockReturnValue({
    subscribe: vi.fn((cb: any) => {
      // Simulate immediate completion
      setTimeout(() => cb({
        context: { status: "completed", store: { result: "done" } },
      }), 10);
      return { unsubscribe: vi.fn() };
    }),
    getSnapshot: vi.fn().mockReturnValue({ context: { status: "completed", store: { result: "done" } } }),
  }),
  launchTask: vi.fn().mockReturnValue(true),
  getWorkflow: vi.fn().mockReturnValue({
    subscribe: vi.fn((cb: any) => {
      setTimeout(() => cb({
        context: { status: "completed", store: { result: "done" } },
      }), 10);
      return { unsubscribe: vi.fn() };
    }),
  }),
  sendEvent: vi.fn(),
}));

vi.mock("./query-tracker.js", () => ({
  cancelTask: vi.fn(),
}));

import { runPipelineCall } from "./pipeline-executor.js";
import { createTaskDraft } from "../machine/actor-registry.js";
import type { WorkflowContext } from "../machine/types.js";
import type { PipelineCallRuntimeConfig } from "../lib/config/types.js";

describe("runPipelineCall with pipeline_source: store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads pipeline definition from store and passes inline config", async () => {
    const inlinePipeline = {
      name: "Dynamic Phase",
      engine: "claude",
      stages: [
        { name: "work", type: "agent", runtime: { engine: "llm", system_prompt: "work" } },
      ],
      inline_prompts: { work: "Do the work." },
    };

    const context: Partial<WorkflowContext> = {
      taskId: "parent-1",
      store: { phase_pipeline: inlinePipeline },
      config: {
        pipelineName: "meta",
        pipeline: { name: "Meta", stages: [] },
        prompts: {
          system: {},
          fragments: {},
          globalConstraints: "",
          globalClaudeMd: "",
          globalGeminiMd: "",
          globalCodexMd: "",
        },
        skills: [],
        mcps: [],
      },
    };

    const runtime: PipelineCallRuntimeConfig = {
      engine: "pipeline",
      pipeline_source: "store",
      pipeline_key: "phase_pipeline",
      writes: [{ key: "result" }],
    };

    await runPipelineCall("parent-1", {
      taskId: "parent-1",
      stageName: "execute-phase",
      context: context as WorkflowContext,
      runtime,
    });

    expect(createTaskDraft).toHaveBeenCalledWith(
      expect.stringContaining("parent-1-sub-execute-phase"),
      undefined,
      "Dynamic Phase",
      undefined,
      expect.objectContaining({
        inlineConfig: expect.objectContaining({
          pipelineName: "Dynamic Phase",
          pipeline: inlinePipeline,
        }),
      }),
    );
  });

  it("throws when store key is missing", async () => {
    const context: Partial<WorkflowContext> = {
      taskId: "parent-2",
      store: {},
      config: undefined,
    };

    const runtime: PipelineCallRuntimeConfig = {
      engine: "pipeline",
      pipeline_source: "store",
      pipeline_key: "missing_key",
    };

    await expect(
      runPipelineCall("parent-2", {
        taskId: "parent-2",
        stageName: "exec",
        context: context as WorkflowContext,
        runtime,
      }),
    ).rejects.toThrow(/does not contain a valid pipeline definition/);
  });

  it("throws on invalid pipeline definition", async () => {
    const context: Partial<WorkflowContext> = {
      taskId: "parent-3",
      store: { bad_pipeline: { name: "Bad", stages: "not-an-array" } },
      config: undefined,
    };

    const runtime: PipelineCallRuntimeConfig = {
      engine: "pipeline",
      pipeline_source: "store",
      pipeline_key: "bad_pipeline",
    };

    await expect(
      runPipelineCall("parent-3", {
        taskId: "parent-3",
        stageName: "exec",
        context: context as WorkflowContext,
        runtime,
      }),
    ).rejects.toThrow(/failed schema validation/);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd apps/server && npx vitest run src/agent/pipeline-executor-store-source.test.ts`

- [ ] **Step 3: Commit**

```
git add apps/server/src/agent/pipeline-executor-store-source.test.ts
git commit -m "test: add integration tests for store-sourced pipeline execution"
```

---

## Task 6: Full Integration Verification

- [ ] **Step 1: Type check**

Run: `cd apps/server && npx tsc --noEmit`

- [ ] **Step 2: Full test suite**

Run: `cd apps/server && npx vitest run`

- [ ] **Step 3: Shared package**

Run: `cd packages/shared && npx vitest run`

- [ ] **Step 4: Commit if fixups needed**

---

## Notes

- The planning-stage prompt template is NOT included in this plan. It's a prompt engineering task that should be developed iteratively with real-world testing, not pre-specified. The infrastructure (pipeline_source: "store" + inline_prompts + validation) is what this plan delivers.
- The proof-of-concept conversion of tech-research to phased model is also a separate effort. It requires redesigning that specific pipeline, which is domain-specific work.
- `inline_prompts` uses stage names as keys (kebab-case). The config builder converts to camelCase for consistency with the existing systemPrompts map.
