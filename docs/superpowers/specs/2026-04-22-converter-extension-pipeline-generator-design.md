# Converter Extension for pipeline-generator — Design

Status: Draft
Date: 2026-04-22
Owner: kernel-next
Prior art: `2026-04-20-legacy-yaml-converter-design.md`

---

## 1. Goal and Non-Goals

### Goal

Extend the legacy-YAML converter and kernel-next runtime so that the
`pipeline-generator` builtin pipeline converts and runs end-to-end
without hand-porting to a TypeScript IR factory and without modifying
the legacy YAML itself.

The concrete mappings to add:

1. `parallel: { name, stages: [...] }` block → flatten to top-level
   stage array; the block name is discarded from the IR.
2. `type: human_confirm` with `runtime.on_reject_to: <stage>` →
   kernel-next `type: gate` with a fixed question and
   approve/reject routing.
3. `runtime.agents` (sub-agent definitions) → a new IR field
   `AgentStage.config.subAgents`, threaded through `RealStageExecutor`
   to the Claude SDK's `options.agents`.
4. `runtime.retry: { max_retries, back_to }` on script stages → a new
   IR field `ScriptStage.config.retry`, backed by runner-level
   machinery that reruns an upstream stage when a script fails and
   `attemptIdx < maxRetries`.

### Non-goals

- `foreach` stage conversion remains `UNSUPPORTED_FEATURE`. It needs a
  parent pipeline YAML to test against and is deferred to a later
  milestone.
- Legacy stage fields `thinking`, `effort`, `mcps`, `claude_md`,
  `max_turns`, `max_budget_usd`, `disallowed_tools` continue to emit
  `LEGACY_FIELD_IGNORED` warnings unchanged.
- Dashboard UI is not changed. The new `stage_retry` SSE event is
  defined but dashboard renders only the existing `stage_error` /
  `stage_done` / `stage_executing` events. A later UX pass can add
  retry visualization.

### Success criteria

1. `apps/server/src/builtin-pipelines/pipeline-generator/pipeline.yaml`
   fed through `convertLegacyYaml` returns `ok: true` with zero fatal
   diagnostics.
2. Via `POST /api/kernel/tasks/run` the converted pipeline runs on the
   kernel-next runtime from `analyzing` all the way to `persisting`
   (including `awaitingConfirm` human gate answer, `generating` block
   running `genSkeleton` and `genPrompts` in parallel with sub-agent
   support, and `persisting.retry.back_to: generating` retrying
   automatically on failure).
3. All existing server tests stay green. New tests cover every new
   diagnostic code and every new runtime path.

## 2. Architecture

```
Legacy YAML
  │
  ▼
┌──────────────────────────────────────────────────┐
│ convertLegacyYaml(yamlText, opts?)                │
│                                                    │
│  parseYaml                                         │
│    │                                               │
│    ▼                                               │
│  [NEW] unwrapParallelBlocks                       │
│    │   flattens parallel: { name, stages } into   │
│    │   top-level stages; records blockName →      │
│    │   firstInnerStageName for later use.         │
│    ▼                                               │
│  mapStoreSchemaToPorts + mapInjectedContext        │
│    │                                               │
│    ▼                                               │
│  [NEW] mapHumanConfirmGates                        │
│    │   converts type: human_confirm to gate shape │
│    │   and records approve/reject routing.        │
│    ▼                                               │
│  mapStagesToIR                                     │
│    │   ├─ [NEW] extract runtime.agents → subAgents│
│    │   └─ [NEW] extract runtime.retry → retry     │
│    ▼                                               │
│  [NEW] rewriteRetryBackTo                          │
│    │   redirects back_to pointing at a parallel   │
│    │   block name to the first inner stage;       │
│    │   errors when target is unknown.             │
│    ▼                                               │
│  mapReadsToWires                                   │
│    │                                               │
│    ▼                                               │
│  assembleIR                                        │
│                                                    │
│  → { ok: true, ir, promptRoot, warnings }          │
└──────────────────────────────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────────────┐
│ PipelineIR (extended)                             │
│   stages: StageIR[]                               │
│     ├─ AgentStage.config.subAgents?       [NEW]    │
│     ├─ ScriptStage.config.retry?          [NEW]    │
│     └─ GateStage (existing; routes type widened)  │
│   wires, externalInputs (unchanged)               │
└──────────────────────────────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────────────┐
│ kernel-next runtime                               │
│                                                    │
│  ir-to-machine [NEW]:                              │
│    ScriptStage with retry: STAGE_FAILED gains a   │
│    transition — guard attemptIdx < maxRetries,    │
│    target scriptStage.waiting, actions raise      │
│    { type: RETRY_TO_STAGE, backToStage, ... }.     │
│                                                    │
│  runner [NEW]:                                     │
│    subscribes RETRY_TO_STAGE at the parent        │
│    machine:                                        │
│     1. topo-downstream walk of ir.wires from     │
│        backToStage; clear portValues for          │
│        backToStage + all downstream stages.       │
│     2. remove finalizedStages entries for those   │
│        stages.                                    │
│     3. send RESET_STAGE { stage: backToStage } so │
│        the region re-enters waiting.              │
│     4. publish stage_retry SSE event.              │
│                                                    │
│  RealStageExecutor [NEW]:                          │
│    When AgentStage.config.subAgents is non-empty, │
│    build SDK options.agents and pass it through  │
│    queryFn().                                     │
└──────────────────────────────────────────────────┘
```

### Concern ownership

| Concern | converter | IR schema | runtime |
|---|---|---|---|
| parallel block unwrap | ✓ | — | — |
| human_confirm → gate | ✓ | routes widened | — |
| subAgents pass-through | ✓ extract | ✓ field | ✓ executor |
| script retry + back_to rerun | ✓ extract | ✓ field | ✓ ir-to-machine + runner |

## 3. Detailed Design

### 3.1 converter: unwrapParallelBlocks

```ts
interface UnwrapResult {
  flat: LegacyStage[];
  blockMap: Map<string, string>;  // blockName → first inner stage name
  diagnostics: ConverterDiagnostic[];
}

function unwrapParallelBlocks(legacy): UnwrapResult
```

Rules:
- Each top-level element of `stages` is either a plain stage or
  `{ parallel: { name, stages } }`. The latter is replaced with its
  inner stages, preserving document order.
- The block's outer `name` is recorded in `blockMap` so later passes
  can redirect `back_to: <blockName>` to the inner first stage.
- Validation:
  - `NESTED_PARALLEL_UNSUPPORTED` — a parallel block contains another
    parallel block.
  - `PARALLEL_EMPTY` — `parallel.stages` has length 0.
  - `PARALLEL_NAME_COLLISION` — an inner stage name duplicates an
    outer stage name already seen during flattening.

### 3.2 converter: mapHumanConfirmGates

```ts
function mapHumanConfirmGates(flat): {
  stages: LegacyStage[];
  gateRoutes: Map<string, { approve: string | string[]; reject: string }>;
}
```

For each `type: human_confirm` stage at flat index `i`:
- `approve` target = name of `flat[i + 1]` if it is a plain stage. If
  the stage at `i + 1` was originally the first stage of a parallel
  block (known via the `blockMap` built in 3.1), `approve` is the
  array of all stages that were flattened out of that block.
- `reject` target = `runtime.on_reject_to` (must be present and must
  name an existing stage).
- Converter produces a synthetic gate shape consumed by
  `mapStagesToIR`:
  ```ts
  {
    name: <original name>,
    type: "gate",
    config: {
      question: { text: "Approve this result?" },
      routing: { routes: { approve: <approve target>, reject: <reject target> } },
    },
  }
  ```

Diagnostics:
- `HUMAN_CONFIRM_AT_END` — the last element of `flat` is a
  human_confirm (no `i + 1`).
- `HUMAN_CONFIRM_NO_REJECT_TARGET` — missing `runtime.on_reject_to`.

### 3.3 converter: mapStagesToIR extensions

Two new extractions:

**subAgents** (agent stages only):
```ts
if (s.type === "agent" && s.runtime?.agents !== undefined) {
  // Reject non-object shapes early. legacy YAML expects
  // `agents: { <name>: <def>, ... }`; arrays, strings, nulls are
  // structural errors.
  if (typeof s.runtime.agents !== "object" ||
      Array.isArray(s.runtime.agents) ||
      s.runtime.agents === null) {
    diagnostics.push({
      code: "SUB_AGENT_INVALID",
      message: `stage '${s.name}': runtime.agents must be an object map of name → def`,
      context: { stage: s.name, got: typeof s.runtime.agents },
    });
    continue;
  }
  const subAgents: SubAgentDef[] = [];
  for (const [name, def] of Object.entries(s.runtime.agents)) {
    if (!def || typeof def !== "object" || !def.description || !def.prompt) {
      diagnostics.push({
        code: "SUB_AGENT_INVALID",
        message: `stage '${s.name}': sub-agent '${name}' missing description or prompt`,
        context: { stage: s.name, subAgent: name },
      });
      continue;
    }
    subAgents.push({
      name, description: def.description, prompt: def.prompt,
      tools: def.tools, model: def.model, maxTurns: def.maxTurns,
    });
  }
  if (subAgents.length > 0) agentConfig.subAgents = subAgents;
}
```

**retry** (script stages only):
```ts
if (s.type === "script" && s.runtime?.retry) {
  const r = s.runtime.retry;
  const maxRetries = r.max_retries ?? r.max_attempts;
  if (maxRetries && r.back_to) {
    scriptConfig.retry = { maxRetries, backToStage: r.back_to };
  } else if (maxRetries && !r.back_to) {
    // retry count without back_to is not supported by the runner;
    // emit LEGACY_FIELD_IGNORED and continue without retry.
    warnings.push({ code: "LEGACY_FIELD_IGNORED", ... });
  }
}
```

Remove from the existing `UNSUPPORTED_FEATURE` list:
- `parallel` block (now handled by unwrap)
- `human_confirm` type (now handled by mapHumanConfirmGates)
- `runtime.retry.back_to` (now handled here)
- `runtime.agents` (now handled here)

### 3.4 converter: rewriteRetryBackTo

Runs after `mapStagesToIR`:

```ts
function rewriteRetryBackTo(
  stages: StageIR[],
  blockMap: Map<string, string>,
  stageNames: Set<string>,
): { warnings, diagnostics }
```

For each script stage with `config.retry`:
- If `retry.backToStage` is in `blockMap`: rewrite to
  `blockMap.get(backToStage)` and emit
  `RETRY_BACK_TO_REDIRECTED` warning with both original and new
  targets in the context.
- Else if `retry.backToStage` is in `stageNames`: leave as-is.
- Else: emit `RETRY_BACK_TO_UNKNOWN` fatal diagnostic.

### 3.5 IR schema changes

```ts
// apps/server/src/kernel-next/ir/schema.ts

const SubAgentDefSchema = z.object({
  name: identifier,
  description: z.string().min(1),
  prompt: z.string().min(1),
  tools: z.array(z.string()).optional(),
  model: z.enum(["sonnet", "opus", "haiku", "inherit"]).optional(),
  maxTurns: z.number().int().positive().optional(),
});

const RetrySpecSchema = z.object({
  // Upper bound chosen arbitrarily to prevent pathological loops in
  // hand-authored YAML; pipeline-generator's real usage is 1. No
  // legacy pipeline uses >3. If a future case needs more, raise this
  // deliberately rather than letting runaway costs hide behind a
  // typo'd `max_retries: 9999`.
  maxRetries: z.number().int().min(1).max(10),
  backToStage: identifier,
});

export const AgentStageSchema = z.object({
  ...StageCommon,
  type: z.literal("agent"),
  config: z.object({
    promptRef: z.string().min(1),
    subAgents: z.array(SubAgentDefSchema).optional(),  // NEW
  }),
  fanout: FanoutSpecSchema.optional(),
});

export const ScriptStageSchema = z.object({
  ...StageCommon,
  type: z.literal("script"),
  config: z.object({
    moduleId: z.string().min(1),
    retry: RetrySpecSchema.optional(),  // NEW
  }),
  fanout: FanoutSpecSchema.optional(),
});

// GateRoutingSchema: routes value widened from identifier to
// identifier | identifier[]. Canonicalizer preserves the shape
// (single string stays single, array stays array) to keep existing
// fixture hashes byte-identical.
export const GateRoutingSchema = z.object({
  routes: z.record(
    z.string().min(1),
    z.union([identifier, z.array(identifier).min(1)]),
  ),
});
```

`PipelineIRSchema` and `WireIRSchema` unchanged.

### 3.6 canonical.ts

- `canonicalizeStage` serializes new optional fields only when
  present. `subAgents` sorted by `name`, field order alphabetical;
  `retry` field order alphabetical.
- `canonicalizeGateRouting` preserves input shape: single string stays
  single, array stays array (runtime normalizes internally). This
  keeps every existing IR fixture hash unchanged.

### 3.7 ir-to-machine: MachineContext new field and retry transition

**MachineContext.retryCounts**: existing MachineContext type in
`ir-to-machine.ts` gains:
```ts
retryCounts: Record<string, number>;  // stageName → retries already taken
```
Initialized to `{}`. All retry-counter semantics live here; no new
XState action beyond the root-level RETRY_TO_STAGE handler mutates
it.



Current ScriptStage structure (simplified):
```
scriptRegion:
  states:
    waiting: ...
    executing:
      invoke scriptExecutor
      on:
        STAGE_DONE: → done
        STAGE_FAILED: → error
    done: final
    error: final
```

With retry:
```
scriptRegion:
  states:
    waiting: ...
    executing:
      invoke scriptExecutor
      on:
        STAGE_DONE: → done
        STAGE_FAILED:
          [
            {
              guard: "ctx.attemptIdx[stageName] < retry.maxRetries",
              target: "waiting",
              actions: raise({
                type: "RETRY_TO_STAGE",
                failedStageName: <this stage name>,
                backToStage: retry.backToStage,
                reason: "executor_failed",
                retryIdx: ctx.retryCounts[stageName] ?? 0,  // 0-based before increment
                maxRetries: retry.maxRetries,
                errorMessage: event.error,
              })
            },
            { target: "error" }  // fallback when attempts exhausted
          ]
    done: final
    error: final
```

**Retry counter in MachineContext (new field)**:

MachineContext gains a new field `retryCounts: Record<string, number>`
keyed by the **failed stage name** (the stage whose executor errored
and whose `retry.backToStage` transition is about to fire), default 0.
The `STAGE_FAILED` transition's guard reads
`(ctx.retryCounts[failedStageName] ?? 0) < retry.maxRetries`. The
root-level `RETRY_TO_STAGE` handler in §3.9 increments
`ctx.retryCounts[failedStageName]` before sending `RESET_STAGE`, so
the next time the same script stage fails the counter reflects one
completed retry cycle.

This is distinct from `attemptIdx` tracked in the `stage_attempts` DB
table (owned by port-runtime). The DB's `attempt_idx` continues
incrementing monotonically across retries for lineage/audit; retries
never share `attempt_idx` with prior attempts. `retryCounts` is the
retry-loop accounting used purely for the transition guard.

### 3.8 ir-to-machine: gate routes normalization

`gateRoutedTargets` currently iterates `Object.values(s.config.routing.routes)`
and adds the single string. With widened schema, iterate: if value is
string add it, if array add each element. No breaking change for
existing single-target routes.

GATE_ANSWERED handler (in runner): `gateAuthorizedTargets` receives
every stage in the picked answer (array or single). `gateSkippedTargets`
receives every stage in the non-picked answers.

### 3.9 runner: RETRY_TO_STAGE handler

```ts
// Inside the snapshot subscribe loop, after event type inspection.
if (lastEvent.type === "RETRY_TO_STAGE") {
  const { failedStageName, backToStage, reason, errorMessage,
          retryIdx, maxRetries } = lastEvent;

  // 1. Compute downstream stages from ir.wires via transitive
  //    closure over wire edges (BFS starting from backToStage,
  //    following wires[].from.stage === current → to.stage).
  //    External-source wires are skipped since they originate outside
  //    the stage DAG.
  const downstream = topoDownstream(ir.wires, backToStage);
  const toReset = [backToStage, ...downstream];

  // 2. Clear port values for all resetted stages.
  for (const stageName of toReset) {
    const prefix = `${stageName}.`;
    for (const key of Object.keys(ctx.portValues)) {
      if (key.startsWith(prefix)) delete ctx.portValues[key];
    }
  }

  // 3. Clear finalizedStages entries for resetted stages.
  ctx.finalizedStages = ctx.finalizedStages.filter(
    e => !toReset.includes(e.name)
  );

  // 4. Reset the target region; downstream auto-reactivates when
  //    portValues change triggers the downstream's allInboundPresent
  //    guard to re-evaluate. (Each stage's `executing` state fires
  //    unconditionally when inbound wires are satisfied; cleared
  //    portValues force a re-check.)
  actor.send({ type: "RESET_STAGE", stage: backToStage });

  // 4b. Increment retry counter for the FAILED stage (not the
  //     back_to target). Guard at STAGE_FAILED reads this to decide
  //     whether further retries are allowed on the next failure.
  ctx.retryCounts[failedStageName] = (ctx.retryCounts[failedStageName] ?? 0) + 1;

  // 5. Publish SSE.
  publish({
    type: "stage_retry",
    taskId, timestamp: isoNow(),
    data: {
      stage: failedStageName,
      backToStage,
      retryIdx,
      maxRetries,
      errorMessage,
    },
  });
}
```

`RESET_STAGE` handler inside each stage region: `waiting` | `done` |
`error` all accept `RESET_STAGE` with `event.stage === self.name`, go
back to `waiting`, reset local `attemptIdx` only for the target stage
(downstream stages' attemptIdx resets naturally when they re-execute).

**Gate-routed stages and retry**: if `backToStage` is in
`gateAuthorizedTargets`, its authorization is preserved across RESET.
The retry re-runs without re-asking the human.

### 3.10 real-executor: subAgents pass-through

```ts
const stage = ... // StageIR for this run
if (stage.type === "agent" && stage.config.subAgents?.length) {
  options.agents = buildSdkAgents(stage.config.subAgents);
}

function buildSdkAgents(defs: SubAgentDef[]): NonNullable<SdkOptions["agents"]> {
  return Object.fromEntries(defs.map(d => [
    d.name,
    {
      description: d.description,
      prompt: d.prompt,
      ...(d.tools ? { tools: d.tools } : {}),
      ...(d.model ? { model: d.model } : {}),
      ...(d.maxTurns ? { maxTurns: d.maxTurns } : {}),
    },
  ]));
}
```

### 3.11 SSE stage_retry

```ts
// sse/types.ts
export interface StageRetryData {
  stage: string;           // failed stage name
  backToStage: string;     // target of the retry
  retryIdx: number;        // 0-based retry count BEFORE this retry
                           // (0 = first retry, 1 = second, ...)
  maxRetries: number;
  errorMessage: string;    // from the failed executor
}

export interface KernelNextStageRetryEvent extends KernelNextSSEEvent {
  type: "stage_retry";
  data: StageRetryData;
}

// Add to AnyKernelNextSSEEvent union.
```

## 4. Error Handling and Boundaries

### 4.1 New fatal diagnostics

| Code | Trigger |
|---|---|
| `NESTED_PARALLEL_UNSUPPORTED` | parallel block inside a parallel block |
| `PARALLEL_EMPTY` | `parallel.stages.length === 0` |
| `PARALLEL_NAME_COLLISION` | inner stage name duplicates an outer stage name |
| `HUMAN_CONFIRM_AT_END` | last flat stage is human_confirm |
| `HUMAN_CONFIRM_NO_REJECT_TARGET` | human_confirm without `on_reject_to` |
| `RETRY_BACK_TO_UNKNOWN` | `retry.back_to` names neither a stage nor a parallel block |
| `SUB_AGENT_INVALID` | sub-agent entry missing `description` or `prompt` |

### 4.2 New warnings

| Code | Trigger |
|---|---|
| `RETRY_BACK_TO_REDIRECTED` | back_to auto-redirected from a parallel block name to its first inner stage |
| `LEGACY_FIELD_IGNORED` (existing, new usage) | `runtime.retry` with `max_retries` but no `back_to` (retry count without redirection target is not supported) |

### 4.3 Retry runtime boundaries

- **Idempotency**: processing RETRY_TO_STAGE repeatedly on the same
  event type is safe. The clear operations are no-ops if already
  clear. RESET_STAGE sent twice is no-op after the first.
- **Exhaustion**: when `attemptIdx >= maxRetries`, the fallback
  transition to `error` fires normally. `stage_error` SSE with
  `reason: executor_failed` is emitted by the existing runner path.
- **Downstream already done**: clearing a downstream stage's
  portValues while it is in `done` state causes no immediate event,
  but when the upstream retry succeeds and new portValues arrive, the
  downstream region re-executes. UI sees `stage_done` → `stage_retry`
  → `stage_executing` (new attempt).
- **Gate-routed target**: gate authorization is preserved across
  retry. No re-ask.

### 4.4 Sub-agent runtime boundaries

- SDK rejection of malformed `agents` option surfaces as standard
  executor error → stageErrors → stage_error SSE. No special
  handling.
- Sub-agent `disallowedTools`: investigated in Slice D kickoff (see
  §9 R5). If SDK expects per-sub-agent allow-lists not inherited from
  parent, converter must route `runtime.agents.<name>.disallowed_tools`
  accordingly.

### 4.5 Expected output for pipeline-generator

After Slice A:
- 6 top-level stages: analyzing, awaitingConfirm, genSkeleton,
  genPrompts, refinePrompts, persisting.
- Warnings: ~8–12 `LEGACY_FIELD_IGNORED` entries (effort/max_turns/
  max_budget_usd/thinking/mcps/claude_md across multiple stages),
  1 `RETRY_BACK_TO_REDIRECTED` (persisting.retry.back_to: generating
  → genSkeleton).
- Zero fatal diagnostics.

After Slice D: genPrompts stage runs with `prompt-writer` sub-agent
actually invoked by the Claude SDK.

After Slice C: `persisting` failure triggers automatic rerun of
`genSkeleton` up to `maxRetries` times.

## 5. Testing Strategy

### 5.1 Converter unit tests

- `unwrap-parallel-blocks.test.ts`:
  - normal flatten preserves document order
  - empty block → PARALLEL_EMPTY
  - nested block → NESTED_PARALLEL_UNSUPPORTED
  - name collision → PARALLEL_NAME_COLLISION
- `map-human-confirm-gates.test.ts`:
  - approve target single when next is a plain stage
  - approve target array when next was a parallel block
  - reject missing → HUMAN_CONFIRM_NO_REJECT_TARGET
  - last stage is human_confirm → HUMAN_CONFIRM_AT_END
- `rewrite-retry-back-to.test.ts`:
  - target is direct stage → untouched
  - target is block name → rewrite + RETRY_BACK_TO_REDIRECTED warning
  - target unknown → RETRY_BACK_TO_UNKNOWN
- `map-stages.test.ts` extensions:
  - subAgents extraction with all optional fields set
  - subAgents missing description → SUB_AGENT_INVALID
  - script.retry with back_to → extracted
  - script.retry without back_to → LEGACY_FIELD_IGNORED, retry
    undefined in IR
- `legacy-yaml.test.ts` integration:
  - full pipeline-generator YAML → ok: true, expected warnings set,
    zero fatal diagnostics

### 5.2 IR schema unit tests

- `schema.test.ts`:
  - AgentStage.config.subAgents optional, shape validated
  - ScriptStage.config.retry optional, shape validated
  - GateRoutingSchema.routes accepts string and array values
- `canonical.test.ts`:
  - existing gate fixture hashes unchanged (single-string routes stay
    single in canonical form)
  - new multi-target fixture canonical output stable
  - subAgents canonical sorts by name
  - retry field order alphabetical

### 5.3 Runtime unit tests

- `ir-to-machine.test.ts`:
  - ScriptStage with retry emits the guarded STAGE_FAILED transition
  - ScriptStage without retry unchanged
  - gate with array routing registers all targets in
    gateRoutedTargets
- `runner.test.ts`:
  - RETRY_TO_STAGE clears portValues for target + downstream
    (transitive closure)
  - RETRY_TO_STAGE clears finalizedStages for resetted stages
  - RETRY_TO_STAGE increments ctx.retryCounts[failedStage] by 1
  - RESET_STAGE drops region back to waiting
  - retry exhaustion (retryCounts reaches maxRetries) reaches
    stage_error with reason: executor_failed
  - downstream done stage re-executes after retry
  - gate-routed stage retried without re-asking the human
  - stage_retry SSE event carries the expected fields with
    retryIdx reflecting the pre-increment value
- `real-executor.test.ts`:
  - subAgents present → options.agents built correctly
  - subAgents absent → options has no agents key

### 5.4 Integration / E2E

- `pipeline-generator-full-convert.test.ts`: convertLegacyYaml against
  the real YAML file, assert IR shape and warning counts.
- `pipeline-generator-run.test.ts`: use MockExecutor to simulate
  agent outputs; drive through gate answer and one induced
  persisting failure to verify retry lands correctly and the run
  completes.
- Manual real-SDK E2E after Slice D (sub-agents sanity) and after
  Slice C (retry behavior against the real Claude SDK).

### 5.5 Regression

- 4132 existing tests must stay green.
- Canonical hash baselines (diamondIR, smokeTestIR) assert unchanged
  in `canonical.test.ts`.

## 6. Observability and Semantic Deviations

### 6.1 SSE changes

Adds `stage_retry` event. No other event changes.

### 6.2 Retry SSE sequence

Single retry on `persisting` that succeeds on the second attempt:
```
stage_executing { stage: "persisting" }
(executor returns status=error; ctx.retryCounts.persisting == 0
 before increment, guard passes)
stage_retry { stage: "persisting", backToStage: "genSkeleton",
              retryIdx: 0, maxRetries: 1, errorMessage: "..." }
(runner clears portValues/finalizedStages for genSkeleton,
 genPrompts, refinePrompts, persisting; increments
 ctx.retryCounts.persisting to 1; sends RESET_STAGE genSkeleton)
stage_executing { stage: "genSkeleton" }
...
stage_executing { stage: "persisting" }
stage_done { stage: "persisting" }
run_final { finalState: "completed", stageErrors: [] }
```

Retry exhaustion (maxRetries=1, two failures):
```
stage_executing { stage: "persisting" }
(first failure; ctx.retryCounts.persisting == 0 < 1, retry fires)
stage_retry { stage: "persisting", retryIdx: 0, maxRetries: 1, ... }
stage_executing { stage: "genSkeleton" }
...
stage_executing { stage: "persisting" }
(second failure; ctx.retryCounts.persisting == 1 ≥ 1, guard fails,
 fallback transition to error)
stage_error { stage: "persisting", reason: "executor_failed", ... }
run_final { finalState: "failed", stageErrors: [...] }
```

### 6.3 Dashboard UI

Unchanged. `stage_retry` events are dropped by the existing unknown-
event handler. Future UX can render a retry badge.

### 6.4 Semantic deviations from legacy

1. **Parallel-block siblings not rerun on retry**: legacy
   `back_to: <blockName>` meant "rerun the entire block". Here, retry
   reruns only the redirected stage (the block's first inner). Siblings
   that were already `done` keep their outputs. Safe for
   pipeline-generator (genSkeleton and genPrompts both read
   pipelineDesign, not each other) but users composing parallel blocks
   with cross-sibling reads need to understand this. Documented in
   `RETRY_BACK_TO_REDIRECTED` warning context.
2. **human_confirm approve target for non-parallel-following case**:
   a human_confirm followed by `stageA; stageB` activates only
   `stageA` via gate authorization. `stageB` joins by natural wire
   delivery. Matches legacy behavior.

### 6.5 Runner logs

On RETRY_TO_STAGE: structured log entry via existing taskLogger with
fields `{ stage, backToStage, attemptIdx, maxRetries, errorMessage }`
for postmortem debugging.

## 7. File Impact Summary

### New files

- `apps/server/src/kernel-next/converter/unwrap-parallel-blocks.ts`
  + `.test.ts`
- `apps/server/src/kernel-next/converter/map-human-confirm-gates.ts`
  + `.test.ts`
- `apps/server/src/kernel-next/converter/rewrite-retry-back-to.ts`
  + `.test.ts`

### Modified files

- `apps/server/src/kernel-next/ir/schema.ts` — new subAgents, retry
  fields; routes union.
- `apps/server/src/kernel-next/ir/canonical.ts` — canonicalize new
  fields; preserve routes input shape.
- `apps/server/src/kernel-next/converter/legacy-yaml.ts` — wire the
  three new passes into the pipeline.
- `apps/server/src/kernel-next/converter/map-stages.ts` — extract
  subAgents and retry; remove four obsolete UNSUPPORTED_FEATURE
  branches (parallel, human_confirm, retry.back_to, runtime.agents).
- `apps/server/src/kernel-next/converter/types.ts` — add new
  diagnostic codes.
- `apps/server/src/kernel-next/compiler/ir-to-machine.ts` — retry
  transition on ScriptStage; array handling on gate routing.
- `apps/server/src/kernel-next/runtime/runner.ts` — RETRY_TO_STAGE
  handler; GATE_ANSWERED multi-target handling; stage_retry publish.
- `apps/server/src/kernel-next/runtime/real-executor.ts` — subAgents
  pass-through into SDK options.
- `apps/server/src/kernel-next/sse/types.ts` — add `stage_retry`
  event type.
- Tests alongside each modified file.

### Unchanged (intentional)

- `apps/web/src/app/kernel-next/[taskId]/page.tsx` — UI not in scope.
- `apps/server/src/kernel-next/mcp/*` — no MCP surface changes.
- `apps/server/src/kernel-next/validator/*` — schema-level changes
  cover widened routing; no structural validator update needed.
- `apps/server/src/routes/kernel-run.ts` — pipeline-generator
  registered via `registerLegacyPipeline` helper one-liner.

Approximate diff: ~1,200 LOC new (including tests), ~200 LOC
modifications.

## 8. Step Sequence

Three independently shippable slices, each leaves the tree green.

### Slice A — parallel unwrap + human_confirm → gate + back_to redirect

Scope: all changes in converter plus `GateRoutingSchema` widening and
canonical input-preserving serialization plus ir-to-machine and runner
gate-array handling.

State after slice:
- pipeline-generator.yaml converts with zero fatal diagnostics.
- Running it via kernel-next exercises the gate (human answer needed)
  and kicks the two parallel stages off.
- genPrompts runs the main agent only — its sub-agent is ignored.
- persisting failure goes to `stage_error` with no retry.

Commits (estimated):
1. `feat(converter): unwrap parallel blocks + diagnostics`
2. `feat(converter): human_confirm → gate + multi-target approve`
3. `feat(ir): widen gate routing to string | string[], runtime normalize`
4. `feat(converter): rewriteRetryBackTo + legacy-yaml integration`

### Slice D — AgentStage.config.subAgents + RealStageExecutor pass-through

State after slice:
- IR carries sub-agent definitions.
- RealStageExecutor passes them to Claude SDK.
- Manual real-SDK E2E: run pipeline-generator end-to-end up to (but
  not including) persisting failure to confirm sub-agent is invoked.

Prerequisite: resolve §9 R5 (SDK sub-agent `disallowedTools`
semantics).

Commits:
1. `feat(ir): AgentStage.config.subAgents + canonical`
2. `feat(converter): extract runtime.agents to subAgents`
3. `feat(executor): thread subAgents to SDK options.agents`

### Slice C — ScriptStage.config.retry + runner retry loop

State after slice:
- ScriptStage with retry compiles to retry-enabled machine.
- Runner handles RETRY_TO_STAGE end-to-end.
- pipeline-generator: persisting failure reruns genSkeleton
  automatically.
- Manual E2E with induced persisting failure confirms closed loop.

Commits:
1. `feat(ir): ScriptStage.config.retry + canonical`
2. `feat(converter): extract runtime.retry + rewrite back_to to stage`
3. `feat(machine): retry transition on ScriptStage STAGE_FAILED`
4. `feat(runner): RETRY_TO_STAGE handler + stage_retry SSE`
5. `feat(sse): stage_retry event type`

Each slice completes with full test suite green. E2E happens after
Slice D (without retry) and after Slice C (with retry).

## 9. Risks and Open Questions

### 9.1 Known risks

- **R1 (high)**: runner's topo-downstream computation for
  RETRY_TO_STAGE must handle fanout stages correctly. pipeline-
  generator has no fanout, but kernel-next supports it. Mitigation:
  the algorithm only walks `ir.wires`; fanout is a runtime property
  of a single stage (not a DAG edge). Add a test case with a fanout
  stage in the downstream set to confirm.
- **R2 (medium)**: Claude SDK `options.agents` behavior in the SDK
  version used by kernel-next may differ from the legacy SDK pathway.
  Mitigation: Slice D includes a real-SDK sanity run before marking
  complete.
- **R3 (medium)**: XState v5 parent machine's `onDone` condition on
  all parallel regions being done — must re-evaluate to false when a
  region goes from done back to waiting via RESET_STAGE. Mitigation:
  dedicated xstate actor test in Slice C.
- **R4 (low)**: widening `routes` to `string | string[]` and keeping
  single-string canonical form relies on existing fixtures never
  mixing types within the same pipeline. Mitigation: canonical test
  with both shapes present verifies correctness.

### 9.2 Open questions (require investigation)

- **R5 (high, blocker for Slice D)**: how does the Claude Agent SDK
  treat sub-agent `disallowedTools` — inherited from parent agent or
  independent? If independent, `runtime.agents.<name>.disallowed_tools`
  (not currently captured by the converter) must be threaded through.
  Action: inspect `@anthropic-ai/claude-agent-sdk` typings and run a
  smoke experiment before starting Slice D.

### 9.3 Closed decisions

- D scope: retry.back_to + sub-agents both in, foreach deferred.
- retry semantics: redirect back_to to the first inner stage of the
  target parallel block, do not rerun siblings.
- sub-agent handling: extend IR, not a prompt-text hack.
- parallel-name resolution: `unwrapParallelBlocks` + `blockMap` +
  `rewriteRetryBackTo` do the redirect automatically; user never
  needs to modify legacy YAML.
- gate routing: legacy `approve` (single stage) stays single; parallel
  block following human_confirm widens to array via `mapHumanConfirm
  Gates`.
- retry field owner: ScriptStage.config.retry only; agents not eligible.
- foreach, dashboard UI, MCP surface changes: deferred.

### 9.4 Deferred explicitly

- foreach stage support (needs parent pipeline YAML + potentially
  sub-pipeline IR concept).
- dashboard rendering of stage_retry events.
- pipeline-generator prompt updates to emit multi-target gate routing.
- runtime type validation of seedValues against externalInputs.

## 10. Acceptance Checklist

- [ ] `convertLegacyYaml(pipelineGeneratorYaml)` returns ok: true with
      expected warnings and zero fatal diagnostics.
- [ ] Automated test: pipeline-generator converts + runs to completion
      under MockExecutor including one gate answer and one induced
      persisting failure + retry.
- [ ] Manual E2E against real Claude SDK (Slice D + Slice C): pipeline-
      generator runs from analyzing to persisting end-to-end, verifying
      sub-agent invocation and retry loop.
- [ ] All 4132+ existing tests stay green.
- [ ] No regression in canonical hash baselines.
- [ ] tsc --noEmit clean across apps/server and apps/web.
- [ ] CLAUDE.md hard invariants preserved (Task.pipelineSnapshot,
      stage reads/writes as only data flow, store writes final per
      stage, pipeline version hash).
