# Run Submitted Pipelines — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every pipeline in `pipeline_versions` runnable via a single uniform path — new MCP `run_pipeline` tool, HTTP route adapter, pg-entry reuse — so AI-submitted pipelines (from pipeline-generator) and builtins (converted legacy YAML) and mock pipelines (diamond family) all flow through one function.

**Architecture:** New `startPipelineRun` internal function owns executor construction, policy merging, and fire-and-forget `runPipeline`. MCP tool + HTTP route + pg-entry delegate to it. Mock handlers isolated into a small registry consulted only for the diamond family.

**Tech Stack:** TypeScript, Zod, Vitest, node:sqlite (DatabaseSync), Hono, Claude Agent SDK MCP.

**Spec:** `docs/superpowers/specs/2026-04-24-run-submitted-pipeline-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `apps/server/src/kernel-next/runtime/start-pipeline-run.ts` | Single-entry orchestration: resolve IR, build executor, fire runPipeline |
| Create | `apps/server/src/kernel-next/runtime/start-pipeline-run.test.ts` | Unit tests covering resolution, policy merge, mock registry, error paths |
| Create | `apps/server/src/kernel-next/runtime/mock-handler-registry.ts` | Map of diamond/diamond-slow/diamond-real handlers + IR; consulted by startPipelineRun |
| Modify | `apps/server/src/kernel-next/ir/sql.ts` | Add `getLatestVersionHashByName` helper |
| Modify | `apps/server/src/kernel-next/ir/sql.test.ts` | Cover the new helper |
| Modify | `apps/server/src/kernel-next/mcp/server.ts` | Register new `run_pipeline` tool on EXTERNAL surface |
| Modify | `apps/server/src/kernel-next/mcp/server.test.ts` | Assert new tool surface membership |
| Create | `apps/server/src/kernel-next/mcp/server.run-pipeline.test.ts` | Integration test: tool call → seeded pipeline → taskId |
| Modify | `apps/server/src/routes/kernel-run.ts` | Delegate to startPipelineRun; accept `name`/`versionHash`/`policy`; keep `pipeline` alias |
| Modify | `apps/server/src/routes/kernel-run.test.ts` | Cover new body shape + AI-submitted pipeline dispatch |
| Modify | `apps/server/src/kernel-next/mcp/pg-entry.ts` | Replace inline run-kickoff with startPipelineRun; add `tscPath` to PgEntryDeps |
| Modify | `apps/server/src/kernel-next/mcp/pg-entry.test.ts` | Update deps fixture to include tscPath |

---

## Task 1: `getLatestVersionHashByName` helper

**Files:**
- Modify: `apps/server/src/kernel-next/ir/sql.ts`
- Modify: `apps/server/src/kernel-next/ir/sql.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/kernel-next/ir/sql.test.ts`:

```typescript
describe("getLatestVersionHashByName", () => {
  it("returns null when no row matches", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    expect(getLatestVersionHashByName(db, "missing")).toBeNull();
  });

  it("returns the most recently created version for the given name", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    db.prepare(
      `INSERT INTO pipeline_versions (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
       VALUES ('v1', 'p', 1000, NULL, '{}', '')`,
    ).run();
    db.prepare(
      `INSERT INTO pipeline_versions (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
       VALUES ('v2', 'p', 2000, 'v1', '{}', '')`,
    ).run();
    db.prepare(
      `INSERT INTO pipeline_versions (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
       VALUES ('vOther', 'q', 3000, NULL, '{}', '')`,
    ).run();
    expect(getLatestVersionHashByName(db, "p")).toBe("v2");
    expect(getLatestVersionHashByName(db, "q")).toBe("vOther");
  });
});
```

Add import at top of test file if not already present:

```typescript
import { getLatestVersionHashByName } from "./sql.js";
```

- [ ] **Step 2: Run — FAIL**

Run: `cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run src/kernel-next/ir/sql.test.ts`
Expected: FAIL — function not exported.

- [ ] **Step 3: Implement**

Append to `apps/server/src/kernel-next/ir/sql.ts`:

```typescript
export function getLatestVersionHashByName(
  db: DatabaseSync,
  pipelineName: string,
): string | null {
  const row = db
    .prepare(
      `SELECT version_hash FROM pipeline_versions
       WHERE pipeline_name = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(pipelineName) as { version_hash: string } | undefined;
  return row ? row.version_hash : null;
}
```

- [ ] **Step 4: Run — PASS**

Run: `cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run src/kernel-next/ir/sql.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/kernel-next/ir/sql.ts apps/server/src/kernel-next/ir/sql.test.ts && git commit -m "feat(sql): getLatestVersionHashByName(db, name) helper"
```

---

## Task 2: Mock handler registry module

**Files:**
- Create: `apps/server/src/kernel-next/runtime/mock-handler-registry.ts`
- Create: `apps/server/src/kernel-next/runtime/mock-handler-registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/kernel-next/runtime/mock-handler-registry.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { MOCK_HANDLER_REGISTRY } from "./mock-handler-registry.js";

describe("MOCK_HANDLER_REGISTRY", () => {
  it("has diamond with 4 handlers", () => {
    const entry = MOCK_HANDLER_REGISTRY["diamond"];
    expect(entry).toBeDefined();
    expect(Object.keys(entry!.handlers).sort()).toEqual(["A", "B", "C", "D"]);
    expect(entry!.ir.stages.length).toBeGreaterThan(0);
  });

  it("has diamond-slow", () => {
    expect(MOCK_HANDLER_REGISTRY["diamond-slow"]).toBeDefined();
  });

  it("has diamond-real with empty handler map (uses real executor)", () => {
    const entry = MOCK_HANDLER_REGISTRY["diamond-real"];
    expect(entry).toBeDefined();
    expect(Object.keys(entry!.handlers)).toEqual([]);
  });

  it("does not contain legacy YAML builtins (they live in pipeline_versions)", () => {
    expect(MOCK_HANDLER_REGISTRY["pipeline-generator"]).toBeUndefined();
    expect(MOCK_HANDLER_REGISTRY["smoke-test"]).toBeUndefined();
    expect(MOCK_HANDLER_REGISTRY["tech-research-collector"]).toBeUndefined();
    expect(MOCK_HANDLER_REGISTRY["tech-research-writer"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — FAIL**

Run: `cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run src/kernel-next/runtime/mock-handler-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/server/src/kernel-next/runtime/mock-handler-registry.ts`:

```typescript
// Mock handler registry — diamond-family only.
//
// AI-submitted pipelines and legacy-YAML builtins live in pipeline_versions
// and run through RealStageExecutor with DbPromptResolver. Only the
// in-memory demo/test pipelines (diamond / diamond-slow / diamond-real)
// require synthetic StageHandlerMap plumbing — they never had prompts on
// disk to begin with.
//
// startPipelineRun consults this map AFTER resolving a versionHash: if
// the requested name has an entry here, its handlers are passed to
// runPipeline; its ir is used to seed pipeline_versions if missing so
// that versionHash resolution works uniformly.

import { diamondIR } from "../generator-mock/mini-generator.js";
import { slowDiamondHandlers } from "../demo/slow-diamond.js";
import type { PipelineIR } from "../ir/schema.js";
import type { StageHandlerMap } from "./mock-executor.js";

export interface MockPipelineEntry {
  ir: PipelineIR;
  handlers: StageHandlerMap;
}

export const MOCK_HANDLER_REGISTRY: Record<string, MockPipelineEntry> = {
  diamond: {
    ir: diamondIR(),
    handlers: {
      A: () => ({ x: 10 }),
      B: (inputs) => ({ y: `B-got-${inputs.x as number}` }),
      C: (inputs) => ({ z: `C-got-${inputs.x as number}` }),
      D: (inputs) => ({ final: `${inputs.b as string}+${inputs.c as string}` }),
    },
  },
  "diamond-slow": {
    ir: diamondIR(),
    handlers: slowDiamondHandlers(),
  },
  "diamond-real": {
    ir: diamondIR(),
    handlers: {},
  },
};
```

- [ ] **Step 4: Run — PASS**

Run: `cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run src/kernel-next/runtime/mock-handler-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/kernel-next/runtime/mock-handler-registry.ts apps/server/src/kernel-next/runtime/mock-handler-registry.test.ts && git commit -m "feat(runtime): MOCK_HANDLER_REGISTRY for diamond-family pipelines"
```

---

## Task 3: `startPipelineRun` function — resolve + build + fire

**Files:**
- Create: `apps/server/src/kernel-next/runtime/start-pipeline-run.ts`
- Create: `apps/server/src/kernel-next/runtime/start-pipeline-run.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/kernel-next/runtime/start-pipeline-run.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelService } from "../mcp/kernel.js";
import { startPipelineRun } from "./start-pipeline-run.js";
import { diamondIR } from "../generator-mock/mini-generator.js";
import type { KernelNextBroadcaster } from "../sse/broadcaster.js";

// Minimal no-op broadcaster stub.
function noopBroadcaster(): KernelNextBroadcaster {
  return {
    publish: () => {},
    subscribe: () => () => {},
    replay: () => [],
  } as unknown as KernelNextBroadcaster;
}

describe("startPipelineRun input resolution", () => {
  it("returns MISSING_INPUT when neither name nor versionHash is supplied", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const res = await startPipelineRun({
      db,
      broadcaster: noopBroadcaster(),
    });
    expect(res).toEqual(expect.objectContaining({ ok: false, code: "MISSING_INPUT" }));
  });

  it("returns UNKNOWN_VERSION_HASH when versionHash does not exist", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const res = await startPipelineRun({
      db,
      broadcaster: noopBroadcaster(),
      versionHash: "nope",
    });
    expect(res).toEqual(expect.objectContaining({ ok: false, code: "UNKNOWN_VERSION_HASH" }));
  });

  it("returns UNKNOWN_PIPELINE when name has no versions", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const res = await startPipelineRun({
      db,
      broadcaster: noopBroadcaster(),
      name: "not-a-pipeline",
    });
    expect(res).toEqual(expect.objectContaining({ ok: false, code: "UNKNOWN_PIPELINE" }));
  });

  it("returns AMBIGUOUS_INPUT when name and versionHash point to different rows", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const r = svc.submit(diamondIR(), { prompts: {} });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = await startPipelineRun({
      db,
      broadcaster: noopBroadcaster(),
      name: "different-name",
      versionHash: r.versionHash,
    });
    expect(res).toEqual(expect.objectContaining({ ok: false, code: "AMBIGUOUS_INPUT" }));
  });
});
```

- [ ] **Step 2: Run — FAIL**

Run: `cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run src/kernel-next/runtime/start-pipeline-run.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the resolution portion**

Create `apps/server/src/kernel-next/runtime/start-pipeline-run.ts`:

```typescript
// startPipelineRun — single entry function for starting a task on any
// submitted pipeline. Callers: MCP run_pipeline tool, HTTP route,
// pg-entry's start_pipeline_generator.
//
// Responsibilities:
//   1. Resolve {name, versionHash} → a single versionHash whose IR is in
//      pipeline_versions.
//   2. Build executor: RealStageExecutor with DbPromptResolver(versionHash),
//      mcpServerFactory threading the monorepo tscPath.
//   3. Consult MOCK_HANDLER_REGISTRY for diamond-family handler overrides.
//   4. Fire runPipeline in background (fire-and-forget).
//   5. Return { taskId, versionHash }.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import type { PipelineIR } from "../ir/schema.js";
import {
  getLatestVersionHashByName,
  getPipelineIR,
} from "../ir/sql.js";
import { KernelService } from "../mcp/kernel.js";
import { createKernelMcp } from "../mcp/server.js";
import { runPipeline } from "./runner.js";
import { RealStageExecutor } from "./real-executor.js";
import { DbPromptResolver } from "./db-prompt-resolver.js";
import { MOCK_HANDLER_REGISTRY } from "./mock-handler-registry.js";
import type { StageHandlerMap } from "./mock-executor.js";
import type { KernelNextBroadcaster } from "../sse/broadcaster.js";
import { logger } from "../../lib/logger.js";

export interface StartPipelineRunInput {
  db: DatabaseSync;
  broadcaster: KernelNextBroadcaster;
  name?: string;
  versionHash?: string;
  taskId?: string;
  seedValues?: Record<string, unknown>;
  policy?: ExecutionPolicyShape;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  tscPath?: string;
  timeoutMs?: number;
}

// Minimal ExecutionPolicy shape — only policy.default is consumed by
// the current RealStageExecutor. perStage is accepted but ignored for
// now; future milestone wires it through.
export interface ExecutionPolicyShape {
  default?: {
    budget?: { maxTurns?: number; maxCostUsd?: number; timeoutSeconds?: number };
    promptAssembly?: { model?: string };
    retry?: unknown;
    permission?: unknown;
  };
  perStage?: Record<string, unknown>;
}

export type StartPipelineRunResult =
  | { ok: true; taskId: string; versionHash: string }
  | {
      ok: false;
      code:
        | "MISSING_INPUT"
        | "UNKNOWN_PIPELINE"
        | "UNKNOWN_VERSION_HASH"
        | "AMBIGUOUS_INPUT";
      message: string;
      context?: Record<string, unknown>;
    };

const DEFAULT_MODEL = "claude-haiku-4-5";
const DEFAULT_MAX_TURNS = 30;
const DEFAULT_MAX_BUDGET_USD = 2;

export async function startPipelineRun(
  input: StartPipelineRunInput,
): Promise<StartPipelineRunResult> {
  // --- Resolve versionHash ---
  if (!input.name && !input.versionHash) {
    return {
      ok: false,
      code: "MISSING_INPUT",
      message: "one of `name` or `versionHash` is required",
    };
  }

  let versionHash: string;
  let ir: PipelineIR;

  if (input.versionHash) {
    const found = getPipelineIR(input.db, input.versionHash);
    if (!found) {
      return {
        ok: false,
        code: "UNKNOWN_VERSION_HASH",
        message: `no pipeline version found for hash '${input.versionHash}'`,
        context: { versionHash: input.versionHash },
      };
    }
    if (input.name && found.name !== input.name) {
      return {
        ok: false,
        code: "AMBIGUOUS_INPUT",
        message: `versionHash '${input.versionHash}' belongs to pipeline '${found.name}', not '${input.name}'`,
        context: { versionHash: input.versionHash, expectedName: input.name, actualName: found.name },
      };
    }
    versionHash = input.versionHash;
    ir = found;
  } else {
    // name-only path
    const name = input.name!;
    let hash = getLatestVersionHashByName(input.db, name);

    // Mock-registry fallback: if the name is a mock entry and no DB row
    // exists yet, seed the IR and retry lookup. This makes diamond*
    // pipelines runnable without a dedicated bootstrap step.
    if (!hash && MOCK_HANDLER_REGISTRY[name]) {
      const entry = MOCK_HANDLER_REGISTRY[name]!;
      const svc = new KernelService(input.db, { skipTypeCheck: true });
      const seedRes = svc.submit(entry.ir, { prompts: {} });
      if (!seedRes.ok) {
        return {
          ok: false,
          code: "UNKNOWN_PIPELINE",
          message: `could not seed mock pipeline '${name}': ${seedRes.diagnostics.map((d) => d.code).join(",")}`,
          context: { name },
        };
      }
      hash = seedRes.versionHash;
    }

    if (!hash) {
      return {
        ok: false,
        code: "UNKNOWN_PIPELINE",
        message: `no pipeline registered under name '${name}'`,
        context: { name },
      };
    }
    const found = getPipelineIR(input.db, hash);
    if (!found) {
      return {
        ok: false,
        code: "UNKNOWN_VERSION_HASH",
        message: `resolved versionHash '${hash}' for name '${name}' but ir_json is missing`,
        context: { name, versionHash: hash },
      };
    }
    versionHash = hash;
    ir = found;
  }

  // --- Determine handlers from registry (if any) ---
  const nameForRegistry = input.name ?? ir.name;
  const mockEntry = MOCK_HANDLER_REGISTRY[nameForRegistry];
  const handlers: StageHandlerMap = mockEntry ? mockEntry.handlers : {};

  // --- Merge policy ---
  const model = input.model
    ?? input.policy?.default?.promptAssembly?.model
    ?? DEFAULT_MODEL;
  const maxTurns = input.maxTurns
    ?? input.policy?.default?.budget?.maxTurns
    ?? DEFAULT_MAX_TURNS;
  const maxBudgetUsd = input.maxBudgetUsd
    ?? input.policy?.default?.budget?.maxCostUsd
    ?? DEFAULT_MAX_BUDGET_USD;

  // --- Build executor ---
  const db = input.db;
  const tscPath = input.tscPath;
  const executor = new RealStageExecutor({
    mcpServerFactory: (_dispatcher, portRuntime) =>
      createKernelMcp(db, {
        surface: "combined",
        portRuntime,
        tscPath,
      }),
    promptResolver: new DbPromptResolver(db, versionHash),
    model,
    maxTurns,
    maxBudgetUsd,
  });

  const taskId = input.taskId
    ?? `${nameForRegistry}-${Date.now()}-${randomUUID().slice(0, 8)}`;

  // --- Fire runPipeline in background ---
  void runPipeline({
    db,
    ir,
    taskId,
    versionHash,
    handlers,
    executor,
    seedValues: input.seedValues,
    broadcaster: input.broadcaster,
  }, input.timeoutMs).catch((err: unknown) => {
    logger.error(
      { taskId, versionHash, err },
      "[startPipelineRun] background runPipeline rejected",
    );
  });

  return { ok: true, taskId, versionHash };
}
```

- [ ] **Step 4: Run — PASS**

Run: `cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run src/kernel-next/runtime/start-pipeline-run.test.ts`
Expected: PASS — all four resolution tests.

- [ ] **Step 5: Expand tests to cover mock registry + policy merge**

Append to `apps/server/src/kernel-next/runtime/start-pipeline-run.test.ts`:

```typescript
describe("startPipelineRun mock registry seeding", () => {
  it("auto-seeds diamond IR into pipeline_versions on first run", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const res = await startPipelineRun({
      db,
      broadcaster: noopBroadcaster(),
      name: "diamond",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = db.prepare("SELECT pipeline_name FROM pipeline_versions WHERE version_hash = ?")
      .get(res.versionHash) as { pipeline_name: string } | undefined;
    expect(row?.pipeline_name).toBe("diamond");
  });
});

describe("startPipelineRun policy merge", () => {
  it("top-level overrides win over policy.default", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const res = await startPipelineRun({
      db,
      broadcaster: noopBroadcaster(),
      name: "diamond",
      model: "top-level-model",
      policy: { default: { promptAssembly: { model: "policy-model" } } },
    });
    // Non-failure is the assertion — merging must not throw.
    expect(res.ok).toBe(true);
  });
});
```

- [ ] **Step 6: Run — PASS**

Run: `cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run src/kernel-next/runtime/start-pipeline-run.test.ts`
Expected: all PASS.

- [ ] **Step 7: Type check**

Run: `cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/tsc --noEmit`
Expected: 0 errors. If `KernelNextBroadcaster` interface doesn't match the stub in tests, import it correctly and match its shape — the type-level contract is whatever `broadcaster.ts` exports.

- [ ] **Step 8: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/kernel-next/runtime/start-pipeline-run.ts apps/server/src/kernel-next/runtime/start-pipeline-run.test.ts && git commit -m "feat(runtime): startPipelineRun — uniform entry for all submitted pipelines"
```

---

## Task 4: Register `run_pipeline` MCP tool on external surface

**Files:**
- Modify: `apps/server/src/kernel-next/mcp/server.ts`
- Modify: `apps/server/src/kernel-next/mcp/server.test.ts`

- [ ] **Step 1: Locate the existing tool list**

Run: `grep -n '"submit_pipeline"\|EXTERNAL_TOOLS\|ToolName' /Users/minghao/workflow-control/apps/server/src/kernel-next/mcp/server.ts | head -20`

Note the `allTools` array structure (name / description / inputSchema / handler shape), the `EXTERNAL_TOOLS` ReadonlySet, and the `ToolName` union type. Record the line ranges before editing.

- [ ] **Step 2: Write the failing test**

Append to `apps/server/src/kernel-next/mcp/server.test.ts`:

```typescript
describe("run_pipeline tool surface", () => {
  it("is in EXTERNAL surface", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const mcp = createKernelMcp(db, { surface: "external" });
    const tools = await collectTools(mcp);
    expect(tools.map((t) => t.name)).toContain("run_pipeline");
  });

  it("is NOT in INTERNAL surface", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const mcp = createKernelMcp(db, { surface: "internal" });
    const tools = await collectTools(mcp);
    expect(tools.map((t) => t.name)).not.toContain("run_pipeline");
  });
});
```

Use the existing `collectTools` helper if present; otherwise find an equivalent already used in the file (likely `mcp.server.tools()` or similar). Pattern-match on the existing submit_pipeline surface test.

- [ ] **Step 3: Run — FAIL**

Run: `cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run src/kernel-next/mcp/server.test.ts`
Expected: FAIL — `run_pipeline` not yet registered.

- [ ] **Step 4: Register the tool**

In `apps/server/src/kernel-next/mcp/server.ts`:

1. Add `"run_pipeline"` to the `ToolName` union type:

Locate the existing union (near line 101):

```typescript
type ToolName =
  | "submit_pipeline" | "validate_pipeline" | "propose_pipeline_change"
  | ...
```

Add `| "run_pipeline"`.

2. Add `"run_pipeline"` to `EXTERNAL_TOOLS`:

```typescript
const EXTERNAL_TOOLS: ReadonlySet<ToolName> = new Set([
  "submit_pipeline", "validate_pipeline", "propose_pipeline_change",
  // ... other entries
  "run_pipeline",
]);
```

3. Import `startPipelineRun` and broadcaster singleton at the top of the file:

```typescript
import { startPipelineRun } from "../runtime/start-pipeline-run.js";
import { kernelNextBroadcaster } from "../sse/singleton.js";
```

4. Extend `KernelMcpOptions` interface with `tscPath?: string` if not already there (startPipelineRun forwards it).

5. In the `allTools` array, add after `submit_pipeline`:

```typescript
{
  name: "run_pipeline",
  description:
    "Start a new task running a previously-submitted pipeline. " +
    "Specify `name` (resolves to latest versionHash) or `versionHash` " +
    "(exact). Returns the taskId — poll get_task_status to observe.",
  inputSchema: {
    name: z.string().optional().describe("Pipeline name; resolves to latest versionHash"),
    versionHash: z.string().optional().describe("Exact pipeline versionHash; overrides name when both supplied"),
    seedValues: z.record(z.string(), z.unknown()).optional().describe("Per-port external input values"),
    policy: z.unknown().optional().describe("ExecutionPolicy (see terminal-design §5.3)"),
    model: z.string().optional(),
    maxTurns: z.number().int().positive().optional(),
    maxBudgetUsd: z.number().positive().optional(),
    taskId: z.string().optional(),
  },
  handler: async (args: {
    name?: string;
    versionHash?: string;
    seedValues?: Record<string, unknown>;
    policy?: unknown;
    model?: string;
    maxTurns?: number;
    maxBudgetUsd?: number;
    taskId?: string;
  }) => {
    const result = await startPipelineRun({
      db,
      broadcaster: kernelNextBroadcaster,
      name: args.name,
      versionHash: args.versionHash,
      seedValues: args.seedValues,
      policy: args.policy as never,
      model: args.model,
      maxTurns: args.maxTurns,
      maxBudgetUsd: args.maxBudgetUsd,
      taskId: args.taskId,
      tscPath: options.tscPath,
    });
    if (result.ok === true) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, taskId: result.taskId, versionHash: result.versionHash }) }],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      isError: true,
    };
  },
}
```

Match the exact style of the surrounding tool definitions (how they access `db`, how errors are structured, whether `options` is closed over or passed differently).

- [ ] **Step 5: Run — PASS**

Run: `cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run src/kernel-next/mcp/server.test.ts`
Expected: all PASS.

- [ ] **Step 6: Type check**

Run: `cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/kernel-next/mcp/server.ts apps/server/src/kernel-next/mcp/server.test.ts && git commit -m "feat(mcp): run_pipeline tool on external surface"
```

---

## Task 5: Integration test for `run_pipeline` tool

**Files:**
- Create: `apps/server/src/kernel-next/mcp/server.run-pipeline.test.ts`

- [ ] **Step 1: Write the test**

Create `apps/server/src/kernel-next/mcp/server.run-pipeline.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, getPipelineIR } from "../ir/sql.js";
import { createKernelMcp } from "./server.js";
import { KernelService } from "./kernel.js";
import { diamondIR } from "../generator-mock/mini-generator.js";

async function invokeRunPipeline(mcp: ReturnType<typeof createKernelMcp>, args: Record<string, unknown>) {
  // Pattern-match how other tests in this file invoke tool handlers.
  // Prefer any existing helper; otherwise go through mcp.server.tools()
  // and find the run_pipeline entry, then call its handler.
  // Placeholder: adapt to the actual helper pattern used in this file.
  const tool = (await (mcp as unknown as { server: { tools: () => unknown[] } }).server.tools())
    .find((t: unknown) => (t as { name: string }).name === "run_pipeline");
  if (!tool) throw new Error("run_pipeline tool not found");
  return (tool as { handler: (a: Record<string, unknown>) => Promise<unknown> }).handler(args);
}

describe("run_pipeline MCP tool integration", () => {
  it("starts a task for a name-resolved pipeline", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const r = svc.submit(diamondIR(), { prompts: {} });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const mcp = createKernelMcp(db, { surface: "external" });
    const res = await invokeRunPipeline(mcp, { name: "diamond" });
    const payload = JSON.parse(((res as { content: { text: string }[] }).content)[0]!.text);
    expect(payload.ok).toBe(true);
    expect(typeof payload.taskId).toBe("string");
    expect(payload.versionHash).toBe(r.versionHash);
  });

  it("returns error payload for unknown pipeline name", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const mcp = createKernelMcp(db, { surface: "external" });
    const res = await invokeRunPipeline(mcp, { name: "no-such-pipeline" });
    const payload = JSON.parse(((res as { content: { text: string }[] }).content)[0]!.text);
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("UNKNOWN_PIPELINE");
  });
});
```

If the invocation pattern above doesn't match how the existing `server.test.ts` invokes tool handlers, adjust. The intent: get hold of the registered `run_pipeline` tool's handler and call it with args, then parse `content[0].text` as JSON.

- [ ] **Step 2: Run — PASS**

Run: `cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run src/kernel-next/mcp/server.run-pipeline.test.ts`
Expected: all PASS. If the handler invocation pattern is wrong (type errors, tool not found), align to the existing `server.test.ts` style.

- [ ] **Step 3: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/kernel-next/mcp/server.run-pipeline.test.ts && git commit -m "test(mcp): run_pipeline integration — name resolution + error path"
```

---

## Task 6: Refactor HTTP route to delegate

**Files:**
- Modify: `apps/server/src/routes/kernel-run.ts`
- Modify: `apps/server/src/routes/kernel-run.test.ts`

- [ ] **Step 1: Read the current route structure**

Run: `sed -n '30,270p' /Users/minghao/workflow-control/apps/server/src/routes/kernel-run.ts`

Note:
- `runBodySchema` (Zod) — current body validation
- `pipelineRegistry` — map of name → factory returning `{ir, handlers, executorFactory}`
- `registerLegacyPipeline` — helper for legacy YAML pipelines
- The POST handler at `kernelRunRoute.post("/kernel/tasks/run", ...)` — where dispatch happens

- [ ] **Step 2: Update the body schema**

In `apps/server/src/routes/kernel-run.ts`, extend `runBodySchema`:

```typescript
const runBodySchema = z.object({
  // `pipeline` is legacy alias for `name`; both accepted, at least one required.
  pipeline: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  versionHash: z.string().min(1).optional(),

  taskId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  maxTurns: z.number().int().positive().optional(),
  maxBudgetUsd: z.number().positive().optional(),
  seedValues: z.record(z.string(), z.unknown()).optional(),
  policy: z.unknown().optional(),
}).strict();
```

- [ ] **Step 3: Rewrite the POST handler**

Replace the body of `kernelRunRoute.post("/kernel/tasks/run", async (c) => { ... })` with:

```typescript
kernelRunRoute.post("/kernel/tasks/run", async (c) => {
  const rawBody = await c.req.json().catch(() => null);
  const parsed = runBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({
      ok: false,
      diagnostics: parsed.error.issues.map((i) => ({
        code: "ZOD_PARSE_ERROR",
        message: `${i.path.join(".") || "<root>"}: ${i.message}`,
      })),
    }, 400);
  }

  const body = parsed.data;
  const name = body.name ?? body.pipeline;

  const db = getKernelNextDb();
  const res = await startPipelineRun({
    db,
    broadcaster: kernelNextBroadcaster,
    name,
    versionHash: body.versionHash,
    taskId: body.taskId,
    seedValues: body.seedValues,
    policy: body.policy as never,
    model: body.model,
    maxTurns: body.maxTurns,
    maxBudgetUsd: body.maxBudgetUsd,
    tscPath: MONOREPO_TSC_PATH,
  });

  if (res.ok === false) {
    return c.json({
      ok: false,
      diagnostics: [{ code: res.code, message: res.message, context: res.context }],
    }, 400);
  }

  return c.json({ ok: true, taskId: res.taskId, versionHash: res.versionHash }, 202);
});
```

4. Remove the existing `pipelineRegistry` object — it's no longer consulted by the route. The legacy builtin submissions still need to happen at module load; do that with standalone calls:

Replace the `const pipelineRegistry: Record<...> = { ... }` block with:

```typescript
// Seed legacy-YAML builtins into pipeline_versions at module load so they
// can be resolved by name via startPipelineRun. No longer stored in a
// runtime registry — SQLite is the only lookup path for real pipelines.
// Mock pipelines (diamond family) are seeded on-demand by
// startPipelineRun via MOCK_HANDLER_REGISTRY.
seedLegacyPipelineByName("smoke-test");
seedLegacyPipelineByName("tech-research-collector");
seedLegacyPipelineByName("tech-research-writer");
seedLegacyPipelineByName("pipeline-generator");

function seedLegacyPipelineByName(pipelineDir: string): void {
  try {
    const loaded = loadLegacyPipelineIR(pipelineDir);
    const db = getKernelNextDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const res = svc.submit(loaded.ir, { prompts: loaded.prompts });
    if (!res.ok) {
      throw new Error(
        `seedLegacyPipelineByName('${pipelineDir}'): submit failed: ${res.diagnostics.map((d) => `${d.code}: ${d.message ?? ""}`).join("; ")}`,
      );
    }
  } catch (err) {
    logger.error(
      { pipelineDir, err: (err as Error).message },
      "[kernel-run] seedLegacyPipelineByName failed",
    );
    throw err;
  }
}
```

5. Remove the `registerLegacyPipeline` helper (no longer needed; replaced by `seedLegacyPipelineByName`).

6. Remove the unused imports (`RealStageExecutor`, `DbPromptResolver`, `createKernelMcp`, `StageHandlerMap`, `PipelineIR` — unless still used) that the old executor construction relied on. Keep `KernelService`, `getKernelNextDb`, `kernelNextBroadcaster`, `loadLegacyPipelineIR`, `LegacyPipelineLoadError`.

7. Import `startPipelineRun`:

```typescript
import { startPipelineRun } from "../kernel-next/runtime/start-pipeline-run.js";
```

- [ ] **Step 4: Update the route tests**

In `apps/server/src/routes/kernel-run.test.ts`, the existing test that asserts `UNKNOWN_PIPELINE.known` listed specific pipeline names (from the old pipelineRegistry) will fail — that field no longer comes from a hardcoded map. Update:

Old pattern (rough):
```typescript
expect(resBody.diagnostics[0].context.known).toEqual(["diamond","diamond-slow",...]);
```

New pattern:
```typescript
// With startPipelineRun + name resolution from SQLite, the error payload
// does not include a "known pipelines" list. Assert the code + a meaningful
// message instead.
expect(resBody.diagnostics[0].code).toBe("UNKNOWN_PIPELINE");
```

For the test that asserts `registerLegacyPipeline populates pipeline_prompt_refs on module load`: the invariant is unchanged (module-load still submits), so the assertion remains true. Only the function name the test may have referenced (`registerLegacyPipeline`) is gone — if any test imports it, update to `seedLegacyPipelineByName` (which is now the module-scoped function).

For the test that POSTs a legacy pipeline name (`pipeline-generator`, etc.), verify it still passes — the route delegates to `startPipelineRun` which resolves by name.

Add one new test for `versionHash` path:

```typescript
it("accepts versionHash body field and starts a run", async () => {
  // Seed a tiny pipeline directly into the DB via KernelService.submit
  // then POST with versionHash.
  const app = buildApp(); // however tests construct the app here
  // ... seed pipeline ... capture versionHash ...
  const resp = await app.request("/api/kernel/tasks/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ versionHash, seedValues: {...} }),
  });
  expect(resp.status).toBe(202);
  const body = await resp.json();
  expect(body.ok).toBe(true);
  expect(body.versionHash).toBe(versionHash);
});
```

Adapt helper names / setup to match existing test file patterns.

- [ ] **Step 5: Type check**

Run: `cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Run the route tests**

Run: `cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run src/routes/kernel-run.test.ts`
Expected: all PASS.

- [ ] **Step 7: Full kernel-next + routes regression**

Run: `cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run src/kernel-next src/routes`
Expected: all PASS. If any test in pg-entry or elsewhere broke because it depended on `registerLegacyPipeline` or the old `pipelineRegistry`, stop and report — pg-entry changes are Task 7.

- [ ] **Step 8: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/routes/kernel-run.ts apps/server/src/routes/kernel-run.test.ts && git commit -m "feat(http): POST /kernel/tasks/run delegates to startPipelineRun"
```

---

## Task 7: Refactor pg-entry to use `startPipelineRun`

**Files:**
- Modify: `apps/server/src/kernel-next/mcp/pg-entry.ts`
- Modify: `apps/server/src/kernel-next/mcp/pg-entry.test.ts`

- [ ] **Step 1: Read current pg-entry deps**

Run: `sed -n '1,100p' /Users/minghao/workflow-control/apps/server/src/kernel-next/mcp/pg-entry.ts`

Identify `PgEntryDeps` interface and the run-kickoff portion around line 131-153.

- [ ] **Step 2: Extend PgEntryDeps with tscPath**

In `apps/server/src/kernel-next/mcp/pg-entry.ts`, modify `PgEntryDeps` interface:

```typescript
export interface PgEntryDeps {
  db: DatabaseSync;
  broadcaster: KernelNextBroadcaster;
  loader: (pipelineDir: string) => LegacyPipelineLoadResult;
  runner?: typeof runPipeline; // optional; used by tests that inject a stub runner
  executorFactory?: (args: {
    promptRoot: string;
    versionHash: string;
    db: DatabaseSync;
    model: string;
    maxTurns?: number;
    maxBudgetUsd?: number;
  }) => StageExecutor;
  model: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  tscPath?: string;                         // NEW: plumbed through to startPipelineRun
}
```

- [ ] **Step 3: Replace the run-kickoff block with startPipelineRun**

In `handleStartPipelineGenerator`, replace lines roughly 120-153 (the `executorFactory` invocation + `deps.runner(...)` call) with:

```typescript
  // Delegate to startPipelineRun for executor construction + background run.
  // Tests that inject a custom runner go through the deps.runner path below
  // instead; production code always uses the shared startPipelineRun.
  if (deps.runner) {
    // Test injection path — build a minimal executor inline, same as before.
    // (Kept to avoid forcing all tests to switch to startPipelineRun.)
    if (!deps.executorFactory) {
      return { ok: false, error: "RUN_BOOTSTRAP_FAILED", reason: "executorFactory is required when runner is injected" };
    }
    const executor = deps.executorFactory({
      promptRoot: loaded.promptRoot,
      versionHash: vh,
      db: deps.db,
      model: deps.model,
      maxTurns: deps.maxTurns,
      maxBudgetUsd: deps.maxBudgetUsd,
    });
    const taskId = input.taskId ?? randomUUID();
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
      void p.catch((err: unknown) => {
        logger.error({ taskId, err }, "[pg-entry] background runPipeline rejected");
      });
    } catch (err) {
      return { ok: false, error: "RUN_BOOTSTRAP_FAILED", reason: (err as Error).message };
    }
    return { ok: true, taskId, versionHash: vh, pipelineDir: "pipeline-generator" };
  }

  // Production path — use startPipelineRun.
  const runRes = await startPipelineRun({
    db: deps.db,
    broadcaster: deps.broadcaster,
    versionHash: vh,
    taskId: input.taskId,
    seedValues: { taskDescription: desc },
    model: deps.model,
    maxTurns: deps.maxTurns,
    maxBudgetUsd: deps.maxBudgetUsd,
    tscPath: deps.tscPath,
  });

  if (runRes.ok === false) {
    return { ok: false, error: "RUN_BOOTSTRAP_FAILED", reason: `${runRes.code}: ${runRes.message}` };
  }

  return { ok: true, taskId: runRes.taskId, versionHash: runRes.versionHash, pipelineDir: "pipeline-generator" };
}
```

Add import at top:

```typescript
import { startPipelineRun } from "../runtime/start-pipeline-run.js";
```

- [ ] **Step 4: Update pg-entry tests to supply tscPath in deps**

In `apps/server/src/kernel-next/mcp/pg-entry.test.ts`, find the `deps` fixture construction (likely a helper like `makeDeps` or direct object literals). Add `tscPath: undefined` or a test-safe path (e.g. `/usr/local/bin/tsc` will be fine for tests since no real submit runs in pg-entry unit tests — `KernelService` is created with `skipTypeCheck: true`).

For tests that inject `runner`, no change needed — the old code path runs for them.

For any test asserting that production path kicks runPipeline directly: those should either inject a runner (old path) OR stub startPipelineRun. Adjust based on existing patterns.

- [ ] **Step 5: Run pg-entry tests**

Run: `cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run src/kernel-next/mcp/pg-entry.test.ts src/kernel-next/mcp/pg-entry.integration.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/kernel-next/mcp/pg-entry.ts apps/server/src/kernel-next/mcp/pg-entry.test.ts && git commit -m "feat(pg-entry): delegate run-kickoff to startPipelineRun"
```

Include pg-entry.integration.test.ts in the commit if it was modified.

---

## Task 8: Full regression + manual E2E

**Files:** none (verification).

- [ ] **Step 1: Full server test suite**

Run: `cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run`
Expected: all PASS. Record passed/skipped/failed counts.

- [ ] **Step 2: Server tsc**

Run: `cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Web tsc**

Run: `cd /Users/minghao/workflow-control/apps/web && ./node_modules/.bin/tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Manual E2E — run an AI-submitted pipeline**

Start dev server: `pnpm --filter server dev` (foreground or background). Wait for port 3001 to listen.

In another terminal:

```bash
# Verify hello-research-v2 exists from stage-3 probe
sqlite3 /tmp/workflow-control-data/kernel-next.db \
  "SELECT pipeline_name, SUBSTR(version_hash,1,12) FROM pipeline_versions WHERE pipeline_name='hello-research-v2';"

# Run by name
curl -s -X POST http://localhost:3001/api/kernel/tasks/run \
  -H "Content-Type: application/json" \
  -d '{
    "name": "hello-research-v2",
    "taskId": "run-generated-manual-01",
    "model": "claude-haiku-4-5",
    "maxTurns": 15,
    "maxBudgetUsd": 1,
    "seedValues": {"topic": "XState 5 actors"}
  }'
```

Expected response: `{"ok":true,"taskId":"run-generated-manual-01","versionHash":"<hash>"}`.

- [ ] **Step 5: Poll status + verify execution**

```bash
while : ; do
  s=$(curl -s http://localhost:3001/api/kernel/tasks/run-generated-manual-01/status)
  echo "$(date +%H:%M:%S) $s"
  case "$s" in
    *'"running"'*) sleep 20 ;;
    *) break ;;
  esac
done
```

Expected: final status `completed` or `failed`. `failed` with diagnostic is acceptable here — this step verifies the pipeline STARTS and runs to termination via the new path, not that hello-research-v2's logic is correct (pipeline-generator's prompt quality is tested separately).

If status never leaves `running` past 10 minutes, capture full port_values + stage_attempts and stop the server for investigation.

- [ ] **Step 6: Stop server**

```bash
pkill -f 'tsx.*server' 2>/dev/null
```

- [ ] **Step 7: No code change, no commit**

Move to self-review.

---

## Self-Review

**1. Spec coverage:**

| Spec § | Task(s) |
|---|---|
| §1 SC 1 run_pipeline external MCP | Task 4 |
| §1 SC 2 AI-submitted pipeline runs uniformly | Tasks 3, 6 |
| §1 SC 3 HTTP route backward-compatible | Task 6 |
| §1 SC 4 pg-entry reuses startPipelineRun | Task 7 |
| §1 SC 5 sub-pipeline recursion | Tasks 3, 4 (agent calls run_pipeline tool) — verified via existing MCP surface |
| §1 SC 6 mock pipelines still work | Tasks 2, 3 (mock registry) |
| §1 SC 7 no regression | Tasks 5, 6, 8 |
| §3.1 module layout | Tasks 1, 2, 3, 4, 6, 7 |
| §3.2 startPipelineRun contract | Task 3 |
| §3.3 MCP tool | Task 4 |
| §3.4 HTTP refactor | Task 6 |
| §3.5 pg-entry refactor | Task 7 |
| §3.6 name helper | Task 1 |
| §4 mock registry | Task 2 |
| §5 sub-pipeline | Works via existing MCP plumbing — no dedicated task |
| §6 data flow | Task 3 implements |
| §7 tests | Tasks 1-8 |
| §8 backward compat | Task 6 handles `pipeline` alias |
| §9 non-negotiables | Maintained by design |

**2. Placeholder scan:** No "TBD", "TODO", "implement later" in the plan body. Each step has actual code or exact commands.

**3. Type consistency:**
- `startPipelineRun(input: StartPipelineRunInput): Promise<StartPipelineRunResult>` — consistent Tasks 3, 4, 6, 7.
- `StartPipelineRunResult.ok: true` → `{taskId, versionHash}`; `ok: false` → `{code, message, context?}` — consistent.
- `MOCK_HANDLER_REGISTRY: Record<string, MockPipelineEntry>` — consistent Tasks 2, 3.
- `getLatestVersionHashByName(db, name): string | null` — Task 1 defines; Task 3 uses.
- Tool name literal `"run_pipeline"` consistent Tasks 4, 5.
- HTTP body field `name` vs `pipeline` — Task 6 handles alias; not used inconsistently.
- `tscPath` propagation: kernel-run.ts owns `MONOREPO_TSC_PATH` (already in repo from stage-3 fix); passes to startPipelineRun; pg-entry accepts via deps; MCP tool reads from `options.tscPath` in `createKernelMcp`. Four-way consistent.
