# Session Handoff — MCP Supply Chain rollout (Phase 2-4) shipped

> **Date**: 2026-04-27 (continuation of `2026-04-26-niche-experiment-verdict-handoff.md`; previous session shipped Phase 1)
> **Scope**: Closed Phase 2 + Phase 3 + Phase 4 of the MCP Supply Chain subsystem. All four phases now on `main`.
> **Total commits this session**: 4 plan commits + 5 merge commits + ~26 implementation commits = ~35.

---

## 1. What was done

This session executed three phases end-to-end via subagent-driven-development. Each phase: write plan → branch off main → TDD per task with two-stage review (spec compliance + code quality) → review followups → merge to main.

**Phase 2** (already merged before this session as commit `8939042`, but listed for completeness):
- AES-256-GCM crypto module (`crypto.ts`) with key file `~/.workflow-control/.secret-key`
- `mcp_inventory` + `mcp_inventory_secrets` SQLite tables
- Inventory state machine: `not-equipped` → `pending-secret` → `equipped` ⇄ `unhealthy`
- Healthcheck (envKey presence + `npm view` package check)
- REST: `/api/kernel/mcp-catalog/{inventory,equip,unequip,recheck,lookup-by-envkey}`
- `mcp-servers-expander` reads inventory between `task_env_values` and `process.env`
- `provideTaskSecrets` gains opt-in `persistAs` parameter
- Web UI: `/kernel-next/mcp-catalog` page + entry card + add-custom dialog (JSON textarea)
- `LaunchPipelineDialog` shows `<InventoryBanner />` next to required envKeys
- `SecretGatePanel` per-envKey checkbox "Save to MCP inventory"

**Phase 3** (merged at `c5b4d1b`):
- `recommendedMcps` IR port type tightened from `object[]` to `Array<{ entryId; name; command; args; env?; envKeys; reason }>` (4 ports + 1 store_schema entry — store_schema sync was a fix-up after the initial change broke `STORE_SCHEMA_TYPE_MISMATCH`)
- `pipeline-generator` `analyzing` prompt: drop PulseMCP, use `recommend_mcp_servers` (already accessible via auto-injected `__kernel_next__` MCP)
- `pipeline-generator` `genSkeleton` prompt: call `get_mcp_catalog_entry(entryId)` to materialize each chosen entry
- `gate-card.tsx` extracts `recommendedMcps` from upstream outputs and renders new `<RecommendedMcpsCard />` with inventory status + "前往装备" deep link

**Phase 4** (merged at `ede04f2`, this session's most recent merge):
- `crypto.keyFileExists()` non-side-effecting helper
- `runSecretKeyRecovery(db, opts?)` — startup guard. If env override absent + key file missing + secrets table non-empty: bulk-mark all `equipped`/`pending-secret` rows `unhealthy` with reason `encryption-key-lost` BEFORE crypto auto-generates a fresh key. Idempotent. Never throws (catch logs via pino + returns `{recovered:false}`). Wired into `index.ts` immediately before `seedBuiltinFromJson`.
- Surface `MCP_INVENTORY_DECRYPT_FAILED` in the secret-pending error message: `real-executor.ts`'s expander callback now collects `{entryId, envKey}` for each decrypt failure and augments `MCP_ENV_MISSING` with a parenthetical hint pointing to `/kernel-next/mcp-catalog`. Backwards compatible — when `decryptFailures.length === 0` the error string is unchanged. Closes the T7 TODO from Phase 2.

Final test count on main: **2032 passed / 4 skipped / 0 failed**. `apps/server` and `apps/web` both `tsc --noEmit` clean.

---

## 2. Architectural decisions worth knowing

### 2.1 Closed-loop UX

After Phase 4, the user-facing loop is:

1. User describes a pipeline. `pipeline-generator` analyzing stage calls `recommend_mcp_servers` (Phase 1 catalog) and emits structured `recommendedMcps`.
2. `awaitingConfirm` gate UI renders the recommendations with inventory status. User clicks "前往装备" for any not-equipped entry → `/kernel-next/mcp-catalog`.
3. On the catalog page, user clicks "Equip" → form prompts for required envKeys → POST `/equip` → AES-GCM encrypts → stored in `mcp_inventory_secrets` → npm view healthcheck → status flips to `equipped`.
4. User returns to gate, approves → `genSkeleton` calls `get_mcp_catalog_entry(entryId)` → emits IR with `mcpServers` blocks.
5. Pipeline launches. `mcp-servers-expander` resolves `${VAR}` placeholders from inventory (decrypts on demand). Stage runs with the right secrets.
6. If a secret was missing or stored-but-unreadable, secret-gate fires with a clear MCP_ENV_MISSING (now Phase 4-augmented when decrypt failures occurred) and `SecretGatePanel` lets the user supply with optional "save to inventory for next time".

If the secret-key file is lost between sessions: Phase 4 startup guard flips all equipped rows to `unhealthy(encryption-key-lost)`. User sees them on the catalog page and re-equips. No silent corruption.

### 2.2 Phase 3 PulseMCP retirement is permanent

The `analyzing.md` prompt previously instructed Claude to "search PulseMCP for relevant tools" — but PulseMCP was never wired into the analyzing stage's `mcpServers` config (the stage had NO mcpServers block at all). The model was hallucinating server definitions from training data. Phase 3 replaced the entire discovery path with `recommend_mcp_servers` against the local 12-entry seeded catalog. The trade-off:

- **Lose**: ability to recommend servers outside the curated catalog (e.g. Notion, Stripe, Atlassian) on the fly.
- **Gain**: every recommendation is pre-validated, comes with `entryId` for one-click inventory equip, and the user has an escape hatch (custom-entry web UI / catalog API).

If you want a recommendation outside the catalog, the workflow is: add a custom catalog entry first, then re-run pipeline-generator. This was a deliberate choice — see Phase 3 plan §10's gap acknowledgement.

### 2.3 Phase 4 swapped `kernel:secret-key-lost` event for pino logger.warn + inventory-row state

Spec §6.3 prescribed an event-bus emission. The repo has no global event bus (only per-task SSE broadcasters). Substitute: pino warning at startup + the inventory row's `lastUnhealthyReason='encryption-key-lost'` IS the user-visible signal (the catalog page reads it). This matches the spec's intent without inventing infrastructure.

### 2.4 Custom-entry "polished form" remains JSON textarea (deliberate)

User considered a Quick / Full mode form during this session. The decision: keep the textarea. Reasons captured in conversation:
- Schema double-declaration burden (zod CatalogEntrySchema vs React form validation)
- AI-authored is the dominant flow per CLAUDE.md ("AI writes JSON, not humans")
- User adds custom entries rarely; the textarea + zod server-side validation + inline `ErrorBanner` is sufficient

If a future session decides to revisit, see Phase 4 plan's "Out of scope" + the conversation around it. The minimum-cost middle ground would be a "Insert template" dropdown that prefills the textarea from `entries.json` — explicitly suggested as a fallback, ~30 lines.

### 2.5 Hard invariants honored

- `Task.pipelineSnapshot` correctness untouched (Phase 4 startup recovery only marks inventory rows; doesn't mutate any pipeline IR or running task).
- Stage `reads`/`writes` data flow unchanged.
- Pipeline version = content hash unchanged (Phase 3's IR edits produced new version hashes for the `pipeline-generator` builtin only — that's by design, since the prompt and port-type changes ARE behavioral).
- "Never regress already-executed information": no migration needed. Phase 2's `mcp_inventory*` tables are new; Phase 3's port-type tightening is structural-only on a *builtin* pipeline that gets re-installed at every server boot via `installBuiltinPipelines`.

---

## 3. Files of interest, with line refs

### 3.1 Module layout (server, post-Phase 4)

```
apps/server/src/kernel-next/mcp-catalog/
├── catalog-store.ts              # Phase 1 — entries CRUD + lookupEntryByCommand
├── crypto.ts                     # Phase 2 + Phase 4 (added keyFileExists)
├── decrypt-diagnostic.test.ts    # Phase 4 T2 — 2 tests
├── e2e-phase-2.test.ts           # Phase 2 final — 1 e2e test
├── e2e.test.ts                   # Phase 1 — catalog smoke
├── entries.json                  # Phase 1 — 12 builtin entries
├── healthcheck.ts                # Phase 2 — checkEnvKeys + checkPackage (injectable exec)
├── inventory-recovery.test.ts    # Phase 4 T1 — equip → loss → recovery integration
├── inventory-sql.ts              # Phase 2 — DDL + initInventorySchema
├── inventory-store.ts            # Phase 2 — raw CRUD (no business logic)
├── inventory-types.ts            # Phase 2 — InventoryStatusSchema, InventoryRowSchema, codes
├── inventory.ts                  # Phase 2 — equipEntry/unequipEntry/recheckEntry/resolveSecret
├── key-recovery.ts               # Phase 4 T1 — runSecretKeyRecovery
├── llm-client.ts                 # Phase 1 — Anthropic SDK direct
├── recommender.ts                # Phase 1 — Local + LLM-overlay
├── schema.ts                     # Phase 1 — CatalogEntrySchema
├── score-weights.ts              # Phase 1 — tunable constants
├── seed.ts                       # Phase 1 — seedBuiltinFromJson
└── sql.ts                        # Phase 1 — catalog DDL
```

### 3.2 Modified call sites (search for these to understand integration)

- `apps/server/src/kernel-next/runtime/real-executor.ts:436-487` — secret resolution chain (Phase 2 T7 + Phase 4 T2 augmentation). The `decryptFailures` closure-scoped array on line 441 is the key Phase 4 T2 addition.
- `apps/server/src/kernel-next/runtime/mcp-servers-expander.ts:1-12` — header comment documents the 3-layer precedence (taskEnv > inventory > processEnv).
- `apps/server/src/kernel-next/mcp/kernel.ts:1422-1591` — `provideTaskSecrets` with `persistAs` extension.
- `apps/server/src/index.ts:165-181` — startup wiring: key-recovery guard FIRST, then catalog seed.
- `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/analysis.md` — Phase 3 prompt: uses `recommend_mcp_servers` + `get_mcp_catalog_entry`. Search for "PulseMCP" → 0 matches.
- `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/gen-skeleton.md` — Phase 3 prompt: explicit `get_mcp_catalog_entry(entryId)` procedure + 5 rules.
- `apps/server/src/builtin-pipelines/pipeline-generator/pipeline.ir.json` — 4 port type updates + 1 store_schema entry update. The Phase 3 T1 commit `4926037` was the store_schema sync fix-up.

### 3.3 Web UI

- `apps/web/src/app/kernel-next/mcp-catalog/{page.tsx,entry-card.tsx,add-entry-dialog.tsx}` — Phase 2 main catalog page.
- `apps/web/src/components/inventory-banner.tsx` — Phase 2, used by `LaunchPipelineDialog`.
- `apps/web/src/components/recommended-mcps-card.tsx` — Phase 3, used by `gate-card.tsx`.
- `apps/web/src/lib/mcp-catalog-api.ts` — Phase 2 typed apiFetch wrappers.

---

## 4. Tests (Phase 2-4 specifically)

| File | Phase | Count |
|---|---|---|
| `crypto.test.ts` | 2+4 | 12 |
| `inventory-types.test.ts` | 2 | 8 |
| `inventory-sql.test.ts` | 2 | 5 |
| `inventory-store.test.ts` | 2 | 10 |
| `healthcheck.test.ts` | 2 | 10 |
| `inventory.test.ts` | 2 | 15 |
| `mcp-servers-expander.inventory.test.ts` | 2 | 5 |
| `kernel-mcp-catalog.inventory.test.ts` | 2 | 9 |
| `kernel-persistAs.test.ts` | 2 | 4 |
| `kernel-tasks.persistAs.test.ts` | 2 | 3 |
| `e2e-phase-2.test.ts` | 2 | 1 |
| `pipeline.ir.test.ts` | 3 | 4 |
| `key-recovery.test.ts` | 4 | 6 |
| `inventory-recovery.test.ts` | 4 | 1 |
| `decrypt-diagnostic.test.ts` | 4 | 2 |

Plus all Phase 1 tests preserved and 100+ pre-existing tests intact.

---

## 5. What didn't get done (intentionally)

These were explicitly out of scope per user direction this session and/or spec §10:

- **Polished custom-entry form (Quick/Full mode)**. JSON textarea retained.
- **Embedding-based recommendation**. Keyword + n-gram substring match suffices for the 12-entry catalog.
- **Real secret-validity verification (calling the MCP)**. Phase 2 healthcheck is `npm view` + envKey presence only.
- **Background periodic health check**. Status only changes on user action (equip/unequip/recheck).
- **Encryption key rotation**. One-shot key only.
- **Marketplace / signed manifests**. Custom entries are local-trust only.
- **Docker / binary MCP servers**. `npx` only.
- **Global `kernel:` event bus**. Replaced with pino logger + inventory row state for `secret-key-lost` signal.

---

## 6. Caveats the next session should know

- **Phase 3 deletion of PulseMCP language is permanent**. If a user reports "I want pipeline-generator to find a Notion MCP", the answer is: add a Notion entry to `entries.json` (or a custom entry via UI), then re-run. Don't restore PulseMCP language to the prompt.
- **Phase 4 startup recovery runs once per server boot** in `index.ts:165-181`. If you add a new startup block that touches crypto BEFORE this guard (e.g. a future "preload all secrets to memory" step), you must move it AFTER the guard or the auto-generated fresh key will silently take effect.
- **Phase 4 T1 catch swallows unexpected SQL errors and logs via pino**. If recovery seems "stuck" in production (rows not flipping despite key loss), grep `[mcp-catalog] key-recovery guard failed` in pino logs.
- **`pipeline.ir.json` and `store_schema` MUST stay in sync**. The Phase 3 T1 fix-up `4926037` was caused by this exact drift. The `pipeline.ir.test.ts` regression test now asserts the parity, so a future change will be caught at test time.
- **`equipEntry` defaults to real `npm view`** (via `defaultExec`). Tests must inject a fake exec. Production startup doesn't call `equipEntry` directly; the server boot is fast.
- **`InventoryDeps.processEnv` defaults to `process.env`**. Mocking `process.env` in tests is racy across vitest workers. The recommended pattern: pass `processEnv: {}` explicitly (see Phase 2 `inventory.test.ts`).
- **Crypto module has a `cachedKey: Buffer | null` module-level cache**. Tests must call `resetKeyCacheForTest()` in `beforeEach` whenever they mutate `WORKFLOW_CONTROL_SECRET_KEY`. The Phase 2 T8 `kernel-mcp-catalog.inventory.test.ts` followup added this; the Phase 4 T2 `decrypt-diagnostic.test.ts` integration describe also has the env restore pair.

---

## 7. Open items for any next session

If the user wants more on this subsystem:

- **Add catalog entries**. `entries.json` has 12 (etherscan, bscscan, github, fetch, filesystem, arxiv, playwright, brave-search, puppeteer, linear, slack, postgres). The schema is documented in `schema.ts`. `recommend_mcp_servers` will pick them up automatically; `get_mcp_catalog_entry` works on any id.
- **Encryption key rotation** (spec §10 explicitly OOS, but not impossible). Would require a new column `mcp_inventory_secrets.key_version`, a re-encrypt migration, and a `kek_versions` table. Estimate 1 day.
- **Marketplace** (spec §10 OOS). Would require entry signature, trust roots, fetch + verify pipeline. Multi-week effort.
- **Polished custom-entry form**. ~300 React lines + duplicated zod validation. Low ROI per the analysis we did this session.
- **Notion/Atlassian/Stripe entries via mcp-remote bridge**. The catalog only stores stdio for v1; adding a remote-HTTP variant means a `transport: "stdio" | "remote-http"` discriminant on `CatalogEntry` + an `oauth?: boolean` flag + `mcp-remote` bridge args. Touches: `schema.ts`, `entries.json`, `gen-skeleton.md` (re-add Sample B language), `inventory.ts equipEntry` (skip envKey check for OAuth-mediated entries), Web UI. Estimate 2-3 days.

Otherwise: every prior-handoff item from `2026-04-26-niche-experiment-verdict-handoff.md` was already closed in that session. The MCP Supply Chain rollout that this session executed was a fresh subsystem on top.

---

## 8. Untracked junk in the working tree

`git status` shows ~24 untracked files in `apps/server/` (`call-write-port.ts`, `invoke-stage-s.ts`, `kernel.db`, etc.). These are leftovers from a prior session's subagent experiments — not produced by this session. They don't affect anything but should be cleaned up at some point. Suggested cleanup is to add them to `.gitignore` or delete them; this session deliberately did not touch them since they predate the work.
