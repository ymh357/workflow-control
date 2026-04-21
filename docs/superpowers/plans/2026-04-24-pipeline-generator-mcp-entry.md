# Pipeline-Generator MCP Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two MCP tools (`start_pipeline_generator`, `wait_pipeline_result`) plus a YAML/loader refactor so external Claude Code sessions and internal pipeline agents can trigger the `pipeline-generator` builtin end-to-end over MCP.

**Architecture:** Extract a shared `loadLegacyPipelineIR` helper used by both the existing HTTP route and the new MCP tools. Add a `taskDescription` external_input to `pipeline-generator/pipeline.yaml` and wire it into `analyzing.reads`. Implement `start` as a thin wrapper that converts YAML → IR, inserts version, and kicks `runPipeline` in the background via the singleton broadcaster. Implement `wait` by subscribing to the broadcaster, mapping `run_final` / `stage_error` / `stage_executing`-on-gate events into four terminal shapes, and racing against a timeout.

**Tech Stack:** TypeScript, Zod, Vitest, Hono (existing HTTP), Claude Agent SDK (MCP server), node:sqlite, XState v5 (runner).

**Spec:** `docs/superpowers/specs/2026-04-24-pipeline-generator-mcp-entry-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `apps/server/src/kernel-next/runtime/load-legacy-pipeline.ts` | Pure helper: `pipelineDir` → `{ ir, promptRoot, yamlFilePath }` via `convertLegacyYaml` |
| Create | `apps/server/src/kernel-next/runtime/load-legacy-pipeline.test.ts` | Unit tests for loader |
| Create | `apps/server/src/kernel-next/mcp/pg-entry.ts` | Pure handlers for `start_pipeline_generator` + `wait_pipeline_result` (split from `server.ts` to keep it focused) |
| Create | `apps/server/src/kernel-next/mcp/pg-entry.test.ts` | Unit + integration tests for handlers |
| Modify | `apps/server/src/kernel-next/mcp/server.ts` | Import handlers from `pg-entry.ts`, register as `external` tools |
| Modify | `apps/server/src/kernel-next/mcp/server.test.ts` | Assert new tools appear in `external`/`combined`, absent from `internal`/`in-pipeline` |
| Modify | `apps/server/src/routes/kernel-run.ts` | Refactor `registerLegacyPipeline` to call `loadLegacyPipelineIR` |
| Modify | `apps/server/src/builtin-pipelines/pipeline-generator/pipeline.yaml` | Add `external_inputs.taskDescription`; change `analyzing.reads` to `{ description: taskDescription }` |
| Modify (conditional) | `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/analysis.md` | If current text assumes implicit task description, switch to referring to the `description` reads port |

---

## Task 1: Extract `loadLegacyPipelineIR` helper

**Files:**
- Create: `apps/server/src/kernel-next/runtime/load-legacy-pipeline.ts`
- Create: `apps/server/src/kernel-next/runtime/load-legacy-pipeline.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/kernel-next/runtime/load-legacy-pipeline.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { loadLegacyPipelineIR, LegacyPipelineLoadError } from "./load-legacy-pipeline.js";

describe("loadLegacyPipelineIR", () => {
  it("loads pipeline-generator YAML into IR", () => {
    const result = loadLegacyPipelineIR("pipeline-generator");
    expect(result.ir.stages.length).toBeGreaterThan(0);
    expect(result.promptRoot).toMatch(/pipeline-generator\/prompts$/);
    expect(result.yamlFilePath).toMatch(/pipeline-generator\/pipeline\.yaml$/);
  });

  it("throws LegacyPipelineLoadError with diagnostics for nonexistent pipeline", () => {
    expect(() => loadLegacyPipelineIR("does-not-exist-xyz")).toThrow(LegacyPipelineLoadError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter server vitest run src/kernel-next/runtime/load-legacy-pipeline.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `apps/server/src/kernel-next/runtime/load-legacy-pipeline.ts`:

```typescript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { convertLegacyYaml } from "../converter/legacy-yaml.js";
import type { PipelineIR } from "../ir/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface LegacyPipelineLoadResult {
  ir: PipelineIR;
  promptRoot: string;
  yamlFilePath: string;
}

export class LegacyPipelineLoadError extends Error {
  constructor(
    message: string,
    public readonly diagnostics: Array<{ code: string; message?: string }>,
  ) {
    super(message);
    this.name = "LegacyPipelineLoadError";
  }
}

export function loadLegacyPipelineIR(pipelineDir: string): LegacyPipelineLoadResult {
  const yamlFilePath = join(
    __dirname,
    "..",
    "..",
    "builtin-pipelines",
    pipelineDir,
    "pipeline.yaml",
  );
  let yamlText: string;
  try {
    yamlText = readFileSync(yamlFilePath, "utf-8");
  } catch (err) {
    throw new LegacyPipelineLoadError(
      `failed to read pipeline YAML at ${yamlFilePath}: ${(err as Error).message}`,
      [{ code: "YAML_READ_FAILED" }],
    );
  }
  const conv = convertLegacyYaml(yamlText, { yamlFilePath });
  if (!conv.ok) {
    throw new LegacyPipelineLoadError(
      `legacy pipeline '${pipelineDir}' failed to convert`,
      conv.diagnostics,
    );
  }
  return {
    ir: conv.ir,
    promptRoot: conv.promptRoot!,
    yamlFilePath,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter server vitest run src/kernel-next/runtime/load-legacy-pipeline.test.ts`
Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/runtime/load-legacy-pipeline.ts apps/server/src/kernel-next/runtime/load-legacy-pipeline.test.ts
git commit -m "feat(kernel-next): extract loadLegacyPipelineIR helper"
```

---

## Task 2: Refactor `kernel-run.ts` to use the loader

**Files:**
- Modify: `apps/server/src/routes/kernel-run.ts`

- [ ] **Step 1: Read current `registerLegacyPipeline`**

Read `apps/server/src/routes/kernel-run.ts` around lines 82-200 to see the current `registerLegacyPipeline` and its callers. Confirm it reads YAML + calls `convertLegacyYaml` + captures the result in a closure.

- [ ] **Step 2: Refactor to call `loadLegacyPipelineIR`**

Replace the body of `registerLegacyPipeline` so it delegates to the helper:

```typescript
// apps/server/src/routes/kernel-run.ts
import { loadLegacyPipelineIR, LegacyPipelineLoadError } from "../kernel-next/runtime/load-legacy-pipeline.js";

function registerLegacyPipeline(opts: LegacyPipelineRegistration): LegacyPipelineHandle {
  let loaded;
  try {
    loaded = loadLegacyPipelineIR(opts.pipelineDir);
  } catch (err) {
    if (err instanceof LegacyPipelineLoadError) {
      throw new Error(
        `legacy pipeline '${opts.pipelineDir}' failed to convert: ${err.diagnostics.map((d) => d.code).join(", ")}`,
      );
    }
    throw err;
  }
  for (const w of loaded.ir.stages) {
    // keep existing warning-log loop if present in the old code
  }
  return {
    ir: loaded.ir,
    promptRoot: loaded.promptRoot,
    yamlFilePath: loaded.yamlFilePath,
  };
}
```

Concretely: remove the inline `readFileSync` + `convertLegacyYaml` + error construction (lines ~112-122 in the current file) and replace with the `loadLegacyPipelineIR` call. Keep the `logger.info` loop that logs converter warnings if present — iterate over `loaded.ir` warnings if the helper exposes them; if not, this loop moves into the helper or is dropped. The current code warns from `conv.warnings`; after the refactor warnings aren't threaded back, so either (a) add `warnings` to `LegacyPipelineLoadResult` and log at call site, or (b) log inside the helper. Pick (a) to keep the helper pure:

Update the helper's return type to include warnings, then in `kernel-run.ts`:

```typescript
for (const w of loaded.warnings) {
  logger.info({ pipeline: opts.pipelineDir, warning: w }, "converter warning");
}
```

Update `load-legacy-pipeline.ts` accordingly:

```typescript
export interface LegacyPipelineLoadResult {
  ir: PipelineIR;
  promptRoot: string;
  yamlFilePath: string;
  warnings: Array<{ code: string; message?: string }>;
}

// in function body:
return {
  ir: conv.ir,
  promptRoot: conv.promptRoot!,
  yamlFilePath,
  warnings: conv.warnings ?? [],
};
```

Update the Task 1 test accordingly:

```typescript
it("returns warnings array", () => {
  const result = loadLegacyPipelineIR("pipeline-generator");
  expect(Array.isArray(result.warnings)).toBe(true);
});
```

- [ ] **Step 3: Run kernel-run tests to verify no regression**

Run: `pnpm --filter server vitest run src/routes/kernel-run.test.ts src/kernel-next/runtime/load-legacy-pipeline.test.ts`
Expected: PASS — all existing route tests green + loader tests green.

- [ ] **Step 4: Type-check**

Run: `pnpm --filter server tsc --noEmit`
Expected: clean, no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/kernel-run.ts apps/server/src/kernel-next/runtime/load-legacy-pipeline.ts apps/server/src/kernel-next/runtime/load-legacy-pipeline.test.ts
git commit -m "refactor(kernel-next): route kernel-run through shared loader"
```

---

## Task 3: Add `taskDescription` external input to pipeline-generator YAML

**Files:**
- Modify: `apps/server/src/builtin-pipelines/pipeline-generator/pipeline.yaml`
- Read first: `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/analysis.md`

- [ ] **Step 1: Read current analysis.md prompt**

Read the full file at `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/analysis.md`. Note whether it already refers to `description` as an input field, or assumes an implicit task description. Decide whether Step 4 below is a no-op or a small edit.

- [ ] **Step 2: Edit pipeline.yaml — add `external_inputs` block**

In `apps/server/src/builtin-pipelines/pipeline-generator/pipeline.yaml`, find the top-level `engine: claude` / `official: true` / `use_cases:` header block. Immediately before the `display:` section (or wherever fits the existing top-level field order — consistent with other builtin pipelines), add:

```yaml
external_inputs:
  taskDescription:
    type: string
    description: Natural language description of the pipeline to generate.
    required: true
```

- [ ] **Step 3: Edit pipeline.yaml — wire `analyzing.reads`**

In `stages`, find:

```yaml
  - name: analyzing
    type: agent
    interactive: true
    thinking:
      type: enabled
    mcps:
      - pulsemcp
    runtime:
      engine: llm
      system_prompt: analysis
      reads: {}
```

Change `reads: {}` to:

```yaml
      reads:
        description: taskDescription
```

- [ ] **Step 4: Update analysis.md if needed**

If Step 1 showed the prompt already speaks of "the task description" generically, add one line near the top stating `The task description is provided in the 'description' port of your reads.` If the prompt already reads from a specific port name, align it to `description`. If the prompt already aligns, skip this step.

- [ ] **Step 5: Verify converter accepts the change**

Run: `pnpm --filter server vitest run src/kernel-next/converter/pipeline-generator.test.ts`
Expected: PASS — converter test for pipeline-generator still green (or updates naturally because external_inputs + wire are well-formed).

If the test asserts an exact versionHash or wire count, update the test to match the new shape. The external_inputs addition is a breaking change to versionHash by design; that's fine (§spec §7 last note).

- [ ] **Step 6: Run full server test suite**

Run: `pnpm --filter server vitest run`
Expected: PASS — no regressions anywhere.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/builtin-pipelines/pipeline-generator/pipeline.yaml apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/analysis.md apps/server/src/kernel-next/converter/pipeline-generator.test.ts
git commit -m "feat(pipeline-generator): add taskDescription external input"
```

---

## Task 4: `start_pipeline_generator` handler — scaffold + empty-description error

**Files:**
- Create: `apps/server/src/kernel-next/mcp/pg-entry.ts`
- Create: `apps/server/src/kernel-next/mcp/pg-entry.test.ts`

- [ ] **Step 1: Write the failing test for empty description**

Create `apps/server/src/kernel-next/mcp/pg-entry.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelNextBroadcaster } from "../sse/broadcaster.js";
import { handleStartPipelineGenerator } from "./pg-entry.js";

function freshDb() {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

describe("handleStartPipelineGenerator — input validation", () => {
  it("rejects empty description", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const res = await handleStartPipelineGenerator(
      { description: "" },
      { db, broadcaster, runner: vi.fn() as any, loader: vi.fn() as any, model: "claude-haiku-4-5" },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("INVALID_DESCRIPTION");
    expect(res.reason).toBe("empty");
  });

  it("rejects description over 8000 chars", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const res = await handleStartPipelineGenerator(
      { description: "x".repeat(8001) },
      { db, broadcaster, runner: vi.fn() as any, loader: vi.fn() as any, model: "claude-haiku-4-5" },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("INVALID_DESCRIPTION");
    expect(res.reason).toBe("too_long");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter server vitest run src/kernel-next/mcp/pg-entry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement scaffold + validation**

Create `apps/server/src/kernel-next/mcp/pg-entry.ts`:

```typescript
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { KernelNextBroadcaster } from "../sse/broadcaster.js";
import type { PipelineIR } from "../ir/schema.js";
import type { StageExecutor } from "../runtime/executor.js";

export interface StartPipelineGeneratorInput {
  description: string;
  taskId?: string;
}

export type StartPipelineGeneratorResult =
  | { ok: true; taskId: string; versionHash: string; pipelineDir: string }
  | { ok: false; error: "INVALID_DESCRIPTION"; reason: "empty" | "too_long" }
  | { ok: false; error: "CONVERT_FAILED"; diagnostics: Array<{ code: string; message?: string }> }
  | { ok: false; error: "RUN_BOOTSTRAP_FAILED"; reason: string };

export interface PgEntryDeps {
  db: DatabaseSync;
  broadcaster: KernelNextBroadcaster;
  loader: (pipelineDir: string) => { ir: PipelineIR; promptRoot: string; yamlFilePath: string; warnings: Array<{ code: string; message?: string }> };
  runner: (args: {
    db: DatabaseSync;
    ir: PipelineIR;
    taskId: string;
    versionHash: string;
    handlers: Record<string, never>;
    executor: StageExecutor;
    seedValues: Record<string, unknown>;
    broadcaster: KernelNextBroadcaster;
  }) => Promise<unknown>;
  model: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  executorFactory?: (args: { promptRoot: string; db: DatabaseSync; model: string; maxTurns?: number; maxBudgetUsd?: number }) => StageExecutor;
}

const MAX_DESCRIPTION_LEN = 8000;

export async function handleStartPipelineGenerator(
  input: StartPipelineGeneratorInput,
  deps: PgEntryDeps,
): Promise<StartPipelineGeneratorResult> {
  const desc = input.description?.trim() ?? "";
  if (desc.length === 0) {
    return { ok: false, error: "INVALID_DESCRIPTION", reason: "empty" };
  }
  if (desc.length > MAX_DESCRIPTION_LEN) {
    return { ok: false, error: "INVALID_DESCRIPTION", reason: "too_long" };
  }
  // Remaining flow implemented in Task 5.
  throw new Error("not implemented");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter server vitest run src/kernel-next/mcp/pg-entry.test.ts`
Expected: PASS — validation tests green; other tests skipped for now.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/mcp/pg-entry.ts apps/server/src/kernel-next/mcp/pg-entry.test.ts
git commit -m "feat(pg-entry): scaffold handleStartPipelineGenerator with input validation"
```

---

## Task 5: `start_pipeline_generator` — full happy path + bootstrap errors

**Files:**
- Modify: `apps/server/src/kernel-next/mcp/pg-entry.ts`
- Modify: `apps/server/src/kernel-next/mcp/pg-entry.test.ts`

- [ ] **Step 1: Write failing tests for happy path + bootstrap errors**

Append to `pg-entry.test.ts`:

```typescript
import { versionHash as computeVersionHash } from "../ir/canonical.js";
import { insertPipelineVersion } from "../ir/sql.js";
import { LegacyPipelineLoadError } from "../runtime/load-legacy-pipeline.js";
import type { PipelineIR } from "../ir/schema.js";

function minimalIR(): PipelineIR {
  return {
    name: "pipeline-generator",
    version: "1.0.0",
    externalInputs: [{ name: "taskDescription", type: "string" }],
    stages: [
      { name: "analyzing", type: "agent", config: { systemPromptId: "analysis", reads: [] }, inputs: [{ name: "description", type: "string" }], outputs: [] },
    ],
    wires: [
      { from: { source: "external", port: "taskDescription" }, to: { stage: "analyzing", port: "description" } },
    ],
  } as unknown as PipelineIR;
}

describe("handleStartPipelineGenerator — happy path", () => {
  it("returns taskId + versionHash and kicks runner with seedValues", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const ir = minimalIR();
    const loader = vi.fn(() => ({ ir, promptRoot: "/tmp/prompts", yamlFilePath: "/tmp/pipeline.yaml", warnings: [] }));
    const runner = vi.fn(async () => undefined);
    const executorFactory = vi.fn(() => ({ executeStage: vi.fn() }) as unknown as StageExecutor);

    const res = await handleStartPipelineGenerator(
      { description: "make a pipeline for X" },
      { db, broadcaster, loader, runner, executorFactory, model: "claude-haiku-4-5" },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pipelineDir).toBe("pipeline-generator");
    expect(res.taskId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.versionHash).toMatch(/^[0-9a-f]+$/);
    expect(loader).toHaveBeenCalledWith("pipeline-generator");
    expect(runner).toHaveBeenCalledOnce();
    const runnerArgs = runner.mock.calls[0][0];
    expect(runnerArgs.seedValues).toEqual({ taskDescription: "make a pipeline for X" });
    expect(runnerArgs.taskId).toBe(res.taskId);
    expect(runnerArgs.broadcaster).toBe(broadcaster);
  });

  it("uses provided taskId when passed", async () => {
    const db = freshDb();
    const ir = minimalIR();
    const res = await handleStartPipelineGenerator(
      { description: "x", taskId: "my-task-1" },
      {
        db,
        broadcaster: new KernelNextBroadcaster(),
        loader: vi.fn(() => ({ ir, promptRoot: "/p", yamlFilePath: "/y", warnings: [] })),
        runner: vi.fn(async () => undefined),
        executorFactory: vi.fn(() => ({ executeStage: vi.fn() }) as any),
        model: "m",
      },
    );
    expect(res.ok && res.taskId).toBe("my-task-1");
  });
});

describe("handleStartPipelineGenerator — bootstrap errors", () => {
  it("returns CONVERT_FAILED when loader throws LegacyPipelineLoadError", async () => {
    const loader = vi.fn(() => {
      throw new LegacyPipelineLoadError("boom", [{ code: "YAML_READ_FAILED" }]);
    });
    const res = await handleStartPipelineGenerator(
      { description: "x" },
      {
        db: freshDb(),
        broadcaster: new KernelNextBroadcaster(),
        loader,
        runner: vi.fn(),
        executorFactory: vi.fn(),
        model: "m",
      },
    );
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe("CONVERT_FAILED");
  });

  it("returns RUN_BOOTSTRAP_FAILED when runner sync-throws", async () => {
    const ir = minimalIR();
    const runner = vi.fn(() => {
      throw new Error("runner init blew up");
    });
    const res = await handleStartPipelineGenerator(
      { description: "x" },
      {
        db: freshDb(),
        broadcaster: new KernelNextBroadcaster(),
        loader: vi.fn(() => ({ ir, promptRoot: "/p", yamlFilePath: "/y", warnings: [] })),
        runner,
        executorFactory: vi.fn(() => ({ executeStage: vi.fn() }) as any),
        model: "m",
      },
    );
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe("RUN_BOOTSTRAP_FAILED");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter server vitest run src/kernel-next/mcp/pg-entry.test.ts`
Expected: FAIL — not implemented branch hits.

- [ ] **Step 3: Implement the full happy path**

Replace the stub in `pg-entry.ts` after the validation block:

```typescript
export async function handleStartPipelineGenerator(
  input: StartPipelineGeneratorInput,
  deps: PgEntryDeps,
): Promise<StartPipelineGeneratorResult> {
  const desc = input.description?.trim() ?? "";
  if (desc.length === 0) return { ok: false, error: "INVALID_DESCRIPTION", reason: "empty" };
  if (desc.length > MAX_DESCRIPTION_LEN) return { ok: false, error: "INVALID_DESCRIPTION", reason: "too_long" };

  let loaded;
  try {
    loaded = deps.loader("pipeline-generator");
  } catch (err) {
    if (err instanceof LegacyPipelineLoadError) {
      return { ok: false, error: "CONVERT_FAILED", diagnostics: err.diagnostics };
    }
    return { ok: false, error: "CONVERT_FAILED", diagnostics: [{ code: "UNKNOWN", message: (err as Error).message }] };
  }

  const vh = computeVersionHash(loaded.ir);
  try {
    insertPipelineVersion(deps.db, loaded.ir, { versionHash: vh, tsSource: "" });
  } catch (err) {
    return { ok: false, error: "RUN_BOOTSTRAP_FAILED", reason: `insertPipelineVersion: ${(err as Error).message}` };
  }

  const taskId = input.taskId ?? randomUUID();
  const executor = deps.executorFactory
    ? deps.executorFactory({ promptRoot: loaded.promptRoot, db: deps.db, model: deps.model, maxTurns: deps.maxTurns, maxBudgetUsd: deps.maxBudgetUsd })
    : undefined;
  if (!executor) {
    return { ok: false, error: "RUN_BOOTSTRAP_FAILED", reason: "executorFactory missing" };
  }

  try {
    const p = deps.runner({
      db: deps.db,
      ir: loaded.ir,
      taskId,
      versionHash: vh,
      handlers: {},
      executor,
      seedValues: { taskDescription: desc },
      broadcaster: deps.broadcaster,
    });
    void p.catch((err) => {
      // background failure; wait_pipeline_result observes via broadcaster or timeout
      // eslint-disable-next-line no-console
      console.error("[pg-entry] background run failed", { taskId, err });
    });
  } catch (err) {
    return { ok: false, error: "RUN_BOOTSTRAP_FAILED", reason: (err as Error).message };
  }

  return { ok: true, taskId, versionHash: vh, pipelineDir: "pipeline-generator" };
}
```

Add the imports at the top of `pg-entry.ts`:

```typescript
import { versionHash as computeVersionHash } from "../ir/canonical.js";
import { insertPipelineVersion } from "../ir/sql.js";
import { LegacyPipelineLoadError } from "../runtime/load-legacy-pipeline.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter server vitest run src/kernel-next/mcp/pg-entry.test.ts`
Expected: PASS — all happy path + bootstrap-error tests green.

- [ ] **Step 5: Type-check**

Run: `pnpm --filter server tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/kernel-next/mcp/pg-entry.ts apps/server/src/kernel-next/mcp/pg-entry.test.ts
git commit -m "feat(pg-entry): implement start_pipeline_generator happy + error paths"
```

---

## Task 6: `wait_pipeline_result` — skeleton + run_final success mapping

**Files:**
- Modify: `apps/server/src/kernel-next/mcp/pg-entry.ts`
- Modify: `apps/server/src/kernel-next/mcp/pg-entry.test.ts`

- [ ] **Step 1: Write the failing test for run_final success → done**

Append to `pg-entry.test.ts`:

```typescript
import { handleWaitPipelineResult } from "./pg-entry.js";

describe("handleWaitPipelineResult — done", () => {
  it("returns done with result fields when run_final success event arrives", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const taskId = "task-done-1";
    const ir = minimalIR();

    // Seed the DB with latest_port_values so `done` can assemble the result.
    // Minimal shape used by the done assembler.
    db.exec(`
      INSERT INTO latest_port_values (task_id, stage_name, port_name, value_json)
      VALUES
        ('task-done-1', 'persistResult', 'pipelineId', '"my-pid"'),
        ('task-done-1', 'pipelineDesign', 'pipelineName', '"My Pipeline"'),
        ('task-done-1', 'pipelineDesign', 'description', '"Short descr"'),
        ('task-done-1', 'skeletonResult', 'yamlPath', '"/tmp/out/pipeline.yaml"'),
        ('task-done-1', 'promptFiles', 'outputDir', '"/tmp/out/prompts"');
    `);

    // Fire the terminal event before wait subscribes — broadcaster replays history.
    broadcaster.publish({
      taskId,
      seq: 1,
      ts: Date.now(),
      type: "run_final",
      data: { status: "succeeded", stageErrors: [] } as any,
    });

    const res = await handleWaitPipelineResult(
      { taskId, timeoutMs: 1000 },
      { db, broadcaster, ir },
    );

    expect(res.ok).toBe(true);
    if (!res.ok || res.status !== "done") throw new Error("expected done");
    expect(res.result.pipelineId).toBe("my-pid");
    expect(res.result.pipelineName).toBe("My Pipeline");
    expect(res.result.yamlPath).toBe("/tmp/out/pipeline.yaml");
    expect(res.result.promptDir).toBe("/tmp/out/prompts");
    expect(res.result.pipelineDesignSummary).toBe("Short descr");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter server vitest run src/kernel-next/mcp/pg-entry.test.ts -t "handleWaitPipelineResult"`
Expected: FAIL — `handleWaitPipelineResult` not exported.

- [ ] **Step 3: Implement wait skeleton with done mapping**

Append to `pg-entry.ts`:

```typescript
import type { AnyKernelNextSSEEvent } from "../sse/types.js";
import type { PipelineIR } from "../ir/schema.js";

export interface WaitPipelineResultInput {
  taskId: string;
  timeoutMs?: number;
}

export type WaitPipelineResultResult =
  | { ok: true; status: "done"; taskId: string; result: DoneResult }
  | { ok: true; status: "gate_pending"; taskId: string; gateName: string; gateContext: { pipelineDesign: Record<string, unknown> }; hint: string }
  | { ok: true; status: "running"; taskId: string; currentStage: string | null; elapsedMs: number; hint: string }
  | { ok: false; status: "error"; taskId: string; error: string; failedStage?: string };

export interface DoneResult {
  pipelineId: string;
  pipelineName: string;
  yamlPath: string;
  promptDir?: string;
  mcpsNeedingKeys?: Array<{ name: string; envVars: string[] }>;
  pipelineDesignSummary: string;
}

export interface WaitDeps {
  db: DatabaseSync;
  broadcaster: KernelNextBroadcaster;
  ir: PipelineIR;
  now?: () => number;
}

const MIN_TIMEOUT = 1_000;
const MAX_TIMEOUT = 300_000;
const DEFAULT_TIMEOUT = 30_000;

function clampTimeout(ms: number | undefined): number {
  const v = ms ?? DEFAULT_TIMEOUT;
  return Math.max(MIN_TIMEOUT, Math.min(MAX_TIMEOUT, v));
}

function readPortValue(db: DatabaseSync, taskId: string, stage: string, port: string): unknown {
  const row = db.prepare(
    "SELECT value_json FROM latest_port_values WHERE task_id=? AND stage_name=? AND port_name=?",
  ).get(taskId, stage, port) as { value_json: string } | undefined;
  if (!row) return undefined;
  try { return JSON.parse(row.value_json); } catch { return undefined; }
}

function assembleDone(db: DatabaseSync, taskId: string): DoneResult {
  const pipelineId = String(readPortValue(db, taskId, "persistResult", "pipelineId") ?? "");
  const pipelineName = String(readPortValue(db, taskId, "pipelineDesign", "pipelineName") ?? "");
  const yamlPath = String(readPortValue(db, taskId, "skeletonResult", "yamlPath") ?? "");
  const promptDir = readPortValue(db, taskId, "promptFiles", "outputDir");
  const mcpsNeedingKeys = readPortValue(db, taskId, "persistResult", "mcpsNeedingKeys");
  const descRaw = String(readPortValue(db, taskId, "pipelineDesign", "description") ?? "");
  return {
    pipelineId,
    pipelineName,
    yamlPath,
    ...(typeof promptDir === "string" ? { promptDir } : {}),
    ...(Array.isArray(mcpsNeedingKeys) ? { mcpsNeedingKeys: mcpsNeedingKeys as DoneResult["mcpsNeedingKeys"] } : {}),
    pipelineDesignSummary: descRaw.slice(0, 500),
  };
}

export async function handleWaitPipelineResult(
  input: WaitPipelineResultInput,
  deps: WaitDeps,
): Promise<WaitPipelineResultResult> {
  const timeoutMs = clampTimeout(input.timeoutMs);
  const now = deps.now ?? Date.now;
  const startedAt = now();

  return await new Promise<WaitPipelineResultResult>((resolve) => {
    let settled = false;
    const settle = (r: WaitPipelineResultResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      resolve(r);
    };

    const unsub = deps.broadcaster.subscribe(input.taskId, (ev: AnyKernelNextSSEEvent) => {
      if (ev.type === "run_final") {
        const data = ev.data as { status: "succeeded" | "failed"; stageErrors: Array<{ stage: string; message: string }> };
        if (data.status === "succeeded") {
          settle({ ok: true, status: "done", taskId: input.taskId, result: assembleDone(deps.db, input.taskId) });
        } else {
          const first = data.stageErrors[0];
          settle({ ok: false, status: "error", taskId: input.taskId, error: first?.message ?? "run failed", failedStage: first?.stage });
        }
      }
      // Other event types handled in subsequent tasks.
    });

    const timer = setTimeout(() => {
      settle({ ok: true, status: "running", taskId: input.taskId, currentStage: null, elapsedMs: now() - startedAt, hint: "Pipeline still running. Call wait_pipeline_result again to continue waiting." });
    }, timeoutMs);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter server vitest run src/kernel-next/mcp/pg-entry.test.ts -t "handleWaitPipelineResult"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/mcp/pg-entry.ts apps/server/src/kernel-next/mcp/pg-entry.test.ts
git commit -m "feat(pg-entry): implement wait_pipeline_result done path"
```

---

## Task 7: `wait_pipeline_result` — error path (run_final failed + stage_error final)

**Files:**
- Modify: `apps/server/src/kernel-next/mcp/pg-entry.ts`
- Modify: `apps/server/src/kernel-next/mcp/pg-entry.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `pg-entry.test.ts`:

```typescript
describe("handleWaitPipelineResult — error", () => {
  it("returns error when run_final status=failed", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const taskId = "task-fail-1";
    broadcaster.publish({
      taskId,
      seq: 1,
      ts: Date.now(),
      type: "run_final",
      data: { status: "failed", stageErrors: [{ stage: "analyzing", message: "boom" }] } as any,
    });
    const res = await handleWaitPipelineResult({ taskId, timeoutMs: 1000 }, { db, broadcaster, ir: minimalIR() });
    expect(res.ok).toBe(false);
    if (res.ok || res.status !== "error") throw new Error("expected error");
    expect(res.error).toBe("boom");
    expect(res.failedStage).toBe("analyzing");
  });

  it("returns error on stage_error with isFinalAttempt=true", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const taskId = "task-fail-2";
    broadcaster.publish({
      taskId,
      seq: 1,
      ts: Date.now(),
      type: "stage_error",
      data: { stage: "genSkeleton", message: "sdk timeout", isFinalAttempt: true } as any,
    });
    const res = await handleWaitPipelineResult({ taskId, timeoutMs: 1000 }, { db, broadcaster, ir: minimalIR() });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.status).toBe("error");
    expect(res.failedStage).toBe("genSkeleton");
    expect(res.error).toBe("sdk timeout");
  });

  it("ignores stage_error with isFinalAttempt=false", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const taskId = "task-retry-1";
    broadcaster.publish({
      taskId,
      seq: 1,
      ts: Date.now(),
      type: "stage_error",
      data: { stage: "analyzing", message: "transient", isFinalAttempt: false } as any,
    });
    // Expect timeout -> running (not error)
    const res = await handleWaitPipelineResult({ taskId, timeoutMs: 1000 }, { db, broadcaster, ir: minimalIR() });
    expect(res.ok).toBe(true);
    if (!res.ok || res.status !== "running") throw new Error("expected running");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter server vitest run src/kernel-next/mcp/pg-entry.test.ts -t "wait_pipeline_result"`
Expected: FAIL on stage_error tests (done path already passes).

- [ ] **Step 3: Implement stage_error handling**

In `pg-entry.ts`, inside the subscribe callback (currently handles only `run_final`), add:

```typescript
if (ev.type === "stage_error") {
  const data = ev.data as { stage: string; message: string; isFinalAttempt: boolean };
  if (data.isFinalAttempt) {
    settle({ ok: false, status: "error", taskId: input.taskId, error: data.message, failedStage: data.stage });
  }
  return;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter server vitest run src/kernel-next/mcp/pg-entry.test.ts -t "wait_pipeline_result"`
Expected: PASS — all three error-path tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/mcp/pg-entry.ts apps/server/src/kernel-next/mcp/pg-entry.test.ts
git commit -m "feat(pg-entry): handle wait_pipeline_result error paths"
```

---

## Task 8: `wait_pipeline_result` — gate_pending detection

**Files:**
- Modify: `apps/server/src/kernel-next/mcp/pg-entry.ts`
- Modify: `apps/server/src/kernel-next/mcp/pg-entry.test.ts`

- [ ] **Step 1: Write failing test**

Append to `pg-entry.test.ts`:

```typescript
describe("handleWaitPipelineResult — gate_pending", () => {
  it("returns gate_pending when stage_executing fires for a gate stage", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const taskId = "task-gate-1";

    // Seed pipelineDesign so assembler has something to embed in gateContext.
    db.exec(`
      INSERT INTO latest_port_values (task_id, stage_name, port_name, value_json)
      VALUES ('task-gate-1', 'pipelineDesign', 'pipelineName', '"Test P"'),
             ('task-gate-1', 'pipelineDesign', 'description', '"desc"');
    `);

    // Build an IR with a gate stage.
    const ir: PipelineIR = {
      name: "pipeline-generator",
      version: "1.0.0",
      externalInputs: [],
      stages: [
        { name: "analyzing", type: "agent", config: { systemPromptId: "a", reads: [] }, inputs: [], outputs: [] },
        { name: "awaitingConfirm", type: "gate", config: { routing: { routes: {}, defaultTarget: null } }, inputs: [], outputs: [] },
      ],
      wires: [],
    } as unknown as PipelineIR;

    broadcaster.publish({
      taskId,
      seq: 1,
      ts: Date.now(),
      type: "stage_executing",
      data: { stage: "awaitingConfirm" } as any,
    });

    const res = await handleWaitPipelineResult({ taskId, timeoutMs: 1000 }, { db, broadcaster, ir });
    expect(res.ok).toBe(true);
    if (!res.ok || res.status !== "gate_pending") throw new Error("expected gate_pending");
    expect(res.gateName).toBe("awaitingConfirm");
    expect(res.gateContext.pipelineDesign.pipelineName).toBe("Test P");
  });

  it("ignores stage_executing for non-gate stage (falls through to timeout)", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const taskId = "task-nongate-1";
    const ir = minimalIR();
    broadcaster.publish({
      taskId,
      seq: 1,
      ts: Date.now(),
      type: "stage_executing",
      data: { stage: "analyzing" } as any,
    });
    const res = await handleWaitPipelineResult({ taskId, timeoutMs: 1000 }, { db, broadcaster, ir });
    expect(res.ok && res.status).toBe("running");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter server vitest run src/kernel-next/mcp/pg-entry.test.ts -t "gate_pending"`
Expected: FAIL — gate_pending logic absent.

- [ ] **Step 3: Implement gate detection**

In `pg-entry.ts`, inside the subscribe callback, before the `run_final` branch, add:

```typescript
if (ev.type === "stage_executing") {
  const data = ev.data as { stage: string };
  const stage = deps.ir.stages.find((s) => s.name === data.stage);
  if (stage && stage.type === "gate") {
    const pipelineDesignEntries = deps.db.prepare(
      "SELECT port_name, value_json FROM latest_port_values WHERE task_id=? AND stage_name='pipelineDesign'",
    ).all(input.taskId) as Array<{ port_name: string; value_json: string }>;
    const pipelineDesign: Record<string, unknown> = {};
    for (const row of pipelineDesignEntries) {
      try { pipelineDesign[row.port_name] = JSON.parse(row.value_json); } catch { /* skip */ }
    }
    settle({
      ok: true,
      status: "gate_pending",
      taskId: input.taskId,
      gateName: data.stage,
      gateContext: { pipelineDesign },
      hint: "Call answer_gate to approve/reject, then wait_pipeline_result again.",
    });
  }
  return;
}
```

Also add `import type` for the IR stage types if not already imported.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter server vitest run src/kernel-next/mcp/pg-entry.test.ts -t "gate_pending"`
Expected: PASS — both gate_pending tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/mcp/pg-entry.ts apps/server/src/kernel-next/mcp/pg-entry.test.ts
git commit -m "feat(pg-entry): detect gate stage_executing as gate_pending"
```

---

## Task 9: `wait_pipeline_result` — running path with currentStage from SQLite

**Files:**
- Modify: `apps/server/src/kernel-next/mcp/pg-entry.ts`
- Modify: `apps/server/src/kernel-next/mcp/pg-entry.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `pg-entry.test.ts`:

```typescript
describe("handleWaitPipelineResult — running", () => {
  it("returns running with currentStage from stage_attempts on timeout", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const taskId = "task-run-1";
    db.exec(`
      INSERT INTO stage_attempts (task_id, stage_name, attempt_idx, version_hash, kind, attempt_at)
      VALUES ('task-run-1', 'analyzing', 0, 'vh', 'agent', 1000),
             ('task-run-1', 'analyzing', 1, 'vh', 'agent', 2000);
    `);
    const res = await handleWaitPipelineResult({ taskId, timeoutMs: 50 }, { db, broadcaster, ir: minimalIR() });
    expect(res.ok).toBe(true);
    if (!res.ok || res.status !== "running") throw new Error("expected running");
    expect(res.currentStage).toBe("analyzing");
    expect(res.elapsedMs).toBeGreaterThanOrEqual(50);
  });

  it("returns currentStage=null when no stage_attempts row exists", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const res = await handleWaitPipelineResult({ taskId: "task-empty-1", timeoutMs: 50 }, { db, broadcaster, ir: minimalIR() });
    if (!res.ok || res.status !== "running") throw new Error("expected running");
    expect(res.currentStage).toBeNull();
  });

  it("clamps timeoutMs below minimum to 1000", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const start = Date.now();
    const res = await handleWaitPipelineResult({ taskId: "t", timeoutMs: 10 }, { db, broadcaster, ir: minimalIR() });
    const dur = Date.now() - start;
    expect(res.ok && res.status).toBe("running");
    expect(dur).toBeGreaterThanOrEqual(1000);
  });
});
```

Check the exact column names in `stage_attempts`:

Run: `grep -A5 "CREATE TABLE.*stage_attempts" apps/server/src/kernel-next/ir/sql.ts`

Adjust the `INSERT` in the test to match (`attempt_at` may be `created_at` or similar).

- [ ] **Step 2: Run tests to verify they fail (or partially fail)**

Run: `pnpm --filter server vitest run src/kernel-next/mcp/pg-entry.test.ts -t "running"`
Expected: FAIL on currentStage test — current implementation returns `null`.

- [ ] **Step 3: Implement currentStage lookup**

Replace the timeout branch in `pg-entry.ts`:

```typescript
const timer = setTimeout(() => {
  let currentStage: string | null = null;
  try {
    const row = deps.db.prepare(
      "SELECT stage_name FROM stage_attempts WHERE task_id=? ORDER BY attempt_at DESC LIMIT 1",
    ).get(input.taskId) as { stage_name: string } | undefined;
    currentStage = row?.stage_name ?? null;
  } catch { /* table missing or other — keep null */ }
  settle({
    ok: true,
    status: "running",
    taskId: input.taskId,
    currentStage,
    elapsedMs: now() - startedAt,
    hint: "Pipeline still running. Call wait_pipeline_result again to continue waiting.",
  });
}, timeoutMs);
```

(Use the actual column name verified in Step 1's grep.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter server vitest run src/kernel-next/mcp/pg-entry.test.ts -t "running"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/mcp/pg-entry.ts apps/server/src/kernel-next/mcp/pg-entry.test.ts
git commit -m "feat(pg-entry): read currentStage from stage_attempts on timeout"
```

---

## Task 10: Wire new tools into `createKernelMcp` (external + combined surfaces)

**Files:**
- Modify: `apps/server/src/kernel-next/mcp/server.ts`
- Modify: `apps/server/src/kernel-next/mcp/server.test.ts`

- [ ] **Step 1: Write the failing surface tests**

Open `apps/server/src/kernel-next/mcp/server.test.ts` and find the existing block that asserts tool names per surface. Add:

```typescript
it("external surface includes start_pipeline_generator and wait_pipeline_result", () => {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  const mcp = createKernelMcp(db, { surface: "external" });
  const names = mcp.tools.map((t: any) => t.name);
  expect(names).toContain("start_pipeline_generator");
  expect(names).toContain("wait_pipeline_result");
});

it("internal surface does not include pg-entry tools", () => {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  const mcp = createKernelMcp(db, { surface: "internal" });
  const names = mcp.tools.map((t: any) => t.name);
  expect(names).not.toContain("start_pipeline_generator");
  expect(names).not.toContain("wait_pipeline_result");
});
```

(Adjust the `.tools` access path to whatever shape `createSdkMcpServer` returns — check an existing test in the same file for the accessor pattern. If tools aren't directly introspectable, test via the `EXTERNAL_TOOLS` set export instead.)

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter server vitest run src/kernel-next/mcp/server.test.ts -t "external surface"`
Expected: FAIL.

- [ ] **Step 3: Add the tool definitions in `server.ts`**

In `apps/server/src/kernel-next/mcp/server.ts`:

1. Extend `ToolName` union to include `"start_pipeline_generator" | "wait_pipeline_result"`.
2. Add both names to `EXTERNAL_TOOLS`.
3. Add two new tool registrations in the `tools: [...]` array, following the existing pattern (like `submit_pipeline`). For each: `zod` input schema, handler calls `handleStartPipelineGenerator` / `handleWaitPipelineResult` with dependency bag.

```typescript
import { handleStartPipelineGenerator, handleWaitPipelineResult } from "./pg-entry.js";
import { loadLegacyPipelineIR } from "../runtime/load-legacy-pipeline.js";
import { kernelNextBroadcaster } from "../sse/singleton.js";
import { runPipeline } from "../runtime/runner.js";
import { RealStageExecutor } from "../runtime/real-executor.js";
import { FsPromptResolver } from "../runtime/fs-prompt-resolver.js";

// Inside the tools: [...] array:
{
  name: "start_pipeline_generator",
  description: "Trigger the pipeline-generator builtin with a natural-language task description. Returns {taskId, versionHash} immediately; use wait_pipeline_result to retrieve the generated pipeline.",
  inputSchema: z.object({
    description: z.string().min(1).max(8000),
    taskId: z.string().min(1).optional(),
  }),
  handler: async (args: { description: string; taskId?: string }) => {
    const res = await handleStartPipelineGenerator(args, {
      db,
      broadcaster: kernelNextBroadcaster,
      loader: loadLegacyPipelineIR,
      runner: (a) => runPipeline({ ...a, handlers: {} }, undefined as any) as any,
      executorFactory: ({ promptRoot, model, maxTurns, maxBudgetUsd }) => new RealStageExecutor({
        mcpServerFactory: (_db, pr) => createKernelMcp(db, { surface: "in-pipeline", portRuntime: pr }),
        promptResolver: new FsPromptResolver({ rootDir: promptRoot }),
        model,
        maxTurns: maxTurns ?? 80,
        maxBudgetUsd: maxBudgetUsd ?? 8,
      }),
      model: options.pipelineGeneratorModel ?? "claude-sonnet-4-6",
      maxTurns: 80,
      maxBudgetUsd: 8,
    });
    return res.ok ? jsonResponse(res) : errorResponse(res.error, res);
  },
},
{
  name: "wait_pipeline_result",
  description: "Wait for a previously started pipeline-generator run to reach a terminal state (done/gate_pending/running/error). Safe to call repeatedly to continue waiting.",
  inputSchema: z.object({
    taskId: z.string().min(1),
    timeoutMs: z.number().int().optional(),
  }),
  handler: async (args: { taskId: string; timeoutMs?: number }) => {
    // Load pipeline-generator IR for gate detection (stage type lookup).
    let ir;
    try {
      ir = loadLegacyPipelineIR("pipeline-generator").ir;
    } catch (err) {
      return errorResponse("LOAD_IR_FAILED", { reason: (err as Error).message });
    }
    const res = await handleWaitPipelineResult(args, {
      db,
      broadcaster: kernelNextBroadcaster,
      ir,
    });
    return res.ok ? jsonResponse(res) : errorResponse(res.error, res);
  },
},
```

Also extend `KernelServiceOptions` (or the `createKernelMcp` options inline type) to add:

```typescript
pipelineGeneratorModel?: string;
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter server vitest run src/kernel-next/mcp/server.test.ts`
Expected: PASS — all surface tests green, no regression.

- [ ] **Step 5: Type-check and full suite**

Run: `pnpm --filter server tsc --noEmit`
Run: `pnpm --filter server vitest run`
Expected: clean + all tests passing.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/kernel-next/mcp/server.ts apps/server/src/kernel-next/mcp/server.test.ts
git commit -m "feat(kernel-next): register pg-entry tools on external surface"
```

---

## Task 11: Integration test — start + wait concurrent flow (mock executor)

**Files:**
- Create: `apps/server/src/kernel-next/mcp/pg-entry.integration.test.ts`

- [ ] **Step 1: Write the integration test**

Create `apps/server/src/kernel-next/mcp/pg-entry.integration.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelNextBroadcaster } from "../sse/broadcaster.js";
import { handleStartPipelineGenerator, handleWaitPipelineResult } from "./pg-entry.js";
import { loadLegacyPipelineIR } from "../runtime/load-legacy-pipeline.js";

describe("pg-entry integration — start + wait", () => {
  it("two concurrent starts produce independent taskIds and independent wait resolution", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const broadcaster = new KernelNextBroadcaster();

    // Mock runner that emits a succeeding run_final shortly after kickoff.
    const runner = async (args: any) => {
      setImmediate(() => {
        broadcaster.publish({ taskId: args.taskId, seq: 1, ts: Date.now(), type: "run_final", data: { status: "succeeded", stageErrors: [] } as any });
      });
    };
    const executorFactory = () => ({ executeStage: async () => ({ ok: true, portValues: {} }) }) as any;

    // Seed deterministic store for done-assembly BEFORE run_final so wait's handler finds the row.
    // Do this per-task below.
    const depsBase = { db, broadcaster, loader: loadLegacyPipelineIR, runner, executorFactory, model: "claude-haiku-4-5" } as const;

    const [r1, r2] = await Promise.all([
      handleStartPipelineGenerator({ description: "pipeline A" }, depsBase),
      handleStartPipelineGenerator({ description: "pipeline B" }, depsBase),
    ]);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.taskId).not.toBe(r2.taskId);

    // Seed minimal done-assembly rows for both.
    for (const taskId of [r1.taskId, r2.taskId]) {
      db.prepare(
        "INSERT INTO latest_port_values (task_id, stage_name, port_name, value_json) VALUES (?, 'persistResult', 'pipelineId', ?)",
      ).run(taskId, JSON.stringify(`pid-${taskId.slice(0, 6)}`));
      db.prepare(
        "INSERT INTO latest_port_values (task_id, stage_name, port_name, value_json) VALUES (?, 'pipelineDesign', 'pipelineName', ?)",
      ).run(taskId, JSON.stringify(`Name ${taskId.slice(0, 6)}`));
      db.prepare(
        "INSERT INTO latest_port_values (task_id, stage_name, port_name, value_json) VALUES (?, 'skeletonResult', 'yamlPath', ?)",
      ).run(taskId, JSON.stringify(`/tmp/${taskId}.yaml`));
      db.prepare(
        "INSERT INTO latest_port_values (task_id, stage_name, port_name, value_json) VALUES (?, 'pipelineDesign', 'description', ?)",
      ).run(taskId, JSON.stringify("descr"));
    }

    const ir = loadLegacyPipelineIR("pipeline-generator").ir;
    const [w1, w2] = await Promise.all([
      handleWaitPipelineResult({ taskId: r1.taskId, timeoutMs: 2000 }, { db, broadcaster, ir }),
      handleWaitPipelineResult({ taskId: r2.taskId, timeoutMs: 2000 }, { db, broadcaster, ir }),
    ]);
    expect(w1.ok && w1.status).toBe("done");
    expect(w2.ok && w2.status).toBe("done");
    if (!w1.ok || w1.status !== "done" || !w2.ok || w2.status !== "done") return;
    expect(w1.result.pipelineId).toMatch(/^pid-/);
    expect(w2.result.pipelineId).toMatch(/^pid-/);
    expect(w1.result.pipelineId).not.toBe(w2.result.pipelineId);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter server vitest run src/kernel-next/mcp/pg-entry.integration.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/kernel-next/mcp/pg-entry.integration.test.ts
git commit -m "test(pg-entry): concurrent start+wait integration"
```

---

## Task 12: Final sanity — full test suite + type-check

**Files:** none (verification only)

- [ ] **Step 1: Server type-check**

Run: `pnpm --filter server tsc --noEmit`
Expected: clean.

- [ ] **Step 2: Server full test suite**

Run: `pnpm --filter server vitest run`
Expected: PASS — no regressions.

- [ ] **Step 3: Web type-check (verify nothing leaked)**

Run: `pnpm --filter web tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Confirm git status is clean and review commit log**

Run:
```bash
git status
git log --oneline -10
```

Expected: working tree clean, all task commits present in order.

- [ ] **Step 5: Manual smoke test (optional, author-canary)**

Start the server locally, configure Claude Code to point at its MCP endpoint, call `start_pipeline_generator` with a real description, then `wait_pipeline_result`. Verify the generated pipeline appears on disk. This is optional — not a CI gate, just the "author is the canary" check from roadmap §10.

---

## Self-Review (spec `2026-04-24-pipeline-generator-mcp-entry-design.md`)

**Spec coverage:**
- §1 success criteria 1 (external start) — Task 4 + 5 + 10
- §1 success criteria 2 (four terminal shapes) — Tasks 6 (done), 7 (error), 8 (gate_pending), 9 (running)
- §1 success criteria 3 (gate transparent) — Task 8; no automatic answer_gate wiring (by design)
- §1 success criteria 4 (taskDescription seed) — Task 3 (YAML) + Task 5 (seedValues forwarding in runner call)
- §1 success criteria 5 (HTTP route regression-free) — Task 2 refactor + Task 12 full suite run
- §3 shared loader — Task 1 + Task 2
- §5 input validation — Tasks 4, 5, 9 (timeoutMs clamp)
- §6 loader — Task 1
- §7 YAML change — Task 3
- §8 MCP surface — Task 10
- §9 tests — Tasks 1, 4, 5, 6, 7, 8, 9, 11
- §10 boundaries — Task 10 (in-pipeline excluded)

**Placeholder scan:** Task 3 Step 4 is conditional on current prompt content; the condition is explicit ("if current text assumes implicit task description"). Task 10 Step 3 has one ambiguous accessor (`mcp.tools.map((t: any) => ...)`) with an explicit fallback instruction to use the `EXTERNAL_TOOLS` set export if tools aren't directly introspectable. Task 9 Step 1 has a grep-first-then-match instruction for the `stage_attempts` column name. No TBDs or vague "add appropriate error handling" phrasing.

**Type consistency:** `StartPipelineGeneratorResult` / `WaitPipelineResultResult` / `DoneResult` names are consistent across Tasks 4-9. `handleStartPipelineGenerator` / `handleWaitPipelineResult` names unchanged. `PgEntryDeps` / `WaitDeps` are distinct dep bags (fine — one handler needs runner, the other doesn't).

**Gaps fixed inline:** originally missed `timeoutMs` clamp test; added in Task 9.
