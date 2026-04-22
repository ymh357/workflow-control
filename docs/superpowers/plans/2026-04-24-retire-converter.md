# Retire Converter — Stage 4b Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Materialize the 4 builtin pipelines as `pipeline.ir.json` on disk, swap the loader from YAML → JSON, delete the converter directory, and verify round-trip versionHash invariance so Stage 3 task snapshots remain valid.

**Architecture:** One-time migration script runs converter to produce canonical IR JSON. Loader renamed `load-builtin-pipeline.ts` reads JSON + scans prompts. `topoDownstream` relocated to runtime/. Four sequential commits, each with tsc + vitest gates.

**Tech Stack:** TypeScript, Zod, Vitest, node:sqlite.

**Spec:** `docs/superpowers/specs/2026-04-24-retire-converter-design.md`

**Baseline (pre-milestone)**: 1586 tests passed / 2 skipped across 122 test files. Server+web tsc clean. HEAD `c74b491`.

---

## Pre-flight

- [ ] **Step 1: Record baseline**

```bash
cd /Users/minghao/workflow-control
git log -1 --format=%H   # expect c74b491 (spec commit)
git status               # expect clean working tree except untracked (collectRefs.md, real-executor.ts, real-executor.empty-inputs.test.ts)
cd apps/server && ./node_modules/.bin/vitest run 2>&1 | tail -3
```

Record: passed / skipped / failed counts.

- [ ] **Step 2: Capture pre-migration versionHashes**

This creates the oracle values the migration script will verify against.

```bash
cd /Users/minghao/workflow-control/apps/server
./node_modules/.bin/tsx -e '
import { loadLegacyPipelineIR } from "./src/kernel-next/runtime/load-legacy-pipeline.js";
import { pipelineVersionHash } from "./src/kernel-next/ir/canonical.js";
const names = ["smoke-test", "tech-research-collector", "tech-research-writer", "pipeline-generator"];
for (const n of names) {
  const r = loadLegacyPipelineIR(n);
  const h = pipelineVersionHash({ ir: r.ir, prompts: r.prompts });
  console.log(n, h);
}
'
```

Save the output as `/tmp/pre-migration-hashes.txt` for later comparison.

```bash
./node_modules/.bin/tsx -e '
import { loadLegacyPipelineIR } from "./src/kernel-next/runtime/load-legacy-pipeline.js";
import { pipelineVersionHash } from "./src/kernel-next/ir/canonical.js";
const names = ["smoke-test", "tech-research-collector", "tech-research-writer", "pipeline-generator"];
for (const n of names) {
  const r = loadLegacyPipelineIR(n);
  const h = pipelineVersionHash({ ir: r.ir, prompts: r.prompts });
  console.log(n, h);
}
' > /tmp/pre-migration-hashes.txt
cat /tmp/pre-migration-hashes.txt
```

---

## Task 1: Write migration script + generate IR JSON + verify round-trip

**Files:**
- Create: `apps/server/src/scripts/migrate-yaml-to-ir.ts`
- Create: `apps/server/src/builtin-pipelines/smoke-test/pipeline.ir.json`
- Create: `apps/server/src/builtin-pipelines/tech-research-collector/pipeline.ir.json`
- Create: `apps/server/src/builtin-pipelines/tech-research-writer/pipeline.ir.json`
- Create: `apps/server/src/builtin-pipelines/pipeline-generator/pipeline.ir.json`

- [ ] **Step 1: Write the migration script**

`scripts/` directory was deleted in Stage 4a — recreate it. Write `apps/server/src/scripts/migrate-yaml-to-ir.ts`:

```typescript
// One-shot migration: convert legacy YAML builtin pipelines to canonical
// IR JSON. Verify versionHash round-trip (pre === post) before writing.
// Script deletes itself after all 4 pipelines migrated successfully.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { convertLegacyYaml } from "../kernel-next/converter/legacy-yaml.js";
import { canonicalizeIR, pipelineVersionHash } from "../kernel-next/ir/canonical.js";
import { PipelineIRSchema } from "../kernel-next/ir/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_ROOT = join(__dirname, "..", "builtin-pipelines");

const PIPELINES = [
  "smoke-test",
  "tech-research-collector",
  "tech-research-writer",
  "pipeline-generator",
];

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

function migratePipeline(name: string): void {
  const dir = join(BUILTIN_ROOT, name);
  const yamlPath = join(dir, "pipeline.yaml");
  const irPath = join(dir, "pipeline.ir.json");
  const promptRoot = join(dir, "prompts");

  console.log(`[${name}] reading ${yamlPath}`);
  const yamlText = readFileSync(yamlPath, "utf-8");
  const conv = convertLegacyYaml(yamlText, { yamlFilePath: yamlPath });
  if (!conv.ok) {
    console.error(`[${name}] convertLegacyYaml failed:`);
    console.error(JSON.stringify(conv.diagnostics, null, 2));
    throw new Error(`conversion failed for ${name}`);
  }

  const prompts = scanPrompts(promptRoot);
  const hashBefore = pipelineVersionHash({ ir: conv.ir, prompts });
  console.log(`[${name}] hashBefore = ${hashBefore}`);

  const canonical = canonicalizeIR(conv.ir);
  const jsonText = JSON.stringify(canonical, null, 2) + "\n";
  writeFileSync(irPath, jsonText, "utf-8");
  console.log(`[${name}] wrote ${irPath} (${jsonText.length} bytes)`);

  const roundTripRaw = readFileSync(irPath, "utf-8");
  const roundTripParsed = PipelineIRSchema.parse(JSON.parse(roundTripRaw));
  const hashAfter = pipelineVersionHash({ ir: roundTripParsed, prompts });
  console.log(`[${name}] hashAfter  = ${hashAfter}`);

  if (hashBefore !== hashAfter) {
    throw new Error(
      `[${name}] ROUND-TRIP FAILED: ${hashBefore} !== ${hashAfter}. ` +
        `IR canonicalization is not idempotent for this pipeline. ` +
        `Leaving ${irPath} in place for inspection.`,
    );
  }
  console.log(`[${name}] ✓ round-trip OK`);
}

function main(): void {
  for (const name of PIPELINES) migratePipeline(name);
  console.log("\nAll 4 pipelines migrated successfully.");
}

main();
```

- [ ] **Step 2: Run the migration script**

```bash
cd /Users/minghao/workflow-control/apps/server
./node_modules/.bin/tsx src/scripts/migrate-yaml-to-ir.ts
```

Expected output: four `[name] ✓ round-trip OK` lines. If any pipeline fails with ROUND-TRIP FAILED, STOP — the `pipeline.ir.json` for that pipeline was left on disk for debugging. The round-trip invariant is non-negotiable; investigate why `canonicalizeIR` isn't idempotent for that input before proceeding.

- [ ] **Step 3: Verify hashes match pre-migration oracle**

```bash
diff /tmp/pre-migration-hashes.txt <(
cd /Users/minghao/workflow-control/apps/server
./node_modules/.bin/tsx -e '
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PipelineIRSchema } from "./src/kernel-next/ir/schema.js";
import { pipelineVersionHash } from "./src/kernel-next/ir/canonical.js";
import { readdirSync, statSync, existsSync } from "node:fs";
import { relative, sep } from "node:path";

function scanPrompts(root: string): Record<string, string> {
  if (!existsSync(root)) return {};
  const out: Record<string, string> = {};
  function walk(dir: string): void {
    for (const e of readdirSync(dir)) {
      const f = join(dir, e);
      const s = statSync(f);
      if (s.isDirectory()) walk(f);
      else if (s.isFile() && e.endsWith(".md")) {
        const rel = relative(root, f).split(sep).join("/");
        out[rel.slice(0, -".md".length)] = readFileSync(f, "utf-8");
      }
    }
  }
  walk(root);
  return out;
}

const root = "./src/builtin-pipelines";
for (const n of ["smoke-test", "tech-research-collector", "tech-research-writer", "pipeline-generator"]) {
  const ir = PipelineIRSchema.parse(JSON.parse(readFileSync(join(root, n, "pipeline.ir.json"), "utf-8")));
  const prompts = scanPrompts(join(root, n, "prompts"));
  console.log(n, pipelineVersionHash({ ir, prompts }));
}
'
)
```

Expected: no diff output (files match). If diff shows any mismatch, the JSON was written but its round-trip differs from what `load-legacy-pipeline` produced — STOP and investigate.

- [ ] **Step 4: Verify tsc still clean**

```bash
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/tsc --noEmit
```

Expected: 0 errors. Script adds new source file with existing imports; shouldn't break.

- [ ] **Step 5: Verify vitest still clean**

```bash
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run 2>&1 | tail -3
```

Expected: same 1586 passed / 2 skipped. Script isn't a test.

- [ ] **Step 6: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/scripts/migrate-yaml-to-ir.ts apps/server/src/builtin-pipelines/*/pipeline.ir.json && git commit -m "feat(retire-converter): generate pipeline.ir.json for 4 builtins (converter still present)

One-shot migration script writes canonical IR JSON + verifies
versionHash round-trip equals pre-migration oracle. All four
builtins pass.

Files added:
- apps/server/src/scripts/migrate-yaml-to-ir.ts (one-shot; deleted in Task 4)
- apps/server/src/builtin-pipelines/smoke-test/pipeline.ir.json
- apps/server/src/builtin-pipelines/tech-research-collector/pipeline.ir.json
- apps/server/src/builtin-pipelines/tech-research-writer/pipeline.ir.json
- apps/server/src/builtin-pipelines/pipeline-generator/pipeline.ir.json

Test delta: 0 (script not a test)
tsc: 0 errors"
```

---

## Task 2: Switch loader to JSON + delete YAML files

**Files:**
- Create: `apps/server/src/kernel-next/runtime/load-builtin-pipeline.ts`
- Create: `apps/server/src/kernel-next/runtime/load-builtin-pipeline.test.ts`
- Delete: `apps/server/src/kernel-next/runtime/load-legacy-pipeline.ts`
- Delete: `apps/server/src/kernel-next/runtime/load-legacy-pipeline.test.ts`
- Modify: `apps/server/src/routes/kernel-run.ts`
- Modify: `apps/server/src/kernel-next/mcp/server.ts`
- Modify: `apps/server/src/kernel-next/mcp/pg-entry.ts`
- Delete: `apps/server/src/builtin-pipelines/smoke-test/pipeline.yaml`
- Delete: `apps/server/src/builtin-pipelines/tech-research-collector/pipeline.yaml`
- Delete: `apps/server/src/builtin-pipelines/tech-research-writer/pipeline.yaml`
- Delete: `apps/server/src/builtin-pipelines/pipeline-generator/pipeline.yaml`

- [ ] **Step 1: Write the new loader**

Create `apps/server/src/kernel-next/runtime/load-builtin-pipeline.ts`:

```typescript
// load-builtin-pipeline — reads pipeline.ir.json + prompts/ from a
// builtin-pipelines directory and returns the IR + prompts bundle.
//
// Replaces load-legacy-pipeline (which parsed YAML + ran the converter).
// pipeline.ir.json is the canonical on-disk representation; no YAML
// anywhere on this path.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import type { PipelineIR } from "../ir/schema.js";
import { PipelineIRSchema } from "../ir/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_PIPELINES_ROOT = join(__dirname, "..", "..", "builtin-pipelines");

export interface BuiltinPipelineLoadResult {
  ir: PipelineIR;
  pipelineDir: string;
  promptRoot: string;
  prompts: Record<string, string>;
  warnings: Array<{ code: string; message?: string }>;
}

export class BuiltinPipelineLoadError extends Error {
  constructor(
    message: string,
    public readonly diagnostics: Array<{ code: string; message?: string }>,
  ) {
    super(message);
    this.name = "BuiltinPipelineLoadError";
  }
}

function scanPrompts(promptRoot: string): Record<string, string> {
  if (!existsSync(promptRoot)) return {};
  const out: Record<string, string> = {};
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile() && entry.endsWith(".md")) {
        const rel = relative(promptRoot, full).split(sep).join("/");
        const key = rel.slice(0, -".md".length);
        out[key] = readFileSync(full, "utf-8");
      }
    }
  }
  walk(promptRoot);
  return out;
}

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
```

- [ ] **Step 2: Write the test**

Create `apps/server/src/kernel-next/runtime/load-builtin-pipeline.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { loadBuiltinPipelineIR, BuiltinPipelineLoadError } from "./load-builtin-pipeline.js";

describe("loadBuiltinPipelineIR", () => {
  it("loads smoke-test IR + prompts", () => {
    const r = loadBuiltinPipelineIR("smoke-test");
    expect(r.ir.name).toBeTruthy();
    expect(r.ir.stages.length).toBeGreaterThan(0);
    expect(r.pipelineDir).toMatch(/smoke-test$/);
    expect(r.promptRoot).toMatch(/smoke-test\/prompts$/);
    expect(Object.keys(r.prompts).length).toBeGreaterThan(0);
    expect(r.warnings).toEqual([]);
  });

  it("loads pipeline-generator with nested system/ prompts", () => {
    const r = loadBuiltinPipelineIR("pipeline-generator");
    const keys = Object.keys(r.prompts);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k).not.toMatch(/\.md$/);
      expect(k).not.toMatch(/\\/);
    }
    expect(keys.some((k) => k.includes("/"))).toBe(true);
  });

  it("throws BuiltinPipelineLoadError when pipeline.ir.json is missing", () => {
    expect(() => loadBuiltinPipelineIR("no-such-pipeline-xyz")).toThrow(BuiltinPipelineLoadError);
    try {
      loadBuiltinPipelineIR("no-such-pipeline-xyz");
    } catch (err) {
      const e = err as BuiltinPipelineLoadError;
      expect(e.diagnostics[0]?.code).toBe("IR_READ_FAILED");
    }
  });

  it("loads tech-research-collector", () => {
    const r = loadBuiltinPipelineIR("tech-research-collector");
    expect(r.ir.stages.length).toBeGreaterThan(0);
    expect(Object.keys(r.prompts).length).toBeGreaterThan(0);
  });

  it("loads tech-research-writer", () => {
    const r = loadBuiltinPipelineIR("tech-research-writer");
    expect(r.ir.stages.length).toBeGreaterThan(0);
    expect(Object.keys(r.prompts).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run the new test — expect PASS since all 4 JSONs exist from Task 1**

```bash
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run src/kernel-next/runtime/load-builtin-pipeline.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 4: Update `routes/kernel-run.ts`**

Read the current file first:
```bash
grep -n 'loadLegacyPipelineIR\|LegacyPipelineLoadError\|seedLegacyPipelineByName' /Users/minghao/workflow-control/apps/server/src/routes/kernel-run.ts
```

Expected matches: 1 import line, 1 call in `seedLegacyPipelineByName`, 4 function calls at module scope.

Edit `apps/server/src/routes/kernel-run.ts`:

Change the import line:
```typescript
import { loadLegacyPipelineIR } from "../kernel-next/runtime/load-legacy-pipeline.js";
```
to:
```typescript
import { loadBuiltinPipelineIR } from "../kernel-next/runtime/load-builtin-pipeline.js";
```

Inside the seed helper, change:
```typescript
const loaded = loadLegacyPipelineIR(pipelineDir);
```
to:
```typescript
const loaded = loadBuiltinPipelineIR(pipelineDir);
```

Rename the function `seedLegacyPipelineByName` → `seedBuiltinPipelineByName` (and its error message string). Update the 4 module-scope call sites from `seedLegacyPipelineByName(...)` to `seedBuiltinPipelineByName(...)`.

- [ ] **Step 5: Update `kernel-next/mcp/server.ts`**

Read:
```bash
grep -n 'loadLegacyPipelineIR\|load-legacy-pipeline\|LegacyPipelineLoadError' /Users/minghao/workflow-control/apps/server/src/kernel-next/mcp/server.ts
```

Edit:
```typescript
import { loadLegacyPipelineIR } from "../runtime/load-legacy-pipeline.js";
```
becomes:
```typescript
import { loadBuiltinPipelineIR } from "../runtime/load-builtin-pipeline.js";
```

Replace both call sites `loadLegacyPipelineIR("pipeline-generator")` and `loader: loadLegacyPipelineIR` with the new name.

Rename `cachedPipelineGeneratorIR` variable type:
```typescript
let cachedPipelineGeneratorIR: ReturnType<typeof loadLegacyPipelineIR> | undefined;
```
becomes:
```typescript
let cachedPipelineGeneratorIR: ReturnType<typeof loadBuiltinPipelineIR> | undefined;
```

- [ ] **Step 6: Update `kernel-next/mcp/pg-entry.ts`**

Read:
```bash
grep -n 'LegacyPipelineLoadError\|load-legacy-pipeline' /Users/minghao/workflow-control/apps/server/src/kernel-next/mcp/pg-entry.ts
```

Edit:
```typescript
import { LegacyPipelineLoadError } from "../runtime/load-legacy-pipeline.js";
```
becomes:
```typescript
import { BuiltinPipelineLoadError } from "../runtime/load-builtin-pipeline.js";
```

Every `err instanceof LegacyPipelineLoadError` in the file becomes `err instanceof BuiltinPipelineLoadError`.

- [ ] **Step 7: Delete old loader**

```bash
cd /Users/minghao/workflow-control
git rm apps/server/src/kernel-next/runtime/load-legacy-pipeline.ts apps/server/src/kernel-next/runtime/load-legacy-pipeline.test.ts
```

- [ ] **Step 8: Delete YAML files**

```bash
cd /Users/minghao/workflow-control
git rm apps/server/src/builtin-pipelines/smoke-test/pipeline.yaml
git rm apps/server/src/builtin-pipelines/tech-research-collector/pipeline.yaml
git rm apps/server/src/builtin-pipelines/tech-research-writer/pipeline.yaml
git rm apps/server/src/builtin-pipelines/pipeline-generator/pipeline.yaml
```

- [ ] **Step 9: tsc gate**

```bash
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/tsc --noEmit 2>&1 | tail -15
```

Expected: 0 errors. If errors mention `load-legacy-pipeline` or `LegacyPipelineLoadError`, a call site was missed — grep again:

```bash
grep -rn 'loadLegacyPipelineIR\|LegacyPipelineLoadError\|load-legacy-pipeline\|seedLegacyPipelineByName' apps/server/src 2>/dev/null
```

Expected: zero hits. Fix any you find.

- [ ] **Step 10: vitest gate**

```bash
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run 2>&1 | tail -10
```

Expected: 0 failures. Test count may drop by ~2 (from removal of load-legacy-pipeline.test.ts, gained by load-builtin-pipeline.test.ts — net +3 from the new tests with 5 cases vs old 2 cases).

- [ ] **Step 11: Commit**

```bash
cd /Users/minghao/workflow-control && git add -A apps/server/src && git commit -m "feat(retire-converter): swap loader to JSON, delete YAML files

New:
- kernel-next/runtime/load-builtin-pipeline.ts + .test.ts (reads pipeline.ir.json + prompts/)
- BuiltinPipelineLoadError class

Deletions:
- kernel-next/runtime/load-legacy-pipeline.ts + .test.ts
- builtin-pipelines/{smoke-test,tech-research-collector,tech-research-writer,pipeline-generator}/pipeline.yaml (4 files)

Renames:
- routes/kernel-run.ts: seedLegacyPipelineByName -> seedBuiltinPipelineByName
- mcp/server.ts + pg-entry.ts: swap imports

Round-trip versionHashes unchanged from Task 1 (verified).
Test delta: <record>
tsc: 0 errors"
```

---

## Task 3: Move topoDownstream + delete converter + delete YAML tests

**Files:**
- Create: `apps/server/src/kernel-next/runtime/topo-downstream.ts` (moved from converter/)
- Create: `apps/server/src/kernel-next/runtime/topo-downstream.test.ts` (moved from converter/)
- Modify: `apps/server/src/kernel-next/runtime/runner.ts` (import path)
- Delete: `apps/server/src/kernel-next/converter/` (entire directory)
- Delete: `apps/server/src/kernel-next/runtime/pg-inspect.test.ts`
- Delete: `apps/server/src/kernel-next/runtime/pipeline-generator-run.test.ts`

- [ ] **Step 1: Read the topoDownstream files**

```bash
cat /Users/minghao/workflow-control/apps/server/src/kernel-next/converter/topo-downstream.ts
```

Short file, generic graph helper. No converter-specific imports expected.

```bash
cat /Users/minghao/workflow-control/apps/server/src/kernel-next/converter/topo-downstream.test.ts
```

Both are safe to move verbatim.

- [ ] **Step 2: Copy to runtime/ then delete from converter/**

```bash
cd /Users/minghao/workflow-control
git mv apps/server/src/kernel-next/converter/topo-downstream.ts apps/server/src/kernel-next/runtime/topo-downstream.ts
git mv apps/server/src/kernel-next/converter/topo-downstream.test.ts apps/server/src/kernel-next/runtime/topo-downstream.test.ts
```

- [ ] **Step 3: Update runner.ts import**

Read:
```bash
grep -n 'topo-downstream\|topoDownstream' /Users/minghao/workflow-control/apps/server/src/kernel-next/runtime/runner.ts
```

Change:
```typescript
import { topoDownstream } from "../converter/topo-downstream.js";
```
to:
```typescript
import { topoDownstream } from "./topo-downstream.js";
```

- [ ] **Step 4: Delete the 2 YAML-dependent test files**

```bash
cd /Users/minghao/workflow-control
git rm apps/server/src/kernel-next/runtime/pg-inspect.test.ts
git rm apps/server/src/kernel-next/runtime/pipeline-generator-run.test.ts
```

Both files import `convertLegacyYaml` directly and read `pipeline.yaml` files that no longer exist. They served converter regression; post-deletion they're orphan.

- [ ] **Step 5: Delete the converter directory**

```bash
cd /Users/minghao/workflow-control
git rm -r apps/server/src/kernel-next/converter/
```

This removes everything in `converter/` including the 20 files of `legacy-yaml.ts`, `map-*.ts`, `rewrite-retry-back-to.ts`, `unwrap-parallel-blocks.ts`, `types.ts`, their tests, and the pipeline-generator.test.ts inside.

- [ ] **Step 6: Verify migration script no longer compiles**

The migration script imports from converter which is gone. It will break tsc. Delete it too (it was a one-shot, already served its purpose):

```bash
cd /Users/minghao/workflow-control
git rm apps/server/src/scripts/migrate-yaml-to-ir.ts
```

If `scripts/` is now empty, git ignores empty dirs; OK.

- [ ] **Step 7: tsc gate**

```bash
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/tsc --noEmit 2>&1 | tail -15
```

Expected: 0 errors. If errors mention `converter/` — grep for residual imports:

```bash
grep -rn 'from "\.\./converter\|from "\.\./\.\./converter\|from "\.\/converter\|kernel-next/converter/' apps/server/src 2>/dev/null
```

Expected: zero hits in non-comment code. If a test or source file still imports — delete or fix.

- [ ] **Step 8: vitest gate**

```bash
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run 2>&1 | tail -10
```

Expected: 0 failures. Test count drops substantially (20+ converter tests + 2 YAML-dependent runtime tests).

- [ ] **Step 9: Commit**

```bash
cd /Users/minghao/workflow-control && git add -A apps/server/src && git commit -m "feat(retire-converter): delete converter + YAML tests, move topo-downstream

Relocations:
- kernel-next/converter/topo-downstream.ts -> kernel-next/runtime/topo-downstream.ts
- kernel-next/converter/topo-downstream.test.ts -> kernel-next/runtime/topo-downstream.test.ts

Deletions:
- kernel-next/converter/ (entire directory, ~2.2k LOC + 20 test files)
- kernel-next/runtime/pg-inspect.test.ts (YAML-dependent)
- kernel-next/runtime/pipeline-generator-run.test.ts (YAML-dependent; describe.skip)
- scripts/migrate-yaml-to-ir.ts (one-shot, served its purpose in Task 1)

Edits:
- kernel-next/runtime/runner.ts: topoDownstream import path now ./topo-downstream

Test delta: <record>
tsc: 0 errors"
```

---

## Task 4: Cleanup — delete web3-research-writer + docs

**Files:**
- Delete: `apps/server/src/builtin-pipelines/web3-research-writer/` (entire directory)
- Modify: `CLAUDE.md`
- Modify: `docs/product-roadmap.md`
- Modify: `docs/kernel-next-terminal-design.md`
- Create: `docs/superpowers/plans/2026-04-24-retire-converter-done-handoff.md`

- [ ] **Step 1: Confirm web3-research-writer is orphan**

```bash
cd /Users/minghao/workflow-control
grep -rn 'web3-research-writer' apps/server/src apps/web/src 2>/dev/null | head
```

Expected: zero hits (Stage 4a already verified; it was never seeded). If hits appear, investigate.

- [ ] **Step 2: Delete the directory**

```bash
cd /Users/minghao/workflow-control
git rm -r apps/server/src/builtin-pipelines/web3-research-writer/
```

- [ ] **Step 3: Update CLAUDE.md**

Read the `## Retired areas` section added in Stage 4a:

```bash
grep -n 'Retired areas\|kernel-next/converter\|builtin-pipelines' /Users/minghao/workflow-control/CLAUDE.md | head
```

Append the converter retirement to the existing Retired areas section. Find the bullet list and add:

```
- `apps/server/src/kernel-next/converter/` — legacy YAML → IR translator (deleted 2026-04-24 Stage 4b)
- `apps/server/src/builtin-pipelines/web3-research-writer/` — orphan sub-pipeline (deleted 2026-04-24 Stage 4b)
- All `apps/server/src/builtin-pipelines/*/pipeline.yaml` files replaced by `pipeline.ir.json` (canonical IR is the on-disk representation)
```

- [ ] **Step 4: Update docs/product-roadmap.md §4**

Read the Gemini/Codex/Edge row you added in Stage 4a:

```bash
grep -n 'Converter\|converter\|已退役 2026' /Users/minghao/workflow-control/docs/product-roadmap.md | head
```

Add a new row or append to the existing "瘦身清单" table:

```markdown
| Converter (legacy YAML → IR) | **已退役 2026-04-24（Stage 4b）** | 4 个 builtin 改用 pipeline.ir.json canonical form |
```

Add an entry to `## 修订历史`:

```markdown
| 2026-04-24 | 1.3 | Stage 4b 完成：converter 删除，4 个 builtin 固化为 pipeline.ir.json。kernel-next 作为唯一引擎 + 唯一 pipeline 表达形式。 |
```

- [ ] **Step 5: Update docs/kernel-next-terminal-design.md Appendix A**

Read the appendix:

```bash
grep -n 'YAML DSL\|Appendix A' /Users/minghao/workflow-control/docs/kernel-next-terminal-design.md | head
```

Find the row `| YAML DSL | IR (JSON or typescript literal) | ... |` and append a date note:

```markdown
| YAML DSL | IR (JSON or typescript literal) | YAML is a user-facing format; IR is canonical. Converter deleted 2026-04-24. |
```

- [ ] **Step 6: Write done-handoff**

Create `docs/superpowers/plans/2026-04-24-retire-converter-done-handoff.md`:

```markdown
# Stage 4b — Retire Converter — Completion Handoff

Date: 2026-04-24
Branch: main

## Milestone results

Four sequential commits:

| Task | SHA | Subject |
|---|---|---|
| 1 | TBD | generate pipeline.ir.json for 4 builtins (converter still present) |
| 2 | TBD | swap loader to JSON, delete YAML files |
| 3 | TBD | delete converter + YAML tests, move topo-downstream |
| 4 | TBD | cleanup: delete web3-research-writer + docs |

Replace TBD with actual SHAs from `git log --oneline -4`.

## Deletions

- `apps/server/src/kernel-next/converter/` (~2.2k LOC + 20 test files)
- 4× `apps/server/src/builtin-pipelines/<name>/pipeline.yaml`
- `apps/server/src/kernel-next/runtime/load-legacy-pipeline.ts` + test
- `apps/server/src/kernel-next/runtime/pg-inspect.test.ts`
- `apps/server/src/kernel-next/runtime/pipeline-generator-run.test.ts`
- `apps/server/src/builtin-pipelines/web3-research-writer/`
- `apps/server/src/scripts/migrate-yaml-to-ir.ts` (one-shot)

## Creations / Renames

- `apps/server/src/kernel-next/runtime/load-builtin-pipeline.ts` + test
- `BuiltinPipelineLoadError` class (was `LegacyPipelineLoadError`)
- `seedBuiltinPipelineByName` helper (was `seedLegacyPipelineByName`)
- 4× `apps/server/src/builtin-pipelines/<name>/pipeline.ir.json`
- `apps/server/src/kernel-next/runtime/topo-downstream.ts` (moved from converter/)

## Round-trip invariant

All four builtins' versionHashes match pre-migration values:

| Pipeline | versionHash |
|---|---|
| smoke-test | TBD |
| tech-research-collector | TBD |
| tech-research-writer | TBD |
| pipeline-generator | TBD |

Replace TBD with hashes from `/tmp/pre-migration-hashes.txt` (also verified post-migration).

## Test deltas

| Phase | Tests passed | Delta |
|---|---|---|
| Baseline (post Stage 4a) | 1586 | — |
| Task 1 | 1586 | 0 |
| Task 2 | TBD | +3 (new loader tests) − 2 (old loader tests) |
| Task 3 | TBD | large drop from converter/ + YAML tests deletion |
| Task 4 | TBD | 0 (docs only) |

Record actual post-task counts.

## kernel-next invariants preserved

- Server `tsc --noEmit` 0 errors at every task
- Server `vitest run` 0 failures at every task
- Web `tsc --noEmit` 0 errors (no web changes in this milestone)
- kernel-next routes + MCP tools behavior unchanged
- All 4 builtin pipelines still seed into `pipeline_versions` at server startup with same versionHashes

## Follow-ups

- Stage 5: B-series hot-update productionization
- Stage 6: Execution Record sidecar
- Stage 7: Registry sharing + Phase 5 打磨
- (Minor) apps/web/src/lib/ orphan cleanup, apps/web/e2e/tests/ legacy specs, config schema gemini_executable/codex_executable stale fields
```

Replace TBDs after Task 4 commit lands.

- [ ] **Step 7: Commit**

```bash
cd /Users/minghao/workflow-control && git add -A apps/server/src CLAUDE.md docs/ && git commit -m "docs(retire-converter): cleanup + handoff

Deletions:
- apps/server/src/builtin-pipelines/web3-research-writer/ (orphan from Stage 4a)

Edits:
- CLAUDE.md Retired areas: append converter + web3-research-writer + YAML-to-JSON migration
- docs/product-roadmap.md §4: Converter row + v1.3 修订历史
- docs/kernel-next-terminal-design.md Appendix A: YAML DSL row date-stamp
- docs/superpowers/plans/2026-04-24-retire-converter-done-handoff.md created"
```

- [ ] **Step 8: Final verification**

```bash
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run 2>&1 | tail -5
cd /Users/minghao/workflow-control/apps/web && ./node_modules/.bin/tsc --noEmit
```

Expected: 0 errors everywhere.

Residual grep:
```bash
cd /Users/minghao/workflow-control/apps/server/src
grep -rn 'from "\.\./converter\|from "\.\./\.\./converter\|loadLegacyPipelineIR\|LegacyPipelineLoadError\|seedLegacyPipelineByName\|load-legacy-pipeline\|convertLegacyYaml\|legacy-yaml' . --include='*.ts' 2>/dev/null
```

Expected: zero hits. If any, they're residual and need cleanup in a follow-up commit.

- [ ] **Step 9: Fill TBDs in handoff and amend commit**

After Step 8 passes, edit `docs/superpowers/plans/2026-04-24-retire-converter-done-handoff.md` to replace TBD markers with actual SHAs, versionHashes, and test counts from the recorded pre-migration file + each Task commit.

```bash
cd /Users/minghao/workflow-control && git add docs/superpowers/plans/2026-04-24-retire-converter-done-handoff.md && git commit --amend --no-edit
```

---

## Self-Review

**1. Spec coverage:**

| Spec SC | Task |
|---|---|
| SC 1 delete converter | Task 3 |
| SC 2 delete 4 pipeline.yaml | Task 2 Step 8 |
| SC 3 create 4 pipeline.ir.json | Task 1 |
| SC 4 round-trip versionHash | Task 1 Step 2-3 |
| SC 5 rename loader | Task 2 |
| SC 6 rename seed helper | Task 2 Step 4 |
| SC 7 move topoDownstream | Task 3 Steps 1-3 |
| SC 8 delete web3-research-writer | Task 4 Step 2 |
| SC 9 delete YAML tests | Task 3 Step 4 |
| SC 10 rename error class | Task 2 Steps 1, 6 |
| SC 11 tsc + vitest clean | Every task gate + Task 4 Step 8 |
| SC 12 E2E smoke | Not automated — manual post-milestone |

**2. Placeholder scan:** No `TBD` / `TODO` in the plan body. Handoff doc has explicit `TBD` placeholders for data-to-be-recorded — acceptable (Task 4 Step 9 fills them).

**3. Type consistency:**

- `BuiltinPipelineLoadResult.warnings: Array<{ code: string; message?: string }>` — consistent between Task 2 Step 1 (definition) and Task 2 Step 2 (test asserts `[]`).
- `BuiltinPipelineLoadError.diagnostics` — same shape as legacy version.
- `loadBuiltinPipelineIR(pipelineDir: string): BuiltinPipelineLoadResult` — consistent across Tasks 2, 3 consumers.
- File path constants (`BUILTIN_PIPELINES_ROOT`) derivation identical in loader and migration script.
- `pipeline.ir.json` filename is used verbatim everywhere.
- `topoDownstream` signature unchanged (move-only).

All consistent.
