# MCP Supply Chain — Design Spec

> **Date**: 2026-04-26
> **Scope**: Define a subsystem that turns MCP from "hidden user burden" into a first-class Flow capability — catalog, recommender, provisioner, and inventory — and integrate it into pipeline-generator.
> **Status**: Approved for planning.

---

## 0. Why this exists

The web3-research dogfood produced a research report (`/tmp/0g-final.md`) that lost head-to-head against a hand-crafted optimization report. Root cause was not the specific pipeline. It was structural: pipeline-generator could not produce **research-class pipelines that have first-hand verification** because:

- Generator did not know which MCP tools existed
- Users did not know either
- There was no mechanism to recommend tools per scenario, install them, validate them, or persist their secrets
- `recommendedMcps` port already exists in pipeline-generator's `analyzing` stage but no consumer reads it

Flow's product proposition is "abstract repeatable work into pipelines and run them repeatedly". For that proposition to deliver, the **pipelines themselves must be able to reach for the right tools**. That is what this subsystem provides.

---

## 1. Concepts

### 1.1 Catalog entry

A canonical record of one runnable MCP server. Source is either `builtin` (shipped with Flow, version-controlled) or `custom` (user-added, lives only in this user's SQLite).

### 1.2 Inventory

Per-user, per-entry record of "is this MCP equipped on this machine right now". Holds the encrypted secrets and the equipped/unhealthy status. Survives across tasks; this is what makes pipelines truly repeatable.

### 1.3 Recommendation

Given a topic (free text) or a pipeline IR, produce a ranked list of catalog entries that fit. Two layers: deterministic local matcher + optional LLM-overlay rerank.

### 1.4 Provisioning

The flow that takes a catalog entry from `not-equipped` to `equipped`: collect secrets, validate, persist to inventory.

### 1.5 Surfaces

Three surfaces over the same SQLite truth source:
- **Internal module** (in-process JS) — for executor, generator stages running in process
- **REST** (`/api/kernel/mcp-catalog/*`) — for web UI
- **MCP tools** (`recommend_mcp_servers`, `get_mcp_catalog_entry`) — for LLMs running inside agent stages

---

## 2. Data model

### 2.1 CatalogEntry shape

```typescript
type CatalogEntry = {
  id: string;                    // 'etherscan' (kebab, unique across builtin+custom)
  source: 'builtin' | 'custom';  // audit only, not part of primary key
  schemaVersion: '1';

  name: string;                  // 'Etherscan'
  description: string;           // user-facing one-liner
  useCases: string[];            // semantic match source (bilingual EN/中)
  tags: string[];                // open vocabulary tags (bilingual)
  homepage?: string;

  command: string;               // 'npx' (v1 npx only)
  args: string[];                // ['-y', '@scope/mcp-server']
  packageName?: string;          // explicit override; if absent, derived from args

  envKeys: Array<{
    name: string;                // 'ETHERSCAN_API_KEY'
    required: boolean;
    description: string;
    obtainUrl: string;           // open-in-new-tab to register
    obtainSteps: string;         // markdown
  }>;

  healthCheckTimeoutMs: number;  // default 10000

  toolsPreview?: Array<{ name: string; brief: string }>; // informational

  deprecatedAt?: number;         // builtin-only: set by seed when removed from JSON
};
```

### 2.2 SQLite schema

```sql
CREATE TABLE mcp_catalog (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL CHECK(source IN ('builtin','custom')),
  entry_json    TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  deprecated_at INTEGER
);

CREATE TABLE mcp_inventory (
  entry_id              TEXT PRIMARY KEY,
  status                TEXT NOT NULL CHECK(status IN (
    'not-equipped','pending-secret','equipped','unhealthy'
  )),
  last_status_change_at INTEGER NOT NULL,
  last_unhealthy_at     INTEGER,
  last_unhealthy_reason TEXT
);

CREATE TABLE mcp_inventory_secrets (
  entry_id        TEXT NOT NULL,
  env_key         TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,   -- base64(IV|ciphertext|GCM-tag)
  last_updated_at INTEGER NOT NULL,
  PRIMARY KEY (entry_id, env_key)
);
CREATE INDEX idx_mis_entry ON mcp_inventory_secrets(entry_id);
```

Encryption: AES-256-GCM with fresh 12-byte IV per encryption. Key from `~/.workflow-control/.secret-key` (auto-generated on first run, 0600 perms) or env override `WORKFLOW_CONTROL_SECRET_KEY`.

Cascade behavior: `unequipEntry` runs both DELETEs in one transaction.

### 2.3 Seed (builtin entries)

`apps/server/src/kernel-next/mcp-catalog/entries.json` is the base catalog. On server startup:

1. Read JSON
2. For each entry: upsert into `mcp_catalog` with `source='builtin'`
3. For any builtin id present in DB but absent from JSON → set `deprecated_at = now`
4. Custom entries are untouched

Seed failures **never block server startup** — log + emit `kernel:catalog-seed-failed` event.

---

## 3. Service surfaces

### 3.1 Internal module

`apps/server/src/kernel-next/mcp-catalog/index.ts`:

```typescript
listEntries(opts?: { source?: 'builtin'|'custom'|'all'; includeDeprecated?: boolean }): CatalogEntry[];
getEntry(id: string, opts?: { includeDeprecated?: boolean }): CatalogEntry | null;
upsertCustomEntry(entry: CatalogEntry): { ok: true; entry: CatalogEntry } | { ok: false; diagnostics: Diagnostic[] };
deleteCustomEntry(id: string): { ok: true } | { ok: false; diagnostics: Diagnostic[] };
recommendForTopicLocal(topic: string, opts?: { maxResults?: number; excludeIds?: string[] }): RecommendResult[];
recommendForTopicWithLLM(topic: string, opts?): Promise<{ recommendations: RecommendResult[]; warnings?: Diagnostic[] }>;
seedBuiltinFromJson(jsonPath: string): { inserted: number; updated: number; deprecated: number };
lookupEntryByCommand(command: string, args: string[]): string | null;  // returns entryId
```

Where:

```typescript
type RecommendResult = {
  id: string;
  score: number;
  evidence: {
    matchedTags: string[];
    matchedUseCases: string[];
    matchedDescriptionTerms: string[];
  };
  llmReason?: string;
};
```

### 3.2 REST surface

Mounted at `/api/kernel/mcp-catalog/*` via new `kernelMcpCatalogRoute`. All responses follow the diagnostic envelope.

| Method | Path | Purpose |
|---|---|---|
| GET | `/entries` | list all (query: `source`, `includeDeprecated`) |
| GET | `/entries/:id` | one entry |
| POST | `/entries` | add custom (source=custom enforced; conflict with builtin id → 409 `CATALOG_ENTRY_ID_CONFLICT`) |
| PUT | `/entries/:id` | update custom (builtin → 409 `CATALOG_BUILTIN_NOT_WRITABLE`) |
| DELETE | `/entries/:id` | delete custom (builtin → 409 `CATALOG_BUILTIN_NOT_WRITABLE`) |
| POST | `/recommend` | body `{topic, excludeIds?, withLLM?}` → recommendations |
| GET | `/inventory` | list inventory rows (no secret values; `{hasValue, lastUpdatedAt}` per envKey) |
| GET | `/inventory/:entryId` | single inventory status |
| POST | `/equip` | body `{entryId, envValues}` → run provisioning |
| POST | `/unequip` | body `{entryId}` |
| POST | `/recheck` | body `{entryId}` or `{}` for all → re-run health check |

**Source-check guard**: every write endpoint verifies the target entry's source before mutation.

**Secret values are never returned by any GET endpoint.**

### 3.3 MCP tool surface

Two new tools in `__kernel_next_external__` (`apps/server/src/kernel-next/mcp/server.ts`):

- `recommend_mcp_servers(topic, excludeIds?, maxResults?)` → wraps `recommendForTopicWithLLM`
- `get_mcp_catalog_entry(id)` → wraps `getEntry`

Both follow standard kernel MCP `{ok, ...}` envelope.

---

## 4. Recommender

### 4.1 Two-layer design

**Layer 1 — Local deterministic matcher** (sync, pure JS):

1. Tokenize topic: split on whitespace + Chinese/English punctuation, lowercase, drop stopwords
2. For each catalog entry (skipping deprecated):
   - useCases match: max overlap-ratio between any useCase tokens and topic tokens (weight 0.5)
   - tags match: token overlap ratio (weight 0.3)
   - description match: token overlap ratio (weight 0.2)
3. For each of (useCases, tags, description), compute the score as `max(tokenOverlapRatio, substringMatchRatio)`. The substring path covers Chinese topics that don't tokenize on whitespace; English topics will typically score higher on token-overlap; we take whichever is higher per field
4. Discard entries with score < `MIN_SCORE` (default 0.1)
5. Sort by score, take top `maxResults` (default 5)

Evidence is structured: which useCases/tags/description-terms hit. Reason is a synthesized string from evidence.

Weights and threshold are constants in `mcp-catalog/score-weights.ts`, tunable.

**Layer 2 — LLM-overlay rerank** (async, optional):

Triggered when `recommend_mcp_servers` MCP tool is called, or REST `/recommend?withLLM=true`.

1. Run Layer 1 to get up to 10 candidates
2. Send candidates + topic to a small LLM call (`claude-haiku-4-5`, maxTokens 500)
3. LLM outputs strict JSON: each result has `id` (must be in candidates), `llmReason` (natural language), `citedEvidence: { tags?: string[]; useCases?: string[] }` (must be subset of evidence)
4. Validate: drop any result whose id isn't a candidate, or whose citedEvidence isn't ⊆ evidence
5. Return validated results

**Failure handling**: if LLM-overlay throws or times out, return Layer 1 results plus a warning diagnostic ("LLM-overlay unavailable, returned local-only ranking"). Never fail the recommend call.

### 4.2 LLM client module

`apps/server/src/kernel-next/mcp-catalog/llm-client.ts` provides:

```typescript
simpleJsonCompletion<T>(args: {
  systemPrompt: string;
  userPrompt: string;
  schema: z.ZodSchema<T>;
  maxTokens?: number;
  model?: string;
}): Promise<T>;
```

Uses Anthropic SDK directly. Does NOT reuse `runtime/sdk-adapter.ts` (that one is stage-executor scoped). Errors throw — caller decides how to degrade.

### 4.3 Bilingual catalog requirement

Every builtin entry's `useCases` and `tags` arrays must include both English and Chinese variants of relevant terms. This is a maintainer obligation, not enforced by code.

Example:

```json
{
  "tags": ["onchain-verification", "链上验证", "evm", "以太坊"],
  "useCases": [
    "verify tx hash and contract source on Ethereum / 验证以太坊上的 tx 哈希和合约源码",
    "..."
  ]
}
```

The Local matcher's substring path handles Chinese topics that don't tokenize on whitespace.

---

## 5. Provisioning

### 5.1 Status machine

```
not-equipped ─[user equip]──> pending-secret
pending-secret ─[secrets full + healthcheck pass]──> equipped
pending-secret ─[healthcheck fail]──> unhealthy
equipped ─[user unequip]──> not-equipped
equipped ─[recheck fail]──> unhealthy
unhealthy ─[user re-equip + healthcheck pass]──> equipped
unhealthy ─[user unequip]──> not-equipped
```

Entries with no required envKeys skip `pending-secret` and go directly to `equipped` after a healthcheck.

`verifying` is a UI-only transient state (button shows spinner while POST `/equip` is in flight); not persisted to DB.

### 5.2 Health check (v1)

Two checks:

1. **envKey check** (`MCP_PROVISION_ENVKEY_MISSING` on failure): all `required` envKeys for this entry have a non-empty value in either inventory secrets or process env.
2. **Package check** (`MCP_PROVISION_PACKAGE_NOT_FOUND` on failure): run `npm view <packageName> version` (extract from `entry.packageName` or fall back to first non-flag arg in `args`); fail on timeout (`healthCheckTimeoutMs`) or non-zero exit.

**v1 explicitly does NOT** validate secret correctness by calling the MCP. The secret-gate runtime flow handles real-call failures.

### 5.3 Web UI

New page `apps/web/src/app/kernel-next/mcp-catalog/page.tsx`. Components:

- Header: "MCP 装备 / Inventory" with overall health summary
- "Recommended" section: shows entries needed by an in-flight task or pipeline (URL query `?neededByTask=...` or `?neededByPipelineHash=...`)
- Each card displays: name, description, status badge, tags, AI reason (if from recommender), action buttons
- Expanded provisioning state per card:
  - For each envKey: input field, "open registration page ↗" button, expandable "how to obtain" markdown
  - "Verify" button → POSTs to `/api/kernel/mcp-catalog/equip`
- Footer: "Browse all" link, "+ Add custom entry" button (opens form modal)

**Add custom entry form**: two modes — Quick (id, name, command, args only) and Full (all fields). Validates against `CatalogEntrySchema` server-side.

**Client-side secret hygiene**: input fields auto-trim, warn on length < 8 chars.

**Launcher integration**: Launcher dialog (`apps/web/src/components/launch-pipeline-dialog.tsx`) reverse-looks-up each `mcpServer` in IR via `lookupEntryByCommand`; if any are not equipped, show a red banner with "前往装备" linking to `/kernel-next/mcp-catalog?neededByPipelineHash=<hash>`.

For mcpServers in IR that don't resolve to a catalog entry (user-hacked IR): display "unknown tool" warning, suggest adding to custom catalog. Do not block task launch.

---

## 6. Inventory + secret resolution

### 6.1 Secret priority chain (executor)

In `runtime/mcp-servers-expander.ts`, when resolving an envKey for a stage's mcpServer:

1. `task_env_values[envKey]` — task-explicit override
2. If `lookupEntryByCommand(mcpServer.command, mcpServer.args)` returns an entryId, then `mcp_inventory_secrets[entryId, envKey]` (decrypted in process)
3. `process.env[envKey]`
4. Else add to `missingKeys` → triggers existing secret-gate flow

Decryption happens inside the expander, plaintext never leaves the server process.

### 6.2 secret-gate persistence option

The existing secret-gate runtime feature (provideTaskSecrets MCP tool + SecretGatePanel UI) gains a `persistAs?: { [envKey]: { entryId: string } }` parameter:

- Without `persistAs`: write to `task_env_values` only (current behavior)
- With `persistAs`: also write to `mcp_inventory_secrets` for the named entryId(s); after success, run health check on those entries and set their inventory status

The dashboard's SecretGatePanel adds a checkbox per envKey: "Save to MCP inventory for entry X" — only shown when the executor's missingKeys diagnostic has resolved an entryId for that envKey.

### 6.3 Encryption key recovery

If `~/.workflow-control/.secret-key` is missing on startup but `mcp_inventory_secrets` has rows:

1. Server logs warning, emits `kernel:secret-key-lost` event
2. Generates a new key file
3. Sets all `equipped` inventory rows to `unhealthy` with reason `'encryption-key-lost'`
4. Server starts normally

User sees their inventory marked unhealthy, refills secrets, returns to normal.

v1 does not support key rotation (re-encrypt with new key). Out of scope.

### 6.4 Inventory module

`apps/server/src/kernel-next/mcp-catalog/inventory.ts`:

```typescript
listInventory(): InventoryRow[];
getInventoryStatus(entryId: string): InventoryRow | null;
hasSecret(entryId: string, envKey: string): boolean;

equipEntry(args: { entryId: string; envValues: Record<string, string> }): Promise<
  | { ok: true; status: 'equipped' | 'pending-secret' }
  | { ok: false; diagnostics: Diagnostic[] }
>;

unequipEntry(entryId: string): { ok: true } | { ok: false; diagnostics: Diagnostic[] };

recheckEntry(entryId: string): Promise<{ status: InventoryStatus; diagnostics?: Diagnostic[] }>;

resolveSecret(entryId: string, envKey: string): string | null;  // INTERNAL only

encryptValue(plaintext: string): string;
decryptValue(ciphertext: string): string;
```

`resolveSecret` is the only function that returns plaintext. Calling sites are restricted to in-process trusted modules (the expander). Never reachable from REST or MCP tool surface.

---

## 7. Pipeline-generator integration

### 7.1 `analyzing` stage

- `mcpServers` config gains access to `__kernel_next__` already-required stage
- System prompt updated: must call `recommend_mcp_servers(topic=user_description)` and integrate results into output
- Output port `recommendedMcps` schema changes from loose strings to structured `{ entryId: string; reason: string }[]`

### 7.2 `genSkeleton` stage

- Inputs add `recommendedMcps`
- System prompt updated: for each recommendation, call `get_mcp_catalog_entry(id)` to retrieve full entry, then place a `mcpServers` block on the appropriate stage (LLM judges semantic fit)
- When constructing the stage `mcpServers` block, include only `name`, `command`, `args`, `envKeys: [{name}]` — NOT envKey metadata
- Stages without semantic fit get no `mcpServers` block

### 7.3 `awaitingConfirm` gate UI extension

(Plan-time prerequisite: confirm current gate UI structure in `apps/web` before designing extension.)

The confirm panel adds a "Recommended Tools" section showing each recommended entry with its inventory status and a per-entry "前往装备" button when not equipped. Equipping returns to confirm with status auto-refreshed.

### 7.4 Backwards compatibility

- Existing builtin pipelines have empty `mcpServers`; behavior unchanged
- Existing user pipelines: launcher reverse-lookup falls through to "unknown tool" warning (non-blocking)
- Running tasks: unaffected (they have their own task_env_values already populated)

---

## 8. Module layout (new code)

```
apps/server/src/kernel-next/mcp-catalog/
├── index.ts                  # internal surface; re-exports
├── schema.ts                 # zod schemas (CatalogEntry, RecommendResult, ...)
├── score-weights.ts          # tunable constants
├── catalog-store.ts          # SQLite CRUD for mcp_catalog
├── inventory.ts              # SQLite CRUD + encrypt/decrypt for mcp_inventory[_secrets]
├── recommender.ts            # Local matcher + LLM-overlay
├── llm-client.ts             # simpleJsonCompletion (independent of runtime SDK adapter)
├── healthcheck.ts            # envKey + npm-view checks
├── seed.ts                   # JSON → DB upsert + deprecation
├── lookup.ts                 # lookupEntryByCommand
├── crypto.ts                 # AES-GCM encrypt/decrypt + key file management
└── entries.json              # base builtin catalog (versioned)

apps/server/src/routes/
└── kernel-mcp-catalog.ts     # /api/kernel/mcp-catalog/* REST routes

apps/server/src/kernel-next/mcp/
└── server.ts (modified)      # adds recommend_mcp_servers + get_mcp_catalog_entry tools

apps/server/src/kernel-next/runtime/
└── mcp-servers-expander.ts (modified)  # adds inventory secret resolution layer

apps/server/src/index.ts (modified)
└── seedBuiltinFromJson on startup; mount kernelMcpCatalogRoute

apps/web/src/app/kernel-next/mcp-catalog/
├── page.tsx                  # main catalog/inventory page
├── add-entry-dialog.tsx      # custom entry form
└── entry-card.tsx            # per-entry display + provisioning

apps/web/src/components/
├── launch-pipeline-dialog.tsx (modified)  # add inventory status section
└── secret-gate-panel.tsx (modified)        # add persistAs checkbox

apps/server/src/builtin-pipelines/pipeline-generator/
├── pipeline.ir.json (modified)            # update analyzing/genSkeleton stages
└── prompts/system/{analyzing,genSkeleton}.md (modified)
```

---

## 9. Error codes (full list)

| Code | Used by | Meaning |
|---|---|---|
| `CATALOG_ENTRY_NOT_FOUND` | catalog GET/PUT/DELETE | entry id not in catalog |
| `CATALOG_ENTRY_ID_CONFLICT` | catalog POST | id already used by builtin |
| `CATALOG_INVALID_ENTRY` | catalog POST/PUT | zod validation failed |
| `CATALOG_BUILTIN_NOT_WRITABLE` | catalog PUT/DELETE | target is builtin |
| `MCP_PROVISION_ENVKEY_MISSING` | equip / recheck | required envKey unsatisfied |
| `MCP_PROVISION_PACKAGE_NOT_FOUND` | equip / recheck | npm view returned non-zero |
| `MCP_PROVISION_HEALTHCHECK_TIMEOUT` | equip / recheck | exceeded healthCheckTimeoutMs |
| `MCP_INVENTORY_DECRYPT_FAILED` | resolveSecret | ciphertext malformed or key mismatch |

---

## 10. What's explicitly out of scope (v1)

- Embedding-based recommendation (use keyword + substring; v2 if needed)
- Real secret validity verification (let secret-gate handle it)
- Background periodic health check (passive checks only)
- Encryption key rotation (one-shot key only)
- Marketplace / signed manifests (custom entries are local trust only)
- Docker / binary MCP servers (npx only)
- Entry signature / provenance verification

---

## 11. Test posture

(Specific tests fall to the writing-plans phase. The architectural commitment is below.)

- Catalog CRUD: unit tests covering source guards (builtin write attempts → 409)
- Recommender Layer 1: deterministic across topics; bilingual fixture coverage
- Recommender LLM-overlay: fake LLM returns degraded-but-validated output; failure → fallback verified
- Provisioning state machine: each transition exercised
- Encryption: round-trip test, IV uniqueness, key-loss recovery test
- Generator integration: end-to-end test that takes a topic, runs analyzing → confirms recommendedMcps non-empty, runs genSkeleton → confirms IR has populated mcpServers blocks

---

## 12. Migration / rollout

This subsystem is additive. Rollout plan:

1. **Phase 1**: catalog data + service surface + REST + MCP tools (no UI, no generator change). Verifiable via curl + MCP tool calls.
2. **Phase 2**: web catalog/inventory page + provisioning UX. Users can manually equip MCPs; generator still doesn't recommend.
3. **Phase 3**: pipeline-generator integration. New pipelines auto-recommend; existing pipelines and tasks unaffected.
4. **Phase 4**: secret-gate `persistAs` and launcher inventory-status integration. Closes the loop.

Each phase leaves the system in a working state per the kernel's "one step at a time, each independently shippable" principle.

---

## 13. Open questions deferred to plan-writing

- awaitingConfirm gate UI current structure (plan must inspect first)
- Exact base catalog entries for v1 launch (target: ~10-15 entries covering web3, codebase, web research, files, github)
- Secret key file location convention (`~/.workflow-control/.secret-key` vs alternative)
