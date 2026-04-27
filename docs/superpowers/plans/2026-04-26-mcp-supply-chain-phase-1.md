# MCP Supply Chain — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the catalog foundation (data model, store, recommender, REST + MCP tools) so that other Flow components can later discover and recommend MCP servers.

**Architecture:** A self-contained subsystem under `apps/server/src/kernel-next/mcp-catalog/` with three surfaces (internal module, REST routes, MCP tools) over a single SQLite truth source. Phase 1 ships catalog data + recommender; provisioning, inventory, encryption come in Phase 2.

**Tech Stack:** TypeScript, vitest, Hono, node:sqlite, zod, @anthropic-ai/sdk (already a dep via Claude Agent SDK)

**Spec reference:** `docs/superpowers/specs/2026-04-26-mcp-supply-chain-design.md` §§ 1-4, plus subset of § 7 (the MCP tool surface).

---

## Out of scope for Phase 1

These belong to Phases 2-4 and **must NOT be built here**:

- `mcp_inventory` and `mcp_inventory_secrets` tables
- AES encryption / `crypto.ts` / `.secret-key` file
- Provisioning state machine, `equip` / `unequip` / `recheck` endpoints
- Health checks (envKey verification, `npm view`)
- Web UI (no `apps/web/` changes)
- `pipeline-generator` IR or prompt changes
- `launcher-pipeline-dialog.tsx` changes
- `mcp-servers-expander.ts` inventory secret resolution
- `secret-gate-panel.tsx` `persistAs` checkbox

If a task below seems to imply any of these, the task is wrong and should be deferred.

---

## File map

**New files (15):**

```
apps/server/src/kernel-next/mcp-catalog/
├── schema.ts                    # zod CatalogEntrySchema, RecommendResultSchema, error codes
├── sql.ts                       # CATALOG_SCHEMA, initCatalogSchema(db), idempotent CREATE
├── catalog-store.ts             # listEntries / getEntry / upsertCustomEntry / deleteCustomEntry / lookupEntryByCommand
├── seed.ts                      # seedBuiltinFromJson(db, jsonPath)
├── score-weights.ts             # SCORE_WEIGHTS + MIN_SCORE consts (tunable)
├── recommender.ts               # recommendForTopicLocal (sync) + recommendForTopicWithLLM (async)
├── llm-client.ts                # simpleJsonCompletion<T>
├── entries.json                 # initial builtin entries (~10-15)
├── schema.test.ts
├── sql.test.ts
├── catalog-store.test.ts
├── seed.test.ts
├── recommender.test.ts
└── llm-client.test.ts

apps/server/src/kernel-next/mcp/tools/
└── mcp-catalog.ts               # buildMcpCatalogTools(deps)

apps/server/src/routes/
├── kernel-mcp-catalog.ts        # /api/kernel/mcp-catalog/{entries,recommend}
└── kernel-mcp-catalog.test.ts
```

**Modified files (3):**

```
apps/server/src/kernel-next/ir/sql.ts         # initKernelNextSchema also runs initCatalogSchema
apps/server/src/kernel-next/mcp/server.ts     # ToolName union + EXTERNAL_TOOLS + buildMcpCatalogTools call
apps/server/src/index.ts                      # mount kernelMcpCatalogRoute + call seedBuiltinFromJson on startup
```

---

## Conventions to mirror (from kernel-next codebase)

- **SQL**: `CATALOG_SCHEMA` exported as a single string of `CREATE TABLE IF NOT EXISTS` statements; `initCatalogSchema(db)` runs them. Index naming: `idx_<table-prefix>_<col>`.
- **Schema files**: zod schemas in `schema.ts`, types via `z.infer<typeof X>`, error code enums in same file.
- **Diagnostic envelope**: `{ ok: true, ... } | { ok: false, diagnostics: Diagnostic[] }`. Reuse `DiagnosticSchema` from `kernel-next/ir/schema.ts`.
- **REST routes**: `new Hono()` per file; `safeParse` + `badRequest()` helper; mount via `app.route("/api", routeExport)` in `index.ts`.
- **MCP tools**: extend `ToolName` union + `EXTERNAL_TOOLS` set in `mcp/server.ts`; tool factory `buildMcpCatalogTools(deps)` in `mcp/tools/mcp-catalog.ts` returns `ToolDef[]`.
- **Tests**: vitest, file naming `<module>.test.ts` adjacent to module; in-memory DB via `new DatabaseSync(":memory:")` + `initCatalogSchema(db)`.

---

## Task list

### Task 1: zod schemas + error codes

**Goal:** Define the `CatalogEntry` shape, `RecommendResult` shape, and the catalog-specific diagnostic codes. This is the type foundation everything else builds on.

**Files:**
- Create: `apps/server/src/kernel-next/mcp-catalog/schema.ts`
- Test: `apps/server/src/kernel-next/mcp-catalog/schema.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// apps/server/src/kernel-next/mcp-catalog/schema.test.ts
import { describe, it, expect } from "vitest";
import {
  CatalogEntrySchema,
  RecommendResultSchema,
  CATALOG_DIAGNOSTIC_CODES,
} from "./schema.js";

describe("CatalogEntrySchema", () => {
  const validEntry = {
    id: "etherscan",
    source: "builtin" as const,
    schemaVersion: "1" as const,
    name: "Etherscan",
    description: "Read Ethereum onchain data",
    useCases: ["verify tx hash on Ethereum"],
    tags: ["onchain-verification"],
    command: "npx",
    args: ["-y", "@scope/etherscan-mcp"],
    envKeys: [{
      name: "ETHERSCAN_API_KEY",
      required: true,
      description: "Etherscan API key",
      obtainUrl: "https://etherscan.io/apis",
      obtainSteps: "1. Register\n2. Generate key",
    }],
    healthCheckTimeoutMs: 10000,
  };

  it("parses a valid entry", () => {
    const parsed = CatalogEntrySchema.safeParse(validEntry);
    expect(parsed.success).toBe(true);
  });

  it("rejects entry with non-kebab id", () => {
    const bad = { ...validEntry, id: "Ether Scan!" };
    expect(CatalogEntrySchema.safeParse(bad).success).toBe(false);
  });

  it("rejects entry with empty useCases", () => {
    const bad = { ...validEntry, useCases: [] };
    expect(CatalogEntrySchema.safeParse(bad).success).toBe(false);
  });

  it("accepts entry without optional fields", () => {
    const minimal = { ...validEntry };
    delete (minimal as { homepage?: unknown }).homepage;
    delete (minimal as { packageName?: unknown }).packageName;
    delete (minimal as { toolsPreview?: unknown }).toolsPreview;
    delete (minimal as { deprecatedAt?: unknown }).deprecatedAt;
    expect(CatalogEntrySchema.safeParse(minimal).success).toBe(true);
  });

  it("source must be 'builtin' or 'custom'", () => {
    const bad = { ...validEntry, source: "marketplace" };
    expect(CatalogEntrySchema.safeParse(bad).success).toBe(false);
  });
});

describe("RecommendResultSchema", () => {
  it("parses a result with evidence and llmReason", () => {
    const r = {
      id: "etherscan",
      score: 0.85,
      evidence: {
        matchedTags: ["onchain-verification"],
        matchedUseCases: ["verify tx hash"],
        matchedDescriptionTerms: [],
      },
      llmReason: "Used to verify smart contracts on Ethereum",
    };
    expect(RecommendResultSchema.safeParse(r).success).toBe(true);
  });

  it("score must be 0..1", () => {
    const r = {
      id: "x",
      score: 1.5,
      evidence: { matchedTags: [], matchedUseCases: [], matchedDescriptionTerms: [] },
    };
    expect(RecommendResultSchema.safeParse(r).success).toBe(false);
  });
});

describe("CATALOG_DIAGNOSTIC_CODES", () => {
  it("includes the 4 codes used by Phase 1 endpoints", () => {
    expect(CATALOG_DIAGNOSTIC_CODES).toContain("CATALOG_ENTRY_NOT_FOUND");
    expect(CATALOG_DIAGNOSTIC_CODES).toContain("CATALOG_ENTRY_ID_CONFLICT");
    expect(CATALOG_DIAGNOSTIC_CODES).toContain("CATALOG_INVALID_ENTRY");
    expect(CATALOG_DIAGNOSTIC_CODES).toContain("CATALOG_BUILTIN_NOT_WRITABLE");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && pnpm vitest run src/kernel-next/mcp-catalog/schema.test.ts`
Expected: FAIL with "Cannot find module './schema.js'".

- [ ] **Step 3: Write the schema file**

```typescript
// apps/server/src/kernel-next/mcp-catalog/schema.ts
import { z } from "zod";

const KEBAB_ID = /^[a-z][a-z0-9-]*$/;

export const CatalogEntrySchema = z.object({
  id: z.string().min(1).max(64).regex(KEBAB_ID, "id must be kebab-case lowercase"),
  source: z.enum(["builtin", "custom"]),
  schemaVersion: z.literal("1"),

  name: z.string().min(1).max(128),
  description: z.string().min(1).max(1024),
  useCases: z.array(z.string().min(1)).min(1),
  tags: z.array(z.string().min(1)).min(0),
  homepage: z.string().url().optional(),

  command: z.string().min(1),
  args: z.array(z.string()),
  packageName: z.string().min(1).optional(),

  envKeys: z.array(z.object({
    name: z.string().min(1).max(128),
    required: z.boolean(),
    description: z.string(),
    obtainUrl: z.string().url(),
    obtainSteps: z.string(),
  })),

  healthCheckTimeoutMs: z.number().int().positive(),

  toolsPreview: z.array(z.object({
    name: z.string(),
    brief: z.string(),
  })).optional(),

  deprecatedAt: z.number().int().positive().optional(),
}).strict();

export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export const RecommendResultSchema = z.object({
  id: z.string().min(1),
  score: z.number().min(0).max(1),
  evidence: z.object({
    matchedTags: z.array(z.string()),
    matchedUseCases: z.array(z.string()),
    matchedDescriptionTerms: z.array(z.string()),
  }),
  llmReason: z.string().optional(),
}).strict();

export type RecommendResult = z.infer<typeof RecommendResultSchema>;

export const CATALOG_DIAGNOSTIC_CODES = [
  "CATALOG_ENTRY_NOT_FOUND",
  "CATALOG_ENTRY_ID_CONFLICT",
  "CATALOG_INVALID_ENTRY",
  "CATALOG_BUILTIN_NOT_WRITABLE",
] as const;

export type CatalogDiagnosticCode = (typeof CATALOG_DIAGNOSTIC_CODES)[number];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && pnpm vitest run src/kernel-next/mcp-catalog/schema.test.ts`
Expected: PASS, 3 describe blocks all green.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/mcp-catalog/schema.ts apps/server/src/kernel-next/mcp-catalog/schema.test.ts
git commit -m "feat(mcp-catalog): zod schemas + diagnostic codes"
```

---

### Task 2: SQL DDL + initCatalogSchema

**Goal:** Define the `mcp_catalog` table and an idempotent init function. Follow the kernel-next/ir/sql.ts pattern: a single schema string + an init function callable from `initKernelNextSchema`.

**Files:**
- Create: `apps/server/src/kernel-next/mcp-catalog/sql.ts`
- Test: `apps/server/src/kernel-next/mcp-catalog/sql.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// apps/server/src/kernel-next/mcp-catalog/sql.test.ts
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initCatalogSchema } from "./sql.js";

describe("initCatalogSchema", () => {
  it("creates mcp_catalog table", () => {
    const db = new DatabaseSync(":memory:");
    initCatalogSchema(db);

    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_catalog'")
      .get();
    expect(row).toEqual({ name: "mcp_catalog" });
  });

  it("is idempotent (running twice does not throw)", () => {
    const db = new DatabaseSync(":memory:");
    initCatalogSchema(db);
    expect(() => initCatalogSchema(db)).not.toThrow();
  });

  it("enforces source CHECK constraint", () => {
    const db = new DatabaseSync(":memory:");
    initCatalogSchema(db);

    expect(() => {
      db.prepare(
        "INSERT INTO mcp_catalog (id, source, entry_json, updated_at) VALUES (?, ?, ?, ?)"
      ).run("x", "marketplace", "{}", 1);
    }).toThrow(/CHECK constraint failed/);
  });

  it("enforces id PRIMARY KEY uniqueness", () => {
    const db = new DatabaseSync(":memory:");
    initCatalogSchema(db);

    db.prepare(
      "INSERT INTO mcp_catalog (id, source, entry_json, updated_at) VALUES (?, ?, ?, ?)"
    ).run("x", "builtin", "{}", 1);

    expect(() => {
      db.prepare(
        "INSERT INTO mcp_catalog (id, source, entry_json, updated_at) VALUES (?, ?, ?, ?)"
      ).run("x", "custom", "{}", 2);
    }).toThrow(/UNIQUE constraint failed/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && pnpm vitest run src/kernel-next/mcp-catalog/sql.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Write sql.ts**

```typescript
// apps/server/src/kernel-next/mcp-catalog/sql.ts
import type { DatabaseSync } from "node:sqlite";

export const CATALOG_SCHEMA = `
CREATE TABLE IF NOT EXISTS mcp_catalog (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL CHECK(source IN ('builtin','custom')),
  entry_json    TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  deprecated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mc_source ON mcp_catalog(source);
CREATE INDEX IF NOT EXISTS idx_mc_deprecated ON mcp_catalog(deprecated_at);
`;

export function initCatalogSchema(db: DatabaseSync): void {
  db.exec(CATALOG_SCHEMA);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && pnpm vitest run src/kernel-next/mcp-catalog/sql.test.ts`
Expected: PASS, all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/mcp-catalog/sql.ts apps/server/src/kernel-next/mcp-catalog/sql.test.ts
git commit -m "feat(mcp-catalog): mcp_catalog table + initCatalogSchema"
```

---

### Task 3: catalog-store CRUD + lookupEntryByCommand

**Goal:** All read/write operations on `mcp_catalog`. This is the data-access module the rest of Phase 1 builds on. Includes the `lookupEntryByCommand` helper that other phases will need.

**Files:**
- Create: `apps/server/src/kernel-next/mcp-catalog/catalog-store.ts`
- Test: `apps/server/src/kernel-next/mcp-catalog/catalog-store.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// apps/server/src/kernel-next/mcp-catalog/catalog-store.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initCatalogSchema } from "./sql.js";
import {
  listEntries,
  getEntry,
  upsertCustomEntry,
  deleteCustomEntry,
  lookupEntryByCommand,
  insertBuiltinEntry,
  markBuiltinDeprecated,
} from "./catalog-store.js";
import type { CatalogEntry } from "./schema.js";

function makeEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "etherscan",
    source: "builtin",
    schemaVersion: "1",
    name: "Etherscan",
    description: "Read Ethereum onchain data",
    useCases: ["verify tx hash"],
    tags: ["onchain-verification"],
    command: "npx",
    args: ["-y", "@scope/etherscan-mcp"],
    envKeys: [],
    healthCheckTimeoutMs: 10000,
    ...overrides,
  };
}

describe("catalog-store", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initCatalogSchema(db);
  });

  describe("listEntries / getEntry", () => {
    it("returns empty list initially", () => {
      expect(listEntries(db)).toEqual([]);
    });

    it("listEntries skips deprecated by default", () => {
      insertBuiltinEntry(db, makeEntry({ id: "a" }));
      insertBuiltinEntry(db, makeEntry({ id: "b" }));
      markBuiltinDeprecated(db, "b", 12345);

      const list = listEntries(db);
      expect(list.map((e) => e.id)).toEqual(["a"]);
    });

    it("listEntries with includeDeprecated=true returns all", () => {
      insertBuiltinEntry(db, makeEntry({ id: "a" }));
      insertBuiltinEntry(db, makeEntry({ id: "b" }));
      markBuiltinDeprecated(db, "b", 12345);

      const list = listEntries(db, { includeDeprecated: true });
      expect(list.map((e) => e.id).sort()).toEqual(["a", "b"]);
    });

    it("listEntries filters by source", () => {
      insertBuiltinEntry(db, makeEntry({ id: "a" }));
      upsertCustomEntry(db, makeEntry({ id: "b", source: "custom" }));

      expect(listEntries(db, { source: "builtin" }).map((e) => e.id)).toEqual(["a"]);
      expect(listEntries(db, { source: "custom" }).map((e) => e.id)).toEqual(["b"]);
    });

    it("getEntry returns null for missing id", () => {
      expect(getEntry(db, "nope")).toBeNull();
    });

    it("getEntry returns deprecated entries only with includeDeprecated", () => {
      insertBuiltinEntry(db, makeEntry({ id: "a" }));
      markBuiltinDeprecated(db, "a", 1);

      expect(getEntry(db, "a")).toBeNull();
      expect(getEntry(db, "a", { includeDeprecated: true })?.id).toBe("a");
    });
  });

  describe("upsertCustomEntry", () => {
    it("inserts a custom entry", () => {
      const r = upsertCustomEntry(db, makeEntry({ id: "x", source: "custom" }));
      expect(r.ok).toBe(true);
      expect(getEntry(db, "x")?.source).toBe("custom");
    });

    it("rejects when id collides with builtin", () => {
      insertBuiltinEntry(db, makeEntry({ id: "a", source: "builtin" }));
      const r = upsertCustomEntry(db, makeEntry({ id: "a", source: "custom" }));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.diagnostics[0].code).toBe("CATALOG_ENTRY_ID_CONFLICT");
      }
    });

    it("forces source='custom' regardless of input", () => {
      const r = upsertCustomEntry(db, makeEntry({ id: "x", source: "builtin" }));
      expect(r.ok).toBe(true);
      expect(getEntry(db, "x")?.source).toBe("custom");
    });

    it("updates existing custom entry on second call", () => {
      upsertCustomEntry(db, makeEntry({ id: "x", source: "custom", name: "v1" }));
      upsertCustomEntry(db, makeEntry({ id: "x", source: "custom", name: "v2" }));
      expect(getEntry(db, "x")?.name).toBe("v2");
    });
  });

  describe("deleteCustomEntry", () => {
    it("deletes a custom entry", () => {
      upsertCustomEntry(db, makeEntry({ id: "x", source: "custom" }));
      const r = deleteCustomEntry(db, "x");
      expect(r.ok).toBe(true);
      expect(getEntry(db, "x")).toBeNull();
    });

    it("rejects deletion of builtin", () => {
      insertBuiltinEntry(db, makeEntry({ id: "a" }));
      const r = deleteCustomEntry(db, "a");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.diagnostics[0].code).toBe("CATALOG_BUILTIN_NOT_WRITABLE");
      }
    });

    it("returns CATALOG_ENTRY_NOT_FOUND for missing id", () => {
      const r = deleteCustomEntry(db, "nope");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.diagnostics[0].code).toBe("CATALOG_ENTRY_NOT_FOUND");
      }
    });
  });

  describe("lookupEntryByCommand", () => {
    it("returns entry id when command+args match exactly", () => {
      insertBuiltinEntry(db, makeEntry({
        id: "etherscan",
        command: "npx",
        args: ["-y", "@scope/etherscan-mcp"],
      }));

      const id = lookupEntryByCommand(db, "npx", ["-y", "@scope/etherscan-mcp"]);
      expect(id).toBe("etherscan");
    });

    it("returns null when no entry matches", () => {
      insertBuiltinEntry(db, makeEntry({
        id: "etherscan",
        command: "npx",
        args: ["-y", "@scope/etherscan-mcp"],
      }));

      expect(lookupEntryByCommand(db, "npx", ["-y", "@other/mcp"])).toBeNull();
      expect(lookupEntryByCommand(db, "node", ["-y", "@scope/etherscan-mcp"])).toBeNull();
    });

    it("does not match deprecated entries", () => {
      insertBuiltinEntry(db, makeEntry({
        id: "etherscan",
        command: "npx",
        args: ["-y", "@scope/etherscan-mcp"],
      }));
      markBuiltinDeprecated(db, "etherscan", 1);

      expect(lookupEntryByCommand(db, "npx", ["-y", "@scope/etherscan-mcp"])).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && pnpm vitest run src/kernel-next/mcp-catalog/catalog-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write catalog-store.ts**

```typescript
// apps/server/src/kernel-next/mcp-catalog/catalog-store.ts
import type { DatabaseSync } from "node:sqlite";
import type { Diagnostic } from "../ir/schema.js";
import { CatalogEntrySchema, type CatalogEntry } from "./schema.js";

type ListOpts = {
  source?: "builtin" | "custom" | "all";
  includeDeprecated?: boolean;
};

type GetOpts = {
  includeDeprecated?: boolean;
};

type WriteResult = { ok: true; entry: CatalogEntry } | { ok: false; diagnostics: Diagnostic[] };

export function listEntries(db: DatabaseSync, opts: ListOpts = {}): CatalogEntry[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.source && opts.source !== "all") {
    conditions.push("source = ?");
    params.push(opts.source);
  }
  if (!opts.includeDeprecated) {
    conditions.push("deprecated_at IS NULL");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT entry_json FROM mcp_catalog ${where} ORDER BY id ASC`;
  const rows = db.prepare(sql).all(...params) as { entry_json: string }[];
  return rows.map((r) => CatalogEntrySchema.parse(JSON.parse(r.entry_json)));
}

export function getEntry(
  db: DatabaseSync,
  id: string,
  opts: GetOpts = {},
): CatalogEntry | null {
  const sql = opts.includeDeprecated
    ? "SELECT entry_json FROM mcp_catalog WHERE id = ?"
    : "SELECT entry_json FROM mcp_catalog WHERE id = ? AND deprecated_at IS NULL";
  const row = db.prepare(sql).get(id) as { entry_json: string } | undefined;
  if (!row) return null;
  return CatalogEntrySchema.parse(JSON.parse(row.entry_json));
}

export function upsertCustomEntry(db: DatabaseSync, entry: CatalogEntry): WriteResult {
  // Validate
  const parsed = CatalogEntrySchema.safeParse({ ...entry, source: "custom" });
  if (!parsed.success) {
    return {
      ok: false,
      diagnostics: [{
        code: "CATALOG_INVALID_ENTRY",
        message: parsed.error.issues[0]?.message ?? "invalid entry",
        context: { path: parsed.error.issues[0]?.path },
      }],
    };
  }

  // Check id collision with builtin
  const existing = db
    .prepare("SELECT source FROM mcp_catalog WHERE id = ?")
    .get(entry.id) as { source: string } | undefined;
  if (existing && existing.source === "builtin") {
    return {
      ok: false,
      diagnostics: [{
        code: "CATALOG_ENTRY_ID_CONFLICT",
        message: `id '${entry.id}' is already used by a builtin entry`,
        context: { id: entry.id },
      }],
    };
  }

  const finalEntry: CatalogEntry = parsed.data;
  const now = Date.now();
  db.prepare(`
    INSERT INTO mcp_catalog (id, source, entry_json, updated_at, deprecated_at)
    VALUES (?, 'custom', ?, ?, NULL)
    ON CONFLICT(id) DO UPDATE SET
      entry_json = excluded.entry_json,
      updated_at = excluded.updated_at,
      deprecated_at = NULL
  `).run(finalEntry.id, JSON.stringify(finalEntry), now);

  return { ok: true, entry: finalEntry };
}

export function deleteCustomEntry(
  db: DatabaseSync,
  id: string,
): { ok: true } | { ok: false; diagnostics: Diagnostic[] } {
  const existing = db
    .prepare("SELECT source FROM mcp_catalog WHERE id = ?")
    .get(id) as { source: string } | undefined;

  if (!existing) {
    return {
      ok: false,
      diagnostics: [{ code: "CATALOG_ENTRY_NOT_FOUND", message: `entry '${id}' not found`, context: { id } }],
    };
  }
  if (existing.source === "builtin") {
    return {
      ok: false,
      diagnostics: [{
        code: "CATALOG_BUILTIN_NOT_WRITABLE",
        message: "builtin entries cannot be deleted via the API; modify entries.json instead",
        context: { id },
      }],
    };
  }

  db.prepare("DELETE FROM mcp_catalog WHERE id = ?").run(id);
  return { ok: true };
}

/**
 * Find an entry by exact command+args match. Used by other subsystems
 * to reverse-look-up an mcpServer declaration in an IR back to a catalog entry.
 */
export function lookupEntryByCommand(
  db: DatabaseSync,
  command: string,
  args: string[],
): string | null {
  const argsJson = JSON.stringify(args);
  const rows = db
    .prepare(`
      SELECT id, entry_json FROM mcp_catalog
      WHERE deprecated_at IS NULL
    `)
    .all() as { id: string; entry_json: string }[];

  for (const row of rows) {
    const entry = CatalogEntrySchema.parse(JSON.parse(row.entry_json));
    if (entry.command === command && JSON.stringify(entry.args) === argsJson) {
      return entry.id;
    }
  }
  return null;
}

/**
 * Internal helper for seed.ts. Bypasses source-check (allows source='builtin').
 * NOT exposed via REST.
 */
export function insertBuiltinEntry(db: DatabaseSync, entry: CatalogEntry): void {
  const now = Date.now();
  const finalEntry: CatalogEntry = { ...entry, source: "builtin" };
  db.prepare(`
    INSERT INTO mcp_catalog (id, source, entry_json, updated_at, deprecated_at)
    VALUES (?, 'builtin', ?, ?, NULL)
    ON CONFLICT(id) DO UPDATE SET
      entry_json = excluded.entry_json,
      updated_at = excluded.updated_at,
      deprecated_at = NULL
  `).run(finalEntry.id, JSON.stringify(finalEntry), now);
}

/**
 * Internal helper for seed.ts. Marks a builtin row as deprecated rather
 * than deleting it.
 */
export function markBuiltinDeprecated(db: DatabaseSync, id: string, atMs: number): void {
  db.prepare(`
    UPDATE mcp_catalog SET deprecated_at = ?
    WHERE id = ? AND source = 'builtin'
  `).run(atMs, id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && pnpm vitest run src/kernel-next/mcp-catalog/catalog-store.test.ts`
Expected: PASS, 13 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/mcp-catalog/catalog-store.ts apps/server/src/kernel-next/mcp-catalog/catalog-store.test.ts
git commit -m "feat(mcp-catalog): catalog-store CRUD + lookupEntryByCommand"
```

---

### Task 4: entries.json + seed.ts

**Goal:** Define the initial 10-15 builtin entries (Phase 1's catalog content) and the seed function that loads them on startup, handling deprecation.

**Files:**
- Create: `apps/server/src/kernel-next/mcp-catalog/entries.json`
- Create: `apps/server/src/kernel-next/mcp-catalog/seed.ts`
- Test: `apps/server/src/kernel-next/mcp-catalog/seed.test.ts`

- [ ] **Step 1: Write the entries.json (12 entries covering web3, code, web research, files, github)**

```json
{
  "schemaVersion": "1",
  "entries": [
    {
      "id": "etherscan",
      "schemaVersion": "1",
      "name": "Etherscan MCP",
      "description": "查询以太坊及 L2 上的合约源码、tx、地址 holdings / Read Ethereum and L2 onchain data: contract source, tx, address holdings",
      "useCases": [
        "verify tx hash and contract source on Ethereum / 验证以太坊上的 tx 哈希和合约源码",
        "read smart contract storage / 读取智能合约 storage",
        "look up address ERC20 balances / 查询地址的 ERC20 余额"
      ],
      "tags": ["onchain-verification", "链上验证", "evm", "ethereum", "以太坊", "research"],
      "homepage": "https://etherscan.io",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-etherscan"],
      "packageName": "@modelcontextprotocol/server-etherscan",
      "envKeys": [
        {
          "name": "ETHERSCAN_API_KEY",
          "required": true,
          "description": "Etherscan API key (free tier available)",
          "obtainUrl": "https://etherscan.io/apis",
          "obtainSteps": "1. 注册 Etherscan 账号\n2. 登录后进入 'API Keys' 页\n3. 点击 'Add' 创建新 key\n4. 复制 key 粘贴到此处"
        }
      ],
      "healthCheckTimeoutMs": 15000
    },
    {
      "id": "bscscan",
      "schemaVersion": "1",
      "name": "BscScan MCP",
      "description": "查询 BSC 链上数据 / Read Binance Smart Chain onchain data",
      "useCases": [
        "verify contracts on BSC / 验证 BSC 上的合约",
        "read BEP-20 token transfers / 读取 BEP-20 转账"
      ],
      "tags": ["onchain-verification", "链上验证", "bsc", "binance"],
      "homepage": "https://bscscan.com",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-bscscan"],
      "packageName": "@modelcontextprotocol/server-bscscan",
      "envKeys": [
        {
          "name": "BSCSCAN_API_KEY",
          "required": true,
          "description": "BscScan API key",
          "obtainUrl": "https://bscscan.com/apis",
          "obtainSteps": "1. 注册 BscScan 账号\n2. 进入 'API Keys' 页\n3. 创建新 key 并复制粘贴"
        }
      ],
      "healthCheckTimeoutMs": 15000
    },
    {
      "id": "github",
      "schemaVersion": "1",
      "name": "GitHub MCP",
      "description": "读取 GitHub repos、issues、pull requests / Read GitHub repos, issues, pull requests",
      "useCases": [
        "read source code from public or private repos / 读取公开或私有仓库的源码",
        "search issues and PRs by keyword / 按关键词搜索 issue 和 PR",
        "list a repository's recent commits / 列出仓库的最近提交"
      ],
      "tags": ["code-research", "代码研究", "github", "vcs", "git", "research"],
      "homepage": "https://github.com",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "packageName": "@modelcontextprotocol/server-github",
      "envKeys": [
        {
          "name": "GITHUB_PERSONAL_ACCESS_TOKEN",
          "required": true,
          "description": "GitHub personal access token, scope: repo (read)",
          "obtainUrl": "https://github.com/settings/tokens",
          "obtainSteps": "1. GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)\n2. Generate new token (classic)\n3. 勾选 'repo' scope (读权限即可)\n4. Generate, 立刻复制 token (只显示一次)\n5. 粘贴到此处"
        }
      ],
      "healthCheckTimeoutMs": 15000
    },
    {
      "id": "fetch",
      "schemaVersion": "1",
      "name": "Fetch MCP",
      "description": "通用 HTTP fetch,可读任意公开 URL / General HTTP fetch for arbitrary public URLs",
      "useCases": [
        "fetch a web page or API response by URL / 抓取任意 URL 的网页或 API 响应",
        "read documentation pages from official websites / 读取官方文档页",
        "verify claims by fetching primary sources / 通过抓取一手来源验证声明"
      ],
      "tags": ["web-research", "网页研究", "http", "fetch", "research"],
      "homepage": "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-fetch"],
      "packageName": "@modelcontextprotocol/server-fetch",
      "envKeys": [],
      "healthCheckTimeoutMs": 10000
    },
    {
      "id": "filesystem",
      "schemaVersion": "1",
      "name": "Filesystem MCP",
      "description": "本地文件系统读写 / Local filesystem read/write",
      "useCases": [
        "read files from a local directory / 读取本地目录下的文件",
        "list directory contents / 列出目录内容",
        "search files by pattern / 按模式搜索文件"
      ],
      "tags": ["filesystem", "文件系统", "local", "code-research"],
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem"],
      "packageName": "@modelcontextprotocol/server-filesystem",
      "envKeys": [],
      "healthCheckTimeoutMs": 10000
    },
    {
      "id": "arxiv",
      "schemaVersion": "1",
      "name": "arXiv MCP",
      "description": "搜索 arXiv 论文摘要和元数据 / Search arXiv paper abstracts and metadata",
      "useCases": [
        "search academic papers by topic / 按主题搜索学术论文",
        "fetch paper metadata for citations / 抓取论文元数据用于引用",
        "find recent preprints in a field / 查找某领域最近的预印本"
      ],
      "tags": ["academic", "学术", "research", "arxiv", "papers"],
      "homepage": "https://arxiv.org",
      "command": "npx",
      "args": ["-y", "@blazickjp/arxiv-mcp-server"],
      "packageName": "@blazickjp/arxiv-mcp-server",
      "envKeys": [],
      "healthCheckTimeoutMs": 15000
    },
    {
      "id": "playwright",
      "schemaVersion": "1",
      "name": "Playwright MCP",
      "description": "浏览器自动化,实测网页交互 / Browser automation for testing real web interactions",
      "useCases": [
        "measure actual page-load timings / 实测网页加载时间",
        "test cross-chain bridge UX flows / 测试跨链桥的 UX 流程",
        "extract data from JS-rendered pages / 抓取 JS 渲染页的数据"
      ],
      "tags": ["browser-automation", "浏览器自动化", "playwright", "testing", "research"],
      "homepage": "https://github.com/microsoft/playwright-mcp",
      "command": "npx",
      "args": ["-y", "@playwright/mcp"],
      "packageName": "@playwright/mcp",
      "envKeys": [],
      "healthCheckTimeoutMs": 30000
    },
    {
      "id": "brave-search",
      "schemaVersion": "1",
      "name": "Brave Search MCP",
      "description": "基于 Brave 引擎的网页搜索 / Web search powered by Brave Search engine",
      "useCases": [
        "search the web for recent news or articles / 搜索最近的新闻或文章",
        "find information across the public web / 在公网上查找信息"
      ],
      "tags": ["web-search", "网页搜索", "research", "brave"],
      "homepage": "https://brave.com/search/api",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "packageName": "@modelcontextprotocol/server-brave-search",
      "envKeys": [
        {
          "name": "BRAVE_API_KEY",
          "required": true,
          "description": "Brave Search API key (2k queries/month free tier)",
          "obtainUrl": "https://api.search.brave.com/app/keys",
          "obtainSteps": "1. 注册 Brave Search API 账号\n2. 进入 keys 页面\n3. Subscribe to free tier (2k queries/month)\n4. 复制 API key"
        }
      ],
      "healthCheckTimeoutMs": 15000
    },
    {
      "id": "puppeteer",
      "schemaVersion": "1",
      "name": "Puppeteer MCP",
      "description": "headless Chromium 浏览器控制 / Headless Chromium browser control",
      "useCases": [
        "screenshot a web page / 给网页截图",
        "scrape JS-heavy sites / 抓取 JS 重的站点"
      ],
      "tags": ["browser-automation", "浏览器自动化", "puppeteer", "research"],
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-puppeteer"],
      "packageName": "@modelcontextprotocol/server-puppeteer",
      "envKeys": [],
      "healthCheckTimeoutMs": 30000
    },
    {
      "id": "linear",
      "schemaVersion": "1",
      "name": "Linear MCP",
      "description": "读写 Linear issues / Read and write Linear issues",
      "useCases": [
        "fetch open issues from a Linear team / 抓取 Linear team 的未关闭 issue",
        "create issues from research findings / 从研究发现自动创建 issue"
      ],
      "tags": ["task-management", "issue-tracker", "linear"],
      "homepage": "https://linear.app",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-linear"],
      "packageName": "@modelcontextprotocol/server-linear",
      "envKeys": [
        {
          "name": "LINEAR_API_KEY",
          "required": true,
          "description": "Linear personal API key",
          "obtainUrl": "https://linear.app/settings/api",
          "obtainSteps": "1. Linear Settings → API\n2. Create Personal API Key\n3. 复制粘贴"
        }
      ],
      "healthCheckTimeoutMs": 15000
    },
    {
      "id": "slack",
      "schemaVersion": "1",
      "name": "Slack MCP",
      "description": "读 Slack 频道消息 / Read Slack channel messages",
      "useCases": [
        "search recent slack discussions / 搜索 Slack 上的最近讨论",
        "fetch a channel's recent messages / 抓取频道的最近消息"
      ],
      "tags": ["communication", "slack", "messaging"],
      "homepage": "https://slack.com",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-slack"],
      "packageName": "@modelcontextprotocol/server-slack",
      "envKeys": [
        {
          "name": "SLACK_BOT_TOKEN",
          "required": true,
          "description": "Slack bot token (xoxb-...)",
          "obtainUrl": "https://api.slack.com/apps",
          "obtainSteps": "1. 创建 Slack app\n2. 启用 Bot Token Scopes (channels:history, channels:read 等)\n3. Install app to workspace\n4. 复制 Bot User OAuth Token"
        }
      ],
      "healthCheckTimeoutMs": 15000
    },
    {
      "id": "postgres",
      "schemaVersion": "1",
      "name": "PostgreSQL MCP",
      "description": "Postgres 数据库只读查询 / Read-only PostgreSQL queries",
      "useCases": [
        "run SELECT queries against a database / 对数据库跑 SELECT 查询",
        "explore database schema / 探索数据库 schema"
      ],
      "tags": ["database", "postgres", "sql"],
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "packageName": "@modelcontextprotocol/server-postgres",
      "envKeys": [
        {
          "name": "POSTGRES_CONNECTION_STRING",
          "required": true,
          "description": "Postgres connection string (postgresql://user:pass@host/db)",
          "obtainUrl": "https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING",
          "obtainSteps": "1. 从你的数据库管理面板拿到 connection string\n2. 形如 'postgresql://user:password@host:5432/dbname'"
        }
      ],
      "healthCheckTimeoutMs": 15000
    }
  ]
}
```

- [ ] **Step 2: Write failing test for seed**

```typescript
// apps/server/src/kernel-next/mcp-catalog/seed.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCatalogSchema } from "./sql.js";
import { seedBuiltinFromJson } from "./seed.js";
import { listEntries, getEntry, upsertCustomEntry } from "./catalog-store.js";

describe("seedBuiltinFromJson", () => {
  let db: DatabaseSync;
  let tmpDir: string;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initCatalogSchema(db);
    tmpDir = mkdtempSync(join(tmpdir(), "catalog-seed-"));
  });

  function writeJson(content: unknown): string {
    const path = join(tmpDir, "entries.json");
    writeFileSync(path, JSON.stringify(content));
    return path;
  }

  it("inserts builtin entries from JSON", () => {
    const path = writeJson({
      schemaVersion: "1",
      entries: [
        {
          id: "x",
          schemaVersion: "1",
          name: "X",
          description: "x",
          useCases: ["use x"],
          tags: ["t"],
          command: "npx",
          args: ["-y", "@x/mcp"],
          envKeys: [],
          healthCheckTimeoutMs: 1000,
        },
      ],
    });

    const r = seedBuiltinFromJson(db, path);
    expect(r.inserted).toBe(1);
    expect(r.updated).toBe(0);
    expect(r.deprecated).toBe(0);

    expect(getEntry(db, "x")?.source).toBe("builtin");
  });

  it("updates existing builtin on second run", () => {
    const path = writeJson({
      schemaVersion: "1",
      entries: [
        {
          id: "x", schemaVersion: "1", name: "X-v1", description: "x",
          useCases: ["use x"], tags: [], command: "npx", args: [],
          envKeys: [], healthCheckTimeoutMs: 1000,
        },
      ],
    });
    seedBuiltinFromJson(db, path);

    writeFileSync(path, JSON.stringify({
      schemaVersion: "1",
      entries: [
        {
          id: "x", schemaVersion: "1", name: "X-v2", description: "x",
          useCases: ["use x"], tags: [], command: "npx", args: [],
          envKeys: [], healthCheckTimeoutMs: 1000,
        },
      ],
    }));
    const r = seedBuiltinFromJson(db, path);
    expect(r.inserted).toBe(0);
    expect(r.updated).toBe(1);

    expect(getEntry(db, "x")?.name).toBe("X-v2");
  });

  it("marks builtin deprecated when removed from JSON", () => {
    const fullPath = writeJson({
      schemaVersion: "1",
      entries: [
        { id: "a", schemaVersion: "1", name: "A", description: "a", useCases: ["a"], tags: [], command: "npx", args: [], envKeys: [], healthCheckTimeoutMs: 1000 },
        { id: "b", schemaVersion: "1", name: "B", description: "b", useCases: ["b"], tags: [], command: "npx", args: [], envKeys: [], healthCheckTimeoutMs: 1000 },
      ],
    });
    seedBuiltinFromJson(db, fullPath);

    writeFileSync(fullPath, JSON.stringify({
      schemaVersion: "1",
      entries: [
        { id: "a", schemaVersion: "1", name: "A", description: "a", useCases: ["a"], tags: [], command: "npx", args: [], envKeys: [], healthCheckTimeoutMs: 1000 },
      ],
    }));
    const r = seedBuiltinFromJson(db, fullPath);
    expect(r.deprecated).toBe(1);

    expect(getEntry(db, "b")).toBeNull();  // deprecated, hidden by default
    expect(getEntry(db, "b", { includeDeprecated: true })?.deprecatedAt).toBeGreaterThan(0);
  });

  it("does not affect custom entries", () => {
    upsertCustomEntry(db, {
      id: "my-custom", source: "custom", schemaVersion: "1",
      name: "My", description: "mine", useCases: ["mine"], tags: [],
      command: "npx", args: [], envKeys: [], healthCheckTimeoutMs: 1000,
    });

    const path = writeJson({ schemaVersion: "1", entries: [] });
    seedBuiltinFromJson(db, path);

    expect(getEntry(db, "my-custom")?.source).toBe("custom");
  });

  it("returns failure result on missing file (does not throw)", () => {
    const r = seedBuiltinFromJson(db, "/nonexistent/path.json");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/ENOENT|not found/i);
    }
  });

  it("returns failure result on invalid JSON (does not throw)", () => {
    const path = join(tmpDir, "bad.json");
    writeFileSync(path, "not json at all");
    const r = seedBuiltinFromJson(db, path);
    expect(r.ok).toBe(false);
  });

  it("returns failure result on invalid entry shape", () => {
    const path = writeJson({
      schemaVersion: "1",
      entries: [
        { id: "INVALID UPPERCASE", schemaVersion: "1", name: "x", description: "x", useCases: ["a"], tags: [], command: "npx", args: [], envKeys: [], healthCheckTimeoutMs: 1000 },
      ],
    });
    const r = seedBuiltinFromJson(db, path);
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 3: Write seed.ts**

```typescript
// apps/server/src/kernel-next/mcp-catalog/seed.ts
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CatalogEntrySchema, type CatalogEntry } from "./schema.js";
import { insertBuiltinEntry, markBuiltinDeprecated } from "./catalog-store.js";

const SeedFileSchema = z.object({
  schemaVersion: z.literal("1"),
  entries: z.array(CatalogEntrySchema.omit({ source: true })),
});

export type SeedResult =
  | { ok: true; inserted: number; updated: number; deprecated: number }
  | { ok: false; error: string };

/**
 * Sync builtin entries from a JSON file into the mcp_catalog table.
 *
 * - Entries in JSON: upsert (insert if new id, replace if existing builtin id)
 * - Builtin entries in DB but absent from JSON: mark deprecated_at
 * - Custom entries: untouched
 *
 * Failures (file missing, JSON invalid, entry invalid) return failure result
 * without throwing — caller decides whether to log/ignore.
 */
export function seedBuiltinFromJson(db: DatabaseSync, jsonPath: string): SeedResult {
  let raw: string;
  try {
    raw = readFileSync(jsonPath, "utf8");
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }

  const validated = SeedFileSchema.safeParse(parsed);
  if (!validated.success) {
    return { ok: false, error: `invalid seed file: ${validated.error.issues[0]?.message ?? "schema mismatch"}` };
  }

  const wantedIds = new Set<string>();
  let inserted = 0;
  let updated = 0;

  // Snapshot existing builtin ids before write
  const existingBuiltinIds = new Set<string>(
    (db.prepare("SELECT id FROM mcp_catalog WHERE source='builtin' AND deprecated_at IS NULL").all() as { id: string }[])
      .map((r) => r.id)
  );

  for (const partial of validated.data.entries) {
    const entry: CatalogEntry = { ...partial, source: "builtin" };
    wantedIds.add(entry.id);
    if (existingBuiltinIds.has(entry.id)) {
      updated += 1;
    } else {
      inserted += 1;
    }
    insertBuiltinEntry(db, entry);
  }

  let deprecated = 0;
  const now = Date.now();
  for (const id of existingBuiltinIds) {
    if (!wantedIds.has(id)) {
      markBuiltinDeprecated(db, id, now);
      deprecated += 1;
    }
  }

  return { ok: true, inserted, updated, deprecated };
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/server && pnpm vitest run src/kernel-next/mcp-catalog/seed.test.ts`
Expected: PASS, 7 tests green.

Also run full mcp-catalog test set to confirm nothing regressed:
Run: `cd apps/server && pnpm vitest run src/kernel-next/mcp-catalog/`
Expected: PASS for all four test files.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/mcp-catalog/entries.json apps/server/src/kernel-next/mcp-catalog/seed.ts apps/server/src/kernel-next/mcp-catalog/seed.test.ts
git commit -m "feat(mcp-catalog): entries.json (12 builtin) + seedBuiltinFromJson"
```

---

### Task 5: score-weights + recommender Layer 1

**Goal:** Local deterministic recommender. Sync function, no LLM calls. Score = max(token-overlap, substring-match) per field, weighted sum.

**Files:**
- Create: `apps/server/src/kernel-next/mcp-catalog/score-weights.ts`
- Create: `apps/server/src/kernel-next/mcp-catalog/recommender.ts` (Layer 1 only; Layer 2 in Task 7)
- Test: `apps/server/src/kernel-next/mcp-catalog/recommender.test.ts` (Layer 1 tests only here)

- [ ] **Step 1: Write the constants**

```typescript
// apps/server/src/kernel-next/mcp-catalog/score-weights.ts

export const SCORE_WEIGHTS = {
  useCases: 0.5,
  tags: 0.3,
  description: 0.2,
} as const;

export const MIN_SCORE = 0.1;

export const DEFAULT_MAX_RESULTS = 5;
export const LLM_OVERLAY_CANDIDATE_LIMIT = 10;

const STOP_WORDS_EN = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "for", "with",
  "by", "from", "is", "are", "was", "were", "be", "been", "being",
  "this", "that", "these", "those", "it", "its", "as",
]);

const STOP_WORDS_ZH = new Set([
  "的", "了", "和", "或", "在", "是", "有", "被", "把", "对", "为", "与",
  "及", "等", "也", "都", "就", "之", "其",
]);

export function isStopWord(word: string): boolean {
  return STOP_WORDS_EN.has(word) || STOP_WORDS_ZH.has(word);
}
```

- [ ] **Step 2: Write failing test for recommender Layer 1**

```typescript
// apps/server/src/kernel-next/mcp-catalog/recommender.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initCatalogSchema } from "./sql.js";
import { insertBuiltinEntry } from "./catalog-store.js";
import { recommendForTopicLocal } from "./recommender.js";
import type { CatalogEntry } from "./schema.js";

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "x", source: "builtin", schemaVersion: "1",
    name: "X", description: "test entry",
    useCases: ["use case x"], tags: ["t"],
    command: "npx", args: [], envKeys: [],
    healthCheckTimeoutMs: 1000,
    ...overrides,
  };
}

describe("recommendForTopicLocal", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initCatalogSchema(db);
  });

  it("returns empty for empty catalog", () => {
    expect(recommendForTopicLocal(db, "anything")).toEqual([]);
  });

  it("matches a useCase by token overlap", () => {
    insertBuiltinEntry(db, entry({
      id: "etherscan",
      useCases: ["verify tx hash on ethereum"],
      tags: [],
      description: "x",
    }));

    const r = recommendForTopicLocal(db, "I want to verify a tx hash");
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].id).toBe("etherscan");
    expect(r[0].evidence.matchedUseCases.length).toBeGreaterThan(0);
  });

  it("matches by tag", () => {
    insertBuiltinEntry(db, entry({
      id: "etherscan",
      useCases: ["unrelated thing"],
      tags: ["onchain-verification"],
      description: "x",
    }));

    const r = recommendForTopicLocal(db, "research onchain-verification needs");
    expect(r[0]?.id).toBe("etherscan");
    expect(r[0]?.evidence.matchedTags).toContain("onchain-verification");
  });

  it("Chinese substring matches Chinese useCase even without spaces", () => {
    insertBuiltinEntry(db, entry({
      id: "etherscan",
      useCases: ["verify tx on ethereum / 验证以太坊上的合约"],
      tags: [],
      description: "x",
    }));

    const r = recommendForTopicLocal(db, "我要验证以太坊上的桥");
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].id).toBe("etherscan");
  });

  it("score is between 0 and 1", () => {
    insertBuiltinEntry(db, entry({
      id: "x",
      useCases: ["test test test test test"],
      tags: ["test"],
      description: "test",
    }));

    const r = recommendForTopicLocal(db, "test");
    expect(r[0].score).toBeGreaterThan(0);
    expect(r[0].score).toBeLessThanOrEqual(1);
  });

  it("filters out entries below MIN_SCORE", () => {
    insertBuiltinEntry(db, entry({
      id: "unrelated",
      useCases: ["xyz unrelated thing"],
      tags: ["unrelated"],
      description: "totally unrelated",
    }));

    expect(recommendForTopicLocal(db, "abc def ghi")).toEqual([]);
  });

  it("respects maxResults", () => {
    for (let i = 0; i < 8; i++) {
      insertBuiltinEntry(db, entry({
        id: `e${i}`,
        useCases: ["common keyword here"],
        tags: ["common"],
      }));
    }

    expect(recommendForTopicLocal(db, "common keyword").length).toBe(5);
    expect(recommendForTopicLocal(db, "common keyword", { maxResults: 3 }).length).toBe(3);
  });

  it("respects excludeIds", () => {
    insertBuiltinEntry(db, entry({ id: "a", useCases: ["common topic"] }));
    insertBuiltinEntry(db, entry({ id: "b", useCases: ["common topic"] }));

    const r = recommendForTopicLocal(db, "common topic", { excludeIds: ["a"] });
    expect(r.map((x) => x.id)).toEqual(["b"]);
  });

  it("ignores deprecated entries", () => {
    insertBuiltinEntry(db, entry({ id: "a", useCases: ["common"] }));
    db.prepare("UPDATE mcp_catalog SET deprecated_at=? WHERE id=?").run(Date.now(), "a");

    expect(recommendForTopicLocal(db, "common")).toEqual([]);
  });

  it("higher useCase match outranks higher tag match", () => {
    insertBuiltinEntry(db, entry({
      id: "useCaseHit",
      useCases: ["alpha beta gamma delta epsilon"],
      tags: [],
    }));
    insertBuiltinEntry(db, entry({
      id: "tagHit",
      useCases: ["unrelated"],
      tags: ["alpha", "beta", "gamma", "delta", "epsilon"],
    }));

    const r = recommendForTopicLocal(db, "alpha beta gamma");
    expect(r[0].id).toBe("useCaseHit");
  });
});
```

- [ ] **Step 3: Write recommender.ts (Layer 1 only — Layer 2 added in Task 7)**

```typescript
// apps/server/src/kernel-next/mcp-catalog/recommender.ts
import type { DatabaseSync } from "node:sqlite";
import { listEntries } from "./catalog-store.js";
import {
  SCORE_WEIGHTS,
  MIN_SCORE,
  DEFAULT_MAX_RESULTS,
  isStopWord,
} from "./score-weights.js";
import type { RecommendResult } from "./schema.js";

type RecommendOpts = {
  maxResults?: number;
  excludeIds?: string[];
};

export function recommendForTopicLocal(
  db: DatabaseSync,
  topic: string,
  opts: RecommendOpts = {},
): RecommendResult[] {
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;
  const excludeIds = new Set(opts.excludeIds ?? []);

  const tokens = tokenize(topic);
  const normalizedTopic = topic.toLowerCase();

  const entries = listEntries(db).filter((e) => !excludeIds.has(e.id));

  const scored = entries.map((entry) => {
    // useCases score
    let useCaseScore = 0;
    const matchedUseCases: string[] = [];
    for (const useCase of entry.useCases) {
      const tokenScore = tokenOverlapRatio(tokens, tokenize(useCase));
      const subScore = substringMatchRatio(normalizedTopic, useCase.toLowerCase());
      const score = Math.max(tokenScore, subScore);
      if (score > useCaseScore) useCaseScore = score;
      if (score >= MIN_SCORE) matchedUseCases.push(useCase);
    }

    // tags score
    let tagScore = 0;
    const matchedTags: string[] = [];
    for (const tag of entry.tags) {
      const tokenScore = tokenOverlapRatio(tokens, tokenize(tag));
      const subScore = substringMatchRatio(normalizedTopic, tag.toLowerCase());
      const score = Math.max(tokenScore, subScore);
      if (score > tagScore) tagScore = score;
      if (score >= MIN_SCORE) matchedTags.push(tag);
    }

    // description score
    const descTokens = tokenize(entry.description);
    const descTokenScore = tokenOverlapRatio(tokens, descTokens);
    const descSubScore = substringMatchRatio(normalizedTopic, entry.description.toLowerCase());
    const descScore = Math.max(descTokenScore, descSubScore);
    const matchedDescriptionTerms: string[] = descScore >= MIN_SCORE
      ? Array.from(new Set(tokens.filter((t) => entry.description.toLowerCase().includes(t))))
      : [];

    const total =
      useCaseScore * SCORE_WEIGHTS.useCases +
      tagScore * SCORE_WEIGHTS.tags +
      descScore * SCORE_WEIGHTS.description;

    return {
      id: entry.id,
      score: Math.min(1, total),
      evidence: {
        matchedUseCases,
        matchedTags,
        matchedDescriptionTerms,
      },
    } satisfies RecommendResult;
  });

  return scored
    .filter((r) => r.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[\s　,，。.!！?？;；:：、/\\()\[\]{}<>"'`]+/)
    .filter((t) => t.length > 0 && !isStopWord(t));
}

function tokenOverlapRatio(topicTokens: string[], targetTokens: string[]): number {
  if (topicTokens.length === 0 || targetTokens.length === 0) return 0;
  const topicSet = new Set(topicTokens);
  const targetSet = new Set(targetTokens);
  let hits = 0;
  for (const t of topicSet) {
    if (targetSet.has(t)) hits += 1;
  }
  // Ratio relative to the smaller set, so a short topic finding all its tokens
  // in a long useCase still scores 1.0
  const smaller = Math.min(topicSet.size, targetSet.size);
  return hits / smaller;
}

function substringMatchRatio(topic: string, target: string): number {
  if (topic.length === 0 || target.length === 0) return 0;
  // Split topic and target into 2..6-gram windows, count how many of topic's
  // n-grams appear in target. This handles Chinese (no whitespace) and partial
  // English phrase overlap.
  const ngrams = (s: string, n: number): Set<string> => {
    const out = new Set<string>();
    if (s.length < n) return out;
    for (let i = 0; i <= s.length - n; i++) {
      out.add(s.slice(i, i + n));
    }
    return out;
  };

  let bestRatio = 0;
  for (const n of [2, 3, 4]) {
    const topicGrams = ngrams(topic, n);
    if (topicGrams.size === 0) continue;
    const targetGrams = ngrams(target, n);
    let hits = 0;
    for (const g of topicGrams) {
      if (targetGrams.has(g)) hits += 1;
    }
    const ratio = hits / topicGrams.size;
    if (ratio > bestRatio) bestRatio = ratio;
  }
  return bestRatio;
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/server && pnpm vitest run src/kernel-next/mcp-catalog/recommender.test.ts`
Expected: PASS, 10 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/mcp-catalog/score-weights.ts apps/server/src/kernel-next/mcp-catalog/recommender.ts apps/server/src/kernel-next/mcp-catalog/recommender.test.ts
git commit -m "feat(mcp-catalog): score-weights + recommender Layer 1 (local deterministic)"
```

---

### Task 6: llm-client (simpleJsonCompletion)

**Goal:** A thin wrapper over the Anthropic SDK that does one synchronous-style "send these prompts, parse JSON output against a zod schema" round trip. Independent of the runtime/sdk-adapter.ts (which is stage-executor scoped).

**Files:**
- Create: `apps/server/src/kernel-next/mcp-catalog/llm-client.ts`
- Test: `apps/server/src/kernel-next/mcp-catalog/llm-client.test.ts`

- [ ] **Step 1: Write failing test (uses dependency injection of an Anthropic-like client)**

```typescript
// apps/server/src/kernel-next/mcp-catalog/llm-client.test.ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { simpleJsonCompletion, type AnthropicLikeClient } from "./llm-client.js";

function fakeClient(responseText: string): AnthropicLikeClient {
  return {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: responseText }],
      }),
    },
  };
}

const schema = z.object({ items: z.array(z.string()) });

describe("simpleJsonCompletion", () => {
  it("parses a clean JSON response", async () => {
    const client = fakeClient(`{"items": ["a", "b"]}`);
    const out = await simpleJsonCompletion({
      client,
      systemPrompt: "system",
      userPrompt: "user",
      schema,
    });
    expect(out).toEqual({ items: ["a", "b"] });
  });

  it("strips markdown code fences", async () => {
    const client = fakeClient("```json\n{\"items\": [\"a\"]}\n```");
    const out = await simpleJsonCompletion({
      client,
      systemPrompt: "system",
      userPrompt: "user",
      schema,
    });
    expect(out).toEqual({ items: ["a"] });
  });

  it("throws on invalid JSON", async () => {
    const client = fakeClient("not json");
    await expect(simpleJsonCompletion({
      client,
      systemPrompt: "s",
      userPrompt: "u",
      schema,
    })).rejects.toThrow(/JSON|parse/i);
  });

  it("throws on schema mismatch", async () => {
    const client = fakeClient(`{"wrong": "shape"}`);
    await expect(simpleJsonCompletion({
      client,
      systemPrompt: "s",
      userPrompt: "u",
      schema,
    })).rejects.toThrow();
  });

  it("throws when model returns no text content", async () => {
    const client: AnthropicLikeClient = {
      messages: {
        create: async () => ({ content: [] }),
      },
    };
    await expect(simpleJsonCompletion({
      client,
      systemPrompt: "s",
      userPrompt: "u",
      schema,
    })).rejects.toThrow(/no text/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && pnpm vitest run src/kernel-next/mcp-catalog/llm-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write llm-client.ts**

```typescript
// apps/server/src/kernel-next/mcp-catalog/llm-client.ts
import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";

/**
 * Minimal interface that allows us to inject a fake client in tests.
 * The real Anthropic SDK client satisfies this shape.
 */
export interface AnthropicLikeClient {
  messages: {
    create: (params: {
      model?: string;
      max_tokens?: number;
      system?: string;
      messages?: Array<{ role: "user" | "assistant"; content: string }>;
    }) => Promise<{
      content: Array<{ type: string; text?: string }>;
    }>;
  };
}

export type SimpleJsonCompletionArgs<T> = {
  client?: AnthropicLikeClient;
  systemPrompt: string;
  userPrompt: string;
  schema: z.ZodSchema<T>;
  model?: string;
  maxTokens?: number;
};

let defaultClient: AnthropicLikeClient | null = null;

function getDefaultClient(): AnthropicLikeClient {
  if (defaultClient) return defaultClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set; cannot run LLM-overlay");
  }
  defaultClient = new Anthropic({ apiKey }) as unknown as AnthropicLikeClient;
  return defaultClient;
}

export async function simpleJsonCompletion<T>(
  args: SimpleJsonCompletionArgs<T>,
): Promise<T> {
  const client = args.client ?? getDefaultClient();
  const model = args.model ?? "claude-haiku-4-5";
  const maxTokens = args.maxTokens ?? 500;

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: args.systemPrompt,
    messages: [{ role: "user", content: args.userPrompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || typeof textBlock.text !== "string") {
    throw new Error("LLM response had no text content");
  }
  const text = textBlock.text;

  const json = stripMarkdownAndParseJson(text);

  const validated = args.schema.safeParse(json);
  if (!validated.success) {
    throw new Error(
      `LLM output did not match schema: ${validated.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return validated.data;
}

function stripMarkdownAndParseJson(text: string): unknown {
  // Models often wrap JSON in ```json ... ``` fences. Strip them.
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  return JSON.parse(body.trim());
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/server && pnpm vitest run src/kernel-next/mcp-catalog/llm-client.test.ts`
Expected: PASS, 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/mcp-catalog/llm-client.ts apps/server/src/kernel-next/mcp-catalog/llm-client.test.ts
git commit -m "feat(mcp-catalog): simpleJsonCompletion LLM client (independent of runtime/sdk-adapter)"
```

---

### Task 7: recommender Layer 2 (LLM-overlay) + citedEvidence validation

**Goal:** Add `recommendForTopicWithLLM` to recommender.ts. Calls Layer 1 first, then sends candidates + topic to a small LLM, validates that the LLM cites only evidence subsets, falls back to Layer 1 results plus a warning diagnostic on any LLM failure.

**Files:**
- Modify: `apps/server/src/kernel-next/mcp-catalog/recommender.ts`
- Modify: `apps/server/src/kernel-next/mcp-catalog/recommender.test.ts`

- [ ] **Step 1: Write failing test for LLM-overlay**

Append to `recommender.test.ts`:

```typescript
import {
  recommendForTopicWithLLM,
  type LlmOverlayClient,
} from "./recommender.js";

describe("recommendForTopicWithLLM", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initCatalogSchema(db);
  });

  function fakeOverlay(jsonText: string): LlmOverlayClient {
    return {
      simpleJsonCompletion: async () => {
        const parsed = JSON.parse(jsonText);
        return parsed;
      },
    };
  }

  it("attaches llmReason to results when LLM succeeds", async () => {
    insertBuiltinEntry(db, entry({
      id: "etherscan",
      useCases: ["verify tx hash on ethereum"],
      tags: ["onchain-verification"],
    }));

    const overlay = fakeOverlay(JSON.stringify({
      recommendations: [
        {
          id: "etherscan",
          llmReason: "Etherscan reads contract source on Ethereum",
          citedEvidence: {
            tags: ["onchain-verification"],
            useCases: ["verify tx hash on ethereum"],
          },
        },
      ],
    }));

    const r = await recommendForTopicWithLLM(db, "verify tx hash", { llmClient: overlay });
    expect(r.warnings).toBeUndefined();
    expect(r.recommendations[0].id).toBe("etherscan");
    expect(r.recommendations[0].llmReason).toMatch(/Etherscan/);
  });

  it("drops LLM result whose id is not in candidates", async () => {
    insertBuiltinEntry(db, entry({
      id: "etherscan",
      useCases: ["verify tx hash on ethereum"],
      tags: [],
    }));

    const overlay = fakeOverlay(JSON.stringify({
      recommendations: [
        {
          id: "fabricated-id",
          llmReason: "I made this up",
          citedEvidence: {},
        },
      ],
    }));

    const r = await recommendForTopicWithLLM(db, "verify tx hash", { llmClient: overlay });
    expect(r.recommendations.find((x) => x.id === "fabricated-id")).toBeUndefined();
  });

  it("drops LLM result whose citedEvidence is not a subset of candidate evidence", async () => {
    insertBuiltinEntry(db, entry({
      id: "etherscan",
      useCases: ["verify tx hash"],
      tags: ["onchain-verification"],
    }));

    const overlay = fakeOverlay(JSON.stringify({
      recommendations: [
        {
          id: "etherscan",
          llmReason: "...",
          citedEvidence: { tags: ["does-not-exist"] },
        },
      ],
    }));

    const r = await recommendForTopicWithLLM(db, "verify tx hash", { llmClient: overlay });
    // Falls back to local result (no llmReason) for that id, OR drops it; check behavior:
    // Spec says "drop any result whose citedEvidence isn't ⊆ evidence" — so result is dropped from LLM list
    // but the original Layer 1 candidate without llmReason should still be returned.
    expect(r.recommendations.find((x) => x.id === "etherscan")?.llmReason).toBeUndefined();
  });

  it("returns Layer 1 results + warning when LLM throws", async () => {
    insertBuiltinEntry(db, entry({
      id: "etherscan",
      useCases: ["verify tx hash"],
      tags: [],
    }));

    const failingOverlay: LlmOverlayClient = {
      simpleJsonCompletion: async () => { throw new Error("network failed"); },
    };

    const r = await recommendForTopicWithLLM(db, "verify tx hash", { llmClient: failingOverlay });
    expect(r.recommendations[0].id).toBe("etherscan");
    expect(r.recommendations[0].llmReason).toBeUndefined();
    expect(r.warnings).toBeDefined();
    expect(r.warnings![0].code).toBe("CATALOG_LLM_OVERLAY_UNAVAILABLE");
  });
});
```

- [ ] **Step 2: Add `CATALOG_LLM_OVERLAY_UNAVAILABLE` to schema.ts diagnostic codes**

Modify `apps/server/src/kernel-next/mcp-catalog/schema.ts` — add to `CATALOG_DIAGNOSTIC_CODES`:

```typescript
export const CATALOG_DIAGNOSTIC_CODES = [
  "CATALOG_ENTRY_NOT_FOUND",
  "CATALOG_ENTRY_ID_CONFLICT",
  "CATALOG_INVALID_ENTRY",
  "CATALOG_BUILTIN_NOT_WRITABLE",
  "CATALOG_LLM_OVERLAY_UNAVAILABLE",  // <-- new
] as const;
```

Also append to `schema.test.ts` `CATALOG_DIAGNOSTIC_CODES` describe:

```typescript
it("includes the LLM-overlay unavailable code", () => {
  expect(CATALOG_DIAGNOSTIC_CODES).toContain("CATALOG_LLM_OVERLAY_UNAVAILABLE");
});
```

- [ ] **Step 3: Extend recommender.ts with Layer 2**

Add to the existing `apps/server/src/kernel-next/mcp-catalog/recommender.ts`:

```typescript
import { z } from "zod";
import type { Diagnostic } from "../ir/schema.js";
import { LLM_OVERLAY_CANDIDATE_LIMIT } from "./score-weights.js";
import { simpleJsonCompletion } from "./llm-client.js";
import { CatalogEntrySchema } from "./schema.js";  // <-- ensure this is imported (it already is via type RecommendResult)

const LlmOverlayResponseSchema = z.object({
  recommendations: z.array(z.object({
    id: z.string(),
    llmReason: z.string(),
    citedEvidence: z.object({
      tags: z.array(z.string()).optional(),
      useCases: z.array(z.string()).optional(),
    }),
  })),
});

export type LlmOverlayClient = {
  simpleJsonCompletion: <T>(args: {
    systemPrompt: string;
    userPrompt: string;
    schema: z.ZodSchema<T>;
  }) => Promise<T>;
};

const DEFAULT_OVERLAY_CLIENT: LlmOverlayClient = {
  simpleJsonCompletion: (args) => simpleJsonCompletion(args),
};

export type RecommendWithLLMResult = {
  recommendations: RecommendResult[];
  warnings?: Diagnostic[];
};

export async function recommendForTopicWithLLM(
  db: DatabaseSync,
  topic: string,
  opts: RecommendOpts & { llmClient?: LlmOverlayClient } = {},
): Promise<RecommendWithLLMResult> {
  const llmClient = opts.llmClient ?? DEFAULT_OVERLAY_CLIENT;

  // Layer 1: get more candidates than usual so LLM has room to filter
  const candidates = recommendForTopicLocal(db, topic, {
    maxResults: LLM_OVERLAY_CANDIDATE_LIMIT,
    excludeIds: opts.excludeIds,
  });

  if (candidates.length === 0) {
    return { recommendations: [] };
  }

  let llmOutput: z.infer<typeof LlmOverlayResponseSchema> | null = null;
  let llmFailureWarning: Diagnostic | null = null;

  try {
    llmOutput = await llmClient.simpleJsonCompletion({
      systemPrompt: buildOverlaySystemPrompt(),
      userPrompt: buildOverlayUserPrompt(topic, candidates),
      schema: LlmOverlayResponseSchema,
    });
  } catch (e) {
    llmFailureWarning = {
      code: "CATALOG_LLM_OVERLAY_UNAVAILABLE",
      message: `LLM-overlay unavailable, returned local-only ranking: ${e instanceof Error ? e.message : String(e)}`,
      context: {},
    };
  }

  // Build the final list. Each candidate may or may not get an llmReason.
  const candidateById = new Map(candidates.map((c) => [c.id, c]));
  const finalById = new Map<string, RecommendResult>(candidates.map((c) => [c.id, { ...c }]));

  if (llmOutput) {
    for (const llmRec of llmOutput.recommendations) {
      const candidate = candidateById.get(llmRec.id);
      if (!candidate) continue;  // hallucinated id

      const cited = llmRec.citedEvidence;
      const tagsValid = !cited.tags || cited.tags.every((t) => candidate.evidence.matchedTags.includes(t));
      const useCasesValid = !cited.useCases || cited.useCases.every((u) => candidate.evidence.matchedUseCases.includes(u));
      if (!tagsValid || !useCasesValid) continue;

      // Must cite at least one piece of evidence
      const totalCited = (cited.tags?.length ?? 0) + (cited.useCases?.length ?? 0);
      if (totalCited === 0) continue;

      const final = finalById.get(llmRec.id);
      if (final) final.llmReason = llmRec.llmReason;
    }
  }

  const recommendations = Array.from(finalById.values()).slice(0, opts.maxResults ?? DEFAULT_MAX_RESULTS);

  return llmFailureWarning
    ? { recommendations, warnings: [llmFailureWarning] }
    : { recommendations };
}

function buildOverlaySystemPrompt(): string {
  return `You are a tool recommender. You will receive a topic and a list of candidate MCP server entries with their match evidence. Your job is to:
1. Decide which candidates are genuinely useful for the topic.
2. Provide a one-sentence natural-language reason for each pick.
3. CITE the specific evidence pieces (tags or useCases) that justify the pick. You MAY ONLY cite evidence that appears in the candidate's evidence list — never invent.
4. You MUST cite at least one evidence piece per recommendation.

Output strict JSON matching:
{
  "recommendations": [
    {
      "id": "<candidate id>",
      "llmReason": "<one sentence>",
      "citedEvidence": {
        "tags": [...subset of candidate.evidence.matchedTags],
        "useCases": [...subset of candidate.evidence.matchedUseCases]
      }
    }
  ]
}

Skip candidates that don't fit. Order by usefulness.`;
}

function buildOverlayUserPrompt(topic: string, candidates: RecommendResult[]): string {
  const candidatesText = candidates.map((c) => `- id: ${c.id}
  score: ${c.score.toFixed(2)}
  matchedTags: ${JSON.stringify(c.evidence.matchedTags)}
  matchedUseCases: ${JSON.stringify(c.evidence.matchedUseCases)}
  matchedDescriptionTerms: ${JSON.stringify(c.evidence.matchedDescriptionTerms)}`).join("\n");

  return `Topic: ${topic}

Candidates:
${candidatesText}`;
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/server && pnpm vitest run src/kernel-next/mcp-catalog/`
Expected: PASS, all mcp-catalog test files green (schema, sql, catalog-store, seed, recommender × 14, llm-client).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/mcp-catalog/
git commit -m "feat(mcp-catalog): recommender Layer 2 (LLM-overlay with citedEvidence validation)"
```

---

### Task 8: REST routes (entries CRUD + recommend)

**Goal:** Expose catalog over REST. 6 endpoints. Each follows the kernel-next diagnostic envelope and uses safeParse.

**Files:**
- Create: `apps/server/src/routes/kernel-mcp-catalog.ts`
- Create: `apps/server/src/routes/kernel-mcp-catalog.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// apps/server/src/routes/kernel-mcp-catalog.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { DatabaseSync } from "node:sqlite";
import { initCatalogSchema } from "../kernel-next/mcp-catalog/sql.js";
import { insertBuiltinEntry } from "../kernel-next/mcp-catalog/catalog-store.js";
import type { CatalogEntry } from "../kernel-next/mcp-catalog/schema.js";
import { createKernelMcpCatalogRoute } from "./kernel-mcp-catalog.js";

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "etherscan", source: "builtin", schemaVersion: "1",
    name: "Etherscan", description: "x",
    useCases: ["verify tx hash"], tags: ["onchain-verification"],
    command: "npx", args: ["-y", "@scope/etherscan"],
    envKeys: [], healthCheckTimeoutMs: 1000,
    ...overrides,
  };
}

function buildApp(db: DatabaseSync): Hono {
  const app = new Hono();
  app.route("/api", createKernelMcpCatalogRoute(() => db));
  return app;
}

describe("kernel-mcp-catalog routes", () => {
  let db: DatabaseSync;
  let app: Hono;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initCatalogSchema(db);
    app = buildApp(db);
  });

  describe("GET /api/kernel/mcp-catalog/entries", () => {
    it("returns empty list initially", async () => {
      const res = await app.fetch(new Request("http://t/api/kernel/mcp-catalog/entries"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true, entries: [] });
    });

    it("returns inserted entries", async () => {
      insertBuiltinEntry(db, entry({ id: "a" }));
      const res = await app.fetch(new Request("http://t/api/kernel/mcp-catalog/entries"));
      const body = await res.json() as { ok: true; entries: CatalogEntry[] };
      expect(body.entries.map((e) => e.id)).toEqual(["a"]);
    });

    it("filters by source query param", async () => {
      insertBuiltinEntry(db, entry({ id: "a" }));
      const res = await app.fetch(new Request("http://t/api/kernel/mcp-catalog/entries?source=custom"));
      const body = await res.json() as { ok: true; entries: CatalogEntry[] };
      expect(body.entries).toEqual([]);
    });
  });

  describe("GET /api/kernel/mcp-catalog/entries/:id", () => {
    it("returns 404 for missing id", async () => {
      const res = await app.fetch(new Request("http://t/api/kernel/mcp-catalog/entries/nope"));
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.diagnostics[0].code).toBe("CATALOG_ENTRY_NOT_FOUND");
    });

    it("returns the entry", async () => {
      insertBuiltinEntry(db, entry({ id: "a" }));
      const res = await app.fetch(new Request("http://t/api/kernel/mcp-catalog/entries/a"));
      const body = await res.json();
      expect(body.entry.id).toBe("a");
    });
  });

  describe("POST /api/kernel/mcp-catalog/entries (create custom)", () => {
    it("creates a custom entry", async () => {
      const e = entry({ id: "my-custom" });
      const res = await app.fetch(new Request("http://t/api/kernel/mcp-catalog/entries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(e),
      }));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.entry.source).toBe("custom");
    });

    it("rejects when id collides with builtin (409)", async () => {
      insertBuiltinEntry(db, entry({ id: "a" }));
      const e = entry({ id: "a" });
      const res = await app.fetch(new Request("http://t/api/kernel/mcp-catalog/entries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(e),
      }));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.diagnostics[0].code).toBe("CATALOG_ENTRY_ID_CONFLICT");
    });

    it("rejects invalid entry (400)", async () => {
      const res = await app.fetch(new Request("http://t/api/kernel/mcp-catalog/entries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "INVALID" }),
      }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.diagnostics[0].code).toBe("CATALOG_INVALID_ENTRY");
    });
  });

  describe("PUT /api/kernel/mcp-catalog/entries/:id", () => {
    it("rejects PUT on builtin (409)", async () => {
      insertBuiltinEntry(db, entry({ id: "a" }));
      const e = entry({ id: "a", name: "modified" });
      const res = await app.fetch(new Request("http://t/api/kernel/mcp-catalog/entries/a", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(e),
      }));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.diagnostics[0].code).toBe("CATALOG_BUILTIN_NOT_WRITABLE");
    });
  });

  describe("DELETE /api/kernel/mcp-catalog/entries/:id", () => {
    it("rejects DELETE on builtin (409)", async () => {
      insertBuiltinEntry(db, entry({ id: "a" }));
      const res = await app.fetch(new Request("http://t/api/kernel/mcp-catalog/entries/a", { method: "DELETE" }));
      expect(res.status).toBe(409);
    });

    it("returns 404 on missing", async () => {
      const res = await app.fetch(new Request("http://t/api/kernel/mcp-catalog/entries/nope", { method: "DELETE" }));
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/kernel/mcp-catalog/recommend", () => {
    it("returns recommendations for a topic", async () => {
      insertBuiltinEntry(db, entry({
        id: "etherscan", useCases: ["verify tx hash on ethereum"], tags: [],
      }));
      const res = await app.fetch(new Request("http://t/api/kernel/mcp-catalog/recommend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: "verify tx hash" }),
      }));
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.recommendations[0].id).toBe("etherscan");
    });

    it("rejects empty topic (400)", async () => {
      const res = await app.fetch(new Request("http://t/api/kernel/mcp-catalog/recommend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: "" }),
      }));
      expect(res.status).toBe(400);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && pnpm vitest run src/routes/kernel-mcp-catalog.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the route**

```typescript
// apps/server/src/routes/kernel-mcp-catalog.ts
import { Hono, type Context } from "hono";
import type { DatabaseSync } from "node:sqlite";
import {
  listEntries,
  getEntry,
  upsertCustomEntry,
  deleteCustomEntry,
} from "../kernel-next/mcp-catalog/catalog-store.js";
import { CatalogEntrySchema } from "../kernel-next/mcp-catalog/schema.js";
import { recommendForTopicLocal, recommendForTopicWithLLM } from "../kernel-next/mcp-catalog/recommender.js";
import { z } from "zod";

const recommendBodySchema = z.object({
  topic: z.string().min(1).max(4096),
  excludeIds: z.array(z.string()).optional(),
  withLLM: z.boolean().optional(),
  maxResults: z.number().int().positive().max(50).optional(),
}).strict();

function badRequest(c: Context, code: string, message: string, context?: Record<string, unknown>) {
  return c.json({ ok: false, diagnostics: [{ code, message, ...(context ? { context } : {}) }] }, 400);
}

/**
 * Factory so tests can inject a custom DB getter.
 * In production, getKernelNextDb is used.
 */
export function createKernelMcpCatalogRoute(getDb: () => DatabaseSync): Hono {
  const route = new Hono();

  route.get("/kernel/mcp-catalog/entries", (c) => {
    const sourceParam = c.req.query("source");
    const includeDeprecated = c.req.query("includeDeprecated") === "true";

    if (sourceParam !== undefined && !["builtin", "custom", "all"].includes(sourceParam)) {
      return badRequest(c, "INVALID_REQUEST_BODY",
        "source must be 'builtin', 'custom', or 'all'", { received: sourceParam });
    }

    const entries = listEntries(getDb(), {
      source: sourceParam as "builtin" | "custom" | "all" | undefined,
      includeDeprecated,
    });
    return c.json({ ok: true, entries });
  });

  route.get("/kernel/mcp-catalog/entries/:id", (c) => {
    const id = c.req.param("id");
    const entry = getEntry(getDb(), id);
    if (!entry) {
      return c.json({
        ok: false,
        diagnostics: [{
          code: "CATALOG_ENTRY_NOT_FOUND",
          message: `entry '${id}' not found`,
          context: { id },
        }],
      }, 404);
    }
    return c.json({ ok: true, entry });
  });

  route.post("/kernel/mcp-catalog/entries", async (c) => {
    const raw = await c.req.text();
    if (raw.trim().length === 0) {
      return badRequest(c, "INVALID_REQUEST_BODY", "request body required");
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return badRequest(c, "INVALID_JSON_BODY", "invalid JSON");
    }
    // Force source='custom' before validation (clients may omit or set 'builtin' incorrectly)
    const candidate = { ...(body as object), source: "custom" };
    const parsed = CatalogEntrySchema.safeParse(candidate);
    if (!parsed.success) {
      return c.json({
        ok: false,
        diagnostics: [{
          code: "CATALOG_INVALID_ENTRY",
          message: parsed.error.issues[0]?.message ?? "invalid entry",
          context: { path: parsed.error.issues[0]?.path },
        }],
      }, 400);
    }

    const result = upsertCustomEntry(getDb(), parsed.data);
    if (!result.ok) {
      const code = result.diagnostics[0].code;
      const status = code === "CATALOG_ENTRY_ID_CONFLICT" ? 409 : 400;
      return c.json(result, status);
    }
    return c.json({ ok: true, entry: result.entry }, 201);
  });

  route.put("/kernel/mcp-catalog/entries/:id", async (c) => {
    const id = c.req.param("id");
    const existing = getEntry(getDb(), id);
    if (existing && existing.source === "builtin") {
      return c.json({
        ok: false,
        diagnostics: [{
          code: "CATALOG_BUILTIN_NOT_WRITABLE",
          message: "builtin entries can only be modified via the seed JSON",
          context: { id },
        }],
      }, 409);
    }
    if (!existing) {
      return c.json({
        ok: false,
        diagnostics: [{
          code: "CATALOG_ENTRY_NOT_FOUND",
          message: `entry '${id}' not found`,
          context: { id },
        }],
      }, 404);
    }

    const raw = await c.req.text();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return badRequest(c, "INVALID_JSON_BODY", "invalid JSON");
    }
    const candidate = { ...(body as object), id, source: "custom" };
    const parsed = CatalogEntrySchema.safeParse(candidate);
    if (!parsed.success) {
      return c.json({
        ok: false,
        diagnostics: [{
          code: "CATALOG_INVALID_ENTRY",
          message: parsed.error.issues[0]?.message ?? "invalid entry",
          context: { path: parsed.error.issues[0]?.path },
        }],
      }, 400);
    }

    const result = upsertCustomEntry(getDb(), parsed.data);
    if (!result.ok) return c.json(result, 400);
    return c.json({ ok: true, entry: result.entry });
  });

  route.delete("/kernel/mcp-catalog/entries/:id", (c) => {
    const id = c.req.param("id");
    const result = deleteCustomEntry(getDb(), id);
    if (!result.ok) {
      const code = result.diagnostics[0].code;
      const status =
        code === "CATALOG_ENTRY_NOT_FOUND" ? 404 :
        code === "CATALOG_BUILTIN_NOT_WRITABLE" ? 409 : 400;
      return c.json(result, status);
    }
    return c.json({ ok: true });
  });

  route.post("/kernel/mcp-catalog/recommend", async (c) => {
    const raw = await c.req.text();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return badRequest(c, "INVALID_JSON_BODY", "invalid JSON");
    }
    const parsed = recommendBodySchema.safeParse(body);
    if (!parsed.success) {
      return badRequest(c, "INVALID_REQUEST_BODY",
        parsed.error.issues[0]?.message ?? "bad request",
        { path: parsed.error.issues[0]?.path });
    }

    if (parsed.data.withLLM) {
      const result = await recommendForTopicWithLLM(getDb(), parsed.data.topic, {
        excludeIds: parsed.data.excludeIds,
        maxResults: parsed.data.maxResults,
      });
      return c.json({
        ok: true,
        recommendations: result.recommendations,
        ...(result.warnings ? { warnings: result.warnings } : {}),
      });
    }

    const recs = recommendForTopicLocal(getDb(), parsed.data.topic, {
      excludeIds: parsed.data.excludeIds,
      maxResults: parsed.data.maxResults,
    });
    return c.json({ ok: true, recommendations: recs });
  });

  return route;
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/server && pnpm vitest run src/routes/kernel-mcp-catalog.test.ts`
Expected: PASS, all 11 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/kernel-mcp-catalog.ts apps/server/src/routes/kernel-mcp-catalog.test.ts
git commit -m "feat(mcp-catalog): REST routes for entries CRUD + recommend"
```

---

### Task 9: MCP tools (recommend_mcp_servers + get_mcp_catalog_entry)

**Goal:** Expose two tools to LLM agents (e.g. pipeline-generator's analyzing stage).

**Files:**
- Create: `apps/server/src/kernel-next/mcp/tools/mcp-catalog.ts`
- Create: `apps/server/src/kernel-next/mcp/tools/mcp-catalog.test.ts`

- [ ] **Step 1: Inspect the existing tool factory pattern (read-only)**

Read `apps/server/src/kernel-next/mcp/tools/task.ts` to understand the `ToolDef`, `ToolsDeps` shape and the `buildXxxTools(deps)` pattern. Confirm:
- ToolsDeps has a `db: DatabaseSync` field
- ToolDef shape is `{ name, description, inputSchema (z.object), handler }`

Run: `cd apps/server && grep -n 'export function build\|ToolsDeps\|ToolDef' src/kernel-next/mcp/tools/task.ts`

Expected output: shows the export, the deps usage, and the ToolDef shape.

- [ ] **Step 2: Write failing test**

```typescript
// apps/server/src/kernel-next/mcp/tools/mcp-catalog.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initCatalogSchema } from "../../mcp-catalog/sql.js";
import { insertBuiltinEntry } from "../../mcp-catalog/catalog-store.js";
import type { CatalogEntry } from "../../mcp-catalog/schema.js";
import { buildMcpCatalogTools } from "./mcp-catalog.js";

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "etherscan", source: "builtin", schemaVersion: "1",
    name: "Etherscan", description: "x",
    useCases: ["verify tx hash"], tags: ["onchain-verification"],
    command: "npx", args: [],
    envKeys: [], healthCheckTimeoutMs: 1000,
    ...overrides,
  };
}

describe("buildMcpCatalogTools", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initCatalogSchema(db);
  });

  it("returns two tools: recommend_mcp_servers and get_mcp_catalog_entry", () => {
    const tools = buildMcpCatalogTools({ db } as any);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_mcp_catalog_entry", "recommend_mcp_servers"]);
  });

  it("recommend_mcp_servers returns recommendations using local recommender", async () => {
    insertBuiltinEntry(db, entry({ id: "etherscan", useCases: ["verify tx hash"] }));
    const tools = buildMcpCatalogTools({ db } as any);
    const tool = tools.find((t) => t.name === "recommend_mcp_servers")!;
    const out = await tool.handler({ topic: "verify tx hash", withLLM: false }) as any;
    expect(out.ok).toBe(true);
    expect(out.recommendations[0].id).toBe("etherscan");
  });

  it("get_mcp_catalog_entry returns the entry by id", async () => {
    insertBuiltinEntry(db, entry({ id: "etherscan" }));
    const tools = buildMcpCatalogTools({ db } as any);
    const tool = tools.find((t) => t.name === "get_mcp_catalog_entry")!;
    const out = await tool.handler({ id: "etherscan" }) as any;
    expect(out.ok).toBe(true);
    expect(out.entry.id).toBe("etherscan");
  });

  it("get_mcp_catalog_entry returns CATALOG_ENTRY_NOT_FOUND for missing id", async () => {
    const tools = buildMcpCatalogTools({ db } as any);
    const tool = tools.find((t) => t.name === "get_mcp_catalog_entry")!;
    const out = await tool.handler({ id: "nope" }) as any;
    expect(out.ok).toBe(false);
    expect(out.diagnostics[0].code).toBe("CATALOG_ENTRY_NOT_FOUND");
  });
});
```

- [ ] **Step 3: Write the tool factory**

```typescript
// apps/server/src/kernel-next/mcp/tools/mcp-catalog.ts
import { z } from "zod";
import type { ToolDef, ToolsDeps } from "../tool-types.js";
// IMPORTANT: if tool-types.js does not exist, look at how task.ts imports its types.
// In current kernel-next, the import is typically:
//   import type { ToolsDeps } from "./types.js"
// or the types are inline in server.ts. Adjust this import to whichever the
// existing tools/<domain>.ts files use. Verified by reading task.ts in step 1.

import { getEntry } from "../../mcp-catalog/catalog-store.js";
import {
  recommendForTopicLocal,
  recommendForTopicWithLLM,
} from "../../mcp-catalog/recommender.js";

export function buildMcpCatalogTools(deps: ToolsDeps): ToolDef[] {
  return [
    {
      name: "recommend_mcp_servers",
      description: "Given a topic in natural language, recommend MCP servers from the catalog. Optionally use LLM-overlay for natural-language reasons.",
      inputSchema: {
        topic: z.string().min(1).max(4096).describe("Free-text topic, in English or Chinese"),
        excludeIds: z.array(z.string()).optional().describe("Catalog entry ids to exclude from results"),
        maxResults: z.number().int().positive().max(50).optional().describe("Max number of recommendations"),
        withLLM: z.boolean().optional().describe("If true, run LLM-overlay rerank with natural-language reasons; default false"),
      },
      handler: async (args: any) => {
        if (args.withLLM) {
          const result = await recommendForTopicWithLLM(deps.db, args.topic, {
            excludeIds: args.excludeIds,
            maxResults: args.maxResults,
          });
          return {
            ok: true,
            recommendations: result.recommendations,
            ...(result.warnings ? { warnings: result.warnings } : {}),
          };
        }
        const recs = recommendForTopicLocal(deps.db, args.topic, {
          excludeIds: args.excludeIds,
          maxResults: args.maxResults,
        });
        return { ok: true, recommendations: recs };
      },
    },
    {
      name: "get_mcp_catalog_entry",
      description: "Get a full catalog entry by id, including command, args, envKeys, and obtainSteps.",
      inputSchema: {
        id: z.string().min(1).describe("Catalog entry id (kebab-case)"),
      },
      handler: async (args: any) => {
        const entry = getEntry(deps.db, args.id);
        if (!entry) {
          return {
            ok: false,
            diagnostics: [{
              code: "CATALOG_ENTRY_NOT_FOUND",
              message: `entry '${args.id}' not found`,
              context: { id: args.id },
            }],
          };
        }
        return { ok: true, entry };
      },
    },
  ];
}
```

- [ ] **Step 4: Run test and adjust import path if needed**

Run: `cd apps/server && pnpm vitest run src/kernel-next/mcp/tools/mcp-catalog.test.ts`

If the test fails with "ToolsDeps not found", inspect how `tools/task.ts` imports its types and copy that import line. Adjust `tools/mcp-catalog.ts` accordingly.

Expected after fixing import: PASS, 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/mcp/tools/mcp-catalog.ts apps/server/src/kernel-next/mcp/tools/mcp-catalog.test.ts
git commit -m "feat(mcp-catalog): MCP tools recommend_mcp_servers + get_mcp_catalog_entry"
```

---

### Task 10: Wire everything into kernel-next-db, mcp/server.ts, and index.ts

**Goal:** All the modules above work in isolation. This task hooks them into the running kernel-next server: schema init on startup, MCP tool registration, REST route mount, seed call.

**Files:**
- Modify: `apps/server/src/kernel-next/ir/sql.ts`
- Modify: `apps/server/src/kernel-next/mcp/server.ts`
- Modify: `apps/server/src/index.ts`

- [ ] **Step 1: Modify ir/sql.ts to call initCatalogSchema**

Find the `initKernelNextSchema` function in `apps/server/src/kernel-next/ir/sql.ts` (around line 431). The function may include drop+rebuild logic for schema-version drift; the catalog init MUST be the **last call** in the function body so it runs after any rebuild and is not undone by a drop.

```typescript
// At the top of sql.ts, add the import:
import { initCatalogSchema } from "../mcp-catalog/sql.js";

// At the very last line of initKernelNextSchema's function body, AFTER all
// kernel-next CREATE TABLE statements and any drop-and-rebuild blocks, add:
initCatalogSchema(db);
```

If the existing `initKernelNextSchema` runs the entire `KERNEL_NEXT_SCHEMA` exec at line N and ends at line M, place `initCatalogSchema(db)` immediately before the closing `}` of the function. Verify by grep:

```bash
cd apps/server && grep -n 'initKernelNextSchema\|^}' src/kernel-next/ir/sql.ts | head -20
```

- [ ] **Step 2: Modify mcp/server.ts to register the new tools**

Find the `ToolName` union (around line 82) and add:

```typescript
type ToolName =
  | "submit_pipeline" | "validate_pipeline" | ...
  | "wait_for_task_event"
  | "recommend_mcp_servers"   // <-- new
  | "get_mcp_catalog_entry";  // <-- new
```

Find `EXTERNAL_TOOLS` set (around line 108) and append the two new names.

Find `allTools` build site (around line 187) and add `...buildMcpCatalogTools(deps)`:

```typescript
import { buildMcpCatalogTools } from "./tools/mcp-catalog.js";

// inside createKernelMcp:
const allTools: ToolDef[] = [
  ...buildPipelineTools(deps),
  ...buildPortsTools(deps),
  ...buildTaskTools(deps),
  ...buildGateTools(deps),
  ...buildPgTools(deps),
  ...buildDebugTools(deps),
  ...buildHotUpdateTools(deps),
  ...buildAdminTools(deps),
  ...buildMcpCatalogTools(deps),  // <-- new
];
```

- [ ] **Step 3: Modify index.ts to mount the route and seed on startup**

Add the imports at the top of `apps/server/src/index.ts` (note: `getKernelNextDb` is already imported in this file — confirm by grep before adding the others):

```typescript
import { createKernelMcpCatalogRoute } from "./routes/kernel-mcp-catalog.js";
import { seedBuiltinFromJson } from "./kernel-next/mcp-catalog/seed.js";
import { join } from "node:path";
// Verify `getKernelNextDb` is already imported. If not, also add:
//   import { getKernelNextDb } from "./lib/kernel-next-db.js";
```

Mount the route after the other `app.route("/api", ...)` calls (search for `app.route("/api", kernelMcpRoute)`):

```typescript
app.route("/api", createKernelMcpCatalogRoute(getKernelNextDb));
```

After `initKernelNextSchema` is called on startup (search where the existing pipelines are seeded — `installBuiltinPipelines` or similar), add the catalog seed:

```typescript
const catalogJsonPath = join(import.meta.dirname, "kernel-next/mcp-catalog/entries.json");
const seedResult = seedBuiltinFromJson(getKernelNextDb(), catalogJsonPath);
if (!seedResult.ok) {
  console.error("[mcp-catalog] seed failed:", seedResult.error);
} else {
  console.log(`[mcp-catalog] seeded ${seedResult.inserted} new, ${seedResult.updated} updated, ${seedResult.deprecated} deprecated`);
}
```

- [ ] **Step 4: Run the full server test suite to confirm no regressions**

Run: `cd apps/server && pnpm vitest run`

Expected: all tests pass (existing ~1854 + ~40 new mcp-catalog tests). If tsc is configured, also run:

Run: `cd apps/server && pnpm tsc --noEmit`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/ir/sql.ts apps/server/src/kernel-next/mcp/server.ts apps/server/src/index.ts
git commit -m "feat(mcp-catalog): wire catalog schema/tools/routes/seed into kernel-next startup"
```

---

### Task 11: End-to-end smoke test (server boot + curl + MCP tool)

**Goal:** Confirm the supply chain Phase 1 actually works against a running server. Manual verification, no automation needed beyond the `e2e.test.ts` file we add.

**Files:**
- Create: `apps/server/src/kernel-next/mcp-catalog/e2e.test.ts`

- [ ] **Step 1: Write the e2e test**

```typescript
// apps/server/src/kernel-next/mcp-catalog/e2e.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { seedBuiltinFromJson } from "./seed.js";
import { listEntries, lookupEntryByCommand } from "./catalog-store.js";
import { recommendForTopicLocal } from "./recommender.js";
import { join } from "node:path";

describe("mcp-catalog E2E", () => {
  let db: DatabaseSync;

  beforeAll(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const path = join(import.meta.dirname, "entries.json");
    const r = seedBuiltinFromJson(db, path);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.inserted).toBeGreaterThanOrEqual(10);
    }
  });

  it("lists all 12 builtin entries", () => {
    const entries = listEntries(db);
    expect(entries.length).toBeGreaterThanOrEqual(12);
    const ids = entries.map((e) => e.id).sort();
    expect(ids).toContain("etherscan");
    expect(ids).toContain("github");
    expect(ids).toContain("playwright");
  });

  it("recommends etherscan for an EN onchain topic", () => {
    const r = recommendForTopicLocal(db, "verify tx hash on Ethereum");
    expect(r[0].id).toBe("etherscan");
  });

  it("recommends etherscan for a CN onchain topic", () => {
    const r = recommendForTopicLocal(db, "我要验证以太坊上的合约源码");
    expect(r.map((x) => x.id)).toContain("etherscan");
  });

  it("recommends github for a code-research topic", () => {
    const r = recommendForTopicLocal(db, "read source code from a github repo");
    expect(r[0].id).toBe("github");
  });

  it("lookupEntryByCommand reverse-resolves a recommended entry", () => {
    const entry = listEntries(db).find((e) => e.id === "etherscan")!;
    const id = lookupEntryByCommand(db, entry.command, entry.args);
    expect(id).toBe("etherscan");
  });
});
```

- [ ] **Step 2: Run the e2e test**

Run: `cd apps/server && pnpm vitest run src/kernel-next/mcp-catalog/e2e.test.ts`
Expected: PASS, 5 tests green.

- [ ] **Step 3: Manual smoke test against a running server**

Start the dev server (in another terminal):

```bash
cd apps/server && pnpm dev
```

In a third terminal, run these curl commands and confirm output:

```bash
# 1. list all entries
curl -s http://localhost:3001/api/kernel/mcp-catalog/entries | jq '.entries | length'
# Expected: 12 (or more if entries.json grew)

# 2. get one entry
curl -s http://localhost:3001/api/kernel/mcp-catalog/entries/etherscan | jq '.entry.name'
# Expected: "Etherscan MCP"

# 3. recommend (local)
curl -s -X POST http://localhost:3001/api/kernel/mcp-catalog/recommend \
  -H 'Content-Type: application/json' \
  -d '{"topic": "verify tx hash on Ethereum"}' | jq '.recommendations[0].id'
# Expected: "etherscan"

# 4. recommend (Chinese)
curl -s -X POST http://localhost:3001/api/kernel/mcp-catalog/recommend \
  -H 'Content-Type: application/json' \
  -d '{"topic": "我要验证以太坊上的合约源码"}' | jq '.recommendations[].id'
# Expected: includes "etherscan"

# 5. add a custom entry
curl -s -X POST http://localhost:3001/api/kernel/mcp-catalog/entries \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "my-custom",
    "schemaVersion": "1",
    "name": "My Custom",
    "description": "test custom entry",
    "useCases": ["test custom use case"],
    "tags": ["custom"],
    "command": "npx",
    "args": ["-y", "@my/mcp"],
    "envKeys": [],
    "healthCheckTimeoutMs": 10000,
    "source": "builtin"
  }' | jq '.entry.source'
# Expected: "custom" (forced regardless of input)

# 6. delete the custom entry
curl -s -X DELETE http://localhost:3001/api/kernel/mcp-catalog/entries/my-custom | jq '.ok'
# Expected: true

# 7. try to delete a builtin (should fail with 409)
curl -s -X DELETE http://localhost:3001/api/kernel/mcp-catalog/entries/etherscan -w '%{http_code}' | tail -c 3
# Expected: 409

# 8. MCP tool via MCP-over-HTTP
curl -s -X POST http://localhost:3001/api/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"recommend_mcp_servers","arguments":{"topic":"verify tx hash"}}}' \
  | jq '.result.content[0].text' | jq -r '.' | jq '.recommendations[0].id'
# Expected: "etherscan"
```

If any command produces unexpected output, debug before continuing.

- [ ] **Step 4: Commit the e2e test**

```bash
git add apps/server/src/kernel-next/mcp-catalog/e2e.test.ts
git commit -m "test(mcp-catalog): end-to-end smoke covering seed + list + recommend + lookup"
```

- [ ] **Step 5: Final tsc check**

```bash
cd apps/server && pnpm tsc --noEmit
```

Expected: no errors.

If errors, fix them and amend the previous commit before declaring Phase 1 complete.

---

## Phase 1 done state

After all 11 tasks complete, the system has:

- New SQLite table `mcp_catalog`
- 12+ builtin catalog entries auto-seeded on every startup
- 6 REST endpoints under `/api/kernel/mcp-catalog/*`
- 2 new MCP tools (`recommend_mcp_servers`, `get_mcp_catalog_entry`) callable via `/api/mcp`
- Bilingual (EN+CN) recommender with optional LLM-overlay
- ~50 new tests, all passing
- `tsc --noEmit` clean

Phase 1 is verifiable by the curl commands in Task 11. No web UI. No generator changes. No inventory/secrets/encryption.

The catalog is now ready to be consumed by Phase 2 (web UI + provisioning), Phase 3 (generator integration), and Phase 4 (launcher inventory awareness).
