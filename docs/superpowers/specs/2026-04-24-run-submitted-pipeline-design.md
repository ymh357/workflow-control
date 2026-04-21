# Run Submitted Pipelines — Design

> **Date:** 2026-04-24
> **Status:** Draft — awaiting user approval
> **Goal-tier:** Stage 3 unblocker — without a way to run AI-submitted pipelines, stage 2's authoring loop has no consumer.
> **Related:**
>   - `docs/kernel-next-terminal-design.md` §1.1 (MCP-first), §3.4 (sub-pipeline recursion), §5.3 (run_pipeline signature), §9 (MCP surface)
>   - `docs/superpowers/specs/2026-04-24-prompts-in-sqlite-design.md` (versionHash covers IR + prompts)
>   - `docs/superpowers/specs/2026-04-24-pipeline-generator-emit-ir-design.md` (upstream milestone; produces submitted pipelines)

## 1. Goal & Success Criteria

**Goal:** Make every pipeline registered in `pipeline_versions` — whether authored by pipeline-generator, submitted manually, or hand-written in builtins — runnable through a single uniform entry point: MCP tool `run_pipeline`, with the HTTP route `POST /api/kernel/tasks/run` and pg-entry's `start_pipeline_generator` both delegating to the same internal function.

**Success criteria:**

1. MCP tool `run_pipeline` is registered on the EXTERNAL surface and accepts `{ name, versionHash?, seedValues?, policy? }` per §5.3 of terminal-design (adapted for multi-field externalInputs).
2. Calling `run_pipeline` on an AI-submitted pipeline (such as `hello-research-v2` from the stage-3 probe) kicks off the same XState runner with the same executor wiring as a hand-registered builtin — no special-casing by pipeline source.
3. HTTP `POST /api/kernel/tasks/run` reuses the same internal function; its body shape is backward-compatible (existing callers continue to work) but the handler is a thin adapter over `startPipelineRun`.
4. `start_pipeline_generator` in `pg-entry.ts` reuses `startPipelineRun` for its post-submit run kickoff; no duplicated executor-construction code.
5. An agent stage prompt containing `run_pipeline(name="sub-pipe-X")` tool calls works for real sub-pipeline recursion: main Claude (or the in-pipeline agent) calls the MCP tool, kernel returns `{taskId}`, caller polls `get_task_status` + reads ports as declared in §3.4.
6. Mock pipelines (diamond / diamond-slow / diamond-real) remain runnable — their in-memory handler map stays usable through a registry override mechanism that does not pollute the general-case path.
7. No regression in kernel-next test suite (4229+ passing as of stage 2 completion).

## 2. Scope & Non-Goals

**In scope:**
- New internal function `startPipelineRun` (module: `apps/server/src/kernel-next/runtime/start-pipeline-run.ts` — new file, single responsibility: take a pipeline identifier + inputs, build executor, fire `runPipeline` in background, return taskId).
- New MCP tool `run_pipeline` on EXTERNAL surface (extends `createKernelMcp` in `kernel-next/mcp/server.ts`).
- Refactor `POST /api/kernel/tasks/run` (`routes/kernel-run.ts`) to delegate.
- Refactor `start_pipeline_generator` (`kernel-next/mcp/pg-entry.ts`) to delegate to `startPipelineRun` for the run-kickoff half (submit half unchanged).
- Name → latest versionHash resolver in `ir/sql.ts` (one small helper).
- Mock pipelines continue to work: a **handler override map** keyed by pipeline-name is consulted by `startPipelineRun`; when present, it's used as the mock-handler source. When absent (AI-submitted pipelines), runner gets an empty handler map and all stages go through `executor` (RealStageExecutor for agents, ScriptStageExecutor for scripts).

**Out of scope (deferred):**
- Blocking variant of `run_pipeline` (decision 8b in brainstorm): agent fires-and-forgets, then polls. Blocking `wait_pipeline_result` already exists in pg-entry, can be reused if needed.
- Full per-stage ExecutionPolicy (policy.perStage override) — current RealStageExecutor only honors a single default layer. Future milestone.
- Dashboard UI for "runnable pipelines" listing — not kernel's concern; shell scripts can `sqlite3 … SELECT pipeline_name FROM pipeline_versions`.
- Automatic pipeline GC / version cleanup.
- Propose/migrate integration on non-registry pipelines — orthogonal; hot-update already works on any versionHash.
- Registry-of-handlers for script-stage modules — script stages currently have no production users; when they appear, `moduleId` resolution is a separate concern.

**Non-goals (explicit rejections):**
- **NOT** creating an "auto-registry" that adds every submitted pipeline to `pipelineRegistry`. The registry is for mock-handler overrides only; for real pipelines, the SQLite `pipeline_versions` table IS the registry.
- **NOT** allowing callers to submit IR+run in one call. Submit and run are distinct lifecycles (versioning, auditing). Callers needing one-shot: submit, then run.
- **NOT** auto-running on gate approval — gates continue to require explicit `answer_gate`.

## 3. Architecture

### 3.1 Module layout

```
kernel-next/
├── runtime/
│   ├── start-pipeline-run.ts         ← NEW: the single entry function
│   ├── start-pipeline-run.test.ts    ← NEW
│   ├── runner.ts                     ← unchanged (runPipeline still the workhorse)
│   └── real-executor.ts              ← unchanged
├── mcp/
│   ├── server.ts                     ← MODIFIED: register run_pipeline tool
│   ├── pg-entry.ts                   ← MODIFIED: delegate the run half
│   └── ...
├── ir/
│   └── sql.ts                        ← MODIFIED: add getLatestVersionHashByName(db, name): string | null
└── runtime/mock-handler-registry.ts   ← NEW (small): export a map {name → StageHandlerMap} for diamond-family mocks
```

`routes/kernel-run.ts` becomes a thin HTTP adapter over `startPipelineRun`.

### 3.2 `startPipelineRun` contract

```typescript
export interface StartPipelineRunInput {
  db: DatabaseSync;
  broadcaster: KernelNextBroadcaster;           // singleton kernelNextBroadcaster in prod
  /** Pipeline name (resolves to latest versionHash). One of name/versionHash required. */
  name?: string;
  /** Exact versionHash. Takes precedence over name if both supplied. */
  versionHash?: string;
  /** Optional task ID; generated if absent. */
  taskId?: string;
  /** Per-port external input values. Must cover every ir.externalInputs entry. */
  seedValues?: Record<string, unknown>;
  /** ExecutionPolicy-shaped. Current runner uses only policy.default (single layer). */
  policy?: ExecutionPolicy;
  /** Shorthand for policy.default.{budget.maxTurns, budget.maxCostUsd, promptAssembly.model}.
   *  Merged with policy if both supplied; explicit policy.default wins per field. */
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** tscPath for the agent-visible submit_pipeline MCP tool (kept in this param so
   *  all three callers — HTTP, MCP, pg-entry — can supply a consistent path). */
  tscPath?: string;
  /** Optional timeout for runPipeline's attempt promise. Defaults to kernel default. */
  timeoutMs?: number;
}

export interface StartPipelineRunResult {
  taskId: string;
  versionHash: string;
}

export interface StartPipelineRunError {
  ok: false;
  code: "UNKNOWN_PIPELINE" | "UNKNOWN_VERSION_HASH" | "MISSING_INPUT" | "AMBIGUOUS_INPUT";
  message: string;
  context?: Record<string, unknown>;
}

export async function startPipelineRun(
  input: StartPipelineRunInput,
): Promise<StartPipelineRunResult | StartPipelineRunError>;
```

Semantics:

1. **Resolve versionHash**:
   - Both `name` and `versionHash` unset → `MISSING_INPUT`.
   - `versionHash` set → lookup in `pipeline_versions`; not found → `UNKNOWN_VERSION_HASH`.
   - `name` set (no versionHash) → `getLatestVersionHashByName(db, name)`; not found → `UNKNOWN_PIPELINE`.
   - Both set → use `versionHash` (verify it resolves to a row whose `pipeline_name` matches `name`; mismatch → `AMBIGUOUS_INPUT`).
2. **Load IR** from `pipeline_versions.ir_json`.
3. **Compute final policy**:
   ```
   default = {
     ...policy.default,
     budget: {
       maxTurns: input.maxTurns ?? policy.default?.budget?.maxTurns ?? DEFAULT,
       maxCostUsd: input.maxBudgetUsd ?? policy.default?.budget?.maxCostUsd ?? DEFAULT,
       timeoutSeconds: policy.default?.budget?.timeoutSeconds,
     },
     promptAssembly: { model: input.model ?? policy.default?.promptAssembly?.model ?? DEFAULT_MODEL, ...policy.default?.promptAssembly },
     retry: policy.default?.retry,
     permission: policy.default?.permission,
   }
   ```
4. **Consult mock-handler registry**: if `mockHandlerRegistry[name]` exists, use those handlers (diamond / diamond-slow / diamond-real path). Otherwise handlers = `{}`.
5. **Construct executor**: always `RealStageExecutor` with:
   - `promptResolver: new DbPromptResolver(db, versionHash)` — works for AI-submitted, builtins-via-`registerLegacyPipeline`, and mocks alike (DbPromptResolver returns the prompts stored by submit for that versionHash; mocks typically have no agent stages so resolver is never called).
   - `mcpServerFactory: (_dispatcher, portRuntime) => createKernelMcp(db, { surface: "combined", portRuntime, tscPath })` — threading `tscPath` so agent-invoked `submit_pipeline` works.
   - `model` / `maxTurns` / `maxBudgetUsd` from merged policy.
6. **Generate taskId** (if not supplied): `${name ?? versionHash.slice(0,8)}-${Date.now()}`.
7. **Fire runPipeline in background** with `{db, ir, taskId, versionHash, handlers, executor, broadcaster, seedValues}`. Do NOT await.
8. **Return** `{taskId, versionHash}`.

### 3.3 MCP tool `run_pipeline`

Registered in `createKernelMcp` external-tool list (after `submit_pipeline`).

```typescript
{
  name: "run_pipeline",
  description: "Start a new task running a previously-submitted pipeline. " +
    "Returns the taskId. Caller polls get_task_status and reads ports as needed.",
  inputSchema: {
    name: z.string().optional().describe("Pipeline name; resolves to latest versionHash"),
    versionHash: z.string().optional().describe("Exact pipeline versionHash; overrides name resolution"),
    seedValues: z.record(z.string(), z.unknown()).optional().describe("Per-port external input values"),
    policy: z.unknown().optional().describe("ExecutionPolicy (see terminal-design §5.3)"),
    model: z.string().optional(),
    maxTurns: z.number().int().positive().optional(),
    maxBudgetUsd: z.number().positive().optional(),
  },
  handler: async (args, context) => {
    // context comes from createKernelMcp — carries db + tscPath + etc.
    const result = await startPipelineRun({
      db: context.db,
      broadcaster: kernelNextBroadcaster,  // singleton
      name: args.name,
      versionHash: args.versionHash,
      seedValues: args.seedValues,
      policy: args.policy as ExecutionPolicy | undefined,
      model: args.model,
      maxTurns: args.maxTurns,
      maxBudgetUsd: args.maxBudgetUsd,
      tscPath: context.tscPath,
    });
    if ("ok" in result && result.ok === false) {
      return { content: [{ type: "text", text: JSON.stringify(result) }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
}
```

Placement: `createKernelMcp`'s inline `allTools` array. Added to `EXTERNAL_TOOLS` set. Kernel MCP handler constructs `context.db` / `context.tscPath` already via the closure from `createKernelMcp(db, options)` — only ensure `tscPath` is exposed to the handler scope (already is per stage 3 probe fix).

The handler imports `kernelNextBroadcaster` (singleton) because `createKernelMcp` doesn't currently know about it — this is acceptable coupling: the broadcaster is a process-singleton and every run needs it.

### 3.4 HTTP route refactor

`routes/kernel-run.ts::kernelRunRoute.post("/kernel/tasks/run", ...)`:

Current body shape `{ pipeline, taskId?, model?, maxTurns?, maxBudgetUsd?, seedValues? }` where `pipeline` is a registry key.

New body shape (backward-compat superset):

```typescript
{
  // One of these must be present. "pipeline" is legacy alias for "name" — both accepted.
  pipeline?: string;            // alias for name (backward compat)
  name?: string;
  versionHash?: string;

  taskId?: string;
  seedValues?: Record<string, unknown>;
  policy?: ExecutionPolicy;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
}
```

Handler:
1. Parse body.
2. `name = body.name ?? body.pipeline`.
3. Call `startPipelineRun({db, broadcaster: kernelNextBroadcaster, name, versionHash: body.versionHash, ..., tscPath: MONOREPO_TSC_PATH})`.
4. On error, return 400 with `{ok: false, diagnostics: [...]}` (shape aligned with existing `UNKNOWN_PIPELINE` diagnostic structure).
5. On success, return 202 with `{ok: true, taskId, versionHash}`.

The existing `pipelineRegistry` map becomes **only a mock-handler registry** — its entries are consulted by `startPipelineRun` for the handlers field, but they no longer drive pipeline lookup. Deleted from registry: `tech-research-collector`, `tech-research-writer`, `smoke-test`, `pipeline-generator` — they're now looked up by name from `pipeline_versions`. The `registerLegacyPipeline` function is preserved **only to submit the YAML→IR conversion at module load** (it no longer returns a factory; it only ensures the latest version of these legacy builtins is in the DB). Kept entries in the registry: `diamond`, `diamond-slow`, `diamond-real` — pure mocks.

### 3.5 pg-entry refactor

`kernel-next/mcp/pg-entry.ts::handleStartPipelineGenerator`:

Current responsibility: (a) submit pipeline-generator IR+prompts from YAML to get versionHash; (b) kick off background run via `runPipeline`. After this milestone (a) stays; (b) delegates to `startPipelineRun`.

Concretely, replace the inline run-kickoff with:

```typescript
const runRes = await startPipelineRun({
  db: deps.db,
  broadcaster: deps.broadcaster,
  versionHash: submitResult.versionHash,
  taskId: args.taskId,
  seedValues: { taskDescription: args.description },
  model: args.model,
  maxTurns: args.maxTurns,
  maxBudgetUsd: args.maxBudgetUsd,
  tscPath: deps.tscPath,
});
```

`deps.tscPath` added to `PgEntryDeps`. Call sites pass `MONOREPO_TSC_PATH`.

### 3.6 Name resolution helper

Added to `kernel-next/ir/sql.ts`:

```typescript
export function getLatestVersionHashByName(
  db: DatabaseSync,
  pipelineName: string,
): string | null {
  const row = db.prepare(
    `SELECT version_hash FROM pipeline_versions
     WHERE pipeline_name = ?
     ORDER BY created_at DESC LIMIT 1`,
  ).get(pipelineName) as { version_hash: string } | undefined;
  return row ? row.version_hash : null;
}
```

Latest = most recently inserted. If multiple versions exist the newest is default; caller picks a specific one via `versionHash`.

## 4. Mock-Handler Registry

Extract mock handlers from `routes/kernel-run.ts::pipelineRegistry` into `kernel-next/runtime/mock-handler-registry.ts`:

```typescript
import { diamondIR } from "../generator-mock/mini-generator.js";
import { slowDiamondHandlers } from "../demo/slow-diamond.js";
import type { StageHandlerMap } from "./mock-executor.js";

export interface MockPipelineEntry {
  ir: PipelineIR;                          // for those not yet in DB at boot time
  handlers: StageHandlerMap;
}

export const MOCK_HANDLER_REGISTRY: Record<string, MockPipelineEntry> = {
  "diamond": {
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
  // diamond-real uses real executor even though it's in the "mock" registry.
  // It has no handlers (empty map); the only reason to keep a registry entry is
  // to seed its IR if not already in pipeline_versions at boot.
  "diamond-real": {
    ir: diamondIR(),
    handlers: {},
  },
};
```

`startPipelineRun` flow:
1. `name` given → check MOCK_HANDLER_REGISTRY.
2. If found: ensure its IR is in `pipeline_versions` (idempotent submit via `KernelService.submit` on first encounter — prompts: `{}` for mock stages with no promptRefs). Use registry's handlers.
3. If not found: look up `pipeline_versions` for the name → latest versionHash. handlers = `{}`.

This **boot seeds mocks on demand** rather than at module load. Keeps startup fast and separates concerns.

## 5. Sub-Pipeline Recursion

Integration with §3.4 of terminal-design.

An agent stage's prompt contains literal `run_pipeline(name="sub-X", seedValues={...})` guidance. At runtime:

1. Agent tool_use fires the MCP `run_pipeline` tool via its in-context MCP server.
2. The MCP handler calls `startPipelineRun(...)`.
3. Returns `{taskId, versionHash}` synchronously (`await startPipelineRun` is ~fast — runPipeline is fired in background, await only covers IR lookup + executor construction).
4. Agent receives tool_result with the taskId.
5. Agent polls `get_task_status(taskId)` MCP tool until `completed` / `failed`.
6. Agent reads results via `read_port(taskId, stageName, portName)` MCP tool.
7. Agent writes its own output ports using collected sub-pipeline results.

Every MCP tool on the list already exists (get_task_status, read_port) — this milestone doesn't add any except `run_pipeline`.

### 5.1 Sub-pipeline gate handling

Sub-pipelines may have their own gates. When an agent's sub-pipeline blocks on a gate:

- `get_task_status` returns `gated` with gate info
- Agent must escalate. In principle agent could call `answer_gate` itself if it's confident (like main Claude does today). In practice for machine-answerable gates this is fine; for human gates the main task is stuck until a human intervenes on the sub-task.

This is by-design (§3.3): the answerer is decided at runtime by whoever sees the gate. Nothing special needs to be built for this milestone — the existing gate_queue + answer_gate plumbing handles it.

## 6. Data Flow

```
caller (HTTP, MCP, pg-entry, agent tool_use)
  │
  ▼
[runtime/start-pipeline-run.ts::startPipelineRun]
  │
  ├─ resolve versionHash:
  │    if versionHash: getPipelineIR(db, hash) or UNKNOWN_VERSION_HASH
  │    else if name:   getLatestVersionHashByName(db, name) or UNKNOWN_PIPELINE
  │
  ├─ if MOCK_HANDLER_REGISTRY[name]:
  │    ensureMockIrSubmitted(svc, name, registry[name].ir)
  │    handlers = registry[name].handlers
  │  else:
  │    handlers = {}
  │
  ├─ merge policy defaults
  │
  ├─ executor = new RealStageExecutor({
  │     promptResolver: new DbPromptResolver(db, versionHash),
  │     mcpServerFactory: (_d, pr) => createKernelMcp(db, {
  │                       surface: "combined", portRuntime: pr, tscPath }),
  │     model, maxTurns, maxBudgetUsd,
  │  })
  │
  ├─ taskId = input.taskId ?? `${name ?? hash.slice(0,8)}-${Date.now()}`
  │
  ├─ // fire-and-forget
  │  runPipeline({db, ir, taskId, versionHash, handlers, executor,
  │               broadcaster, seedValues}).catch(err => logger.error(...))
  │
  └─ return { taskId, versionHash }
```

## 7. Testing Strategy

### 7.1 Unit tests (`runtime/start-pipeline-run.test.ts`)

- Missing both name and versionHash → `MISSING_INPUT`
- Name resolves correctly to latest versionHash (seed 2 versions, assert latest)
- VersionHash found → OK
- VersionHash not found → `UNKNOWN_VERSION_HASH`
- Name not found → `UNKNOWN_PIPELINE`
- Both name+versionHash matching → OK
- Both mismatching → `AMBIGUOUS_INPUT`
- Mock registry hit → handlers supplied
- Mock registry miss → handlers empty
- Policy merge: top-level `model` overrides `policy.default.promptAssembly.model` when top-level supplied; else policy.default wins
- taskId generation when not supplied

Mock `runPipeline` so unit tests don't actually kick runs — assert `runPipeline` was called with expected args (`db`, `ir`, `executor`, `broadcaster`, `seedValues` correctly forwarded).

### 7.2 Integration tests

- `mcp/server.test.ts`: `run_pipeline` appears in external-surface tool list; absent from internal.
- `mcp/server.run-pipeline.test.ts` (new): actual MCP tool call with in-memory db seeded with a tiny IR → returns `{taskId, versionHash}`; polling `get_task_status` shows progression.
- `routes/kernel-run.test.ts`: existing tests adjusted — `pipeline` field still accepted, new `name`/`versionHash`/`policy` fields work, AI-submitted pipeline (hand-seed a `pipeline_versions` row) is runnable via the route.
- `mcp/pg-entry.integration.test.ts`: `start_pipeline_generator` still works; the run half now calls `startPipelineRun`.

### 7.3 End-to-end (manual, real Claude SDK)

After milestone lands:
1. Submit `hello-research-v2` via pipeline-generator (already done in stage-3 probe).
2. Call `run_pipeline(name="hello-research-v2", seedValues={topic: "X"})` via curl to HTTP endpoint.
3. Observe SSE; expect `hello-research-v2` stages to fire.
4. Verify `persistResult` (or whatever the user-generated pipeline writes) appears in `port_values`.

## 8. Backward Compatibility

- HTTP `POST /api/kernel/tasks/run` body `{pipeline, model, maxTurns, maxBudgetUsd, seedValues}` continues to work verbatim. `pipeline` is treated as `name`.
- Test files calling the old `pipelineRegistry["tech-research-collector"]()` factory shape need adjustment: the registry no longer exposes factories for those — instead they're looked up by name. Adjust `routes/kernel-run.test.ts` assertions that introspect the registry.
- `registerLegacyPipeline` changes signature: no longer returns a registration factory; instead returns `void` and just ensures the pipeline's latest YAML is submitted to DB at module load. All call sites in `routes/kernel-run.ts` change from `"tech-research-collector": registerLegacyPipeline({...})` (map entry) to a standalone call: `registerLegacyPipeline({ pipelineDir: "tech-research-collector" });` at module scope.

## 9. Non-Negotiables Check

- ✅ Kernel executor-agnostic: `startPipelineRun` doesn't know about Claude specifics; plugs in RealStageExecutor generically.
- ✅ IR cannot encode policy: policy is a separate parameter, never embedded in IR.
- ✅ MCP surface physical separation: `run_pipeline` added to EXTERNAL only.
- ✅ Lineage synchronous, sidecar async-best-effort: unchanged — `runPipeline` already handles this.
- ✅ Hot-update never silently migrates: `run_pipeline` starts new tasks; never mutates existing task version.
- ✅ No mutable global state: versionHash binds at task start; task snapshot is immutable.
- ✅ Zero legacy compatibility: old `pipelineRegistry` factory entries for legacy YAML pipelines are deleted — those pipelines now live in `pipeline_versions`.

## 10. Known Risks

- **Mock handler IR drift**: if `diamondIR()` is updated, the `pipeline_versions` row seeded for `diamond` at first-run is stale until next seeding. Mitigation: seed idempotently on every `startPipelineRun` call that hits the registry (small cost — `insertPipelineVersion` with `INSERT OR IGNORE`). This is the existing idempotency from stage-1.
- **Broadcaster singleton coupling**: `run_pipeline` MCP handler imports `kernelNextBroadcaster`. If a test wants to use a non-singleton broadcaster, it must stub the import. Acceptable: tests that care about broadcaster output test `startPipelineRun` directly with injected broadcaster.
- **`tscPath` consistency**: three callers supply it (HTTP, MCP, pg-entry). All three must pass the monorepo path. Regression risk if a fourth caller appears; mitigate by making `tscPath` required in `StartPipelineRunInput` — documented but not enforced at type level (optional to match real-world "no tscPath in test" flows).
- **Sub-pipeline recursion depth**: not bounded by kernel (terminal-design §3.4 states "budget / time-limit enforcement at the policy layer handles runaway recursion"). This milestone doesn't add a depth check; rely on maxBudgetUsd/maxTurns of the outer agent.

## 11. Self-Review Checklist

- [ ] Every success criterion in §1 mapped to code change in §3
- [ ] `startPipelineRun` handles name/versionHash/both-matching/both-mismatching without ambiguity
- [ ] Mock registry allows diamond family to keep working
- [ ] HTTP route body shape is backward compatible
- [ ] pg-entry no longer duplicates executor construction logic
- [ ] No new kernel-next runner changes — only orchestration above it
- [ ] `tscPath` plumbed through every caller that constructs `createKernelMcp`
