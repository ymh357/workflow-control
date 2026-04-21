# Prompts in SQLite — Kernel-next Content-Addressed Prompts Design

> **Date:** 2026-04-24
> **Status:** Draft — awaiting user approval
> **Goal-tier:** Phase 1 of the "pipeline-generator outputs IR" milestone
> **Related:**
>   - `docs/kernel-next-terminal-design.md` §2.3 (prompt assembly interface), §5.2 (IR canonical hash), §8 (lineage/sidecar)
>   - `docs/product-roadmap.md` §6.2 A2 (pipeline versioning)
>   - `docs/superpowers/plans/2026-04-24-pipeline-generator-mcp-entry.md` (upstream milestone)

## 1. Goal & Success Criteria

**Goal:** Make prompts first-class kernel-next storage — content-addressed in SQLite, hashed into `versionHash` — so that a pipeline's behaviour is fully captured by `versionHash` and is replayable without relying on the filesystem state at a past point in time.

This is the prerequisite for the "pipeline-generator outputs IR" milestone: before pipeline-generator can emit an IR+prompts bundle to `submit_pipeline`, kernel-next must be able to store, retrieve, and version prompts in a first-class way.

**Success criteria:**

1. `pipeline_versions.version_hash` becomes a function of `(canonical IR, promptRef → content_hash map)` — any prompt text change produces a new `version_hash`.
2. `submit_pipeline` accepts an `{ ir, prompts }` bundle atomically; prompts are stored content-addressed and deduplicated across versions.
3. A `DbPromptResolver` implementation serves `AgentStage.config.promptRef` lookups from SQLite, replacing `FsPromptResolver` on the kernel-next execution path.
4. All currently-registered kernel-next pipelines (`smoke-test`, `tech-research-collector`, `tech-research-writer`, `pipeline-generator`) migrate their prompts into SQLite on registration and execute unchanged end-to-end on the new resolver.
5. Existing `canonical.ts` IR-only hashing remains available as `canonicalizeIR` / `versionHash(ir)`; the new pipeline-level hash is a separate function `pipelineVersionHash({ ir, prompts })`.
6. No regression in kernel-next test suite (4255+ passing as of milestone baseline).

## 2. Scope & Non-Goals

**In scope:**

- SQLite schema: `prompt_contents` + `pipeline_prompt_refs` tables.
- `canonical.ts` extension: `canonicalizePipeline`, `pipelineVersionHash`.
- `submit_pipeline` API contract extension to accept prompts.
- `DbPromptResolver` implementation.
- Kernel-next runtime wiring: `runPipeline` / `registerLegacyPipeline` / `loadLegacyPipelineIR` use `DbPromptResolver` grounded in the active task's `versionHash`.
- One-shot migration of builtin pipelines' on-disk prompts into SQLite during `registerLegacyPipeline`.
- `FsPromptResolver` deprecation path: kept alive only for tests that exercise the file-based resolver directly; production code paths switch to `DbPromptResolver`.

**Out of scope (deferred):**

- `pipeline-generator` improving the prompts it writes — this milestone only gives it a storage target. Its own pipeline.yaml + generation prompts stay as-is; just the `persistResult` script changes output.
- Removing the converter — still needed while pipeline-generator itself is a legacy YAML pipeline. This milestone keeps converter intact.
- Fragment system as a distinct entity — content-addressed prompts *enable* fragment-style sharing (same content_hash referenced by multiple versions), but no dedicated "fragment table" / namespace is introduced. The `kernel-next-terminal-design.md §2.3` fragment deferral remains.
- Hot-update `update_prompt` patch op — prompts participate in `versionHash`, so prompt changes naturally flow through the existing IR-level patch mechanism (user modifies prompt → resubmit pipeline → new version → existing `migrate_task` applies).
- GC of unreferenced `prompt_contents` rows — acceptable to accumulate; SQLite rows are cheap. Reclamation is future work if storage ever matters.

## 3. Architecture

Three layers, each with one clear responsibility.

```
┌──────────────────────────────────────────────────────────────┐
│ submit_pipeline({ ir, prompts })                             │
│   ── API boundary ──                                         │
│   1. canonicalizeIR(ir)                                      │
│   2. For each prompt: contentHash = sha256(normalize(text))  │
│   3. INSERT OR IGNORE into prompt_contents                   │
│   4. pipelineVersionHash = sha256(canonical IR + sorted      │
│      promptRef→contentHash map)                              │
│   5. INSERT pipeline_versions row                            │
│   6. INSERT pipeline_prompt_refs rows (one per promptRef)    │
│   All five in one transaction.                               │
└──────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────┐
│ pipeline_versions                                            │
│   version_hash PK                                            │
│   pipeline_name, ir_json, ts_source, parent_hash, ...        │
│                                                              │
│ prompt_contents                                              │
│   content_hash PK                                            │
│   content, created_at                                        │
│                                                              │
│ pipeline_prompt_refs                                         │
│   version_hash + prompt_ref PK                               │
│   content_hash FK                                            │
└──────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────┐
│ DbPromptResolver(db, versionHash)                            │
│   resolve({ stage }): string                                 │
│     SELECT content FROM prompt_contents pc                   │
│       JOIN pipeline_prompt_refs ppr                          │
│       ON pc.content_hash = ppr.content_hash                  │
│       WHERE ppr.version_hash = ? AND ppr.prompt_ref = ?      │
└──────────────────────────────────────────────────────────────┘
```

## 4. Database Schema

Added to `apps/server/src/kernel-next/ir/sql.ts` alongside `pipeline_versions`:

```sql
CREATE TABLE IF NOT EXISTS prompt_contents (
  content_hash TEXT PRIMARY KEY,
  content      TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pipeline_prompt_refs (
  version_hash TEXT NOT NULL,
  prompt_ref   TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (version_hash, prompt_ref),
  FOREIGN KEY (version_hash) REFERENCES pipeline_versions(version_hash),
  FOREIGN KEY (content_hash) REFERENCES prompt_contents(content_hash)
);

CREATE INDEX IF NOT EXISTS idx_ppr_content
  ON pipeline_prompt_refs(content_hash);
```

**Why two tables, not one**: content-addressed dedup. If `pipeline-generator` v1 and v2 share an unchanged `system/gen-prompts.md`, they reference the same `content_hash` row in `prompt_contents`. This also gives "prompts used by more than one version" queries for free via `GROUP BY content_hash` on `pipeline_prompt_refs`.

**`idx_ppr_content`**: reverse lookup "which pipelines reference this prompt?" — used by debug tooling and future GC.

**No CASCADE**: kernel-next-design §1.3 "zero legacy compatibility" — stale rows are harmless; hot-update churn is low. ON DELETE behavior is explicit at the query layer when needed.

## 5. Canonical Hash Extension

New function in `canonical.ts` (alongside existing `canonicalizeIR`, `canonicalJSON`, `versionHash`):

```typescript
/**
 * Normalize prompt content to prevent hash drift from editor-induced
 * whitespace differences:
 *   - Strip BOM
 *   - Normalize line endings to \n
 *   - Strip trailing whitespace per line
 *   - Ensure exactly one trailing \n
 */
export function normalizePromptContent(raw: string): string {
  let s = raw.replace(/^\uFEFF/, "");
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  s = s.split("\n").map((line) => line.replace(/[ \t]+$/, "")).join("\n");
  if (!s.endsWith("\n")) s += "\n";
  return s;
}

export function promptContentHash(content: string): string {
  const normalized = normalizePromptContent(content);
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Canonical body for pipeline-level version hash.
 * Shape: { ir: <canonicalIR>, prompts: { <promptRef>: "sha256:<hex>" } }
 * promptRef keys sorted by codepointCompare.
 */
export function canonicalizePipeline(input: {
  ir: PipelineIR;
  prompts: Record<string, string>;
}): CanonicalValue {
  const ir = canonicalizeIR(input.ir);
  const promptEntries = Object.entries(input.prompts)
    .sort(([a], [b]) => codepointCompare(a, b))
    .map(([ref, content]) => [ref, `sha256:${promptContentHash(content)}`] as const);
  const prompts: Record<string, CanonicalValue> = {};
  for (const [ref, hash] of promptEntries) prompts[ref] = hash;
  return sortKeys({ ir, prompts });
}

export function pipelineCanonicalJSON(input: {
  ir: PipelineIR;
  prompts: Record<string, string>;
}): string {
  return JSON.stringify(canonicalizePipeline(input));
}

export function pipelineVersionHash(input: {
  ir: PipelineIR;
  prompts: Record<string, string>;
}): string {
  return createHash("sha256")
    .update(pipelineCanonicalJSON(input))
    .digest("hex");
}
```

**Existing `versionHash(ir)` and `canonicalizeIR(ir)` are preserved**. They remain the primitive for patch-level diffing (hot-update IRPatch operates on IR structure only, not prompts — prompt changes go through a fresh submit). Callers that have IR only (no prompts context) use the old signature; callers with full pipeline definitions use the new `pipelineVersionHash`.

**Prompt hash prefix `sha256:`**: makes the canonical body self-documenting and forward-compatible with other hash algorithms (e.g. blake3) if ever needed.

**Empty prompts map**: `pipelineVersionHash({ ir, prompts: {} })` is valid — represents a pipeline with no agent stages (script-only pipelines). The canonical body shape is `{ ir, prompts: {} }` → hash differs from `versionHash(ir)`. This is intentional: "this pipeline has zero prompts" is a distinct assertion from "hash only the IR".

## 6. submit_pipeline API Extension

Current shape (in `mcp/kernel.ts::submitPipeline`):

```typescript
submitPipeline(db: Database, ir: PipelineIR, tsSource: string): {
  ok: true; versionHash: string; parentHash?: string;
} | { ok: false; diagnostics: Diagnostic[] };
```

New shape:

```typescript
submitPipeline(db: Database, input: {
  ir: PipelineIR;
  prompts: Record<string, string>;
  tsSource: string;
}): { ok: true; versionHash: string; parentHash?: string }
 | { ok: false; diagnostics: Diagnostic[] };
```

**Behavior**:

1. Validate IR (existing path: Zod schema + structural validator + DAG cycle check).
2. Validate prompts:
   - All `AgentStage.config.promptRef` values reference a key in `prompts`. Missing reference → `Diagnostic { code: "PROMPT_REF_MISSING", context: { stage, promptRef } }`.
   - No `prompts` key is unused (every uploaded prompt must be referenced somewhere — either by an AgentStage or transitively by another prompt via userland fragment markers; for this milestone, require every prompt key to appear as some AgentStage.promptRef). Extras → `Diagnostic { code: "PROMPT_REF_UNUSED", context: { promptRef } }`. (Rationale: force bundle hygiene. If an author uploads a 2 MB unused prompt, the version_hash is bloated forever.)
   - Empty content (after normalization: zero bytes or only whitespace) → `Diagnostic { code: "PROMPT_CONTENT_EMPTY", context: { promptRef } }`.
3. Compute `versionHash = pipelineVersionHash({ ir, prompts })`.
4. Open transaction:
   - `INSERT OR IGNORE INTO pipeline_versions` — returns existing row on conflict (idempotent).
   - For each prompt: `INSERT OR IGNORE INTO prompt_contents`.
   - For each (promptRef, content) pair: `INSERT INTO pipeline_prompt_refs (version_hash, prompt_ref, content_hash) ON CONFLICT DO NOTHING`.
   - Commit.
5. Return `{ ok: true, versionHash }`.

**Failure atomicity**: all-or-nothing via transaction. If any INSERT fails (constraint, disk error), the entire submit rolls back — no half-inserted pipeline.

### 6.1 MCP tool schema update

`apps/server/src/kernel-next/mcp/tools/submit-pipeline.ts` (exact path to be confirmed in plan) input Zod schema:

```typescript
const submitPipelineInputSchema = z.object({
  ir: PipelineIRSchema,
  prompts: z.record(z.string().min(1), z.string()).default({}),
  tsSource: z.string().default(""),
});
```

**Backward-compatible default**: callers that don't pass `prompts` get `{}`. For the short window between schema deployment and all callers being updated, this keeps existing callers working — but submit fails with `PROMPT_REF_MISSING` the moment the IR contains any AgentStage. In practice every active caller will be updated in-flight (the migration M.B described below updates them all synchronously).

## 7. DbPromptResolver

New module `apps/server/src/kernel-next/runtime/db-prompt-resolver.ts`:

```typescript
import type { Database } from "node:sqlite";
import type { PromptResolver, PromptResolveArgs } from "./prompt-resolver.js";

export class DbPromptResolver implements PromptResolver {
  private readonly lookupStmt: ReturnType<Database["prepare"]>;

  constructor(
    private readonly db: Database,
    private readonly versionHash: string,
  ) {
    this.lookupStmt = db.prepare(`
      SELECT pc.content
      FROM pipeline_prompt_refs ppr
      JOIN prompt_contents pc ON pc.content_hash = ppr.content_hash
      WHERE ppr.version_hash = ? AND ppr.prompt_ref = ?
    `);
  }

  resolve(args: PromptResolveArgs): string {
    const promptRef = args.stage.config.promptRef;
    if (!promptRef || promptRef.trim().length === 0) {
      throw new Error(
        `DbPromptResolver: stage '${args.stage.name}' has empty promptRef`,
      );
    }
    const row = this.lookupStmt.get(this.versionHash, promptRef) as
      | { content: string }
      | undefined;
    if (!row) {
      throw new Error(
        `DbPromptResolver: promptRef '${promptRef}' not found for ` +
          `versionHash='${this.versionHash}' (stage '${args.stage.name}')`,
      );
    }
    return row.content;
  }
}
```

**Scope of the resolver instance**: one per task run. Runner constructs it at task start, passes it to executor factory alongside other task-scoped context. `versionHash` is immutable for the life of the task (hot-update creates a new actor via `migrate_task`, which constructs a fresh resolver).

**No caching beyond the prepared statement**: SQLite prepared statements already cache at the driver level. `content` columns are typically < 100 KB; per-resolve query cost is microseconds. A content-keyed LRU would be premature optimization.

**Thread/concurrency**: node:sqlite is synchronous and single-threaded within a process. No locks needed.

### 7.1 Fs resolver deprecation

`FsPromptResolver` stays in the codebase but loses all production wiring:

- `routes/kernel-run.ts::registerLegacyPipeline` — replaced with DbPromptResolver
- `runtime/runner.ts` default resolver — replaced
- `builtins/smoke-test.ts::smokeTestPromptRoot` helper — replaced
- `kernel-next/mcp/pg-entry.ts` — replaced

Files retaining FsPromptResolver:
- `runtime/fs-prompt-resolver.test.ts` — unit test of the FS implementation itself
- `generator-real/real-generator.ts` — if it uses FsPromptResolver (confirm at plan time; expected to migrate)
- Any demo/smoke that wants to read from disk for doc purposes — keep the class available

At the end of this milestone we do **not** delete `FsPromptResolver.ts`; it becomes a utility that an outside caller can still use if they want filesystem-backed prompts. This defers the irreversible delete to a later cleanup once all call sites are verified.

## 8. pipeline-generator Adaptation (three slices)

### Slice 1: Infrastructure plumbing (DB schema, submit API, resolver, migration helper)

Nothing about pipeline-generator's AI prompts changes. All pre-migration registered pipelines continue working because `registerLegacyPipeline` is updated to submit IR+prompts to SQLite on module load and wire the runner with `DbPromptResolver`.

**Concretely**:
1. Add DB schema (§4).
2. Add `canonicalizePipeline` / `pipelineVersionHash` / `normalizePromptContent` / `promptContentHash` (§5).
3. Extend `submitPipeline` to accept `{ ir, prompts }` (§6).
4. Add `DbPromptResolver` (§7).
5. Modify `loadLegacyPipelineIR` (`runtime/load-legacy-pipeline.ts`): in addition to returning `{ ir, promptRoot, yamlFilePath }`, also scan `promptRoot` recursively and return `prompts: Record<string, string>` where keys are promptRefs derived from relative paths (with `.md` stripped).
6. Modify `registerLegacyPipeline` (`routes/kernel-run.ts`): at module load, invoke loader, submit IR+prompts via `submitPipeline` (idempotent — safe across restarts), capture returned `versionHash`, construct `DbPromptResolver(db, versionHash)`, bind into executor factory.
7. Modify `pg-entry.ts::handleStartPipelineGenerator`: same change pattern — submit IR+prompts, resolver from DB.
8. Modify `kernel-run.ts` POST handler: resolver wiring uses the pipeline's bound `versionHash`.

**Slice 1 acceptance**:
- All 4 registered pipelines (`smoke-test`, `tech-research-collector`, `tech-research-writer`, `pipeline-generator`) continue running E2E on their existing legacy YAML + prompts (filesystem) inputs.
- After server restart, `pipeline_prompt_refs` table has rows for each registered pipeline's versionHash × promptRef count.
- Running any registered pipeline exercises `DbPromptResolver` (verified via grep / log / test).
- `versionHash` of each registered pipeline changes (because it now includes prompts) — baseline golden hashes in `canonical.test.ts` need updating for the pipeline-level hash; IR-level `versionHash(ir)` goldens remain byte-identical (for `smokeTestIR()`, `diamondIR()`).

### Slice 2: Rewrite pipeline-generator prompts to emit IR (not YAML)

Out of this spec's scope — belongs to a sibling spec "pipeline-generator IR prompts rewrite". This spec's job is to make Slice 2 possible by giving it a place to submit the prompts it writes.

### Slice 3: pipeline-generator itself as IR (its own pipeline.yaml → IR bundle in SQLite)

Also out of this spec's scope — depends on Slice 2 producing IR-emitting prompts first.

## 9. Migration Strategy for Registered Pipelines

**Decision**: M.B (per §10 prior conversation) — migration happens inside `registerLegacyPipeline` at module load.

Current code path (`routes/kernel-run.ts:105`):
```typescript
function registerLegacyPipeline(opts: {
  pipelineDir: string;
  model?: string; maxTurns?: number; maxBudgetUsd?: number; timeoutMs?: number;
}) {
  const { ir, promptRoot, yamlFilePath } = loadLegacyPipelineIR(opts.pipelineDir);
  return () => ({ ir, ... });
}
```

New code path:
```typescript
function registerLegacyPipeline(opts: ...) {
  const loaded = loadLegacyPipelineIR(opts.pipelineDir);
  // loaded.prompts: Record<string, string>  (NEW from loader)
  const db = getKernelNextDb();
  const result = submitPipeline(db, {
    ir: loaded.ir,
    prompts: loaded.prompts,
    tsSource: "",                              // TS codegen not wired for legacy
  });
  if (!result.ok) {
    throw new Error(
      `registerLegacyPipeline(${opts.pipelineDir}): submit failed: ${JSON.stringify(result.diagnostics)}`,
    );
  }
  const versionHash = result.versionHash;
  const promptRoot = loaded.promptRoot;        // retained for tests only
  return () => ({
    ir: loaded.ir,
    versionHash,
    // Executor factory now constructs DbPromptResolver bound to versionHash:
    executorFactory: (mcpServer) => new RealStageExecutor({
      ..., promptResolver: new DbPromptResolver(db, versionHash),
    }),
  });
}
```

**Idempotency**: `submitPipeline` uses `INSERT OR IGNORE` on `pipeline_versions` and `prompt_contents`, `ON CONFLICT DO NOTHING` on `pipeline_prompt_refs`. Module load runs N times across server restarts with identical result.

**Prompt discovery**: `loadLegacyPipelineIR` walks `<pipelineDir>/prompts/` recursively. For each `.md` file, promptRef = relative path without `.md` extension (e.g. `prompts/system/gen-skeleton.md` → `system/gen-skeleton`; `prompts/analyzing.md` → `analyzing`). Files that are not `.md` are ignored. Directories are walked, not followed as symlinks.

**promptRef validation**: must match `[a-zA-Z_][a-zA-Z0-9_/-]*` (allow path-like segments with `/`, `_`, `-`). Reject anything else with `PROMPT_REF_INVALID_PATH`.

**What prompts exist but aren't referenced**: slice 1 adds a diagnostic `PROMPT_REF_UNUSED` at submit time (§6 step 2). All currently-registered pipelines' prompt trees must be audited and pruned before this milestone can land — any orphan `.md` files in `prompts/` that no IR stage references will fail submission. Expected to be a small tidy-up (zero orphans in smoke-test; pipeline-generator may have a few).

**tsSource empty**: legacy registered pipelines don't have a TS codegen path wired. `ts_source` column becomes empty string. This is already the case today.

## 10. Testing Strategy

### Unit tests

- `canonical.test.ts`:
  - `normalizePromptContent`: BOM / CRLF / trailing whitespace / trailing newline regression
  - `promptContentHash`: same content under different whitespace → same hash
  - `canonicalizePipeline`: promptRef ordering stable regardless of input order
  - `pipelineVersionHash`: changes if any prompt changes; stable otherwise
- `ir/sql.test.ts` (new table coverage):
  - Insert prompts, verify dedup on same content_hash
  - Foreign key constraints: `pipeline_prompt_refs.version_hash` must exist in `pipeline_versions`
- `runtime/db-prompt-resolver.test.ts`:
  - Happy path: resolve returns content
  - Missing promptRef: throws with actionable message
  - Two versions with same promptRef but different content: each version's resolver returns correct content
- `runtime/load-legacy-pipeline.test.ts` (extension):
  - `prompts` field populated from disk
  - Nested paths become `/`-separated promptRefs
  - Non-`.md` files ignored

### Integration tests

- `mcp/kernel.test.ts::submitPipeline` new shape:
  - Happy path: submit with prompts, verify `pipeline_prompt_refs` rows exist
  - Missing promptRef: `PROMPT_REF_MISSING` diagnostic
  - Unused prompt: `PROMPT_REF_UNUSED` diagnostic
  - Empty content: `PROMPT_CONTENT_EMPTY` diagnostic
  - Dedup: two submits with same prompt content → `prompt_contents` has one row
- `routes/kernel-run.test.ts`:
  - After module load, all registered pipelines have `pipeline_prompt_refs` rows
  - POST /api/kernel/tasks/run on each registered pipeline uses DbPromptResolver (assertable via spy on resolver path, or via integration run)
- `runtime/runner.test.ts`: existing mock-executor tests continue passing; no structural change since resolver interface is unchanged

### E2E validation (manual, not automated)

After Slice 1 lands, manually run each registered pipeline end-to-end via POST, confirm completion, and check SSE event sequence matches pre-change baseline. (This is the same manual check the A7 milestone did; no new automation required.)

## 11. Rollout & Acceptance

### Shipping order within Slice 1

1. DB schema + migration code (runs on server start). **Ship alone, verify table creation**.
2. `canonical.ts` new exports + unit tests. **Ship alone**.
3. `submitPipeline` API extension + MCP tool schema update. **Ship alone**.
4. `DbPromptResolver` + unit tests. **Ship alone**.
5. `loadLegacyPipelineIR` prompt scanning extension. **Ship alone**.
6. `registerLegacyPipeline` wires the new path. **Integration point — break/fix window**.
7. `pg-entry.ts` wires the new path. **Ship with 6**.
8. Manual E2E across all 4 pipelines. **Acceptance gate**.

At any point between 1 and 5, the engine continues working on the old `FsPromptResolver` path. Step 6+7 is the hard cutover; feature-flag not used (keep code simple — rollback is git revert).

### Acceptance criteria

- [ ] All unit tests pass (target: +15-25 new tests)
- [ ] All integration tests pass
- [ ] Manual E2E: smoke-test, tech-research-collector, tech-research-writer, pipeline-generator — each completes
- [ ] `pipeline_prompt_refs` populated correctly after one clean server restart
- [ ] `FsPromptResolver` has zero call sites in production routes (verified via grep of `routes/`, `kernel-next/mcp/`, `kernel-next/runtime/runner.ts`)
- [ ] New canonical hash goldens recorded in `canonical.test.ts`

## 12. Non-Negotiables (lifted from kernel-next-design §11.2)

- Kernel remains executor-agnostic: prompt content is opaque to kernel, just bytes referenced by hash.
- IR cannot encode policy: prompts stay a concern adjacent to IR, not a policy knob.
- MCP surface separation preserved: `submit_pipeline` is on external surface; prompt queries via `read_port`-equivalent are out of scope for this milestone (debug tooling can query the DB directly if needed).
- Lineage is synchronous; prompt resolution is also synchronous (per node:sqlite constraints).
- Zero legacy compatibility: prompts in SQLite is the new normal; prior-session task runs that still reference `FsPromptResolver` via their snapshot will not be replayed post-migration (consistent with "old tasks stop working when legacy kernel deletes" principle).

## 13. Known Risks & Deferred Decisions

- **Large prompts blob SQLite row size**: SQLite handles multi-MB TEXT columns fine, but individual prompt_contents row > 100 MB would be unusual. No per-row size limit enforced. If a future authoring pattern emits giant prompts, revisit.
- **Unused prompts enforcement** (`PROMPT_REF_UNUSED`): strict today; may soften if Slice 2's `pipeline-generator` authoring pattern produces "unused" prompts that are actually referenced via userland fragment assembly. Revisit at Slice 2.
- **Transaction write throughput**: submit_pipeline doing 5 INSERTs in a transaction is cheap. Bulk submission (hypothetical CI migration scenario) not needed yet.
- **Backups of prompts**: content is duplicated across dev/prod databases per normal SQLite practice. No dedicated prompt backup pipeline; the database IS the backup.

## 14. Self-Review Checklist

- [ ] Every success criterion in §1 maps to a test in §10
- [ ] Every table in §4 has an indexed access path
- [ ] `submit_pipeline` diagnostics are actionable (include stage/promptRef context)
- [ ] `DbPromptResolver` error messages include versionHash and promptRef (critical for debug when a prompt lookup mysteriously fails)
- [ ] Migration (§9) is idempotent across server restarts
- [ ] Canonical hash algorithm is deterministic across platforms (no locale-dependent sort)
- [ ] `FsPromptResolver` still exists post-milestone; tests for it still run
- [ ] No backward-compat shims beyond the `prompts: {}` default on submit_pipeline — that default is for the short in-flight window only
- [ ] Rollback plan: git revert of the hard-cutover commit (step 6+7) restores `FsPromptResolver` path
