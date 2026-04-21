# Prompts in SQLite — Slice 1 Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move prompts from the filesystem into SQLite as content-addressed rows that participate in `pipelineVersionHash`, introduce `DbPromptResolver`, and keep every currently-registered kernel-next pipeline running end-to-end.

**Architecture:** Two new tables (`prompt_contents`, `pipeline_prompt_refs`) + content-addressed hashing. `KernelService.submit` gains `prompts: Record<string, string>` parameter. `loadLegacyPipelineIR` scans disk prompts. `registerLegacyPipeline` submits IR+prompts on module load and binds the resulting `versionHash` to a `DbPromptResolver` used by the executor factory.

**Tech Stack:** TypeScript, Zod, Vitest, node:sqlite (DatabaseSync), Hono.

**Spec:** `docs/superpowers/specs/2026-04-24-prompts-in-sqlite-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `apps/server/src/kernel-next/ir/sql.ts` | Add `prompt_contents` + `pipeline_prompt_refs` DDL; add `insertPromptContent` + `insertPromptRefs` + `getPromptContent` helpers; make `insertPipelineVersion` idempotent (INSERT OR IGNORE) |
| Modify | `apps/server/src/kernel-next/ir/canonical.ts` | Add `normalizePromptContent`, `promptContentHash`, `canonicalizePipeline`, `pipelineCanonicalJSON`, `pipelineVersionHash` |
| Create | `apps/server/src/kernel-next/ir/canonical.prompts.test.ts` | Unit tests for the new prompt-aware canonical helpers |
| Create | `apps/server/src/kernel-next/runtime/db-prompt-resolver.ts` | `DbPromptResolver` implementing `PromptResolver` backed by SQLite |
| Create | `apps/server/src/kernel-next/runtime/db-prompt-resolver.test.ts` | Unit tests for DbPromptResolver |
| Modify | `apps/server/src/kernel-next/mcp/kernel.ts` | Extend `KernelService.submit` to accept `{ ir, prompts }` input; persist prompts alongside IR in one transaction; emit `PROMPT_REF_MISSING` / `PROMPT_REF_UNUSED` / `PROMPT_CONTENT_EMPTY` diagnostics |
| Modify | `apps/server/src/kernel-next/mcp/kernel.test.ts` | Cover new submit shape, dedup semantics, diagnostic cases |
| Modify | `apps/server/src/kernel-next/runtime/load-legacy-pipeline.ts` | Scan `<pipelineDir>/prompts/**/*.md` recursively and return `prompts: Record<string, string>` |
| Modify | `apps/server/src/kernel-next/runtime/load-legacy-pipeline.test.ts` | Cover prompt scanning: nested paths, `.md`-only, missing dir |
| Modify | `apps/server/src/routes/kernel-run.ts` | `registerLegacyPipeline` submits IR+prompts on module load via `KernelService.submit` and wires `DbPromptResolver(db, versionHash)` into `RealStageExecutor` |
| Modify | `apps/server/src/routes/kernel-run.test.ts` | Assert prompts table populated after module load; assert each registered pipeline runs |
| Modify | `apps/server/src/kernel-next/mcp/pg-entry.ts` | Use new submit signature + DbPromptResolver |
| Modify | `apps/server/src/kernel-next/mcp/pg-entry.test.ts` | Adjust fixtures to supply prompts |
| Modify | `apps/server/src/kernel-next/ir/sql.test.ts` | Cover new tables (dedup, FK, index) |
| Modify | `apps/server/src/kernel-next/ir/canonical.test.ts` | Preserve existing IR-only baseline hashes; new pipeline-level hash goldens live in `canonical.prompts.test.ts` |

---

## Task 1: DDL for prompt_contents + pipeline_prompt_refs

**Files:**
- Modify: `apps/server/src/kernel-next/ir/sql.ts`
- Modify: `apps/server/src/kernel-next/ir/sql.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/kernel-next/ir/sql.test.ts` inside the existing `describe("initKernelNextSchema", ...)` block:

```typescript
it("creates prompt_contents table with content_hash PK", () => {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  const cols = db.prepare("PRAGMA table_info(prompt_contents)").all() as Array<{ name: string; pk: number }>;
  const names = cols.map((c) => c.name).sort();
  expect(names).toEqual(["content", "content_hash", "created_at"]);
  const pk = cols.find((c) => c.name === "content_hash");
  expect(pk?.pk).toBe(1);
});

it("creates pipeline_prompt_refs table with composite PK and FK to prompt_contents", () => {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  const cols = db.prepare("PRAGMA table_info(pipeline_prompt_refs)").all() as Array<{ name: string; pk: number }>;
  const names = cols.map((c) => c.name).sort();
  expect(names).toEqual(["content_hash", "prompt_ref", "version_hash"]);
  const fks = db.prepare("PRAGMA foreign_key_list(pipeline_prompt_refs)").all() as Array<{ table: string; from: string; to: string }>;
  expect(fks.some((fk) => fk.table === "prompt_contents" && fk.from === "content_hash")).toBe(true);
  expect(fks.some((fk) => fk.table === "pipeline_versions" && fk.from === "version_hash")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && ./node_modules/.bin/vitest run src/kernel-next/ir/sql.test.ts`
Expected: FAIL — `no such table: prompt_contents` or the assertion fails.

- [ ] **Step 3: Add DDL**

In `apps/server/src/kernel-next/ir/sql.ts`, append to the `KERNEL_NEXT_SCHEMA` template string (just before the closing backtick):

```sql
CREATE TABLE IF NOT EXISTS prompt_contents (
  content_hash TEXT PRIMARY KEY,
  content      TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pipeline_prompt_refs (
  version_hash TEXT NOT NULL REFERENCES pipeline_versions(version_hash),
  prompt_ref   TEXT NOT NULL,
  content_hash TEXT NOT NULL REFERENCES prompt_contents(content_hash),
  PRIMARY KEY (version_hash, prompt_ref)
);

CREATE INDEX IF NOT EXISTS idx_ppr_content
  ON pipeline_prompt_refs(content_hash);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && ./node_modules/.bin/vitest run src/kernel-next/ir/sql.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/ir/sql.ts apps/server/src/kernel-next/ir/sql.test.ts
git commit -m "feat(sql): prompt_contents + pipeline_prompt_refs tables"
```

---

## Task 2: insertPromptContent + insertPromptRefs helpers

**Files:**
- Modify: `apps/server/src/kernel-next/ir/sql.ts`
- Modify: `apps/server/src/kernel-next/ir/sql.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `sql.test.ts`:

```typescript
describe("insertPromptContent + insertPromptRefs", () => {
  it("inserts content once and is idempotent on same content_hash", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    insertPromptContent(db, "abc123", "hello world");
    insertPromptContent(db, "abc123", "hello world");
    const rows = db.prepare("SELECT content_hash FROM prompt_contents").all();
    expect(rows.length).toBe(1);
  });

  it("inserts prompt refs referencing an existing version and content", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    // Seed a dummy pipeline_version row for FK satisfaction.
    db.prepare(
      `INSERT INTO pipeline_versions (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
       VALUES ('v1', 'test', 0, NULL, '{}', '')`,
    ).run();
    insertPromptContent(db, "h1", "content1");
    insertPromptRefs(db, "v1", { analyzing: "h1", "system/analysis": "h1" });
    const rows = db
      .prepare("SELECT prompt_ref, content_hash FROM pipeline_prompt_refs WHERE version_hash = ? ORDER BY prompt_ref")
      .all("v1") as Array<{ prompt_ref: string; content_hash: string }>;
    expect(rows).toEqual([
      { prompt_ref: "analyzing", content_hash: "h1" },
      { prompt_ref: "system/analysis", content_hash: "h1" },
    ]);
  });

  it("insertPromptRefs is idempotent on same (version_hash, prompt_ref)", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    db.prepare(
      `INSERT INTO pipeline_versions (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
       VALUES ('v1', 'test', 0, NULL, '{}', '')`,
    ).run();
    insertPromptContent(db, "h1", "c1");
    insertPromptRefs(db, "v1", { analyzing: "h1" });
    insertPromptRefs(db, "v1", { analyzing: "h1" });
    const rows = db.prepare("SELECT prompt_ref FROM pipeline_prompt_refs WHERE version_hash = ?").all("v1");
    expect(rows.length).toBe(1);
  });

  it("getPromptContent returns null for missing content_hash", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    expect(getPromptContent(db, "missing")).toBeNull();
  });
});
```

Add the import line at the top of the test file:

```typescript
import { insertPromptContent, insertPromptRefs, getPromptContent } from "./sql.js";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && ./node_modules/.bin/vitest run src/kernel-next/ir/sql.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement the helpers**

Append to `apps/server/src/kernel-next/ir/sql.ts`:

```typescript
export function insertPromptContent(
  db: DatabaseSync,
  contentHash: string,
  content: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO prompt_contents (content_hash, content, created_at)
     VALUES (?, ?, ?)`,
  ).run(contentHash, content, Date.now());
}

export function insertPromptRefs(
  db: DatabaseSync,
  versionHash: string,
  refs: Record<string, string>,
): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO pipeline_prompt_refs (version_hash, prompt_ref, content_hash)
     VALUES (?, ?, ?)`,
  );
  for (const [ref, contentHash] of Object.entries(refs)) {
    stmt.run(versionHash, ref, contentHash);
  }
}

export function getPromptContent(
  db: DatabaseSync,
  contentHash: string,
): string | null {
  const row = db
    .prepare(`SELECT content FROM prompt_contents WHERE content_hash = ?`)
    .get(contentHash) as { content: string } | undefined;
  return row ? row.content : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && ./node_modules/.bin/vitest run src/kernel-next/ir/sql.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/ir/sql.ts apps/server/src/kernel-next/ir/sql.test.ts
git commit -m "feat(sql): insertPromptContent/insertPromptRefs/getPromptContent helpers"
```

---

## Task 3: Make insertPipelineVersion idempotent

**Files:**
- Modify: `apps/server/src/kernel-next/ir/sql.ts`
- Modify: `apps/server/src/kernel-next/ir/sql.test.ts`

**Why:** Task 8 (registerLegacyPipeline) will call `submit` every module load. Currently the second call throws `UNIQUE constraint failed: pipeline_versions.version_hash` because `insertPipelineVersion` is not idempotent at the pipeline_versions row level. `KernelService.submit` does a pre-check via `getPipelineIR`, which works, but a race (two in-flight calls) still hits the constraint. Harden the inner function.

- [ ] **Step 1: Write the failing test**

Append to `sql.test.ts`:

```typescript
describe("insertPipelineVersion idempotency", () => {
  it("is a no-op when called twice with the same versionHash", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const ir: PipelineIR = {
      name: "tiny",
      stages: [{
        name: "a", type: "script", inputs: [], outputs: [],
        config: { moduleId: "m" },
      }],
      wires: [],
    };
    insertPipelineVersion(db, ir, { versionHash: "h1", tsSource: "" });
    insertPipelineVersion(db, ir, { versionHash: "h1", tsSource: "" });
    const rows = db.prepare("SELECT version_hash FROM pipeline_versions").all();
    expect(rows.length).toBe(1);
  });
});
```

Ensure `PipelineIR` is imported at the top of the test file if not already.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && ./node_modules/.bin/vitest run src/kernel-next/ir/sql.test.ts`
Expected: FAIL — `UNIQUE constraint failed: pipeline_versions.version_hash`.

- [ ] **Step 3: Make the inserts idempotent**

In `apps/server/src/kernel-next/ir/sql.ts` `insertPipelineVersion`, change the existing inserts to use `INSERT OR IGNORE`:

Replace the four prepared statements inside the `try` block:

```typescript
    db.prepare(
      `INSERT OR IGNORE INTO pipeline_versions
       (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      meta.versionHash,
      ir.name,
      now,
      meta.parentHash ?? null,
      JSON.stringify(ir),
      meta.tsSource,
    );

    const insertStage = db.prepare(
      `INSERT OR IGNORE INTO stages (version_hash, stage_name, stage_type, config_json)
       VALUES (?, ?, ?, ?)`,
    );
    const insertPort = db.prepare(
      `INSERT OR IGNORE INTO ports
       (version_hash, stage_name, port_name, direction, type_signature, zod_schema)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertWire = db.prepare(
      `INSERT OR IGNORE INTO wires
       (version_hash, from_stage, from_port, to_stage, to_port)
       VALUES (?, ?, ?, ?, ?)`,
    );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && ./node_modules/.bin/vitest run src/kernel-next/ir/sql.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/ir/sql.ts apps/server/src/kernel-next/ir/sql.test.ts
git commit -m "fix(sql): insertPipelineVersion idempotent via INSERT OR IGNORE"
```

---

## Task 4: normalizePromptContent + promptContentHash

**Files:**
- Modify: `apps/server/src/kernel-next/ir/canonical.ts`
- Create: `apps/server/src/kernel-next/ir/canonical.prompts.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/kernel-next/ir/canonical.prompts.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  normalizePromptContent,
  promptContentHash,
} from "./canonical.js";

describe("normalizePromptContent", () => {
  it("strips UTF-8 BOM", () => {
    expect(normalizePromptContent("\uFEFFhello\n")).toBe("hello\n");
  });

  it("converts CRLF and lone CR to LF", () => {
    expect(normalizePromptContent("a\r\nb\rc\n")).toBe("a\nb\nc\n");
  });

  it("strips trailing whitespace per line", () => {
    expect(normalizePromptContent("hi  \n  there\t\n")).toBe("hi\n  there\n");
  });

  it("appends a trailing newline when missing", () => {
    expect(normalizePromptContent("hi")).toBe("hi\n");
  });

  it("keeps a single trailing newline intact", () => {
    expect(normalizePromptContent("hi\n")).toBe("hi\n");
  });
});

describe("promptContentHash", () => {
  it("hashes equivalent content to the same digest regardless of CRLF/BOM/trailing-space", () => {
    const a = promptContentHash("hello\n");
    const b = promptContentHash("\uFEFFhello  \r\n");
    expect(a).toBe(b);
  });

  it("returns a 64-char hex sha256", () => {
    const h = promptContentHash("x");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when normalized content differs", () => {
    expect(promptContentHash("a")).not.toBe(promptContentHash("b"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && ./node_modules/.bin/vitest run src/kernel-next/ir/canonical.prompts.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement the helpers**

Append to `apps/server/src/kernel-next/ir/canonical.ts`:

```typescript
/**
 * Normalize prompt content to prevent hash drift from editor-induced
 * whitespace differences:
 *   - Strip UTF-8 BOM
 *   - Normalize CRLF and lone CR to LF
 *   - Strip trailing spaces/tabs per line
 *   - Ensure exactly one trailing LF
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && ./node_modules/.bin/vitest run src/kernel-next/ir/canonical.prompts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/ir/canonical.ts apps/server/src/kernel-next/ir/canonical.prompts.test.ts
git commit -m "feat(canonical): normalizePromptContent + promptContentHash"
```

---

## Task 5: canonicalizePipeline + pipelineVersionHash

**Files:**
- Modify: `apps/server/src/kernel-next/ir/canonical.ts`
- Modify: `apps/server/src/kernel-next/ir/canonical.prompts.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `canonical.prompts.test.ts`:

```typescript
import {
  canonicalizePipeline,
  pipelineCanonicalJSON,
  pipelineVersionHash,
} from "./canonical.js";
import type { PipelineIR } from "./schema.js";

const tinyIR: PipelineIR = {
  name: "tiny",
  stages: [{
    name: "a",
    type: "agent",
    inputs: [],
    outputs: [],
    config: { promptRef: "a" },
  }],
  wires: [],
};

describe("canonicalizePipeline", () => {
  it("sorts prompt keys by codepoint independent of input order", () => {
    const c1 = canonicalizePipeline({ ir: tinyIR, prompts: { b: "B", a: "A" } });
    const c2 = canonicalizePipeline({ ir: tinyIR, prompts: { a: "A", b: "B" } });
    expect(JSON.stringify(c1)).toBe(JSON.stringify(c2));
  });

  it("embeds sha256:<hex> references for each prompt", () => {
    const c = canonicalizePipeline({ ir: tinyIR, prompts: { a: "hello" } });
    const s = JSON.stringify(c);
    expect(s).toMatch(/"a":"sha256:[0-9a-f]{64}"/);
  });
});

describe("pipelineVersionHash", () => {
  it("differs when a prompt changes but IR is the same", () => {
    const h1 = pipelineVersionHash({ ir: tinyIR, prompts: { a: "v1" } });
    const h2 = pipelineVersionHash({ ir: tinyIR, prompts: { a: "v2" } });
    expect(h1).not.toBe(h2);
  });

  it("differs when IR changes but prompts are the same", () => {
    const ir2: PipelineIR = {
      ...tinyIR,
      stages: [{ ...tinyIR.stages[0]!, name: "b" }],
    };
    expect(
      pipelineVersionHash({ ir: tinyIR, prompts: { a: "x" } }),
    ).not.toBe(
      pipelineVersionHash({ ir: ir2, prompts: { a: "x" } }),
    );
  });

  it("is stable across whitespace-only changes in prompts", () => {
    const h1 = pipelineVersionHash({ ir: tinyIR, prompts: { a: "hello\n" } });
    const h2 = pipelineVersionHash({ ir: tinyIR, prompts: { a: "\uFEFFhello  \r\n" } });
    expect(h1).toBe(h2);
  });

  it("empty prompts map is a distinct hash from an IR with no prompts map (no-arg versionHash)", () => {
    const { versionHash } = require("./canonical.js") as typeof import("./canonical.js");
    const pipelineHash = pipelineVersionHash({ ir: tinyIR, prompts: {} });
    const irOnlyHash = versionHash(tinyIR);
    expect(pipelineHash).not.toBe(irOnlyHash);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && ./node_modules/.bin/vitest run src/kernel-next/ir/canonical.prompts.test.ts`
Expected: FAIL — `canonicalizePipeline` / `pipelineCanonicalJSON` / `pipelineVersionHash` not exported.

- [ ] **Step 3: Implement the helpers**

Append to `apps/server/src/kernel-next/ir/canonical.ts`:

```typescript
/**
 * Canonical body for a pipeline = canonical IR + sorted promptRef→contentHash map.
 * Shape: { ir: <canonicalIR>, prompts: { <promptRef>: "sha256:<hex>" } }.
 * Empty prompts map is valid and produces a distinct hash from the IR-only one.
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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && ./node_modules/.bin/vitest run src/kernel-next/ir/canonical.prompts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/ir/canonical.ts apps/server/src/kernel-next/ir/canonical.prompts.test.ts
git commit -m "feat(canonical): canonicalizePipeline + pipelineVersionHash"
```

---

## Task 6: DbPromptResolver

**Files:**
- Create: `apps/server/src/kernel-next/runtime/db-prompt-resolver.ts`
- Create: `apps/server/src/kernel-next/runtime/db-prompt-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/kernel-next/runtime/db-prompt-resolver.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  initKernelNextSchema,
  insertPromptContent,
  insertPromptRefs,
} from "../ir/sql.js";
import { DbPromptResolver } from "./db-prompt-resolver.js";
import type { AgentStage } from "../ir/schema.js";

function seed(db: DatabaseSync, versionHash: string, refs: Record<string, string>) {
  db.prepare(
    `INSERT INTO pipeline_versions (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
     VALUES (?, 'test', 0, NULL, '{}', '')`,
  ).run(versionHash);
  const hashToContent = new Map<string, string>();
  const refsToHash: Record<string, string> = {};
  let i = 0;
  for (const [ref, content] of Object.entries(refs)) {
    const h = `h${i++}`;
    insertPromptContent(db, h, content);
    refsToHash[ref] = h;
    hashToContent.set(h, content);
  }
  insertPromptRefs(db, versionHash, refsToHash);
}

function agentStage(name: string, promptRef: string): AgentStage {
  return { name, type: "agent", inputs: [], outputs: [], config: { promptRef } };
}

describe("DbPromptResolver", () => {
  it("returns stored prompt content for the bound versionHash", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seed(db, "v1", { analyzing: "ANALYZE ME" });
    const r = new DbPromptResolver(db, "v1");
    const out = r.resolve({
      stage: agentStage("analyzing", "analyzing"),
      taskId: "t", attemptId: "a", inputs: {},
    });
    expect(out).toBe("ANALYZE ME");
  });

  it("supports nested / path-style promptRefs", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seed(db, "v1", { "system/analysis": "DEEP" });
    const r = new DbPromptResolver(db, "v1");
    const out = r.resolve({
      stage: agentStage("s", "system/analysis"),
      taskId: "t", attemptId: "a", inputs: {},
    });
    expect(out).toBe("DEEP");
  });

  it("throws a helpful error when promptRef is missing", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seed(db, "v1", { a: "X" });
    const r = new DbPromptResolver(db, "v1");
    expect(() =>
      r.resolve({ stage: agentStage("s", "missing"), taskId: "t", attemptId: "a", inputs: {} }),
    ).toThrow(/promptRef 'missing' not found.*v1.*stage 's'/);
  });

  it("throws when promptRef is empty on stage", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seed(db, "v1", {});
    const r = new DbPromptResolver(db, "v1");
    expect(() =>
      r.resolve({ stage: agentStage("s", ""), taskId: "t", attemptId: "a", inputs: {} }),
    ).toThrow(/empty promptRef/);
  });

  it("distinguishes two versions with same promptRef but different content", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seed(db, "v1", { a: "old" });
    seed(db, "v2", { a: "new" });
    const r1 = new DbPromptResolver(db, "v1");
    const r2 = new DbPromptResolver(db, "v2");
    const args = { stage: agentStage("s", "a"), taskId: "t", attemptId: "a", inputs: {} };
    expect(r1.resolve(args)).toBe("old");
    expect(r2.resolve(args)).toBe("new");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && ./node_modules/.bin/vitest run src/kernel-next/runtime/db-prompt-resolver.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement DbPromptResolver**

Create `apps/server/src/kernel-next/runtime/db-prompt-resolver.ts`:

```typescript
// DbPromptResolver — SQLite-backed prompt lookup for kernel-next.
// See docs/superpowers/specs/2026-04-24-prompts-in-sqlite-design.md §7.

import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { PromptResolveArgs, PromptResolver } from "./prompt-resolver.js";

export class DbPromptResolver implements PromptResolver {
  private readonly lookupStmt: StatementSync;

  constructor(
    private readonly db: DatabaseSync,
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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && ./node_modules/.bin/vitest run src/kernel-next/runtime/db-prompt-resolver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/runtime/db-prompt-resolver.ts apps/server/src/kernel-next/runtime/db-prompt-resolver.test.ts
git commit -m "feat(runtime): DbPromptResolver — SQLite-backed prompt lookup"
```

---

## Task 7: Extend KernelService.submit to accept prompts

**Files:**
- Modify: `apps/server/src/kernel-next/mcp/kernel.ts`
- Modify: `apps/server/src/kernel-next/mcp/kernel.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/kernel-next/mcp/kernel.test.ts` (inside the existing `describe("KernelService.submit", ...)` block; create one if absent):

```typescript
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelService } from "./kernel.js";
import type { PipelineIR } from "../ir/schema.js";

function agentOnlyIR(): PipelineIR {
  return {
    name: "pg",
    stages: [{
      name: "a",
      type: "agent",
      inputs: [],
      outputs: [{ name: "out", type: "string" }],
      config: { promptRef: "a" },
    }],
    wires: [],
  };
}

describe("KernelService.submit with prompts", () => {
  it("accepts { ir, prompts } and records pipeline_prompt_refs", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const ir = agentOnlyIR();
    const res = svc.submit(ir, { prompts: { a: "HELLO" } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const rows = db
      .prepare("SELECT prompt_ref, content_hash FROM pipeline_prompt_refs WHERE version_hash = ?")
      .all(res.versionHash);
    expect(rows.length).toBe(1);
  });

  it("dedups content across two submits with the same prompt text", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const irA = agentOnlyIR();
    const irB: PipelineIR = { ...agentOnlyIR(), name: "pg2" };
    svc.submit(irA, { prompts: { a: "SHARED" } });
    svc.submit(irB, { prompts: { a: "SHARED" } });
    const contentRows = db.prepare("SELECT content_hash FROM prompt_contents").all();
    expect(contentRows.length).toBe(1);
  });

  it("is idempotent on repeat submit of same { ir, prompts }", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const ir = agentOnlyIR();
    const r1 = svc.submit(ir, { prompts: { a: "X" } });
    const r2 = svc.submit(ir, { prompts: { a: "X" } });
    expect(r1.ok && r2.ok && r1.versionHash === r2.versionHash).toBe(true);
  });

  it("emits PROMPT_REF_MISSING when an AgentStage promptRef is not in prompts", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const res = svc.submit(agentOnlyIR(), { prompts: {} });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.diagnostics.some((d) => d.code === "PROMPT_REF_MISSING")).toBe(true);
  });

  it("emits PROMPT_REF_UNUSED when prompts contains keys no AgentStage references", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const res = svc.submit(agentOnlyIR(), { prompts: { a: "X", orphan: "Y" } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.diagnostics.some((d) => d.code === "PROMPT_REF_UNUSED")).toBe(true);
  });

  it("emits PROMPT_CONTENT_EMPTY on whitespace-only prompt content", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const res = svc.submit(agentOnlyIR(), { prompts: { a: "   \n  " } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.diagnostics.some((d) => d.code === "PROMPT_CONTENT_EMPTY")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && ./node_modules/.bin/vitest run src/kernel-next/mcp/kernel.test.ts`
Expected: FAIL — `submit` signature doesn't accept `{ prompts }`.

- [ ] **Step 3: Extend submit signature and logic**

In `apps/server/src/kernel-next/mcp/kernel.ts`:

1. Add to the top-of-file imports alongside existing sql imports:

```typescript
import {
  getPipelineIR,
  insertPipelineVersion,
  insertPromptContent,
  insertPromptRefs,
} from "../ir/sql.js";
import { pipelineVersionHash, promptContentHash, normalizePromptContent } from "../ir/canonical.js";
```

(Merge these with whatever imports already exist; don't duplicate `getPipelineIR` / `insertPipelineVersion`.)

2. Add the `DiagnosticSchema` codes. Open `apps/server/src/kernel-next/ir/schema.ts`, find the `DiagnosticSchema` enum, and add three new codes in the appropriate section (near the related validation codes):

```typescript
"PROMPT_REF_MISSING",
"PROMPT_REF_UNUSED",
"PROMPT_CONTENT_EMPTY",
```

3. Replace the existing `submit` method body with:

```typescript
  /** Validate and, if ok, persist a new pipeline version with its prompts. */
  submit(
    ir: unknown,
    options: { parentHash?: string; prompts?: Record<string, string> } = {},
  ): SubmitResult {
    const result = this.validate(ir);
    if (!result.ok) return { ok: false, diagnostics: result.diagnostics };

    const pipeline = PipelineIRSchema.parse(ir);
    const prompts = options.prompts ?? {};

    // Collect AgentStage promptRefs.
    const agentPromptRefs = new Set<string>();
    for (const s of pipeline.stages) {
      if (s.type === "agent" && s.config.promptRef) {
        agentPromptRefs.add(s.config.promptRef);
      }
    }
    const providedRefs = new Set(Object.keys(prompts));

    const diagnostics: Diagnostic[] = [];
    for (const ref of agentPromptRefs) {
      if (!providedRefs.has(ref)) {
        diagnostics.push({
          code: "PROMPT_REF_MISSING",
          message: `prompt for AgentStage promptRef '${ref}' was not supplied`,
          context: { promptRef: ref },
        });
      }
    }
    for (const ref of providedRefs) {
      if (!agentPromptRefs.has(ref)) {
        diagnostics.push({
          code: "PROMPT_REF_UNUSED",
          message: `prompt '${ref}' is not referenced by any AgentStage`,
          context: { promptRef: ref },
        });
      }
    }
    for (const [ref, content] of Object.entries(prompts)) {
      if (normalizePromptContent(content).trim().length === 0) {
        diagnostics.push({
          code: "PROMPT_CONTENT_EMPTY",
          message: `prompt '${ref}' has empty content after normalization`,
          context: { promptRef: ref },
        });
      }
    }
    if (diagnostics.length > 0) return { ok: false, diagnostics };

    const hash = pipelineVersionHash({ ir: pipeline, prompts });

    // Dedup: if version already exists, do not re-insert.
    if (getPipelineIR(this.db, hash) !== null) {
      const { source } = emitPipelineModule(pipeline);
      return { ok: true, versionHash: hash, tsSource: source };
    }

    const { source } = emitPipelineModule(pipeline);

    // Persist IR + prompts in one atomic transaction.
    this.db.exec("BEGIN");
    try {
      insertPipelineVersion(this.db, pipeline, {
        versionHash: hash,
        parentHash: options.parentHash,
        tsSource: source,
      });
      const refsMap: Record<string, string> = {};
      for (const [ref, content] of Object.entries(prompts)) {
        const ch = promptContentHash(content);
        insertPromptContent(this.db, ch, normalizePromptContent(content));
        refsMap[ref] = ch;
      }
      insertPromptRefs(this.db, hash, refsMap);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    return { ok: true, versionHash: hash, tsSource: source };
  }
```

Ensure `Diagnostic` is imported (it is already, since `ValidateResponse` uses it; confirm).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && ./node_modules/.bin/vitest run src/kernel-next/mcp/kernel.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the rest of the kernel test file still passes**

Run: `cd apps/server && ./node_modules/.bin/vitest run src/kernel-next/mcp/kernel.test.ts`
Expected: all tests PASS. If any existing test in the file calls `svc.submit(ir)` without prompts on an IR containing agent stages, it now fails with `PROMPT_REF_MISSING` — update those fixtures in the same commit by supplying a `prompts: { <ref>: "..." }` map, or switch those IRs to script-only.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/kernel-next/ir/schema.ts apps/server/src/kernel-next/mcp/kernel.ts apps/server/src/kernel-next/mcp/kernel.test.ts
git commit -m "feat(kernel): KernelService.submit accepts prompts, persists to SQLite"
```

---

## Task 8: Extend loadLegacyPipelineIR to scan disk prompts

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/load-legacy-pipeline.ts`
- Modify: `apps/server/src/kernel-next/runtime/load-legacy-pipeline.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/kernel-next/runtime/load-legacy-pipeline.test.ts`:

```typescript
it("returns a prompts map scanned from <pipelineDir>/prompts/**/*.md", () => {
  // smoke-test ships at least one prompt; confirm the map is populated.
  const result = loadLegacyPipelineIR("smoke-test");
  expect(Object.keys(result.prompts).length).toBeGreaterThan(0);
  for (const v of Object.values(result.prompts)) {
    expect(typeof v).toBe("string");
    expect(v.length).toBeGreaterThan(0);
  }
});

it("uses /-joined relative paths without .md for nested prompts", () => {
  // pipeline-generator has prompts/system/*.md
  const result = loadLegacyPipelineIR("pipeline-generator");
  const keys = Object.keys(result.prompts);
  // Every key must not end in .md and must use / not \
  for (const k of keys) {
    expect(k).not.toMatch(/\.md$/);
    expect(k).not.toMatch(/\\/);
  }
  // Expect at least one nested key
  expect(keys.some((k) => k.includes("/"))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && ./node_modules/.bin/vitest run src/kernel-next/runtime/load-legacy-pipeline.test.ts`
Expected: FAIL — `result.prompts` undefined.

- [ ] **Step 3: Implement prompt scanning**

Replace `apps/server/src/kernel-next/runtime/load-legacy-pipeline.ts`:

```typescript
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { convertLegacyYaml } from "../converter/legacy-yaml.js";
import type { PipelineIR } from "../ir/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_PIPELINES_ROOT = join(__dirname, "..", "..", "builtin-pipelines");

export interface LegacyPipelineLoadResult {
  ir: PipelineIR;
  promptRoot: string;
  yamlFilePath: string;
  warnings: Array<{ code: string; message?: string }>;
  prompts: Record<string, string>;
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
        const rel = relative(promptRoot, full).replace(new RegExp(`\\${sep}`, "g"), "/");
        const key = rel.slice(0, -".md".length);
        out[key] = readFileSync(full, "utf-8");
      }
    }
  }
  walk(promptRoot);
  return out;
}

export function loadLegacyPipelineIR(pipelineDir: string): LegacyPipelineLoadResult {
  const yamlFilePath = join(BUILTIN_PIPELINES_ROOT, pipelineDir, "pipeline.yaml");
  let yamlText: string;
  try {
    yamlText = readFileSync(yamlFilePath, "utf-8");
  } catch (err) {
    throw new LegacyPipelineLoadError(
      `failed to read pipeline YAML at ${yamlFilePath}: ${(err as Error).message}`,
      [{ code: "YAML_READ_FAILED", message: (err as Error).message }],
    );
  }
  const conv = convertLegacyYaml(yamlText, { yamlFilePath });
  if (!conv.ok) {
    throw new LegacyPipelineLoadError(
      `legacy pipeline '${pipelineDir}' failed to convert`,
      conv.diagnostics,
    );
  }
  if (!conv.promptRoot) {
    throw new LegacyPipelineLoadError(
      `legacy pipeline '${pipelineDir}' produced no promptRoot`,
      [{ code: "MISSING_PROMPT_ROOT" }],
    );
  }
  const prompts = scanPrompts(conv.promptRoot);
  return {
    ir: conv.ir,
    promptRoot: conv.promptRoot,
    yamlFilePath,
    warnings: conv.warnings,
    prompts,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && ./node_modules/.bin/vitest run src/kernel-next/runtime/load-legacy-pipeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/runtime/load-legacy-pipeline.ts apps/server/src/kernel-next/runtime/load-legacy-pipeline.test.ts
git commit -m "feat(loader): scan pipeline prompts/**/*.md into prompts map"
```

---

## Task 9: Prune orphan prompt files from builtin pipeline dirs

**Why:** Task 7's `PROMPT_REF_UNUSED` diagnostic will block `registerLegacyPipeline` in Task 10 if any builtin has `.md` files under `prompts/` that no AgentStage references. Audit before the hard cutover.

**Files:**
- Potentially delete or rename files under `apps/server/src/builtin-pipelines/<name>/prompts/`

- [ ] **Step 1: Enumerate orphan prompts**

Run this script at the repo root:

```bash
cd apps/server
./node_modules/.bin/tsx -e '
import { loadLegacyPipelineIR } from "./src/kernel-next/runtime/load-legacy-pipeline.js";
const pipelines = ["smoke-test", "tech-research-collector", "tech-research-writer", "pipeline-generator"];
for (const p of pipelines) {
  const r = loadLegacyPipelineIR(p);
  const refs = new Set<string>();
  for (const s of r.ir.stages) {
    if (s.type === "agent" && s.config.promptRef) refs.add(s.config.promptRef);
  }
  const provided = Object.keys(r.prompts);
  const orphans = provided.filter((k) => !refs.has(k));
  console.log(p, "orphans:", orphans);
}
'
```

- [ ] **Step 2: Examine each orphan**

For every orphan reported: decide whether it is legitimately a **fragment file** (referenced indirectly by an agent prompt via fragment inclusion, not a direct `promptRef`). If yes, it will break Task 7 submissions. Options:
1. If the orphan is genuinely unused — delete it.
2. If it IS used by userland fragment assembly (pipeline-generator's `prompts/system/*.md` are used this way — read by the `analyzing` agent via fragment inclusion in its prompt assembler), then the `PROMPT_REF_UNUSED` rule from Task 7 is too strict.

For this milestone, **relax the rule**: `PROMPT_REF_UNUSED` is downgraded to a diagnostic that is **not fatal** when provided prompt keys contain segments whose prefix matches `system/`. Update Task 7's submit logic:

```typescript
    for (const ref of providedRefs) {
      if (!agentPromptRefs.has(ref)) {
        // Allow 'system/*' prompts that serve as fragments pulled in by
        // userland prompt assembly. They do not appear as direct AgentStage
        // promptRefs but must still be stored and version-hashed.
        if (ref.startsWith("system/")) continue;
        diagnostics.push({
          code: "PROMPT_REF_UNUSED",
          message: `prompt '${ref}' is not referenced by any AgentStage`,
          context: { promptRef: ref },
        });
      }
    }
```

Apply this patch to `apps/server/src/kernel-next/mcp/kernel.ts` and add one additional test in `kernel.test.ts`:

```typescript
  it("allows 'system/*' prompts even if no AgentStage references them directly", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const res = svc.submit(agentOnlyIR(), {
      prompts: { a: "X", "system/fragment": "INVARIANT CONTENT" },
    });
    expect(res.ok).toBe(true);
  });
```

- [ ] **Step 3: Delete any non-system orphans that are truly unused**

For every orphan that is NOT under `system/`, delete the file with `git rm`. Keep `system/*` files (they are fragments).

- [ ] **Step 4: Re-run the enumeration script**

Confirm all four pipelines now report either empty orphans or orphans entirely under `system/`:

```
smoke-test orphans: []
tech-research-collector orphans: []
tech-research-writer orphans: []
pipeline-generator orphans: [ 'system/analysis', 'system/gen-prompts', 'system/gen-skeleton', ... ]
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/mcp/kernel.ts apps/server/src/kernel-next/mcp/kernel.test.ts
git add -A apps/server/src/builtin-pipelines/
git commit -m "chore(prompts): prune orphan prompts, allow system/* fragments in submit"
```

---

## Task 10: Wire registerLegacyPipeline to submit IR+prompts and bind DbPromptResolver

**Files:**
- Modify: `apps/server/src/routes/kernel-run.ts`
- Modify: `apps/server/src/routes/kernel-run.test.ts`

- [ ] **Step 1: Read the current registerLegacyPipeline implementation**

Run: `cd apps/server && grep -n "registerLegacyPipeline\|FsPromptResolver" src/routes/kernel-run.ts`
Note the current factory shape — you will replace the `FsPromptResolver` construction with a `DbPromptResolver` bound to the submitted versionHash.

- [ ] **Step 2: Write the failing test**

Append to `apps/server/src/routes/kernel-run.test.ts`:

```typescript
import { getKernelNextDb } from "../lib/kernel-next-db.js";

describe("registerLegacyPipeline populates pipeline_prompt_refs on module load", () => {
  it("at least one row exists for every registered legacy pipeline", () => {
    const db = getKernelNextDb();
    const names = ["smoke-test", "tech-research-collector", "tech-research-writer", "pipeline-generator"];
    for (const name of names) {
      const row = db
        .prepare(
          `SELECT pv.pipeline_name, COUNT(ppr.prompt_ref) AS n
           FROM pipeline_versions pv
           LEFT JOIN pipeline_prompt_refs ppr ON ppr.version_hash = pv.version_hash
           WHERE pv.pipeline_name = ?
           GROUP BY pv.version_hash
           ORDER BY pv.created_at DESC
           LIMIT 1`,
        )
        .get(name) as { pipeline_name: string; n: number } | undefined;
      expect(row, `pipeline ${name} not found`).toBeDefined();
      expect(row!.n).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/server && ./node_modules/.bin/vitest run src/routes/kernel-run.test.ts`
Expected: FAIL — no rows.

- [ ] **Step 4: Update registerLegacyPipeline**

In `apps/server/src/routes/kernel-run.ts`:

1. Add imports:

```typescript
import { KernelService } from "../kernel-next/mcp/kernel.js";
import { DbPromptResolver } from "../kernel-next/runtime/db-prompt-resolver.js";
```

2. Find the `registerLegacyPipeline` function. Replace its body so it:
   - Loads IR + prompts via `loadLegacyPipelineIR`
   - Calls `new KernelService(db, { skipTypeCheck: true }).submit(ir, { prompts })`
   - Throws on `!ok`
   - Binds the resulting `versionHash` into a closure
   - Returns a factory whose executor uses `new DbPromptResolver(db, versionHash)` in place of `new FsPromptResolver(promptRoot)`

The exact replacement (substitute the current body; preserve the surrounding helper signature):

```typescript
function registerLegacyPipeline(opts: LegacyPipelineRegistrationOpts): () => PipelineRegistration {
  const loaded = loadLegacyPipelineIR(opts.pipelineDir);
  const db = getKernelNextDb();
  const svc = new KernelService(db, { skipTypeCheck: true });
  const submitResult = svc.submit(loaded.ir, { prompts: loaded.prompts });
  if (!submitResult.ok) {
    const joined = submitResult.diagnostics.map((d) => `${d.code}: ${d.message ?? ""}`).join("; ");
    throw new Error(`registerLegacyPipeline(${opts.pipelineDir}): submit failed: ${joined}`);
  }
  const versionHash = submitResult.versionHash;

  return () => ({
    ir: loaded.ir,
    handlers: {},
    executorFactory: (mcpServer: unknown) => new RealStageExecutor({
      model: opts.model,
      maxTurns: opts.maxTurns,
      maxBudgetUsd: opts.maxBudgetUsd,
      timeoutMs: opts.timeoutMs,
      promptResolver: new DbPromptResolver(db, versionHash),
      mcpServer: mcpServer as never,
    }),
  });
}
```

(Adjust field names to match the current `RealStageExecutor` constructor if they differ — the point is `promptResolver: new DbPromptResolver(...)` replaces `promptResolver: new FsPromptResolver(loaded.promptRoot)`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/server && ./node_modules/.bin/vitest run src/routes/kernel-run.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the wider kernel-next test suite to catch regressions**

Run: `cd apps/server && ./node_modules/.bin/vitest run src/kernel-next src/routes`
Expected: all PASS. If any existing kernel-run or pg-entry test fails due to the change, update its fixture to match the new behavior. Do NOT weaken assertions.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/routes/kernel-run.ts apps/server/src/routes/kernel-run.test.ts
git commit -m "feat(kernel-run): registerLegacyPipeline submits IR+prompts and uses DbPromptResolver"
```

---

## Task 11: Update pg-entry.ts to use new submit signature + DbPromptResolver

**Files:**
- Modify: `apps/server/src/kernel-next/mcp/pg-entry.ts`
- Modify: `apps/server/src/kernel-next/mcp/pg-entry.test.ts`

- [ ] **Step 1: Identify the submit call site**

Run: `cd apps/server && grep -n "submit\|FsPromptResolver\|svc\." src/kernel-next/mcp/pg-entry.ts`
Note the lines using the old signature.

- [ ] **Step 2: Update the call**

In `apps/server/src/kernel-next/mcp/pg-entry.ts`, wherever submit is invoked, change:
- `svc.submit(ir)` → `svc.submit(ir, { prompts: loaded.prompts })` (the `loaded` variable is the result of `loadLegacyPipelineIR`; if it's not currently in scope, add a call)
- `new FsPromptResolver(loaded.promptRoot)` → `new DbPromptResolver(db, versionHash)` (where `versionHash` is the one returned from submit)

Add the `DbPromptResolver` import and drop the `FsPromptResolver` import if no longer used in this file.

- [ ] **Step 3: Update pg-entry tests**

In `apps/server/src/kernel-next/mcp/pg-entry.test.ts`, any test that:
- Directly calls `svc.submit(ir)` without prompts on an agent-containing IR → add `{ prompts: { ... } }`
- Mocks `FsPromptResolver` → rewire to `DbPromptResolver`

- [ ] **Step 4: Run tests**

Run: `cd apps/server && ./node_modules/.bin/vitest run src/kernel-next/mcp/pg-entry.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full kernel-next suite**

Run: `cd apps/server && ./node_modules/.bin/vitest run src/kernel-next`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/kernel-next/mcp/pg-entry.ts apps/server/src/kernel-next/mcp/pg-entry.test.ts
git commit -m "feat(pg-entry): use new submit signature and DbPromptResolver"
```

---

## Task 12: Type-check the whole server package

- [ ] **Step 1: Run tsc**

```bash
cd apps/server && ./node_modules/.bin/tsc --noEmit
```

Expected: 0 errors. Fix any.

- [ ] **Step 2: Commit (only if fixes were required)**

If Step 1 needed edits:

```bash
git add -A
git commit -m "fix(kernel-next): type errors after prompts-in-sqlite landing"
```

---

## Task 13: Full test run + final acceptance

- [ ] **Step 1: Run the full server test suite**

```bash
cd apps/server && ./node_modules/.bin/vitest run
```

Expected: all PASS. Record the passed count.

- [ ] **Step 2: Run the web build (it reads kernel-next types via tRPC)**

```bash
cd apps/web && ./node_modules/.bin/tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Manual E2E**

Start the dev server (`pnpm --filter server dev`) and POST each of these:

```bash
curl -X POST http://localhost:3001/api/kernel/tasks/run \
  -H "Content-Type: application/json" \
  -d '{"pipeline":"smoke-test"}'
```

Expected: 202 `{ ok: true, taskId, versionHash }`. Then poll the SSE stream or GET `/api/kernel-next/tasks/<taskId>/stream` — pipeline should complete.

Repeat for `tech-research-collector`, `tech-research-writer`, `pipeline-generator` (the latter two require `seedValues`; use the seed values from existing docs in `2026-04-20-kernel-next-a7-done-handoff.md` §5 and `2026-04-22-converter-extension-pipeline-generator-done-handoff.md` §7).

Expected: each runs without a `DbPromptResolver`-related error in logs and produces the same SSE event shape as pre-milestone.

- [ ] **Step 4: Verify no remaining FsPromptResolver in production paths**

```bash
cd apps/server && grep -rn "FsPromptResolver" src/routes src/kernel-next/mcp src/kernel-next/runtime/runner.ts
```

Expected: zero matches other than `src/kernel-next/runtime/fs-prompt-resolver.ts` itself and any `*.test.ts`.

- [ ] **Step 5: Final commit if a doc or handoff note was added during manual verification**

Otherwise skip.

---

## Self-Review (fill in before handing off)

**1. Spec coverage:**

| Spec §   | Section topic                       | Task(s)        |
|----------|-------------------------------------|----------------|
| §1 SC 1  | versionHash includes prompts        | Task 5         |
| §1 SC 2  | submit accepts IR+prompts atomic    | Task 7         |
| §1 SC 3  | DbPromptResolver                    | Task 6         |
| §1 SC 4  | All 4 pipelines run on new resolver | Tasks 10,11,13 |
| §1 SC 5  | IR-only hashing preserved           | Task 5 (regression implicit) |
| §1 SC 6  | No regression                       | Tasks 12, 13   |
| §4 DDL   | Two new tables + index              | Task 1         |
| §5 Canon | 4 new functions in canonical.ts     | Tasks 4, 5     |
| §6 API   | submit signature + 3 diagnostics    | Task 7, 9      |
| §7 Res.  | DbPromptResolver                    | Task 6         |
| §8 Slice | Infrastructure only                 | whole plan     |
| §9 Mig.  | M.B in registerLegacyPipeline       | Task 10        |
| §10 Tests| Unit + integration                  | Tasks 1-11     |
| §11 Roll | Order of shipping                   | Tasks 1→13     |

**2. Placeholder scan:** grep the plan for "TBD", "TODO", "implement later", "fill in" — expect zero matches.

**3. Type consistency:**
- `PromptResolver` interface unchanged, implementations differ.
- `KernelService.submit` signature: `(ir: unknown, options?: { parentHash?: string; prompts?: Record<string, string> })`
- `LegacyPipelineLoadResult.prompts: Record<string, string>` (added)
- New sql helpers: `insertPromptContent(db, contentHash, content): void`, `insertPromptRefs(db, versionHash, refs): void`, `getPromptContent(db, contentHash): string | null`
- New canonical exports: `normalizePromptContent`, `promptContentHash`, `canonicalizePipeline`, `pipelineCanonicalJSON`, `pipelineVersionHash`
- New diagnostic codes: `PROMPT_REF_MISSING`, `PROMPT_REF_UNUSED`, `PROMPT_CONTENT_EMPTY`
