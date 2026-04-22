# Retire Converter — Stage 4b Design

> **Date:** 2026-04-24
> **Status:** Draft — awaiting user approval
> **Goal-tier:** Stage 4b of the 7-stage Y-direction path. Finishes the work Stage 4a left open.
> **Related:**
>   - `docs/superpowers/specs/2026-04-24-retire-legacy-engine-design.md` (Stage 4a, committed)
>   - `docs/superpowers/specs/2026-04-24-prompts-in-sqlite-design.md`
>   - `docs/kernel-next-terminal-design.md` §1.3 (zero legacy compatibility), §5.2 (canonical IR = versionHash source)

## 1. Goal & Success Criteria

**Goal:** Delete `apps/server/src/kernel-next/converter/`. The four seeded builtin pipelines — `smoke-test`, `tech-research-collector`, `tech-research-writer`, `pipeline-generator` — become native IR: each directory carries a `pipeline.ir.json` file (canonical-ordered) next to its existing `prompts/` directory. No YAML reading at runtime. No legacy DSL anywhere on the production path.

**Success criteria:**

1. `apps/server/src/kernel-next/converter/` directory deleted.
2. `apps/server/src/builtin-pipelines/<name>/pipeline.yaml` files deleted for all four seeded pipelines.
3. Each `apps/server/src/builtin-pipelines/<name>/` contains a `pipeline.ir.json` file.
4. **Round-trip invariant**: for each pipeline, `pipelineVersionHash({ir: JSON.parse(pipeline.ir.json), prompts: scan(prompts/)})` equals the versionHash that the old converter-based path produced. Existing DB rows and Stage 3 task snapshots remain consistent.
5. `apps/server/src/kernel-next/runtime/load-legacy-pipeline.ts` renamed to `load-builtin-pipeline.ts`, reading JSON + prompts from disk (no YAML parsing).
6. `seedLegacyPipelineByName` in `routes/kernel-run.ts` renamed to `seedBuiltinPipelineByName` with the new loader.
7. `topoDownstream` (currently `converter/topo-downstream.ts`) moved to `kernel-next/runtime/topo-downstream.ts` with no behavior change.
8. `builtin-pipelines/web3-research-writer/` deleted (Stage 4a follow-up).
9. Converter-dependent test files deleted: `kernel-next/runtime/pg-inspect.test.ts`, `kernel-next/runtime/pipeline-generator-run.test.ts`.
10. `LegacyPipelineLoadError` class renamed `BuiltinPipelineLoadError` (breaking rename, all callers updated).
11. Server `tsc --noEmit` clean. Server `vitest run` 0 failures. Web `tsc --noEmit` clean.
12. kernel-next stack runs the four builtins end-to-end after restart (smoke-test via mock, pipeline-generator via real Claude SDK).

## 2. Scope & Non-Goals

**In scope:**
- One-time migration: run converter on each of 4 YAMLs, write canonical-ordered `pipeline.ir.json`, verify versionHash round-trip equals pre-migration.
- Delete 4 `pipeline.yaml` files after migration commit lands.
- Rename + reimplement `load-legacy-pipeline.ts` → `load-builtin-pipeline.ts` (JSON + prompts scan, no YAML).
- Rename `seedLegacyPipelineByName` → `seedBuiltinPipelineByName`.
- Move `topoDownstream` helper out of converter before deletion.
- Delete `kernel-next/converter/` entirely (20 files, ~2.2k LOC + tests).
- Delete 2 YAML-dependent test files in `kernel-next/runtime/`.
- Delete `builtin-pipelines/web3-research-writer/` (orphan from Stage 4a).
- Delete the migration script itself once it has served its purpose.
- Docs: CLAUDE.md + roadmap + design-doc Appendix A.

**Out of scope:**
- Stage 5 hot-update B-series.
- Stage 6 Execution Record sidecar.
- Web dashboard rebuild.
- pipeline-generator prompt quality improvements.
- Adding IR authoring tools (JSON editors, validators-on-save).

**Non-goals:**
- **NOT** regenerating builtins via pipeline-generator. Whatever converter currently produces is the baseline; changing it in this milestone would be two risks at once (convert bug + regeneration bug). Regeneration belongs to a separate Stage 3-extension if ever warranted.
- **NOT** hand-writing IR from scratch. converter has already been proven correct by Stage 2/3; translating via converter one more time is deterministic.

## 3. Architectural Justification

Terminal design §5.2 says IR is canonical, YAML is presentation. Converter lived as a "translation" seam for legacy YAML authoring. Post-Stage-4a:
- No legacy engine to convert to.
- No legacy YAML authoring surface.
- pipeline-generator emits IR directly (Stage 2 proven).
- Builtin YAMLs are the last YAML residues, and they serve zero purpose: they're read at boot, converted, and thrown away.

Materializing IR on disk removes:
- A ~2.2k-LOC subsystem.
- 20+ test files.
- A source-of-truth ambiguity ("which is canonical: YAML or IR?").
- A hidden conversion step on every server boot.

Round-trip invariant makes this safe: if the JSON we write today round-trips to the same versionHash as converter's output, the DB rows produced by the old path remain re-resolvable.

## 4. Migration Strategy

### 4.1 One-time migration script

Create `apps/server/src/scripts/migrate-yaml-to-ir.ts` that:

1. For each of the four pipelines (`smoke-test`, `tech-research-collector`, `tech-research-writer`, `pipeline-generator`):
   - Read `apps/server/src/builtin-pipelines/<name>/pipeline.yaml`
   - Call `convertLegacyYaml(yamlText, {yamlFilePath})`; stop with a clear error on `!ok`
   - Scan `apps/server/src/builtin-pipelines/<name>/prompts/**/*.md` → `prompts: Record<string, string>`
   - Compute `hashBefore = pipelineVersionHash({ir: conv.ir, prompts})`
   - Write canonical-ordered, pretty-printed IR JSON to `pipeline.ir.json`:
     ```
     JSON.stringify(canonicalizeIR(conv.ir), null, 2) + "\n"
     ```
   - Read the JSON back; `ir2 = PipelineIRSchema.parse(JSON.parse(raw))`
   - Compute `hashAfter = pipelineVersionHash({ir: ir2, prompts})`
   - Assert `hashBefore === hashAfter`. On mismatch, delete the bad JSON and throw with a diff message.

2. Script lives under `scripts/` because that directory was deleted in Stage 4a (no residual legacy `scripts/` to collide with). Re-creating it is fine; the script deletes itself in the final commit.

3. Script usage: `cd apps/server && ./node_modules/.bin/tsx src/scripts/migrate-yaml-to-ir.ts`. No args. Exits 0 on success, non-zero on round-trip failure.

### 4.2 Commit sequence

**Commit 1** — "generate IR JSON + verify round-trip (converter still present)":
- Add `scripts/migrate-yaml-to-ir.ts`
- Run it → produces 4 `pipeline.ir.json` files
- Commit script + 4 new JSON files
- `pipeline.yaml` files still on disk; converter still in place; everything still runs the old way
- Tests unchanged

**Commit 2** — "switch loader to JSON + delete YAML":
- Create `kernel-next/runtime/load-builtin-pipeline.ts` (new file) — reads `pipeline.ir.json` + scans prompts; returns `{ir, prompts, pipelineDir, promptRoot}`. Exports `BuiltinPipelineLoadError`.
- Delete `kernel-next/runtime/load-legacy-pipeline.ts` + `.test.ts`. Create `kernel-next/runtime/load-builtin-pipeline.test.ts`.
- Update `routes/kernel-run.ts`: rename `seedLegacyPipelineByName` → `seedBuiltinPipelineByName`, swap `loadLegacyPipelineIR` → `loadBuiltinPipelineIR`. Same 4 call sites.
- Update `kernel-next/mcp/server.ts`: swap the `loadLegacyPipelineIR("pipeline-generator")` import + call to the new loader. Update cached variable name.
- Update `kernel-next/mcp/pg-entry.ts`: swap `LegacyPipelineLoadError` import to `BuiltinPipelineLoadError`.
- Delete 4 `pipeline.yaml` files.
- `tsc` + `vitest` green.

**Commit 3** — "delete converter + dependent tests":
- Move `kernel-next/converter/topo-downstream.ts` → `kernel-next/runtime/topo-downstream.ts` (+ its test). Update `runner.ts` import path.
- Delete entire `kernel-next/converter/` directory (all remaining files).
- Delete `kernel-next/runtime/pg-inspect.test.ts` (directly imports converter).
- Delete `kernel-next/runtime/pipeline-generator-run.test.ts` (directly imports converter; describe.skip anyway, but import would break tsc).
- `tsc` + `vitest` green.

**Commit 4** — "cleanup: delete migration script + web3-research-writer + docs":
- Delete `scripts/migrate-yaml-to-ir.ts`
- Delete `builtin-pipelines/web3-research-writer/` directory
- Update CLAUDE.md, product-roadmap.md, kernel-next-terminal-design.md
- Write `docs/superpowers/plans/2026-04-24-retire-converter-done-handoff.md`

### 4.3 Round-trip invariant

The whole migration hinges on this:

```
for each pipeline P:
  yamlText = readFileSync(P/pipeline.yaml)
  (ir_A, warnings) = convertLegacyYaml(yamlText)
  prompts = scan(P/prompts)
  hash_A = pipelineVersionHash({ir: ir_A, prompts})

  jsonText = JSON.stringify(canonicalizeIR(ir_A), null, 2) + "\n"
  writeFileSync(P/pipeline.ir.json, jsonText)

  ir_B = PipelineIRSchema.parse(JSON.parse(readFileSync(P/pipeline.ir.json)))
  hash_B = pipelineVersionHash({ir: ir_B, prompts})

  assert hash_A === hash_B
```

If hash_A ≠ hash_B for any pipeline, the migration script aborts. Possible causes and mitigations:

1. **Zod field-order sensitivity**: `canonicalizeIR` already sorts keys + arrays by canonical order. Writing + parsing JSON is order-preserving at the JS-Object level. Hash comes from `canonicalizePipeline` which re-canonicalizes before hashing, so re-canonicalization is idempotent. Risk: low.
2. **Optional field handling**: `canonicalizeIR` omits undefined. If ir_A had `externalInputs: undefined` and ir_B has `externalInputs: []` (default from Zod), canonicalization paths may differ. Test: existing `canonical.test.ts` baseline already validates these shapes; rely on them.
3. **Prompts scan stability**: prompts scanned twice should be identical (same directory, same files). If a `.md` file has platform-dependent line endings, `promptContentHash` already normalizes via `normalizePromptContent`. OK.

Mitigation if invariant fails: fix the specific case (almost certainly in `canonicalizeIR` handling of an edge field), commit the fix, re-run migration.

## 5. Module-Level Design

### 5.1 `kernel-next/runtime/load-builtin-pipeline.ts`

Direct replacement of `load-legacy-pipeline.ts`. New contract:

```typescript
export interface BuiltinPipelineLoadResult {
  ir: PipelineIR;
  pipelineDir: string;     // absolute path to <builtin-pipelines>/<name>/
  promptRoot: string;      // absolute path to <pipelineDir>/prompts
  prompts: Record<string, string>;  // scanned from promptRoot
  warnings: never[];       // empty — no converter, no warnings layer
}

export class BuiltinPipelineLoadError extends Error {
  constructor(
    message: string,
    public readonly diagnostics: Array<{ code: string; message?: string }>,
  ) { ... }
}

export function loadBuiltinPipelineIR(pipelineDir: string): BuiltinPipelineLoadResult;
```

Implementation sketch:

```typescript
const BUILTIN_PIPELINES_ROOT = join(__dirname, "..", "..", "builtin-pipelines");

export function loadBuiltinPipelineIR(pipelineDir: string): BuiltinPipelineLoadResult {
  const dir = join(BUILTIN_PIPELINES_ROOT, pipelineDir);
  const irPath = join(dir, "pipeline.ir.json");
  const promptRoot = join(dir, "prompts");

  let raw: string;
  try {
    raw = readFileSync(irPath, "utf-8");
  } catch (err) {
    throw new BuiltinPipelineLoadError(
      `failed to read ${irPath}: ${(err as Error).message}`,
      [{ code: "IR_READ_FAILED", message: (err as Error).message }],
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    throw new BuiltinPipelineLoadError(
      `invalid JSON in ${irPath}: ${(err as Error).message}`,
      [{ code: "IR_JSON_PARSE_FAILED", message: (err as Error).message }],
    );
  }

  const parsed = PipelineIRSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new BuiltinPipelineLoadError(
      `IR schema violation in ${irPath}`,
      parsed.error.issues.map((i) => ({
        code: "ZOD_PARSE_ERROR",
        message: `${i.path.join(".") || "<root>"}: ${i.message}`,
      })),
    );
  }

  const prompts = scanPrompts(promptRoot);

  return {
    ir: parsed.data,
    pipelineDir: dir,
    promptRoot,
    prompts,
    warnings: [],
  };
}

function scanPrompts(promptRoot: string): Record<string, string> {
  if (!existsSync(promptRoot)) return {};
  const out: Record<string, string> = {};
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && entry.endsWith(".md")) {
        const rel = relative(promptRoot, full).split(sep).join("/");
        const key = rel.slice(0, -".md".length);
        out[key] = readFileSync(full, "utf-8");
      }
    }
  }
  walk(promptRoot);
  return out;
}
```

The `scanPrompts` helper is copied verbatim from `load-legacy-pipeline.ts` — it works there, it works here.

### 5.2 `routes/kernel-run.ts::seedBuiltinPipelineByName`

Direct rename + loader swap:

```typescript
import { loadBuiltinPipelineIR, BuiltinPipelineLoadError }
  from "../kernel-next/runtime/load-builtin-pipeline.js";

function seedBuiltinPipelineByName(pipelineDir: string): void {
  try {
    const loaded = loadBuiltinPipelineIR(pipelineDir);
    const db = getKernelNextDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const res = svc.submit(loaded.ir, { prompts: loaded.prompts });
    if (!res.ok) {
      throw new Error(
        `seedBuiltinPipelineByName('${pipelineDir}'): submit failed: ${res.diagnostics.map((d) => `${d.code}: ${d.message ?? ""}`).join("; ")}`,
      );
    }
  } catch (err) {
    logger.error(
      { pipelineDir, err: (err as Error).message },
      "[kernel-run] seedBuiltinPipelineByName failed",
    );
    throw err;
  }
}

seedBuiltinPipelineByName("smoke-test");
seedBuiltinPipelineByName("tech-research-collector");
seedBuiltinPipelineByName("tech-research-writer");
seedBuiltinPipelineByName("pipeline-generator");
```

Same behavior, same versionHashes (per round-trip invariant).

### 5.3 `kernel-next/mcp/server.ts` update

Single-site change:

```typescript
import { loadBuiltinPipelineIR }
  from "../runtime/load-builtin-pipeline.js";

let cachedPipelineGeneratorIR: ReturnType<typeof loadBuiltinPipelineIR> | undefined;
// ...
cachedPipelineGeneratorIR = loadBuiltinPipelineIR("pipeline-generator");
// ...
loader: loadBuiltinPipelineIR,
```

The `cachedPipelineGeneratorIR` cache variable name is kept because it's private to the file.

### 5.4 `kernel-next/mcp/pg-entry.ts` update

Error type rename only:

```typescript
import { BuiltinPipelineLoadError }
  from "../runtime/load-builtin-pipeline.js";
// ... and the three call sites that check `err instanceof LegacyPipelineLoadError`
// become `err instanceof BuiltinPipelineLoadError`
```

### 5.5 `kernel-next/runtime/topo-downstream.ts` (relocated)

Move the file verbatim from `kernel-next/converter/topo-downstream.ts`. Update `runner.ts` import from `../converter/topo-downstream.js` to `./topo-downstream.js`. The test file goes with it.

## 6. Files Touched (summary)

**Created:**
- `apps/server/src/scripts/migrate-yaml-to-ir.ts` (removed in Commit 4)
- `apps/server/src/builtin-pipelines/smoke-test/pipeline.ir.json`
- `apps/server/src/builtin-pipelines/tech-research-collector/pipeline.ir.json`
- `apps/server/src/builtin-pipelines/tech-research-writer/pipeline.ir.json`
- `apps/server/src/builtin-pipelines/pipeline-generator/pipeline.ir.json`
- `apps/server/src/kernel-next/runtime/load-builtin-pipeline.ts`
- `apps/server/src/kernel-next/runtime/load-builtin-pipeline.test.ts`
- `apps/server/src/kernel-next/runtime/topo-downstream.ts` (moved from converter/)
- `apps/server/src/kernel-next/runtime/topo-downstream.test.ts` (moved from converter/)
- `docs/superpowers/plans/2026-04-24-retire-converter-done-handoff.md`

**Modified:**
- `apps/server/src/routes/kernel-run.ts`
- `apps/server/src/kernel-next/mcp/server.ts`
- `apps/server/src/kernel-next/mcp/pg-entry.ts`
- `apps/server/src/kernel-next/runtime/runner.ts` (topo-downstream import path)
- `CLAUDE.md`
- `docs/product-roadmap.md`
- `docs/kernel-next-terminal-design.md`

**Deleted:**
- `apps/server/src/kernel-next/converter/` (entire directory)
- `apps/server/src/kernel-next/runtime/load-legacy-pipeline.ts` + `.test.ts`
- `apps/server/src/kernel-next/runtime/pg-inspect.test.ts`
- `apps/server/src/kernel-next/runtime/pipeline-generator-run.test.ts`
- `apps/server/src/builtin-pipelines/smoke-test/pipeline.yaml`
- `apps/server/src/builtin-pipelines/tech-research-collector/pipeline.yaml`
- `apps/server/src/builtin-pipelines/tech-research-writer/pipeline.yaml`
- `apps/server/src/builtin-pipelines/pipeline-generator/pipeline.yaml`
- `apps/server/src/builtin-pipelines/web3-research-writer/` (directory)
- `apps/server/src/scripts/migrate-yaml-to-ir.ts` (after Commit 1 serves its purpose)

## 7. Testing Strategy

### 7.1 Unit-level

New: `load-builtin-pipeline.test.ts` covers:
- Reads a valid `pipeline.ir.json`, returns `{ir, prompts, pipelineDir, promptRoot}`
- Missing JSON file → `BuiltinPipelineLoadError` with `IR_READ_FAILED` diagnostic
- Invalid JSON syntax → `IR_JSON_PARSE_FAILED`
- JSON that violates PipelineIRSchema → `ZOD_PARSE_ERROR` diagnostics
- Prompts scan returns expected keys for the smoke-test fixture

Tests that worked for `load-legacy-pipeline.test.ts` but now YAML-dependent (e.g. "returns prompts map scanned from prompts/**/*.md") migrate to the new test file with JSON-based fixtures.

### 7.2 Round-trip verification (Commit 1 script)

The migration script itself is the regression test: it refuses to write a JSON whose round-trip versionHash differs. Run it, keep output.

### 7.3 Integration regression

After Commit 2:
- `vitest run src/routes/kernel-run.test.ts` — asserts seed populates prompt refs. Still passes because versionHashes are unchanged.
- `vitest run src/kernel-next` — runs kernel-next suite minus the 2 deleted YAML-dependent tests.
- Full `vitest run` should drop by 2-3 tests (the deleted YAML tests + a handful of converter tests).

### 7.4 End-to-end smoke (manual)

After Commit 3 lands:
- Start dev server, POST `/api/kernel/tasks/run` with `{name: "smoke-test", seedValues: {entry: "probe"}}`
- Verify it runs (stage_executing → stage_done → run_final).

This is the same smoke test already done throughout prior stages; no new test automation required.

## 8. Non-Negotiables Check

- ✅ Kernel executor-agnostic — untouched.
- ✅ IR cannot encode policy — untouched.
- ✅ MCP surface physical separation — untouched.
- ✅ Lineage synchronous — untouched.
- ✅ Hot-update never silently migrates — untouched.
- ✅ No mutable global state — untouched.
- ✅ **Zero legacy compatibility** — this milestone finalizes it. Last legacy YAML file disappears with Commit 2.
- ✅ Never regress already-executed information — round-trip invariant ensures historical versionHashes remain resolvable.

## 9. Risks & Mitigations

**9.1 versionHash mismatch at round-trip**

If any hash changes between YAML-route and JSON-route, existing DB rows (including Stage 3's `hello-research-v2` task snapshots) become orphans keyed by hashes no longer producible.

Mitigation: migration script aborts on mismatch. Fix the specific canonicalization edge in `canonical.ts` and re-run. Do not proceed past Commit 1 with any mismatch.

**9.2 Pipeline-generator YAML is hand-maintained; a `.yaml` edit won't propagate post-deletion**

Correct. That's the point — the YAML becomes non-canonical. Future edits to pipeline-generator design happen by editing `pipeline.ir.json` (or via a new generation step). Until there's a reason to edit the IR, it's static.

A developer making a typo fix to a prompt markdown file still works without issue; the IR is unchanged, prompts have their own content-hash path.

**9.3 Removed test coverage**

`converter/` tests go with the directory. `pg-inspect.test.ts` and `pipeline-generator-run.test.ts` go. These were verifying converter behavior; irrelevant post-deletion.

Mitigation: the round-trip invariant verifies the factual output converter produced for the four builtins is preserved. That's the only property we cared about.

**9.4 web3-research-writer deletion**

Orphan from Stage 4a. If anything unexpected still references it, tsc will catch it. Grep first.

**9.5 Migration script itself is non-production code**

It runs once, writes 4 files, then gets deleted. Any bug in the script before it's deleted is fine; the script's output (the JSON files) is what matters.

## 10. Self-Review Checklist

- [ ] All 4 builtins have `pipeline.ir.json` committed
- [ ] Round-trip versionHashes in migration script output match pre-migration hashes
- [ ] `loadBuiltinPipelineIR` is the only pipeline loader on production path
- [ ] `BuiltinPipelineLoadError` replaces `LegacyPipelineLoadError` at all 4 call sites
- [ ] `topoDownstream` moved without behavior change (unit test passes post-move)
- [ ] `converter/` directory does not exist after Commit 3
- [ ] Zero references to `converter` in production `src/` (test comments OK)
- [ ] `pipeline.yaml` files gone from all 4 builtin dirs
- [ ] `web3-research-writer/` deleted
- [ ] CLAUDE.md + roadmap + design doc updated
- [ ] `tsc --noEmit` + `vitest run` green at every commit
- [ ] Handoff doc reflects actual SHAs and test deltas
