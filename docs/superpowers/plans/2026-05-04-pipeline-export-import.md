# Pipeline Export / Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add file-based cross-user pipeline sharing — a self-contained JSON envelope (`wfctl-pipeline-export/v1`) wrapping `PipelineIR + prompts + provenance`, served by two HTTP endpoints (`GET .../export`, `POST .../import`) and surfaced via Export / Import buttons in the web UI.

**Architecture:** Pure-data envelope module + zod schema in `kernel-next/ir/`. Two new handlers added to the existing `kernel-pipelines.ts` route. Import goes through unchanged `KernelService.submit` — same validator stack as `submit_pipeline`. Web UI: `<a download>` for export (no JS state), new `ImportPipelineDialog` for import.

**Tech Stack:** TypeScript, hono, zod, vitest, Next.js (web), React Testing Library.

**Spec:** `docs/superpowers/specs/2026-05-04-pipeline-export-import-design.md`

---

## File Structure

**Server (new files):**
- `apps/server/src/kernel-next/ir/export-envelope.ts` — pure data: zod schema + `buildEnvelope` + `parseEnvelope`. No IO.
- `apps/server/src/kernel-next/ir/export-envelope.test.ts` — round-trip + strict-schema unit tests.

**Server (modifications):**
- `apps/server/src/routes/kernel-pipelines.ts` — add 2 handlers (`GET /:versionHash/export`, `POST /import`).
- `apps/server/src/routes/kernel-pipelines.test.ts` — add tests for both handlers.

**Web (new files):**
- `apps/web/src/components/import-pipeline-dialog.tsx` — modal dialog with file input + textarea fallback.
- `apps/web/src/components/import-pipeline-dialog.test.tsx` — React Testing Library tests.

**Web (modifications):**
- `apps/web/src/app/kernel-next/pipelines/page.tsx` — add Import button to header; mount dialog.
- `apps/web/src/app/kernel-next/pipelines/[name]/page.tsx` — add Export `<a download>` link to actions area.

**Docs (modifications):**
- `docs/whitepaper.md` + `docs/whitepaper-zh.md` — §1.2 wording: "future" → present tense.
- `docs/product-roadmap.md` — append revision row 1.28.

---

## Task 1: Envelope schema + pure-data helpers

**Files:**
- Create: `apps/server/src/kernel-next/ir/export-envelope.ts`
- Test: `apps/server/src/kernel-next/ir/export-envelope.test.ts`

- [ ] **Step 1.1: Write the failing test file**

Create `apps/server/src/kernel-next/ir/export-envelope.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  PipelineExportEnvelopeSchema,
  buildEnvelope,
  parseEnvelope,
  EXPORT_FORMAT_V1,
} from "./export-envelope.js";
import { diamondIR } from "../generator-mock/mini-generator.js";
import type { PipelineIR } from "./schema.js";

function diamondPrompts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of diamondIR().stages) {
    if (s.type === "agent") out[s.config.promptRef] = "dummy";
  }
  return out;
}

describe("buildEnvelope", () => {
  it("produces an envelope with the v1 format literal", () => {
    const env = buildEnvelope({
      pipelineName: "p",
      versionHash: "a".repeat(64),
      parentHash: null,
      createdAt: 1_700_000_000_000,
      ir: diamondIR() as PipelineIR,
      prompts: diamondPrompts(),
      now: 1_700_000_001_000,
    });
    expect(env.format).toBe(EXPORT_FORMAT_V1);
    expect(env.exportedAt).toBe(1_700_000_001_000);
    expect(env.source).toEqual({
      pipelineName: "p",
      versionHash: "a".repeat(64),
      parentHash: null,
      createdAt: 1_700_000_000_000,
    });
    expect(env.prompts).toEqual(diamondPrompts());
  });

  it("round-trips through parseEnvelope without loss", () => {
    const built = buildEnvelope({
      pipelineName: "p",
      versionHash: "b".repeat(64),
      parentHash: "c".repeat(64),
      createdAt: 1,
      ir: diamondIR() as PipelineIR,
      prompts: diamondPrompts(),
      now: 2,
    });
    const parsed = parseEnvelope(JSON.parse(JSON.stringify(built)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.envelope).toEqual(built);
  });
});

describe("parseEnvelope", () => {
  function valid(): unknown {
    return buildEnvelope({
      pipelineName: "p",
      versionHash: "a".repeat(64),
      parentHash: null,
      createdAt: 1,
      ir: diamondIR() as PipelineIR,
      prompts: diamondPrompts(),
      now: 2,
    });
  }

  it("accepts a valid envelope", () => {
    const r = parseEnvelope(valid());
    expect(r.ok).toBe(true);
  });

  it("accepts empty prompts object", () => {
    const v = valid() as Record<string, unknown>;
    v.prompts = {};
    // diamondIR has agent stages; for this test we only assert envelope-level
    // schema. submit-time prompt-completeness lives in KernelService.submit.
    const r = parseEnvelope(v);
    expect(r.ok).toBe(true);
  });

  it("rejects unknown top-level fields (strict schema)", () => {
    const v = valid() as Record<string, unknown>;
    v.extra = "junk";
    const r = parseEnvelope(v);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics[0]!.code).toBe("INVALID_ENVELOPE");
    }
  });

  it("rejects wrong format literal with UNSUPPORTED_FORMAT", () => {
    const v = valid() as Record<string, unknown>;
    v.format = "wfctl-pipeline-export/v2";
    const r = parseEnvelope(v);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics[0]!.code).toBe("UNSUPPORTED_FORMAT");
    }
  });

  it("rejects non-string prompt values", () => {
    const v = valid() as Record<string, unknown>;
    v.prompts = { p1: 42 };
    const r = parseEnvelope(v);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics[0]!.code).toBe("INVALID_ENVELOPE");
    }
  });

  it("rejects non-object root", () => {
    const r = parseEnvelope("not an object");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics[0]!.code).toBe("INVALID_ENVELOPE");
    }
  });

  it("rejects missing source field", () => {
    const v = valid() as Record<string, unknown>;
    delete v.source;
    const r = parseEnvelope(v);
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 1.2: Run test to verify it fails**

```
cd apps/server && npx vitest run src/kernel-next/ir/export-envelope.test.ts
```

Expected: FAIL — module `./export-envelope.js` not found.

- [ ] **Step 1.3: Implement `export-envelope.ts`**

Create `apps/server/src/kernel-next/ir/export-envelope.ts`:

```ts
// Pure-data envelope for cross-machine pipeline export/import.
// No DB / HTTP / FS access — see spec §5 (module organization).
//
// File format: a single self-contained JSON file wrapping PipelineIR
// + prompts + provenance metadata. Versioned via the `format` literal
// so future breaking changes can be detected at parse time rather than
// silently mis-deserialized.

import { z } from "zod";
import type { Diagnostic } from "./schema.js";

export const EXPORT_FORMAT_V1 = "wfctl-pipeline-export/v1" as const;

const SourceSchema = z.object({
  pipelineName: z.string().min(1),
  versionHash: z.string().min(1),
  parentHash: z.string().min(1).nullable(),
  createdAt: z.number().int().nonnegative(),
}).strict();

export const PipelineExportEnvelopeSchema = z.object({
  format: z.literal(EXPORT_FORMAT_V1),
  exportedAt: z.number().int().nonnegative(),
  source: SourceSchema,
  // We intentionally do NOT validate `ir` against PipelineIRSchema here.
  // Envelope-level parsing only checks the wrapper shape; the IR's full
  // semantic validation happens at KernelService.submit time, so the
  // import handler reports the same diagnostics a direct submit_pipeline
  // call would. Keeping ir as `unknown` here also means an envelope can
  // round-trip even if the future PipelineIRSchema gains required fields
  // — the handler decides whether to accept.
  ir: z.unknown(),
  prompts: z.record(z.string(), z.string()),
}).strict();

export type PipelineExportEnvelope = z.infer<typeof PipelineExportEnvelopeSchema>;

export interface BuildEnvelopeArgs {
  pipelineName: string;
  versionHash: string;
  parentHash: string | null;
  createdAt: number;
  ir: unknown;
  prompts: Record<string, string>;
  now?: number;
}

export function buildEnvelope(args: BuildEnvelopeArgs): PipelineExportEnvelope {
  return {
    format: EXPORT_FORMAT_V1,
    exportedAt: args.now ?? Date.now(),
    source: {
      pipelineName: args.pipelineName,
      versionHash: args.versionHash,
      parentHash: args.parentHash,
      createdAt: args.createdAt,
    },
    ir: args.ir,
    prompts: args.prompts,
  };
}

export type ParseEnvelopeResult =
  | { ok: true; envelope: PipelineExportEnvelope }
  | { ok: false; diagnostics: Diagnostic[] };

export function parseEnvelope(raw: unknown): ParseEnvelopeResult {
  // Special-case: differentiate "right schema, wrong format literal" from
  // generic schema-fail so callers can tell users "this file looks like
  // a wfctl export but the wrong version" vs "this file isn't an export
  // at all".
  if (
    typeof raw === "object"
    && raw !== null
    && "format" in raw
    && typeof (raw as { format: unknown }).format === "string"
    && (raw as { format: string }).format !== EXPORT_FORMAT_V1
  ) {
    return {
      ok: false,
      diagnostics: [{
        code: "UNSUPPORTED_FORMAT",
        message:
          `unsupported envelope format '${(raw as { format: string }).format}' `
          + `(expected '${EXPORT_FORMAT_V1}')`,
        context: { received: (raw as { format: string }).format },
      }],
    };
  }
  const result = PipelineExportEnvelopeSchema.safeParse(raw);
  if (result.success) return { ok: true, envelope: result.data };
  return {
    ok: false,
    diagnostics: result.error.issues.map((i) => ({
      code: "INVALID_ENVELOPE",
      message: `${i.path.join(".") || "(root)"}: ${i.message}`,
      context: { path: i.path, zodCode: i.code },
    })),
  };
}
```

- [ ] **Step 1.4: Run test to verify it passes**

```
cd apps/server && npx vitest run src/kernel-next/ir/export-envelope.test.ts
```

Expected: All 8 tests PASS.

- [ ] **Step 1.5: Verify no TS errors**

```
cd apps/server && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 1.6: Commit**

```bash
git add apps/server/src/kernel-next/ir/export-envelope.ts apps/server/src/kernel-next/ir/export-envelope.test.ts
git commit -m "$(cat <<'EOF'
feat(export-envelope): pure-data wfctl-pipeline-export/v1 schema

Wraps PipelineIR + prompts + provenance metadata into a self-contained
JSON file. Strict zod schema rejects unknown top-level fields; format
literal locks the version so future breaks are detectable.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: HTTP `GET /:versionHash/export` handler

**Files:**
- Modify: `apps/server/src/routes/kernel-pipelines.ts`
- Modify: `apps/server/src/routes/kernel-pipelines.test.ts`

- [ ] **Step 2.1: Write the failing test (append to kernel-pipelines.test.ts)**

Append to the end of `apps/server/src/routes/kernel-pipelines.test.ts`:

```ts
describe("GET /api/kernel/pipelines/:versionHash/export", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    __setKernelNextDbForTest(db);
  });

  afterEach(() => {
    __setKernelNextDbForTest(undefined);
    db.close();
  });

  it("returns a v1 envelope for an existing version", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("setup submit failed");

    const app = buildApp();
    const res = await app.fetch(new Request(
      `http://t/api/kernel/pipelines/${submitted.versionHash}/export`,
    ));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const cd = res.headers.get("content-disposition") ?? "";
    expect(cd).toContain("attachment");
    expect(cd).toContain("filename=");

    const body = await res.json() as Record<string, unknown>;
    expect(body.format).toBe("wfctl-pipeline-export/v1");
    expect(body.source).toMatchObject({
      pipelineName: diamondIR().name,
      versionHash: submitted.versionHash,
    });
    expect(body.ir).toBeDefined();
    expect(body.prompts).toEqual(diamondPrompts());
  });

  it("returns 404 VERSION_NOT_FOUND for an unknown hash", async () => {
    const app = buildApp();
    const res = await app.fetch(new Request(
      "http://t/api/kernel/pipelines/" + "0".repeat(64) + "/export",
    ));
    expect(res.status).toBe(404);
    const body = await res.json() as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.diagnostics[0]!.code).toBe("VERSION_NOT_FOUND");
  });

  it("sanitizes pipeline name in Content-Disposition filename", async () => {
    // Manually insert a pipeline with an awkward name to confirm the
    // filename sanitizer collapses unsafe characters.
    const svc = new KernelService(db, { skipTypeCheck: true });
    const ir = { ...diamondIR(), name: "Weird/Name With Spaces!" };
    const submitted = await svc.submit(ir, { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("setup submit failed");

    const app = buildApp();
    const res = await app.fetch(new Request(
      `http://t/api/kernel/pipelines/${submitted.versionHash}/export`,
    ));
    const cd = res.headers.get("content-disposition") ?? "";
    expect(cd).toMatch(/filename="weird-name-with-spaces-[a-f0-9]{8}\.wfctl\.json"/);
  });
});
```

- [ ] **Step 2.2: Run test to verify it fails**

```
cd apps/server && npx vitest run src/routes/kernel-pipelines.test.ts -t "export"
```

Expected: FAIL — handler not registered (404 on the route).

- [ ] **Step 2.3: Implement the export handler**

Modify `apps/server/src/routes/kernel-pipelines.ts`. Add the import at the top (after the existing imports):

```ts
import { buildEnvelope } from "../kernel-next/ir/export-envelope.js";
```

Then add a sanitizer helper above the handlers (after the `PipelineSummary` interface):

```ts
function sanitizeFilenameSegment(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "pipeline";
}
```

Then add the handler (place it after the existing `GET /kernel/pipelines/:versionHash` handler so route ordering puts the more-specific `/export` suffix last — hono matches in registration order, and `:versionHash/export` doesn't conflict because it's a distinct path):

```ts
kernelPipelinesRoute.get("/kernel/pipelines/:versionHash/export", (c) => {
  const hash = c.req.param("versionHash");
  const db = getKernelNextDb();
  const ir = getPipelineIR(db, hash);
  if (ir === null) {
    return c.json({
      ok: false,
      diagnostics: [{
        code: "VERSION_NOT_FOUND",
        message: `pipeline version '${hash}' not found`,
        context: { versionHash: hash },
      }],
    }, 404);
  }
  const prompts = getPromptsByVersion(db, hash);
  const meta = db.prepare(
    `SELECT pipeline_name, parent_hash, created_at
     FROM pipeline_versions WHERE version_hash = ?`,
  ).get(hash) as
    | { pipeline_name: string; parent_hash: string | null; created_at: number }
    | undefined;
  // meta cannot realistically be undefined here because getPipelineIR
  // succeeded against the same row, but we narrow defensively.
  if (!meta) {
    return c.json({
      ok: false,
      diagnostics: [{
        code: "VERSION_NOT_FOUND",
        message: `pipeline version '${hash}' not found`,
        context: { versionHash: hash },
      }],
    }, 404);
  }
  const envelope = buildEnvelope({
    pipelineName: meta.pipeline_name,
    versionHash: hash,
    parentHash: meta.parent_hash,
    createdAt: meta.created_at,
    ir,
    prompts,
  });
  const safeName = sanitizeFilenameSegment(meta.pipeline_name);
  const shortHash = hash.slice(0, 8);
  const filename = `${safeName}-${shortHash}.wfctl.json`;
  return new Response(JSON.stringify(envelope, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
});
```

- [ ] **Step 2.4: Run test to verify it passes**

```
cd apps/server && npx vitest run src/routes/kernel-pipelines.test.ts -t "export"
```

Expected: 3 tests PASS.

- [ ] **Step 2.5: Run full kernel-pipelines test file (no regression)**

```
cd apps/server && npx vitest run src/routes/kernel-pipelines.test.ts
```

Expected: all tests PASS (existing + 3 new).

- [ ] **Step 2.6: Verify no TS errors**

```
cd apps/server && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 2.7: Commit**

```bash
git add apps/server/src/routes/kernel-pipelines.ts apps/server/src/routes/kernel-pipelines.test.ts
git commit -m "$(cat <<'EOF'
feat(routes): GET /api/kernel/pipelines/:versionHash/export

Returns the wfctl-pipeline-export/v1 envelope for a stored version,
with sanitized Content-Disposition filename. 404 + VERSION_NOT_FOUND
for unknown hashes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: HTTP `POST /import` handler

**Files:**
- Modify: `apps/server/src/routes/kernel-pipelines.ts`
- Modify: `apps/server/src/routes/kernel-pipelines.test.ts`

- [ ] **Step 3.1: Write the failing tests (append to test file)**

Append to `apps/server/src/routes/kernel-pipelines.test.ts`:

```ts
describe("POST /api/kernel/pipelines/import", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    __setKernelNextDbForTest(db);
  });

  afterEach(() => {
    __setKernelNextDbForTest(undefined);
    db.close();
  });

  async function buildEnvelopeJson(): Promise<{
    envelope: Record<string, unknown>;
    sourceVersionHash: string;
  }> {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("setup submit failed");
    const app = buildApp();
    const res = await app.fetch(new Request(
      `http://t/api/kernel/pipelines/${submitted.versionHash}/export`,
    ));
    const env = await res.json() as Record<string, unknown>;
    return { envelope: env, sourceVersionHash: submitted.versionHash };
  }

  it("imports a valid envelope into a fresh DB", async () => {
    const { envelope } = await buildEnvelopeJson();
    // Fresh DB to simulate a different machine.
    db.close();
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    __setKernelNextDbForTest(db);

    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/pipelines/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      versionHash: string;
      pipelineName: string;
      alreadyExisted: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.pipelineName).toBe(diamondIR().name);
    expect(body.versionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.alreadyExisted).toBe(false);

    // Row should now exist.
    const row = db.prepare(
      `SELECT version_hash FROM pipeline_versions WHERE version_hash = ?`,
    ).get(body.versionHash);
    expect(row).toBeDefined();
  });

  it("returns alreadyExisted=true on duplicate import", async () => {
    const { envelope, sourceVersionHash } = await buildEnvelopeJson();
    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/pipelines/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      versionHash: string;
      alreadyExisted: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.versionHash).toBe(sourceVersionHash);
    expect(body.alreadyExisted).toBe(true);
  });

  it("rejects non-JSON body with INVALID_JSON_BODY", async () => {
    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/pipelines/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json {",
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(body.diagnostics[0]!.code).toBe("INVALID_JSON_BODY");
  });

  it("rejects wrong format literal with UNSUPPORTED_FORMAT", async () => {
    const { envelope } = await buildEnvelopeJson();
    envelope.format = "wfctl-pipeline-export/v2";
    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/pipelines/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(body.diagnostics[0]!.code).toBe("UNSUPPORTED_FORMAT");
  });

  it("passes through submit diagnostics for missing prompts", async () => {
    const { envelope } = await buildEnvelopeJson();
    envelope.prompts = {};  // strip prompts; AgentStage promptRefs become unsatisfied
    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/pipelines/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.diagnostics.some((d) => d.code === "PROMPT_REF_MISSING")).toBe(true);
  });

  it("rejects unknown top-level fields with INVALID_ENVELOPE", async () => {
    const { envelope } = await buildEnvelopeJson();
    (envelope as Record<string, unknown>).extra = "junk";
    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/pipelines/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(body.diagnostics[0]!.code).toBe("INVALID_ENVELOPE");
  });

  it("rejects empty body with INVALID_JSON_BODY", async () => {
    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/pipelines/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(body.diagnostics[0]!.code).toBe("INVALID_JSON_BODY");
  });
});
```

- [ ] **Step 3.2: Run tests to verify they fail**

```
cd apps/server && npx vitest run src/routes/kernel-pipelines.test.ts -t "import"
```

Expected: FAIL — POST handler not registered.

- [ ] **Step 3.3: Implement the import handler**

In `apps/server/src/routes/kernel-pipelines.ts`, add to the imports:

```ts
import { parseEnvelope } from "../kernel-next/ir/export-envelope.js";
import { KernelService } from "../kernel-next/mcp/kernel.js";
```

Add the handler at the end of the file (after env-probe):

```ts
// 10 MB cap on import body. Local single-user server; this prevents
// trivial mistakes (paste of a giant file) from hanging the process.
// Typical envelopes are < 100 KB.
const MAX_IMPORT_BODY_BYTES = 10 * 1024 * 1024;

kernelPipelinesRoute.post("/kernel/pipelines/import", async (c) => {
  const raw = await c.req.text();
  if (raw.length > MAX_IMPORT_BODY_BYTES) {
    return c.json({
      ok: false,
      diagnostics: [{
        code: "BODY_TOO_LARGE",
        message: `import body exceeds ${MAX_IMPORT_BODY_BYTES} bytes`,
        context: { received: raw.length, limit: MAX_IMPORT_BODY_BYTES },
      }],
    }, 413);
  }
  if (raw.trim().length === 0) {
    return c.json({
      ok: false,
      diagnostics: [{ code: "INVALID_JSON_BODY", message: "request body is empty" }],
    }, 400);
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    return c.json({
      ok: false,
      diagnostics: [{
        code: "INVALID_JSON_BODY",
        message: err instanceof Error ? err.message : "invalid JSON",
      }],
    }, 400);
  }

  const envResult = parseEnvelope(parsedJson);
  if (!envResult.ok) {
    return c.json({ ok: false, diagnostics: envResult.diagnostics }, 400);
  }
  const envelope = envResult.envelope;

  const db = getKernelNextDb();

  // Detect "this hash already exists locally" BEFORE submit so the
  // response can flag idempotent re-imports. We check against
  // source.versionHash because that's what the file claims; the actual
  // post-submit hash is what matters for the response, but if the
  // source hash already exists, submit will return that same hash
  // (canonical content hash is deterministic).
  const sourceHashRow = db.prepare(
    `SELECT version_hash FROM pipeline_versions WHERE version_hash = ?`,
  ).get(envelope.source.versionHash) as { version_hash: string } | undefined;
  const sourceAlreadyExisted = sourceHashRow !== undefined;

  const svc = new KernelService(db);
  const submitResult = await svc.submit(envelope.ir, { prompts: envelope.prompts });
  if (!submitResult.ok) {
    return c.json({ ok: false, diagnostics: submitResult.diagnostics }, 400);
  }

  // alreadyExisted: the post-submit hash matches what was already
  // present BEFORE this request. We re-check post-submit because the
  // source hash and the local-recompute hash should match (canonical
  // form is deterministic) — but if the source IR was tampered with
  // mid-transport, the recomputed hash differs. In that case,
  // alreadyExisted reflects the locally-computed truth.
  const alreadyExisted =
    sourceAlreadyExisted && submitResult.versionHash === envelope.source.versionHash;

  const irRecord = envelope.ir as { name?: unknown };
  const pipelineName = typeof irRecord.name === "string" ? irRecord.name : envelope.source.pipelineName;

  return c.json({
    ok: true,
    versionHash: submitResult.versionHash,
    pipelineName,
    alreadyExisted,
  });
});
```

- [ ] **Step 3.4: Run tests to verify they pass**

```
cd apps/server && npx vitest run src/routes/kernel-pipelines.test.ts -t "import"
```

Expected: 7 tests PASS.

- [ ] **Step 3.5: Run the full route test file**

```
cd apps/server && npx vitest run src/routes/kernel-pipelines.test.ts
```

Expected: all PASS.

- [ ] **Step 3.6: Verify no TS errors**

```
cd apps/server && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3.7: Commit**

```bash
git add apps/server/src/routes/kernel-pipelines.ts apps/server/src/routes/kernel-pipelines.test.ts
git commit -m "$(cat <<'EOF'
feat(routes): POST /api/kernel/pipelines/import

Accepts a wfctl-pipeline-export/v1 envelope and routes the IR + prompts
through KernelService.submit (no validator bypass). 10 MB body cap.
Returns alreadyExisted=true on idempotent re-imports.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Web — Export button on pipeline detail page

**Files:**
- Modify: `apps/web/src/app/kernel-next/pipelines/[name]/page.tsx`

This is a tiny addition (one `<a>` element). No tests needed — `<a download>` is a browser primitive with no logic to assert. We will manually smoke this in Task 7.

- [ ] **Step 4.1: Add Export link next to Launch button**

In `apps/web/src/app/kernel-next/pipelines/[name]/page.tsx`, locate the `<button onClick={() => setLauncherOpen(true)}>Launch →</button>` element (around line 158-164). Wrap it together with a new `<a>` in a flex container, and add the `<a>`:

Find this block:

```tsx
        <button
          type="button"
          onClick={() => setLauncherOpen(true)}
          className="rounded border border-info-border bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover focus:outline-none focus:ring-1 focus-visible:ring-accent"
        >
          Launch →
        </button>
```

Replace with:

```tsx
        <div className="flex items-center gap-2">
          <a
            href={`${API_BASE}/api/kernel/pipelines/${detail.latestVersion}/export`}
            download
            className="rounded border border-strong bg-surface px-3 py-1.5 text-sm text-secondary hover:border-strong hover:bg-elevated"
            title="Download this pipeline as a portable JSON file"
          >
            Export
          </a>
          <button
            type="button"
            onClick={() => setLauncherOpen(true)}
            className="rounded border border-info-border bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover focus:outline-none focus:ring-1 focus-visible:ring-accent"
          >
            Launch →
          </button>
        </div>
```

- [ ] **Step 4.2: Verify web tsc**

```
cd apps/web && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 4.3: Verify web tests still pass (no regression)**

```
cd apps/web && npx vitest run
```

Expected: all PASS.

- [ ] **Step 4.4: Commit**

```bash
git add apps/web/src/app/kernel-next/pipelines/[name]/page.tsx
git commit -m "$(cat <<'EOF'
feat(web): Export button on pipeline detail page

Plain <a download> targeting GET /api/kernel/pipelines/:hash/export.
Browser handles the download natively — no client state.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Web — ImportPipelineDialog component

**Files:**
- Create: `apps/web/src/components/import-pipeline-dialog.tsx`
- Test: `apps/web/src/components/import-pipeline-dialog.test.tsx`

- [ ] **Step 5.1: Write the failing test**

Create `apps/web/src/components/import-pipeline-dialog.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ImportPipelineDialog } from "./import-pipeline-dialog";

describe("ImportPipelineDialog", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders when open", () => {
    const onClose = vi.fn();
    const onImported = vi.fn();
    render(<ImportPipelineDialog open={true} onClose={onClose} onImported={onImported} />);
    expect(screen.getByText(/import pipeline/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/paste pipeline export json/i)).toBeInTheDocument();
  });

  it("does not render when closed", () => {
    const onClose = vi.fn();
    const onImported = vi.fn();
    render(<ImportPipelineDialog open={false} onClose={onClose} onImported={onImported} />);
    expect(screen.queryByText(/import pipeline/i)).not.toBeInTheDocument();
  });

  it("posts pasted JSON to import endpoint and calls onImported on success", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        versionHash: "deadbeef".repeat(8),
        pipelineName: "imported",
        alreadyExisted: false,
      }),
    } as unknown as Response);
    const onClose = vi.fn();
    const onImported = vi.fn();
    render(<ImportPipelineDialog open={true} onClose={onClose} onImported={onImported} />);
    const ta = screen.getByPlaceholderText(/paste pipeline export json/i);
    fireEvent.change(ta, { target: { value: '{"format":"wfctl-pipeline-export/v1"}' } });
    fireEvent.click(screen.getByRole("button", { name: /import/i }));
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
    expect(onImported).toHaveBeenCalledWith({
      versionHash: "deadbeef".repeat(8),
      pipelineName: "imported",
      alreadyExisted: false,
    });
  });

  it("renders diagnostics on failure response and stays open", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({
        ok: false,
        diagnostics: [{ code: "PROMPT_REF_MISSING", message: "prompt 'foo' missing" }],
      }),
    } as unknown as Response);
    const onClose = vi.fn();
    const onImported = vi.fn();
    render(<ImportPipelineDialog open={true} onClose={onClose} onImported={onImported} />);
    fireEvent.change(screen.getByPlaceholderText(/paste pipeline export json/i), {
      target: { value: "{}" },
    });
    fireEvent.click(screen.getByRole("button", { name: /import/i }));
    await waitFor(() => {
      expect(screen.getByText(/prompt_ref_missing/i)).toBeInTheDocument();
    });
    expect(onImported).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("disables Import button when neither file nor textarea provided", () => {
    render(
      <ImportPipelineDialog open={true} onClose={vi.fn()} onImported={vi.fn()} />,
    );
    const btn = screen.getByRole("button", { name: /import/i });
    expect(btn).toBeDisabled();
  });

  it("calls onClose when Cancel clicked", () => {
    const onClose = vi.fn();
    render(<ImportPipelineDialog open={true} onClose={onClose} onImported={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 5.2: Run test to verify it fails**

```
cd apps/web && npx vitest run src/components/import-pipeline-dialog.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 5.3: Implement the component**

Create `apps/web/src/components/import-pipeline-dialog.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "../lib/api-client";

interface ImportDiagnostic {
  code: string;
  message?: string;
}

export interface ImportSuccessResult {
  versionHash: string;
  pipelineName: string;
  alreadyExisted: boolean;
}

interface ImportPipelineDialogProps {
  open: boolean;
  onClose: () => void;
  onImported: (result: ImportSuccessResult) => void;
}

export function ImportPipelineDialog({ open, onClose, onImported }: ImportPipelineDialogProps): JSX.Element | null {
  const [pasted, setPasted] = useState<string>("");
  const [fileText, setFileText] = useState<string>("");
  const [fileName, setFileName] = useState<string>("");
  const [diagnostics, setDiagnostics] = useState<ImportDiagnostic[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset state when dialog opens.
  useEffect(() => {
    if (open) {
      setPasted("");
      setFileText("");
      setFileName("");
      setDiagnostics([]);
      setSubmitting(false);
    }
  }, [open]);

  const handleFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) {
      setFileText("");
      setFileName("");
      return;
    }
    setFileName(file.name);
    void file.text().then((txt) => setFileText(txt));
  }, []);

  const handleSubmit = useCallback(async () => {
    const body = fileText.trim() || pasted.trim();
    if (!body) return;
    setSubmitting(true);
    setDiagnostics([]);
    try {
      const res = await fetch(`${API_BASE}/api/kernel/pipelines/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const json = await res.json() as
        | ImportSuccessResult & { ok: true }
        | { ok: false; diagnostics: ImportDiagnostic[] };
      if (res.ok && json.ok) {
        onImported({
          versionHash: json.versionHash,
          pipelineName: json.pipelineName,
          alreadyExisted: json.alreadyExisted,
        });
        return;
      }
      const diag = (json as { diagnostics?: ImportDiagnostic[] }).diagnostics ?? [];
      setDiagnostics(diag.length > 0 ? diag : [{ code: `HTTP_${res.status}`, message: "import failed" }]);
    } catch (err) {
      setDiagnostics([{ code: "NETWORK_ERROR", message: err instanceof Error ? err.message : String(err) }]);
    } finally {
      setSubmitting(false);
    }
  }, [fileText, pasted, onImported]);

  if (!open) return null;

  const canSubmit = (fileText.trim().length > 0 || pasted.trim().length > 0) && !submitting;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl rounded-lg border border-strong bg-surface p-5 shadow-lg">
        <h2 className="text-lg font-semibold">Import pipeline</h2>
        <p className="mt-1 text-sm text-secondary">
          Upload a <code className="rounded bg-elevated px-1 font-mono text-xs">.wfctl.json</code> file
          exported from another instance, or paste the JSON directly.
        </p>

        <div className="mt-4 space-y-3">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-secondary">
              File
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.wfctl.json,application/json"
              onChange={handleFile}
              className="mt-1 block w-full text-sm text-secondary file:mr-3 file:rounded file:border file:border-strong file:bg-elevated file:px-3 file:py-1 file:text-sm file:text-primary"
            />
            {fileName && (
              <p className="mt-1 text-xs text-muted">selected: {fileName}</p>
            )}
          </div>

          <div className="text-center text-xs uppercase tracking-wide text-muted">— or —</div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-secondary">
              Paste JSON
            </label>
            <textarea
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder="Paste pipeline export JSON here…"
              rows={8}
              className="mt-1 block w-full rounded border border-strong bg-surface p-2 font-mono text-xs text-primary focus:outline-none focus:border-strong"
              disabled={submitting || fileText.trim().length > 0}
            />
            {fileText.trim().length > 0 && (
              <p className="mt-1 text-xs text-muted">
                Textarea disabled because a file is selected. Clear file selection to paste.
              </p>
            )}
          </div>

          {diagnostics.length > 0 && (
            <div className="rounded border border-danger-border bg-danger-bg p-2 text-sm text-danger-fg">
              <p className="font-semibold">Import failed</p>
              <ul className="mt-1 space-y-1 text-xs">
                {diagnostics.map((d, i) => (
                  <li key={i}>
                    <code className="font-mono">{d.code}</code>
                    {d.message ? `: ${d.message}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-strong bg-surface px-3 py-1.5 text-sm hover:bg-elevated"
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className="rounded border border-info-border bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Importing…" : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5.4: Run test to verify it passes**

```
cd apps/web && npx vitest run src/components/import-pipeline-dialog.test.tsx
```

Expected: 6 tests PASS.

- [ ] **Step 5.5: Verify web tsc**

```
cd apps/web && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 5.6: Commit**

```bash
git add apps/web/src/components/import-pipeline-dialog.tsx apps/web/src/components/import-pipeline-dialog.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): ImportPipelineDialog component

File input + paste-as-JSON textarea fallback. Posts to
/api/kernel/pipelines/import; renders inline diagnostics on failure.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Web — Wire Import button into pipelines list page

**Files:**
- Modify: `apps/web/src/app/kernel-next/pipelines/page.tsx`

- [ ] **Step 6.1: Add Import button + dialog mount**

In `apps/web/src/app/kernel-next/pipelines/page.tsx`:

Add import at the top (after the existing imports):

```ts
import { useRouter } from "next/navigation";
import { ImportPipelineDialog, type ImportSuccessResult } from "../../../components/import-pipeline-dialog";
```

In the component body, after the existing `useState` hooks, add:

```ts
  const [importOpen, setImportOpen] = useState(false);
  const router = useRouter();

  const handleImported = useCallback((res: ImportSuccessResult) => {
    setImportOpen(false);
    router.push(`/kernel-next/pipelines/${encodeURIComponent(res.pipelineName)}`);
  }, [router]);
```

Also add `useCallback` to the React imports at the top of the file:

```ts
import { useCallback, useEffect, useMemo, useState } from "react";
```

In the JSX header `<div className="flex items-center gap-2 text-sm">`, add the Import button as the first child of that div (before the search input, so it's the leftmost action), or place it next to the existing tasks/proposals links — for consistency with existing layout, add it right after the proposals link:

Find:

```tsx
          <Link
            href="/kernel-next/proposals"
            className="rounded border border-strong bg-surface px-3 py-1 hover:border-strong hover:bg-elevated"
          >
            proposals
          </Link>
        </div>
```

Replace with:

```tsx
          <Link
            href="/kernel-next/proposals"
            className="rounded border border-strong bg-surface px-3 py-1 hover:border-strong hover:bg-elevated"
          >
            proposals
          </Link>
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="rounded border border-strong bg-surface px-3 py-1 hover:border-strong hover:bg-elevated"
          >
            Import
          </button>
        </div>
```

Then at the very bottom of the JSX (just before the closing `</div>` of the page-root container), add:

```tsx
      <ImportPipelineDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={handleImported}
      />
```

- [ ] **Step 6.2: Verify web tsc**

```
cd apps/web && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 6.3: Run web tests (no regression)**

```
cd apps/web && npx vitest run
```

Expected: all PASS, including the new dialog tests.

- [ ] **Step 6.4: Commit**

```bash
git add apps/web/src/app/kernel-next/pipelines/page.tsx
git commit -m "$(cat <<'EOF'
feat(web): Import button on pipelines list page

Mounts ImportPipelineDialog; on successful import navigates to the
pipeline detail page.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Manual smoke test (end-to-end)

**Files:** None modified. This task verifies the full human flow.

- [ ] **Step 7.1: Start the dev server (user runs)**

The user starts `pnpm --filter @workflow-control/server dev` and `pnpm --filter @workflow-control/web dev` in separate terminals (or already has them running). The agent does NOT start dev servers per CLAUDE.md.

- [ ] **Step 7.2: Document the manual smoke checklist**

Capture the manual smoke verification expectations in this plan checkpoint (no file change; this is a recorded verification step the user performs):

1. Open `http://localhost:3000/kernel-next/pipelines`.
2. Click any existing pipeline (e.g. `smoke-test`).
3. Click **Export** → file downloads as `<name>-<short>.wfctl.json`.
4. Open the file, confirm `format: "wfctl-pipeline-export/v1"` and prompts present.
5. Back on the list, click **Import**, paste the file contents into the textarea, click Import.
6. Dialog closes; URL updates to that pipeline's detail page.
7. (Optional) Edit one prompt in the file, save as a new file, import it — should succeed and create a new version (visible on the detail page once the editor reloads).
8. Re-import the same exported file → should succeed (idempotent — server logs / response carries `alreadyExisted: true`, but UI just navigates).

If any step fails, file the bug as a follow-up task and stop here.

- [ ] **Step 7.3: No commit needed for this task** (no file changes).

---

## Task 8: Documentation updates

**Files:**
- Modify: `docs/whitepaper.md`
- Modify: `docs/whitepaper-zh.md`
- Modify: `docs/product-roadmap.md`

- [ ] **Step 8.1: Update English whitepaper §1.2**

In `docs/whitepaper.md`, find the §1.2 paragraph that says "执行 single-user; legacy YAML registry retired 2026-05-04" or equivalent (the wording added in revision 1.27). Use `grep -n "single-user" docs/whitepaper.md` to locate the exact line, then update it to mention export/import as the supported sharing path:

The relevant paragraph (post-1.27) should currently read approximately:

> Execution is single-user. The legacy YAML registry was retired on
> 2026-05-04 because YAML packages were structurally incompatible with
> the kernel-next runtime; future cross-user sharing should start from
> `pipeline.ir.json` plus the encrypted MCP catalog rather than
> reintroducing YAML.

Replace with:

> Execution is single-user. Cross-user sharing is supported via
> file-based export/import: any pipeline detail page exposes an
> **Export** button that downloads a `wfctl-pipeline-export/v1` JSON
> envelope (`{ format, exportedAt, source, ir, prompts }`); the
> pipelines list page exposes **Import** to upload such a file. Imports
> route through the same `KernelService.submit` validator stack as
> `submit_pipeline`, so no validation can be bypassed by a hand-edited
> file. Secrets stay on each machine (env vars or `run_pipeline`
> `envValues`); files contain `envKey` *names* but never values.

- [ ] **Step 8.2: Mirror the change in Chinese whitepaper**

In `docs/whitepaper-zh.md`, locate the corresponding §1.2 paragraph (use `grep -n "单用户\|single-user" docs/whitepaper-zh.md`) and update it to:

> 执行层完全单用户。跨用户共享通过文件导入导出实现：每个 pipeline 详情页提供 **Export** 按钮，下载 `wfctl-pipeline-export/v1` JSON 信封（`{ format, exportedAt, source, ir, prompts }`）；pipelines 列表页的 **Import** 按钮上传同样格式的文件。导入路径走 `KernelService.submit` 完整 validator 链，与 `submit_pipeline` 等价——手编辑文件无法绕过校验。Secret 留在各自机器（env vars 或 `run_pipeline` 的 `envValues`）；文件只含 `envKey` **名字**，绝不含值。

- [ ] **Step 8.3: Append revision row 1.28 to product-roadmap.md**

In `docs/product-roadmap.md`, append the following row to the "修订历史" table (at the bottom of the file):

```markdown
| 2026-05-04 | 1.28 | **跨用户 sharing v1 落地（pipeline export/import）**。文件信封格式 `wfctl-pipeline-export/v1`：`{ format, exportedAt, source, ir, prompts }`，纯 JSON，自含、可移植、不带任何机器/用户特定信息（envKey 名进 IR，值绝不进文件）。新增 (a) `apps/server/src/kernel-next/ir/export-envelope.ts` 纯数据模块（zod strict schema + `buildEnvelope` / `parseEnvelope`，独立单元测试）；(b) `GET /api/kernel/pipelines/:versionHash/export` 返回信封 + sanitized `Content-Disposition` filename；(c) `POST /api/kernel/pipelines/import` 走完整 `KernelService.submit` validator 链（无任何绕过），10 MB body 上限，幂等 re-import 通过 source `versionHash` pre-check 检测（`alreadyExisted` 标志）；(d) Web detail 页加 **Export** 按钮（`<a download>`，零 client state）；(e) Web 列表页加 **Import** 按钮 + `ImportPipelineDialog` 组件（文件 input + 粘贴 textarea fallback + 行内 diagnostics）。同时白皮书 §1.2 中英版本更新表述："未来若要恢复" → 当前状态描述。Server +X 文件 / +Y 测试；Web +1 dialog / +1 测试文件。所有错误返回沿用现有 `{ ok: false, diagnostics }` 形状。spec：`docs/superpowers/specs/2026-05-04-pipeline-export-import-design.md`；plan：`docs/superpowers/plans/2026-05-04-pipeline-export-import.md`。|
```

(Replace `+X` / `+Y` with the actual counts after running the test suites at Step 8.5.)

- [ ] **Step 8.4: Verify counts**

```
cd apps/server && npx vitest run 2>&1 | tail -5
cd apps/web && npx vitest run 2>&1 | tail -5
```

Read the test counts and update the roadmap row in Step 8.3 with concrete numbers.

- [ ] **Step 8.5: Final TS + test sanity sweep**

```
cd apps/server && npx tsc --noEmit && npx vitest run 2>&1 | tail -3
cd apps/web && npx tsc --noEmit && npx vitest run 2>&1 | tail -3
```

Expected: both apps clean, all tests green.

- [ ] **Step 8.6: Commit docs**

```bash
git add docs/whitepaper.md docs/whitepaper-zh.md docs/product-roadmap.md
git commit -m "$(cat <<'EOF'
docs: pipeline export/import landed (whitepaper §1.2 + roadmap 1.28)

§1.2 (en + zh) changes from "future sharing path" hand-wave to a
concrete description of the file format + UI affordances. Roadmap row
1.28 records the implementation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Checklist (executed during plan write)

**Spec coverage:**
- §File envelope schema → Task 1 ✓
- §HTTP endpoints (GET export) → Task 2 ✓
- §HTTP endpoints (POST import) → Task 3 ✓
- §Web UI (detail page Export) → Task 4 ✓
- §Web UI (list page Import + dialog) → Tasks 5 + 6 ✓
- §Module organization → All file paths match spec §5 ✓
- §Error handling table → All codes appear in tests (Tasks 2 + 3) ✓
- §Security (envKey names not values, filename sanitization, body limit) → Task 2 (filename), Task 3 (body limit), envelope module never touches `process.env` ✓
- §Idempotence (`alreadyExisted` flag) → Task 3 step 3.3 + tests ✓
- §Testing (envelope unit, route handler, dialog) → Tasks 1, 2, 3, 5 ✓
- §Documentation updates → Task 8 ✓
- §Out of scope items → not implemented (correctly absent) ✓

**Type consistency:**
- `EXPORT_FORMAT_V1` used identically in module, schema, tests ✓
- `parseEnvelope` return type `{ ok: true | false, ... }` matches test expectations ✓
- `ImportSuccessResult` shape `{ versionHash, pipelineName, alreadyExisted }` matches handler response and dialog test ✓
- `Diagnostic` import path `../ir/schema.js` (envelope module) aligned with project convention ✓

**Placeholder scan:**
- No "TBD", "implement later", "similar to Task N", or hand-wavy steps. All code blocks contain real code.
- Step 8.3's `+X` / `+Y` are explicitly flagged for replacement at Step 8.4 (a normal real-counts substitution, not a placeholder).

**Scope:**
- One spec → one plan. No subsystems split needed. ✓
