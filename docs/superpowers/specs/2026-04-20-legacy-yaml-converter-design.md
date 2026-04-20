# Legacy YAML → kernel-next IR Converter + externalInputs Schema Extension

Status: Draft
Date: 2026-04-20
Owner: kernel-next

## 1. Goal and Non-Goals

### Goal

Allow legacy builtin pipelines (YAML under `apps/server/src/builtin-pipelines/`)
to be consumed by kernel-next runtime without hand-porting each one to a
TypeScript IR factory like `smokeTestIR()`.

Two deliverables, independently shippable:

1. **Schema extension** — Add first-class `externalInputs` to `PipelineIR`
   so a pipeline can declare ports supplied at runtime (replacing legacy
   `injected_context`). Wire sources become a discriminated union:
   `{ source: "stage" | "external" }`.

2. **Converter** — A pure function
   `convertLegacyYaml(yamlText, opts?) → ConversionResult`
   that produces a `PipelineIR` (plus prompt-root path) from a legacy
   YAML file of the complexity covered by `smoke-test` and
   `tech-research-collector`.

### Non-goals

- **Not** a general converter. `parallel`, `human_confirm`, `foreach`,
  `script` with retry, sub-agents, `mcps`, `thinking`, `interactive`,
  `effort`, `compensation`, fragments, hooks, skills are **out of
  scope**. Any legacy YAML using these emits a `UNSUPPORTED_FEATURE`
  diagnostic and conversion fails.
- **Not** a runtime loader. The converter returns IR; wiring into
  `POST /api/kernel/tasks/run` is a separate commit within the same
  milestone but has its own spec section.
- **Not** a promotion of `effort`/`max_turns`/`max_budget_usd` to
  kernel-next config. These become `warning` entries in the conversion
  result. The HTTP route already accepts body overrides for
  `model/maxTurns/maxBudgetUsd`; callers set them there.
- **Not** a dashboard change. Rendering `__external__` as a distinct
  "Seed" band is tracked as a known-limitation under §1.4 of the A7
  handoff, not this spec.

## 2. Acceptance Criteria

1. `smoke-test` legacy YAML, run through the converter, produces an IR
   whose canonical hash equals the hand-written `smokeTestIR()`.
2. `tech-research-collector` legacy YAML converts successfully and can
   be executed via `POST /api/kernel/tasks/run` with a seedValues body,
   reaching `run_final = completed` in the browser dashboard against
   the real Claude SDK.
3. All existing tests pass. No regression in `smokeTestIR()`-backed
   smoke-test end-to-end run.
4. `npx tsc --noEmit` clean. No weakening of existing adversarial
   tests.

## 3. Architecture

```
┌───────────────────────────────────────────────────────────┐
│ convertLegacyYaml(yamlText, opts?) : ConversionResult     │
│                                                            │
│  parseYaml ─┐                                              │
│             ├─ mapStoreSchemaToPorts ─┐                    │
│             │                          │                   │
│             ├─ mapStagesToIR ──────────┤                   │
│             │                          ├─ assembleIR       │
│             ├─ mapReadsToWires ────────┤                   │
│             │                          │                   │
│             └─ mapInjectedContext ─────┘                   │
│                                                            │
│  → { ok: true, ir, promptRoot, warnings }                  │
│  → { ok: false, diagnostics }                              │
└───────────────────────────────────────────────────────────┘

                      │
                      ▼

┌───────────────────────────────────────────────────────────┐
│ PipelineIR (extended)                                     │
│                                                            │
│  name, stages[], wires[], entry?,                          │
│  externalInputs: PortIR[]                                  │
│                                                            │
│  WireIR.from: { source: "stage" | "external", ...}        │
└───────────────────────────────────────────────────────────┘

                      │
                      ▼

┌───────────────────────────────────────────────────────────┐
│ Runtime                                                    │
│                                                            │
│  RunnerOptions.seedValues?: Record<string, unknown>        │
│                                                            │
│  Startup:                                                  │
│   1. Validate seedValues keys == externalInputs names     │
│   2. Insert stage_attempts row: kind="external",           │
│                                  status="success"          │
│   3. For each seed: writePort(__external__, portName, v)  │
│   4. Seed portValues in actor context:                    │
│        __external__.<portName> → value                    │
│                                                            │
│  Stages read via read_port(__external__, portName) —       │
│  lineage works out of the box.                             │
└───────────────────────────────────────────────────────────┘
```

## 4. Schema Extension Detail

### 4.1 `PipelineIRSchema`

```ts
externalInputs: z.array(PortIRSchema).default([]),
```

Existing fields unchanged. `default([])` makes this backward-compatible
with every existing IR fixture (`diamondIR`, `smokeTestIR`, etc.).

### 4.2 `WireIRSchema.from`

```ts
const WireSourceSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("stage"),
    stage: identifier,
    port: identifier,
  }),
  z.object({
    source: z.literal("external"),
    port: identifier,
  }),
]);
```

**Backward-compat transform**: at parse time, a `from` object lacking
`source` is treated as `source: "stage"`. Implementation approach:
`z.preprocess(normalizeWireFrom, WireIRSchema)` where `normalizeWireFrom`
injects `source: "stage"` into any legacy-shaped `from` before the
discriminated union runs. Keeps the discriminated union clean while
zero-cost for already-tagged inputs. All existing test fixtures and
hand-written IR continue to parse without modification.

### 4.3 New diagnostic codes

Added to kernel-next `DiagnosticSchema` enum (ir/schema.ts):

- `WIRE_EXTERNAL_SOURCE_PORT_MISSING` — wire `from.source="external"`
  references an external port not declared in `externalInputs`.
- `DUPLICATE_EXTERNAL_INPUT_NAME` — same name listed twice in
  `externalInputs`.
- `EXTERNAL_INPUT_COLLIDES_WITH_STAGE` — external port name equals a
  stage name, forbidden to avoid ambiguity in lineage UI. Note:
  external port names CAN coincide with any stage's output port name
  (they live in separate namespaces: `__external__.<port>` vs
  `<stage>.<port>`). Only top-level name collision with stage names
  is forbidden.
- `RESERVED_STAGE_NAME` — any stage name or external-input name
  equals the literal `"__external__"`. See §4.15.

Runner-layer startup validation (§4.7) uses plain `Error` for fatal
failures (surfaces as `run_final.finalState="failed"` via the
existing `.catch(...)` in kernel-run.ts). These do not go through the
Diagnostic channel because they arise at runtime after a submit-time
validated IR, not during IR validation:

- `SEED_VALUES_MISSING_KEY` — Error thrown if `seedValues` lacks a key
  listed in `externalInputs`.
- `SEED_VALUES_UNEXPECTED_KEY` — logger warning (not fatal).

### 4.4 Structural validator changes

- External wires (`from.source="external"`): verify `from.port ∈
  externalInputs[].name`. Do NOT run the existing "must be an output
  port" check (external ports have no direction in the PortIR sense;
  they're a single-slot source).
- Duplicate check on `externalInputs[].name`.
- Collision check against stage names.

### 4.5 DAG validator changes

External wires do NOT contribute to `upstream[to.stage]`. A stage with
only external inputs has in-degree 0 and is a natural root in the
topological order.

### 4.6 ir-to-machine changes

- Compiler does not create any extra machine region for external
  inputs — they are pure data, not execution.
- The `allOutboundPresent` guard logic is **unchanged**. The runner
  writes external seed values into `context.portValues` before the
  actor starts, keying them as `__external__.<portName>`. This matches
  the existing `stage.port` two-segment convention.

### 4.7 Runner (`runPipeline`)

New option:

```ts
interface RunnerOptions {
  // ...existing...
  seedValues?: Record<string, unknown>;
}
```

Startup sequence (before `actor.start()`):

1. Validate `seedValues` against `ir.externalInputs`:
   - Missing key for any externalInput → throw
     `Error("SEED_VALUES_MISSING_KEY: external input '<name>' has no
     seed value")`. Surfaces as `run_final` with
     `finalState="failed"` via the existing `.catch(...)` in
     kernel-run.ts.
   - Extra keys → logger.warn, not fatal. A `SEED_VALUES_UNEXPECTED_KEY`
     entry appears in server logs with the offending key name.
   - Iteration order: `ir.externalInputs` declaration order (not
     `Object.keys(seedValues)`). This makes port_values row order
     and SSE `port_written` event order deterministic across runs,
     which matters for replay diffs.
2. Open a single `stage_attempts` row:
   - `attempt_id = att-<taskId>-__external__`
   - `stage_name = "__external__"`
   - `kind = "external"`
   - `status = "success"`
   - `started_at = ended_at = now`
3. For each external port (in declaration order): call
   `portRuntime.writePort({ attemptId, stageName: "__external__",
   portName: name, value })`. This produces normal `port_values`
   lineage rows AND (when a broadcaster is provided) fires
   `port_written` SSE events with `stage = "__external__"`.
4. Seed `context.portValues["__external__." + name] = value` for each
   port BEFORE calling `actor.start()`. Rationale: the PORT_WRITTEN
   event that writePort dispatches via the EventDispatcher (runner.ts:
   131-134) is discarded when `actor === null`. The actor is not
   created until after this bootstrap phase, so the explicit seed in
   step 4 is the authoritative source; step 3 is purely lineage
   persistence + SSE, not state propagation. Step 3 and step 4
   therefore each have a single, non-overlapping purpose.

### 4.8 `AttemptKind` extension

```ts
export type AttemptKind =
  | "regular"
  | "fanout_element"
  | "fanout_aggregate"
  | "external";       // new
```

SQLite CHECK constraint on `stage_attempts.kind` extended accordingly.
Migration note: this is an additive CHECK change; existing rows are
unaffected. Since the dev/local DB is wiped between runs, no migration
script is written — the schema is recreated from `initKernelNextSchema`.

### 4.9 Codegen

- `export namespace __external__ { ... }` emitted for the external
  port bag.
- Each external port becomes a typed property.
- Legacy `injected_context` lacks type annotations; converter emits
  `type: "unknown"` for every external port AND a
  `INJECTED_CONTEXT_UNTYPED` warning per port.

### 4.10 MCP surface

- `read_port`: accepts `stage = "__external__"` as a valid source.
  Reads go against the same `port_values` table via the `external`
  attempt row seeded at runner startup. No new code path — the
  existing read path works because the attempt row exists.
- `query_lineage`: already driven by `port_values` rows, so external
  inputs appear as a root node with `stage = "__external__"` without
  any lineage-module changes. Visual polish (distinct node style) is
  dashboard work, out of scope.

### 4.11 SSE

- `port_written` events fire for external ports with
  `data.stage = "__external__"`. Dashboard will render them as stage
  rows with that literal name — ugly but correct. Distinct "Seed"
  styling is tracked in §1.4 follow-ups.
- `stage_executing` / `stage_done` are NOT emitted for
  `__external__`. Runner treats external-port seeding as a synchronous
  pre-start phase, not a stage execution.

### 4.12 Canonical form (canonical.ts)

This section is a **blocker must-do for Step 1**. Without it,
versionHash collides or mutates incorrectly.

Changes:

1. `canonicalizeIR` must serialize `externalInputs` as a sorted
   (by name) array of port-objects ({name, type, zod?}). Addition is
   placed alongside `stages` and `wires` in the top-level object.
   `default([])` handling: when `ir.externalInputs.length === 0`, the
   key is omitted (preserves versionHash of every pre-existing IR
   fixture — see §8.1 backward-compat assertion).
2. `canonicalizeWire` must serialize `from` according to the
   discriminated-union tag:
   - `source: "stage"` → `{ stage, port }` WITHOUT the `source` tag
     (preserves legacy hash for fixtures that never had `source`).
   - `source: "external"` → `{ source: "external", port }` (no
     `stage`). The `source` tag IS serialized here; absence of it
     unambiguously means "stage".
3. Wire sort key (currently `to.stage.to.port`) unchanged — targets
   are still stage-scoped, so uniqueness still holds.

**Invariant**: for any IR that does not declare `externalInputs` and
whose wires all have `source: "stage"` (or no `source` at all via
backward-compat transform), `canonicalizeIR` output is byte-identical
to the pre-change output. §8.1 asserts this against fixtures:
`diamondIR()`, `smokeTestIR()`, and one multi-stage gate IR from the
existing test suite.

### 4.13 Codegen (emit-ts.ts)

This section is a **blocker must-do for Step 1**.

Changes:

1. Emit `export namespace __external__` alongside `Stages`, containing
   an `Outputs` type for each external port. External ports have no
   `Inputs` (they are one-directional sources). Shape:
   ```ts
   export namespace __external__ {
     export interface Outputs {
       "<portName>": <type>;
       ...
     }
   }
   ```
2. Wire assertions for `source: "external"` wires use
   `__external__.Outputs["<port>"]` on the RHS instead of
   `Stages.<stage>.Outputs["<port>"]`. LHS unchanged.
3. Wire identifier builder (`wireIdentifier`) accepts
   `__external__` as a valid stage identifier — no regex change
   needed because the function is just string concat; but a test
   asserts a wire from `__external__.x` to `B.y` produces a unique
   identifier.
4. Fanout branch logic (`fromIsFanout` / `toIsFanout` lookup in
   `ir.stages.find`): skip fanout wrap when
   `source === "external"`. External sources never fan out.

### 4.14 Persistence (sql.ts wires table)

**No schema change required.** The wires table `from_stage` is a
plain TEXT column with no FK (design §3.2 notes SQLite FKs can't
reference literal columns). External wires store `from_stage =
"__external__"` and `from_port = <portName>`. The PK
`(version_hash, to_stage, to_port)` is unaffected since uniqueness
still holds per target port.

`insertPipelineVersion` iterates `ir.wires` and writes one row per
wire. For `source: "external"` wires, the code path is:
```ts
wiresInsert.run(
  versionHash,
  w.from.source === "external" ? "__external__" : w.from.stage,
  w.from.port,
  w.to.stage,
  w.to.port,
);
```

### 4.15 Reserved stage name

`__external__` is a sentinel literal, not a user-declarable stage or
external-port name. `validateStructural` emits `RESERVED_STAGE_NAME`
when:
- any `ir.stages[].name === "__external__"`, or
- any `ir.externalInputs[].name === "__external__"`.

Added to §4.3 diagnostic code list as `RESERVED_STAGE_NAME`.

### 4.16 Impact on existing SELECT queries

`AttemptKind = "external"` introduces one permanent successful
`stage_attempts` row per task whose `stage_name = "__external__"`.
The following queries aggregate over `stage_attempts` and must be
audited:

- `runner.ts:438-448` — errorRow COUNT: filters on
  `status = "error"`, so `__external__` (status=success) never
  contributes. **Safe, no change.**
- `kernel.ts` `getTaskStatus` / `query_lineage` / `migrate_task`:
  return per-stage aggregates. These will include `__external__` as
  a successful stage. For lineage this is **desirable** (users want
  to see the seed as a lineage root). For status summary
  ("N stages complete") it slightly shifts the count.
- **Decision**: do not add `WHERE kind != 'external'` filters.
  `__external__` is a real lineage node — treating it as a stage in
  aggregates is the most consistent story. Tests for getTaskStatus
  that assert stage counts get updated to include the +1.

Files to grep-audit during Step 1: `SELECT.*FROM stage_attempts` in
`apps/server/src/kernel-next/**`.

### 4.17 MCP write_port guard against sentinel

MCP tool `write_port` rejects calls with `stage = "__external__"` —
this sentinel is reserved for runner-initiated seeds only. Agents
must not write to it at runtime; doing so would pollute lineage with
non-seed external-port rows. Diagnostic: `Error("write_port: stage
'__external__' is reserved for seed values")`. Unit test added
against MCP server.

## 5. Converter Detail

### 5.1 Entry point

```ts
export interface ConvertOptions {
  /** Absolute path of the YAML file on disk, if known. When provided,
   *  ConversionResult.promptRoot is derived from it (`<dir>/prompts`).
   *  When undefined, promptRoot is undefined in the result and callers
   *  must supply the PromptResolver themselves. */
  yamlFilePath?: string;
}

export type ConversionResult =
  | { ok: true;  ir: PipelineIR; promptRoot?: string; warnings: Warning[] }
  | { ok: false; diagnostics: Diagnostic[] };

export interface Warning {
  code:
    | "LEGACY_TYPE_DOWNGRADED"           // markdown → string, object → Record, ...
    | "INJECTED_CONTEXT_UNTYPED"         // injected_context has no type info
    | "LEGACY_FIELD_IGNORED"             // effort/max_turns/max_budget_usd/thinking
    | "DISPLAY_FIELDS_IGNORED"           // display: block ignored
    | "USE_CASES_IGNORED";
  message: string;
  context?: Record<string, unknown>;
}

export function convertLegacyYaml(
  yamlText: string,
  opts?: ConvertOptions,
): ConversionResult;
```

Converter diagnostics are structurally identical to kernel-next
`Diagnostic` (`{ code, message, context? }`) but use a **distinct
code enum** rather than extending `DiagnosticSchema`. Rationale:
`DiagnosticSchema` is the submit-pipeline error vocabulary; converter
errors arise earlier (before a candidate IR exists). Keeping them
separate avoids polluting the submit-path surface with conversion-only
codes. A converter `Diagnostic`'s shape: `{ code: ConverterErrorCode,
message: string, context?: Record<string, unknown> }`.

Converter-specific codes:

- `YAML_PARSE_ERROR`
- `LEGACY_SCHEMA_INVALID` — input doesn't match the legacy zod
  `PipelineConfigSchema` from `lib/config/schema.ts`.
- `UNSUPPORTED_FEATURE` — stage uses `parallel | human_confirm |
  foreach | fanout | sub-agents | mcps | retry.back_to | compensation`,
  or stage `type` is not `agent` or `script`.
- `UNSUPPORTED_FIELD_TYPE` — `store_schema.<entry>.fields.<f>.type` is
  not one of: `string`, `string[]`, `number`, `boolean`, `markdown`,
  `object`, `object[]`.
- `STORE_ENTRY_PRODUCER_MISSING` — `store_schema.<e>.produced_by`
  names a stage not in `stages[]`.
- `STAGE_READS_UNKNOWN_KEY` — `runtime.reads.<local>: <key>` references
  a key not in `store_schema` and not in `injected_context`.

### 5.2 Internal pipeline (pure functions, each independently tested)

```
parseYaml(text) : LegacyPipelineConfig          // YAML.parse + legacy zod
mapStoreSchemaToPorts(legacy) : {
  stageOutputs: Map<stageName, PortIR[]>,
  entryDirectory: Map<storeKey, { producerStage, fields }>,
}
mapInjectedContext(legacy) : {
  externalInputs: PortIR[],
  externalKeys: Set<string>,
}
mapStagesToIR(legacy, stageOutputs, externalKeys) : StageIR[]
mapReadsToWires(legacy, stageOutputs, externalKeys) : WireIR[]
assembleIR(name, stages, wires, externalInputs) : PipelineIR
```

Note: `assembleIR` does NOT set `ir.entry`. Kernel-next's `entry`
field is optional and currently unused by the compiler (runner uses
DAG-derived topology). Setting it via the converter would couple the
converter to a not-yet-stable semantic and would change canonical
hash. Leave undefined.

### 5.3 `store_schema` → port mapping

Rule: **one port per declared field**. Matches the hand-port in
`smoke-test.ts` verbatim.

Legacy type → kernel-next port `type` (TS type source):

| Legacy `type`    | kernel-next `type` string | Warning?             |
|------------------|---------------------------|----------------------|
| `string`         | `"string"`                | —                    |
| `string[]`       | `"string[]"`              | —                    |
| `number`         | `"number"`                | —                    |
| `boolean`        | `"boolean"`               | —                    |
| `markdown`       | `"string"`                | `LEGACY_TYPE_DOWNGRADED` (no markdown primitive in kernel-next) |
| `object`         | `"Record<string, unknown>"` | `LEGACY_TYPE_DOWNGRADED` |
| `object[]`       | `"Record<string, unknown>[]"` | `LEGACY_TYPE_DOWNGRADED` |
| anything else    | fatal `UNSUPPORTED_FIELD_TYPE` | —                |

Port name = field key. `required: true/false` is not represented in
kernel-next PortIR — presence/absence is governed by `allOutboundPresent`
which requires every declared output to be written. Warning is NOT
emitted here; this is a known semantic difference and documented in
spec §6.

### 5.4 `injected_context` → `externalInputs`

Each entry in `injected_context: string[]` becomes one external port:

```ts
{ name: entry, type: "unknown" }   // plus INJECTED_CONTEXT_UNTYPED warning
```

Name validation: each entry must satisfy the kernel-next `identifier`
regex (`^[a-zA-Z_][a-zA-Z0-9_]*$`, non-TS-reserved). Legacy YAML in
practice uses camelCase (`pipelineConfig`, `projectContext`) which is
compliant. Non-compliant names (kebab-case, dots, hyphens) → fatal
converter diagnostic `INJECTED_CONTEXT_NAME_INVALID`. Rationale:
codegen emits `__external__.Outputs["<name>"]` — non-identifier names
would still be valid TS property keys inside quotes, but they'd be
unreadable and would break any `w.from.port` downstream that assumes
identifier shape.

Duplicate detection: same entry listed twice → fatal
`DUPLICATE_EXTERNAL_INPUT_NAME` (reusing the kernel-next schema
diagnostic since converter output IR would fail validation anyway).
Collision with a `store_schema.<entry>` top-level key → fatal
`EXTERNAL_INPUT_COLLIDES_WITH_STAGE` (same stage/external collision
constraint from §4.3, checked at converter level for faster feedback).

### 5.5 Stages

Only `type: agent` and `type: script` pass. Everything else (parallel
block, human_confirm, foreach, script with `retry.back_to`,
compensation) fails with `UNSUPPORTED_FEATURE`.

For `type: agent`:
- `config.promptRef = runtime.system_prompt` (file-relative path
  without `.md` — matches `FsPromptResolver` convention).
- `inputs` = ports derived from `runtime.reads` target entries'
  fields. For each local key → legacy entry, every declared field of
  the entry becomes an input port on this stage (same name as field).
- `outputs` = ports from `store_schema.<e>.fields` where `<e>` is the
  entry with `produced_by == stage.name`.
- `effort`, `max_turns`, `max_budget_usd`, `thinking`, `interactive`,
  `mcps` → `LEGACY_FIELD_IGNORED` warning each.
- `runtime.engine: "llm"` — silently ignored (mandatory marker in
  legacy, implicit in kernel-next agent stages). Any other
  `runtime.*` field not enumerated here (e.g. a future legacy
  addition) → `LEGACY_FIELD_IGNORED` with the full path in context.

For `type: script`:
- `config.moduleId = runtime.script_id`.
- Same `inputs` derivation from reads.
- `outputs` from `store_schema`.
- `retry.back_to`, `args`, `timeout_sec`, `compensation` →
  `LEGACY_FIELD_IGNORED` or `UNSUPPORTED_FEATURE` depending on
  severity (back_to is unsupported, args/timeout are ignored).

### 5.6 Wires from `runtime.reads`

For each stage with `reads: Record<localKey, sourceKey>`:

```
sourceKey ∈ injected_context?
  → one wire per declared external port (field-less):
      { from: { source: "external", port: sourceKey }, to: { stage, port: sourceKey } }
  → stage MUST declare input port named `sourceKey` (type "unknown")

sourceKey ∈ store_schema?
  → resolve to { producer: entry.produced_by, fields: entry.fields }
  → for each field:
      { from: { source: "stage", stage: producer, port: field },
        to:   { stage, port: field } }
  → stage MUST declare input port per field (already handled in 5.5)

sourceKey ∈ neither
  → diagnostic STAGE_READS_UNKNOWN_KEY
```

The `localKey` in legacy `reads` is **ignored** — kernel-next agent
prompts receive a port-bag keyed by port name, and the legacy rename
is a YAML convenience with no kernel-next equivalent. Warning is not
emitted since this is a consistent, documented loss.

### 5.7 Fields completely ignored

- `display.title_path`, `display.completion_summary_path` — emit
  `DISPLAY_FIELDS_IGNORED` warning.
- `use_cases` — `USE_CASES_IGNORED` warning.
- `official`, `description`, `engine` — no warning (pipeline-level
  metadata that kernel-next simply doesn't track).
- `claude_md` — `UNSUPPORTED_FEATURE` diagnostic. Rationale: silently
  dropping global constraint files would let a tech-research-writer
  pipeline run without its stated quality rules. Forced opt-in.

## 6. Semantic Differences (Documented, Not Warnings)

These differ between legacy and kernel-next but are not flagged per
conversion — they are structural:

1. **`required: false`**: legacy lets a field be optionally written;
   kernel-next requires every declared output port to be written for
   the stage to complete. Converter preserves the port regardless —
   the producing stage now MUST write it, or it hangs in
   `allOutboundPresent`. This is a **behaviour change by design**
   documented here; users notice only if their YAML relied on
   optional-field semantics.
2. **`writes` declarations (legacy)**: converter does not read the
   legacy `writes` field. kernel-next output ports come from
   `store_schema`. This is consistent with how `smoke-test.ts` was
   hand-ported.
3. **`reads` local rename**: see §5.6.

## 7. HTTP Route Integration

`POST /api/kernel/tasks/run` body schema extension:

```ts
{
  pipeline: string,
  taskId?: string,
  model?: string,
  maxTurns?: number,
  maxBudgetUsd?: number,
  seedValues?: Record<string, unknown>,      // NEW
}
```

`pipelineRegistry` gains a `"tech-research-collector"` entry that:

1. Reads the legacy YAML from
   `apps/server/src/builtin-pipelines/tech-research-collector/pipeline.yaml`.
2. Runs `convertLegacyYaml(yamlText, { yamlFilePath })`.
3. Uses the returned `ir` + `promptRoot` to build
   `RealStageExecutor` with `FsPromptResolver`.
4. Propagates `seedValues` from body to `runPipeline(opts)`.

HTTP error surface: a missing or malformed `seedValues` body key
against a pipeline that requires external inputs results in the same
async failure path as other runtime errors. The POST still returns
202 immediately; the failure appears only via the SSE `run_final`
event with `finalState="failed"`. This is consistent with the
existing diamond-real path and does not special-case seed validation
into the request handler.

The `smoke-test` entry is **not** re-pointed to the converter in this
milestone. It stays on the hand-written `smokeTestIR()` so acceptance
criterion #1 (canonical-hash equivalence test) remains testable
directly against the hand-written reference.

## 8. Testing Strategy

### 8.1 Unit — schema

- `PipelineIRSchema` accepts externalInputs + wire with
  `source:"external"`.
- Backward-compat: existing IR fixtures (no `source` on wires, no
  `externalInputs`) parse unchanged.
- **Canonical hash backward-compat**: assert `versionHash(diamondIR())`,
  `versionHash(smokeTestIR())`, and `versionHash(<one-gate-IR-fixture>)`
  each equal the literal sha256 value captured before any Step 1
  schema / canonical changes. This is the Step 1 no-regression
  guardrail — if even one shifts, `pipeline_versions` and dependent
  migrate-task / propose_pipeline_change tests break.
- Structural validator: negative test for each new diagnostic code:
  `WIRE_EXTERNAL_SOURCE_PORT_MISSING`,
  `DUPLICATE_EXTERNAL_INPUT_NAME`,
  `EXTERNAL_INPUT_COLLIDES_WITH_STAGE`,
  `RESERVED_STAGE_NAME`.
- DAG validator: external-only driven stage has in-degree 0
  (specifically the single-stage tech-research-collector shape).
- Regression (adversarial): run the full kernel-next adversarial
  suite (`structural.test.ts`, `a2-3-5-live-migration.adversarial.test.ts`,
  any `*.adversarial.test.ts` under kernel-next/) and assert 0
  failures. Do not weaken any existing assertion to make new tests
  pass (CLAUDE.md invariant).

### 8.2 Unit — runner

- `runPipeline` with externalInputs + seedValues opens `kind="external"`
  attempt, writes port_values rows, seeds `context.portValues`.
- Missing seedValues key → rejected promise / failed RunResult.
- Extra seedValues key → warning, not fatal.
- SSE `port_written` events for external ports have stage=`__external__`.
- Event ordering: SSE `port_written` for externalInputs fires in
  `ir.externalInputs` declaration order (not seedValues key-insertion
  order). Assert by declaring externalInputs [b, a] and seedValues
  { a, b }; observe port_written(b) before port_written(a).
- MCP `write_port` with `stage="__external__"` rejected with the
  reserved-sentinel error (§4.17).
- MCP `read_port` with `stage="__external__"` + an external port name
  returns the seeded value after seed phase runs (proves the
  kind="external" attempt row makes read_port work without code
  change).

### 8.3 Unit — converter

Per internal function (§5.2), a describe block with positive + negative
cases. Notable:

- `mapStoreSchemaToPorts`: all legacy type mappings (string, string[],
  number, boolean, markdown, object, object[], unsupported fatal),
  missing `produced_by`, duplicate entries.
- `mapInjectedContext`:
  - every key becomes unknown-typed external port,
  - non-identifier name → `INJECTED_CONTEXT_NAME_INVALID`,
  - duplicate entry → `DUPLICATE_EXTERNAL_INPUT_NAME`,
  - key collision with `store_schema.<entry>` → fatal.
- `mapReadsToWires`: reads pointing at store key, at injected context,
  at unknown key (STAGE_READS_UNKNOWN_KEY).
- `assembleIR`: golden test —
  `convertLegacyYaml(readFileSync(smoke-test/pipeline.yaml))` produces
  IR whose `versionHash()` equals `versionHash(smokeTestIR())`. This
  is the acceptance #1 assertion, implemented as a unit test not a
  manual check.

### 8.4 Integration

- `convertLegacyYaml(techResearchCollectorYamlText)` returns ok.
- Browser-verified end-to-end: POST with seedValues, observe SSE events
  + run_final=completed. Matches A7's smoke-test verification pattern
  (taskId screenshot attached to handoff).

### 8.5 Regression

Pre-existing:
- All kernel-next tests pass (4062 count at start of this work).
- smoke-test browser run still green against hand-written IR.
- `diamond`, `diamond-slow`, `diamond-real` unchanged.

## 9. Step Sequence (Independently Shippable)

1. **Step 1 — Schema + validator + runner (no converter yet)**. Add
   `externalInputs`, discriminated wire source, backward-compat
   transform, structural+DAG diagnostics, runner seedValues path,
   SSE, MCP read_port, AttemptKind="external", sql CHECK.
   Tests: 8.1 + 8.2. Ship.

2. **Step 2 — Converter (no integration yet)**. Pure-function
   conversion, all internal mappers, canonical-hash golden test
   against `smokeTestIR()`, tech-research-collector parses clean.
   Tests: 8.3 + 8.4's non-browser slice. Ship.

3. **Step 3 — HTTP integration**. Add `tech-research-collector`
   pipelineRegistry entry, body.seedValues plumbing. Browser-verify.
   Ship.

Each step is green independently. No intermediate broken state.

## 10. Risks and Open Questions

### 10.1 Known risks

- **R1. Hidden legacy YAML feature** in tech-research-collector we
  haven't enumerated. Mitigation: Step 2 surfaces UNSUPPORTED_FEATURE
  early; Step 3 only runs if Step 2 returns ok. No runtime surprise.
- **R2. seedValues type mismatch** against the external port's typed
  namespace at codegen time. Since all injected_context ports are
  `unknown`, tsc won't object — but this means no type safety on
  seedValues. Acceptable for legacy porting; future pipelines should
  declare externalInputs with real types.
- **R3. Dashboard visual regression** — `__external__` renders as a
  stage row. Acceptable (read §1 non-goals) and tracked separately.

### 10.2 Closed decisions (from brainstorm)

- Scope: smoke-test level (not parallel / gate / fanout).
- injected_context: first-class externalInputs schema change.
- API: pure function `convertLegacyYaml(yamlText) → ConversionResult`.
- Acceptance: smoke-test canonical-hash equivalence +
  tech-research-collector browser run.
- portValues key format: `__external__.<portName>`.
- lineage: seed opens a stage_attempts row with kind="external".

### 10.3 Not decided here (deferred)

- Full YAML→IR for pipeline-generator (needs `parallel` support).
- Dashboard "Seed" band styling (§1.4 followup).
- Runtime type validation of seedValues against externalInputs shapes.

## 11. File Impact Summary

Step 1 (schema + runtime):
- `apps/server/src/kernel-next/ir/schema.ts` — externalInputs,
  WireSourceSchema with backward-compat preprocess, new diagnostic
  codes (§4.3).
- `apps/server/src/kernel-next/ir/canonical.ts` — §4.12 changes to
  canonicalizeIR + canonicalizeWire.
- `apps/server/src/kernel-next/ir/sql.ts` — AttemptKind CHECK
  extended (§4.8). wires table schema unchanged (§4.14).
- `apps/server/src/kernel-next/codegen/emit-ts.ts` — §4.13
  `__external__` namespace + wire assertion path + fanout branch
  skip for external wires.
- `apps/server/src/kernel-next/validator/structural.ts` — external
  wire + duplicate + collision + RESERVED_STAGE_NAME checks (§4.3,
  §4.15).
- `apps/server/src/kernel-next/validator/dag.ts` — skip external
  wires from upstream relation (§4.5).
- `apps/server/src/kernel-next/runtime/port-runtime.ts` —
  AttemptKind="external".
- `apps/server/src/kernel-next/runtime/runner.ts` — seedValues path
  (§4.7), seed-phase SSE hooking.
- `apps/server/src/kernel-next/mcp/server.ts` — `write_port` rejects
  `stage="__external__"` (§4.17). `read_port` needs no code change.
- `apps/server/src/kernel-next/compiler/ir-to-machine.ts` — no code
  change expected, but verify the allOutboundPresent guard logic
  works when portValues already contains `__external__.*` keys at
  actor start (should be no-op; add a test that proves it).
- Tests alongside each.

Step 2 (converter):
- `apps/server/src/kernel-next/converter/legacy-yaml.ts` — main.
- `apps/server/src/kernel-next/converter/map-store-schema.ts` —
  port mapping.
- `apps/server/src/kernel-next/converter/map-stages.ts`
- `apps/server/src/kernel-next/converter/map-wires.ts`
- `apps/server/src/kernel-next/converter/map-injected-context.ts`
- `apps/server/src/kernel-next/converter/types.ts` — Warning +
  ConversionResult + ConverterErrorCode (independent of
  DiagnosticSchema, see §5.1).
- Tests alongside each + `legacy-yaml.test.ts` (integration).

Step 3 (HTTP):
- `apps/server/src/routes/kernel-run.ts` — tech-research-collector
  registry entry, body.seedValues schema.
- `apps/server/src/routes/kernel-run.test.ts` — body schema coverage.
