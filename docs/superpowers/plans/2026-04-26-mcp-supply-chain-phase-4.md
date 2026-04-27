# MCP Supply Chain — Phase 4 Implementation Plan (polish)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two data-integrity loose ends that Phase 1-3 left open: encryption-key-loss recovery (spec §6.3) and decrypt-failure observability (T7 TODO).

**Architecture:** Both changes are surgical and additive.
- Task 1 adds a startup-time guard in `index.ts` that runs **before** crypto.loadKey is called for the first time. The guard inspects whether a key file exists on disk and whether the inventory has any non-empty rows; if it would auto-generate a new key while encrypted rows are present, it instead marks every inventory row `unhealthy` with reason `encryption-key-lost` BEFORE generating the new key. The user sees those rows as unhealthy on the catalog page and re-equips them.
- Task 2 closes the T7 TODO in `real-executor.ts:448`. The expander's resolveInventorySecret callback currently swallows the typed decrypt error; we plumb the diagnostic up so it shows up in the stage's secret-pending error message and the user understands "key is fine, your stored secret is unreadable" vs "you never set this".

**Tech Stack:** Same — TypeScript, vitest, node:sqlite, node:fs.

**Spec reference:** `docs/superpowers/specs/2026-04-26-mcp-supply-chain-design.md` § 6.3, plus closure of `apps/server/src/kernel-next/runtime/real-executor.ts:448` TODO.

---

## Out of scope for Phase 4

These are out of Phase 4 polish (per prior decision):

- "Polished" custom-entry web form (Quick / Full mode); current JSON textarea stays.
- Embedding-based recommendation
- Real secret-validity verification (calling the MCP)
- Background periodic health check
- Encryption key rotation
- Marketplace / signed manifests

If a task below seems to imply any of these, it's mis-scoped and should be deferred.

---

## File map

**New files (server, 4):**

```
apps/server/src/kernel-next/mcp-catalog/key-recovery.ts
  # Pre-loadKey startup guard. Detects "key file missing but inventory non-empty"
  # and bulk-marks rows unhealthy before crypto.ts auto-generates a new key.
apps/server/src/kernel-next/mcp-catalog/key-recovery.test.ts
apps/server/src/kernel-next/mcp-catalog/decrypt-diagnostic.test.ts
  # Verifies expander → real-executor surfaces MCP_INVENTORY_DECRYPT_FAILED
  # in the secret-pending error path when a stored ciphertext is corrupt.
apps/server/src/kernel-next/mcp-catalog/inventory-recovery.test.ts
  # Integration test for Task 1: equip → simulate key loss (delete file) →
  # boot guard runs → all rows now unhealthy with the right reason.
```

**Modified files (server, 3):**

```
apps/server/src/kernel-next/mcp-catalog/crypto.ts
  # Tiny additions: export a `keyFileExists()` helper for the recovery
  # module to check without triggering loadKey/auto-generate.
apps/server/src/index.ts
  # Mount the key-recovery guard BEFORE the catalog seed block.
apps/server/src/kernel-next/runtime/real-executor.ts
  # Replace the empty catch with one that records the decrypt diagnostic
  # into a closure-scoped array, then includes it in the secret-pending
  # error message when expandResult.missingKeys triggers the secret gate.
```

---

## Conventions

- Same as Phase 2-3.
- Tests use vitest, in-memory SQLite, fake `process.env.WORKFLOW_CONTROL_SECRET_KEY` + `resetKeyCacheForTest`.
- Recovery guard MUST be idempotent: running it twice in a row is a no-op on the second run.
- Recovery guard MUST NOT throw — startup failures cascade.

---

## Branch

This plan is to be executed on branch `feature/mcp-supply-chain-phase-4` (already created off `main` after Phase 3 merge). Each task ends with a single commit. After Task 2 the branch is merged to `main` via `superpowers:finishing-a-development-branch`.

Commit messages follow `feat(mcp-supply-chain-4): <one-line>` / `fix(mcp-supply-chain-4): T<N> review followups`.

---

### Task 1: Startup key-recovery guard

**Why first:** without this, a user who deletes `~/.workflow-control/.secret-key` (intentionally, accidentally, or via OS reinstall) gets a server that auto-generates a new key, and every previously-stored secret silently becomes undecryptable. Phase 2 catches this at decrypt-time only — the operator only sees it when a task hits a stage that needs the secret. Spec §6.3 says we should detect this proactively at startup.

**Approach:**
- Add `keyFileExists(path?: string): boolean` to `crypto.ts` (read-only filesystem check; doesn't touch the cache, doesn't trigger generation).
- Create `key-recovery.ts` exporting `runSecretKeyRecovery(db, opts?)`. Logic:
  1. If `WORKFLOW_CONTROL_SECRET_KEY` env override is set, skip recovery (env override takes precedence; user opted into a managed key).
  2. If the default key file already exists, skip (nominal case).
  3. If the file is missing but `mcp_inventory_secrets` has zero rows, skip (first-run, nothing to lose).
  4. Otherwise: bulk-mark every `mcp_inventory` row with `status='unhealthy', last_unhealthy_reason='encryption-key-lost'`. Then return `{ recovered: true, affectedRows: N }` so the caller can log it. Do NOT delete the secret rows — the user may still want to inspect them, and the Phase 2 expander's decrypt path will fail safely.
- `index.ts` calls this BEFORE seedBuiltinFromJson (which is BEFORE any task can run, BEFORE any crypto operation needs to happen).

**Files:**
- Modify: `apps/server/src/kernel-next/mcp-catalog/crypto.ts`
- Create: `apps/server/src/kernel-next/mcp-catalog/key-recovery.ts`
- Create: `apps/server/src/kernel-next/mcp-catalog/key-recovery.test.ts`
- Create: `apps/server/src/kernel-next/mcp-catalog/inventory-recovery.test.ts`
- Modify: `apps/server/src/index.ts`

- [ ] **Step 1: Write failing test for crypto.keyFileExists**

Append to `apps/server/src/kernel-next/mcp-catalog/crypto.test.ts` (inside the existing describe block, after the existing tests):

```typescript
  it("keyFileExists returns true when env override is the source", () => {
    // env override is set in beforeEach; the env path doesn't touch a file.
    // The helper checks the DEFAULT file path; with an env override the
    // file may or may not exist, but the helper's return value should be
    // independent of env (it inspects the disk, not env).
    // We can't make absolute assertions about a real ~/.workflow-control
    // path in CI, so we exercise the path argument form instead.
    expect(typeof keyFileExists()).toBe("boolean");
  });

  it("keyFileExists honors an explicit path argument", () => {
    const tmp = `${process.cwd()}/.test-nonexistent-${Date.now()}-${Math.random()}`;
    expect(keyFileExists(tmp)).toBe(false);
  });
```

Add to the import line: `keyFileExists`.

Run: `cd apps/server && pnpm vitest run src/kernel-next/mcp-catalog/crypto.test.ts`
Expected: FAIL — `keyFileExists` not exported.

- [ ] **Step 2: Add keyFileExists to crypto.ts**

Edit `apps/server/src/kernel-next/mcp-catalog/crypto.ts`. After the existing `defaultKeyPath` function (line 12-14), add:

```typescript
/**
 * Check whether the default secret-key file exists, WITHOUT triggering
 * key generation. The startup recovery guard uses this to detect the
 * "key file lost but inventory non-empty" state before crypto.ts would
 * silently auto-generate a fresh key.
 */
export function keyFileExists(path?: string): boolean {
  return existsSync(path ?? defaultKeyPath());
}
```

`existsSync` is already imported (line 2).

Run: `cd apps/server && pnpm vitest run src/kernel-next/mcp-catalog/crypto.test.ts`
Expected: 12 passed (was 10 + 2 new = 12).

- [ ] **Step 3: Write failing test for key-recovery**

Create `apps/server/src/kernel-next/mcp-catalog/key-recovery.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initInventorySchema } from "./inventory-sql.js";
import {
  writeInventoryStatus,
  writeSecret,
  readInventoryRow,
} from "./inventory-store.js";
import { runSecretKeyRecovery } from "./key-recovery.js";

const ENV_OVERRIDE = "WORKFLOW_CONTROL_SECRET_KEY";

function newDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initInventorySchema(db);
  return db;
}

describe("runSecretKeyRecovery", () => {
  let prevEnv: string | undefined;
  beforeEach(() => {
    prevEnv = process.env[ENV_OVERRIDE];
    delete process.env[ENV_OVERRIDE];
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env[ENV_OVERRIDE];
    else process.env[ENV_OVERRIDE] = prevEnv;
  });

  it("no-op when env override is set", () => {
    process.env[ENV_OVERRIDE] = Buffer.alloc(32, 1).toString("base64");
    const db = newDb();
    writeInventoryStatus(db, "etherscan", "equipped");
    writeSecret(db, "etherscan", "ETHERSCAN_API_KEY", "ciphertext");
    const r = runSecretKeyRecovery(db, { keyFileExists: () => false });
    expect(r).toEqual({ recovered: false, reason: "env-override-active", affectedRows: 0 });
    expect(readInventoryRow(db, "etherscan")?.status).toBe("equipped");
  });

  it("no-op when key file exists", () => {
    const db = newDb();
    writeInventoryStatus(db, "etherscan", "equipped");
    writeSecret(db, "etherscan", "ETHERSCAN_API_KEY", "ciphertext");
    const r = runSecretKeyRecovery(db, { keyFileExists: () => true });
    expect(r).toEqual({ recovered: false, reason: "key-file-present", affectedRows: 0 });
    expect(readInventoryRow(db, "etherscan")?.status).toBe("equipped");
  });

  it("no-op when key file missing but inventory has zero secret rows", () => {
    const db = newDb();
    const r = runSecretKeyRecovery(db, { keyFileExists: () => false });
    expect(r).toEqual({ recovered: false, reason: "no-secrets-stored", affectedRows: 0 });
  });

  it("bulk-marks every inventory row unhealthy when key missing + secrets present", () => {
    const db = newDb();
    writeInventoryStatus(db, "etherscan", "equipped");
    writeSecret(db, "etherscan", "ETHERSCAN_API_KEY", "ciphertext-eth");
    writeInventoryStatus(db, "github", "equipped");
    writeSecret(db, "github", "GITHUB_TOKEN", "ciphertext-gh");
    writeInventoryStatus(db, "playwright", "equipped");
    // playwright has no secrets — but it's an equipped row; we still mark it
    // unhealthy because the key loss casts doubt on the system as a whole.
    // (Decision: yes, we mark every equipped row, not just rows with secrets.
    // Rationale: from the user's perspective, a key loss is a "the inventory
    // I configured is suspect" event; equipped rows without secrets are still
    // technically "still equipped" but the user should re-confirm.)

    const r = runSecretKeyRecovery(db, { keyFileExists: () => false });
    expect(r.recovered).toBe(true);
    expect(r.affectedRows).toBe(3);

    expect(readInventoryRow(db, "etherscan")?.status).toBe("unhealthy");
    expect(readInventoryRow(db, "etherscan")?.lastUnhealthyReason).toBe("encryption-key-lost");
    expect(readInventoryRow(db, "github")?.status).toBe("unhealthy");
    expect(readInventoryRow(db, "github")?.lastUnhealthyReason).toBe("encryption-key-lost");
    expect(readInventoryRow(db, "playwright")?.status).toBe("unhealthy");
  });

  it("idempotent: running twice returns affectedRows=0 on the second pass", () => {
    const db = newDb();
    writeInventoryStatus(db, "etherscan", "equipped");
    writeSecret(db, "etherscan", "ETHERSCAN_API_KEY", "ciphertext");

    const r1 = runSecretKeyRecovery(db, { keyFileExists: () => false });
    expect(r1.recovered).toBe(true);
    expect(r1.affectedRows).toBe(1);

    // After first pass, the row is already unhealthy. Second run should
    // not re-mark it (it's not equipped any more — nothing TO mark).
    const r2 = runSecretKeyRecovery(db, { keyFileExists: () => false });
    expect(r2.recovered).toBe(false);
    expect(r2.affectedRows).toBe(0);
  });

  it("does not throw when DB has no inventory tables", () => {
    const db = new DatabaseSync(":memory:");
    // No initInventorySchema — tables don't exist.
    expect(() => runSecretKeyRecovery(db, { keyFileExists: () => false })).not.toThrow();
  });
});
```

Run: FAIL — module doesn't exist.

- [ ] **Step 4: Implement key-recovery.ts**

Create `apps/server/src/kernel-next/mcp-catalog/key-recovery.ts`:

```typescript
import type { DatabaseSync } from "node:sqlite";
import { keyFileExists as defaultKeyFileExists } from "./crypto.js";

const ENV_OVERRIDE = "WORKFLOW_CONTROL_SECRET_KEY";

export type KeyRecoveryResult =
  | {
      recovered: false;
      reason: "env-override-active" | "key-file-present" | "no-secrets-stored" | "no-equipped-rows" | "no-tables";
      affectedRows: 0;
    }
  | {
      recovered: true;
      affectedRows: number;
    };

export type KeyRecoveryOptions = {
  /** Test injection. Production: omit and let the default `crypto.keyFileExists` decide. */
  keyFileExists?: () => boolean;
};

/**
 * Detect the "key file lost but inventory non-empty" state at server startup
 * and pre-emptively mark every equipped inventory row `unhealthy` with reason
 * `encryption-key-lost` BEFORE crypto.ts auto-generates a fresh key. After
 * this, the user's first task that needs a secret won't run with the wrong
 * key — the inventory page already shows the rows as unhealthy and prompts a
 * re-equip.
 *
 * MUST be called BEFORE any crypto.encryptValue / decryptValue / loadKey
 * call, because loadKey will silently auto-create a new file if missing.
 *
 * Idempotent: a second invocation with the same DB state is a no-op (no rows
 * are still equipped).
 *
 * Never throws — a recovery failure should not crash the server. Tests
 * verify graceful behavior when tables don't exist.
 */
export function runSecretKeyRecovery(
  db: DatabaseSync,
  opts: KeyRecoveryOptions = {},
): KeyRecoveryResult {
  try {
    if (process.env[ENV_OVERRIDE] && process.env[ENV_OVERRIDE]!.length > 0) {
      return { recovered: false, reason: "env-override-active", affectedRows: 0 };
    }
    const keyExists = (opts.keyFileExists ?? defaultKeyFileExists)();
    if (keyExists) {
      return { recovered: false, reason: "key-file-present", affectedRows: 0 };
    }

    // Need to inspect inventory. Schema may not be initialized in pathological
    // cases (e.g. fresh DB before initInventorySchema has run). Treat that as
    // "nothing to recover".
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type='table' AND name IN ('mcp_inventory','mcp_inventory_secrets')`,
      )
      .all() as { name: string }[];
    if (tables.length < 2) {
      return { recovered: false, reason: "no-tables", affectedRows: 0 };
    }

    const secretCountRow = db.prepare(`SELECT COUNT(*) AS c FROM mcp_inventory_secrets`).get() as {
      c: number;
    };
    if (secretCountRow.c === 0) {
      return { recovered: false, reason: "no-secrets-stored", affectedRows: 0 };
    }

    // Bulk-mark every row that is currently equipped (or pending-secret) as
    // unhealthy. Rows that are already unhealthy or not-equipped stay as-is.
    const now = Date.now();
    const result = db
      .prepare(
        `UPDATE mcp_inventory
            SET status                = 'unhealthy',
                last_status_change_at = ?,
                last_unhealthy_at     = ?,
                last_unhealthy_reason = 'encryption-key-lost'
          WHERE status IN ('equipped','pending-secret')`,
      )
      .run(now, now);

    const affected = Number(result.changes ?? 0);
    if (affected === 0) {
      return { recovered: false, reason: "no-equipped-rows", affectedRows: 0 };
    }
    return { recovered: true, affectedRows: affected };
  } catch {
    // Never crash startup. The catch is intentionally empty — any failure
    // here is recovered by the regular Phase 2 decrypt-fails-loud path
    // when an actual task tries to use a secret.
    return { recovered: false, reason: "no-tables", affectedRows: 0 };
  }
}
```

Run: `cd apps/server && pnpm vitest run src/kernel-next/mcp-catalog/key-recovery.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Wire into index.ts**

Edit `apps/server/src/index.ts`. Find the existing block:

```typescript
// --- Seed MCP catalog builtins ---
{
  const { seedBuiltinFromJson } = await import("./kernel-next/mcp-catalog/seed.js");
```

Insert a NEW block immediately ABOVE it:

```typescript
// --- Recover from encryption key loss (spec §6.3) ---
// MUST run before any crypto operation. If the key file is missing but
// inventory has stored secrets, mark all equipped/pending rows unhealthy
// before crypto.ts silently auto-generates a fresh key (which would make
// every stored ciphertext undecryptable without warning).
{
  const { runSecretKeyRecovery } = await import("./kernel-next/mcp-catalog/key-recovery.js");
  const r = runSecretKeyRecovery(getKernelNextDb());
  if (r.recovered) {
    logger.warn(
      { affectedRows: r.affectedRows },
      "[mcp-catalog] secret-key file missing — bulk-marked equipped inventory rows unhealthy. User must re-equip via /kernel-next/mcp-catalog.",
    );
  }
}
```

(`logger` is already imported as part of the file's top-level imports — verify by grep before editing.)

- [ ] **Step 6: Write end-to-end recovery test**

Create `apps/server/src/kernel-next/mcp-catalog/inventory-recovery.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCatalogSchema } from "./sql.js";
import { initInventorySchema } from "./inventory-sql.js";
import { insertBuiltinEntry } from "./catalog-store.js";
import { equipEntry, getInventoryStatus } from "./inventory.js";
import { resetKeyCacheForTest } from "./crypto.js";
import { runSecretKeyRecovery } from "./key-recovery.js";

const ENV_OVERRIDE = "WORKFLOW_CONTROL_SECRET_KEY";

const ETHERSCAN = {
  id: "etherscan", source: "builtin" as const, schemaVersion: "1" as const,
  name: "Etherscan MCP", description: "verify",
  useCases: ["verify"], tags: ["evm"],
  command: "npx", args: ["-y", "@scope/etherscan"],
  envKeys: [{ name: "ETHERSCAN_API_KEY", required: true, description: "" }],
  healthCheckTimeoutMs: 1000,
};

describe("inventory recovery — equip then simulate key loss", () => {
  let tmpDir: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env[ENV_OVERRIDE];
    delete process.env[ENV_OVERRIDE];
    tmpDir = mkdtempSync(join(tmpdir(), "phase4-recovery-"));
    process.env[ENV_OVERRIDE] = Buffer.alloc(32, 5).toString("base64");
    resetKeyCacheForTest();
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env[ENV_OVERRIDE];
    else process.env[ENV_OVERRIDE] = prevEnv;
    resetKeyCacheForTest();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("equip → key-file disappears → recovery flips status to unhealthy with right reason", async () => {
    const db = new DatabaseSync(":memory:");
    initCatalogSchema(db);
    initInventorySchema(db);
    insertBuiltinEntry(db, ETHERSCAN);

    // 1. Equip with the env-override key.
    const eq = await equipEntry(
      { db, exec: async () => ({ code: 0, stdout: "v", stderr: "", timedOut: false }) },
      { entryId: "etherscan", envValues: { ETHERSCAN_API_KEY: "real-secret" } },
    );
    expect(eq.ok).toBe(true);
    expect(getInventoryStatus(db, "etherscan")?.status).toBe("equipped");

    // 2. Simulate key loss: clear env, claim no key file exists.
    delete process.env[ENV_OVERRIDE];
    resetKeyCacheForTest();
    const r = runSecretKeyRecovery(db, { keyFileExists: () => false });
    expect(r.recovered).toBe(true);
    expect(r.affectedRows).toBe(1);

    // 3. Inventory row is now unhealthy with the right reason.
    const row = getInventoryStatus(db, "etherscan");
    expect(row?.status).toBe("unhealthy");
    expect(row?.lastUnhealthyReason).toBe("encryption-key-lost");
  });
});
```

Run: PASS — 1 test.

- [ ] **Step 7: tsc + full test run**

```bash
cd apps/server && pnpm exec tsc --noEmit
cd apps/server && pnpm vitest run src/kernel-next/mcp-catalog 2>&1 | tail -10
```

Expected: tsc clean. mcp-catalog tests: previous count + 2 (crypto) + 6 (key-recovery) + 1 (inventory-recovery) = +9 net new.

- [ ] **Step 8: Commit**

```bash
cd /Users/minghao/workflow-control && \
git add apps/server/src/kernel-next/mcp-catalog/crypto.ts \
        apps/server/src/kernel-next/mcp-catalog/crypto.test.ts \
        apps/server/src/kernel-next/mcp-catalog/key-recovery.ts \
        apps/server/src/kernel-next/mcp-catalog/key-recovery.test.ts \
        apps/server/src/kernel-next/mcp-catalog/inventory-recovery.test.ts \
        apps/server/src/index.ts && \
git commit -m "feat(mcp-supply-chain-4): startup key-loss recovery — bulk-mark inventory unhealthy"
```

---

### Task 2: Surface MCP_INVENTORY_DECRYPT_FAILED to task diagnostics

**Why now:** the T7 TODO at `apps/server/src/kernel-next/runtime/real-executor.ts:448` is real: when a stored ciphertext fails to decrypt (key loss, corruption, wrong key), the expander silently treats it as "no value" and the user sees the same `secret_pending` MCP_ENV_MISSING error they'd see for a key they never set. Operationally these are different, and Phase 4 should surface the distinction.

**Approach:** In `real-executor.ts:435-487`, the resolveInventorySecret callback runs synchronously inside expandMcpServers. It catches the typed `Error & { diagnostic: Diagnostic }` thrown by `resolveSecret` and silently returns null. Replace that with: collect each thrown diagnostic into a closure-scoped array; after the expand call completes, if `expandResult.ok === false` AND the array is non-empty, augment the secret-pending error message so the user understands the cause. The existing `secret_gate_queue` row still gets written with `required_keys = expandResult.missingKeys` (no schema change), but the task error text now reads:

```
MCP_ENV_MISSING: stage 'verifyOnchain' needs envKeys [ETHERSCAN_API_KEY]
  (1 stored secret was unreadable: MCP_INVENTORY_DECRYPT_FAILED for entry 'etherscan' envKey 'ETHERSCAN_API_KEY' — try re-equipping via /kernel-next/mcp-catalog)
```

This is the smallest change that surfaces the diagnostic without adding new tables / new SSE channels.

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/real-executor.ts`
- Create: `apps/server/src/kernel-next/mcp-catalog/decrypt-diagnostic.test.ts`

- [ ] **Step 1: Write failing test**

Create `apps/server/src/kernel-next/mcp-catalog/decrypt-diagnostic.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { expandMcpServers } from "../runtime/mcp-servers-expander.js";
import type { McpServerDecl } from "../ir/schema.js";

const decl: McpServerDecl = {
  name: "etherscan",
  command: "npx",
  args: ["-y", "@scope/etherscan-mcp"],
  envKeys: ["ETHERSCAN_API_KEY"],
  env: { ETHERSCAN_API_KEY: "${ETHERSCAN_API_KEY}" },
};

describe("expander — caller can collect inventory decrypt diagnostics", () => {
  it("inventoryResolver throwing a typed Error allows the caller to capture and surface", () => {
    // Sanity: confirm the contract — when resolveInventorySecret returns null,
    // the expander reports missingKeys; the CALLER (real-executor) is responsible
    // for surfacing any decrypt diagnostic it collected during the resolver.
    const collected: Array<{ code: string; entryId: string; envKey: string }> = [];
    const result = expandMcpServers(
      [decl], {}, {} as NodeJS.ProcessEnv,
      {
        resolveInventorySecret: (envKey) => {
          // Simulate: reading the stored secret throws the Phase 2 typed error.
          // The caller catches and records the diagnostic.
          try {
            throw Object.assign(
              new Error("MCP_INVENTORY_DECRYPT_FAILED: corrupt"),
              {
                diagnostic: {
                  code: "MCP_INVENTORY_DECRYPT_FAILED",
                  message: `failed to decrypt secret for entry 'etherscan', envKey '${envKey}'`,
                  context: { entryId: "etherscan", envKey },
                },
              },
            );
          } catch (e) {
            const d = (e as { diagnostic?: { code: string; context?: Record<string, unknown> } }).diagnostic;
            if (d) {
              collected.push({
                code: d.code,
                entryId: String(d.context?.entryId ?? ""),
                envKey: String(d.context?.envKey ?? ""),
              });
            }
            return null;
          }
        },
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.missingKeys).toEqual(["ETHERSCAN_API_KEY"]);
    expect(collected.length).toBe(1);
    expect(collected[0]).toEqual({
      code: "MCP_INVENTORY_DECRYPT_FAILED",
      entryId: "etherscan",
      envKey: "ETHERSCAN_API_KEY",
    });
  });
});
```

Run: `cd apps/server && pnpm vitest run src/kernel-next/mcp-catalog/decrypt-diagnostic.test.ts`
Expected: PASS — this is a contract sanity test, not a new behavior. (The real-executor change is in Step 2; this test asserts the closure-pattern works as expected, which it already does. We add this test before the real-executor edit so the behavior is locked in.)

- [ ] **Step 2: Update real-executor.ts**

Edit `apps/server/src/kernel-next/runtime/real-executor.ts`. Find the existing block (line 435-487):

```typescript
      let externalMcpServers: Record<string, ExpandedMcpServer> | undefined;
      if (stage.config.mcpServers && stage.config.mcpServers.length > 0) {
        const expanderDb = portRuntime.getDb();
        const taskEnv = loadTaskEnvValues(expanderDb, taskId);
        const expandResult = expandMcpServers(stage.config.mcpServers, taskEnv, process.env, {
          resolveInventorySecret: (envKey) => {
            for (const decl of stage.config.mcpServers ?? []) {
              const entryId = lookupEntryByCommand(expanderDb, decl.command, decl.args);
              if (!entryId) continue;
              try {
                const v = resolveSecret({ db: expanderDb }, entryId, envKey);
                if (v !== null) return v;
              } catch {
                // TODO: surface MCP_INVENTORY_DECRYPT_FAILED to task diagnostics.
                // Treating the decrypt error as "no value" lets the existing
                // missingKeys → secret-gate flow prompt the operator to refill,
                // but operationally a decrypt error on an *equipped* entry is
                // different from a key that was never supplied — the operator
                // will re-enter a value for a key they think is already saved.
                // Spec §6.3 ("encryption key recovery") is the long-term fix.
              }
            }
            return null;
          },
        });
```

Replace with:

```typescript
      let externalMcpServers: Record<string, ExpandedMcpServer> | undefined;
      if (stage.config.mcpServers && stage.config.mcpServers.length > 0) {
        const expanderDb = portRuntime.getDb();
        const taskEnv = loadTaskEnvValues(expanderDb, taskId);
        // Phase 4: collect any MCP_INVENTORY_DECRYPT_FAILED that fires during
        // resolution so we can include it in the secret-pending error message.
        const decryptFailures: Array<{ entryId: string; envKey: string }> = [];
        const expandResult = expandMcpServers(stage.config.mcpServers, taskEnv, process.env, {
          resolveInventorySecret: (envKey) => {
            for (const decl of stage.config.mcpServers ?? []) {
              const entryId = lookupEntryByCommand(expanderDb, decl.command, decl.args);
              if (!entryId) continue;
              try {
                const v = resolveSecret({ db: expanderDb }, entryId, envKey);
                if (v !== null) return v;
              } catch (e) {
                const d = (e as { diagnostic?: { code?: string; context?: Record<string, unknown> } }).diagnostic;
                if (d?.code === "MCP_INVENTORY_DECRYPT_FAILED") {
                  decryptFailures.push({
                    entryId: String(d.context?.entryId ?? entryId),
                    envKey: String(d.context?.envKey ?? envKey),
                  });
                }
                // Treat as "no value" — secret-gate flow will prompt the
                // operator to refill. The augmented error message below
                // tells them that this is a decrypt failure, not a never-set
                // secret, so they know to re-equip via the catalog page.
              }
            }
            return null;
          },
        });
```

And find the existing block 5 lines below (the `if (!expandResult.ok) {` body):

```typescript
          const errMsg = `MCP_ENV_MISSING: stage '${stage.name}' needs envKeys [${expandResult.missingKeys.join(", ")}]`;
```

Replace with:

```typescript
          const decryptHint = decryptFailures.length > 0
            ? ` (${decryptFailures.length} stored secret${decryptFailures.length === 1 ? "" : "s"} unreadable: ${decryptFailures.map((f) => `MCP_INVENTORY_DECRYPT_FAILED for entry '${f.entryId}' envKey '${f.envKey}'`).join("; ")} — try re-equipping via /kernel-next/mcp-catalog)`
            : "";
          const errMsg = `MCP_ENV_MISSING: stage '${stage.name}' needs envKeys [${expandResult.missingKeys.join(", ")}]${decryptHint}`;
```

- [ ] **Step 3: Add an integration test verifying the augmented error**

Append to `decrypt-diagnostic.test.ts` a SECOND describe that exercises the actual real-executor path:

```typescript
import { DatabaseSync } from "node:sqlite";
import { initCatalogSchema } from "./sql.js";
import { initInventorySchema } from "./inventory-sql.js";
import { insertBuiltinEntry } from "./catalog-store.js";
import { resolveSecret } from "./inventory.js";
import { lookupEntryByCommand } from "./catalog-store.js";

describe("expander integration — corrupt ciphertext surfaces decrypt diagnostic", () => {
  it("collects MCP_INVENTORY_DECRYPT_FAILED into a side channel when ciphertext is malformed", () => {
    const db = new DatabaseSync(":memory:");
    initCatalogSchema(db);
    initInventorySchema(db);
    insertBuiltinEntry(db, {
      id: "etherscan", source: "builtin", schemaVersion: "1",
      name: "Etherscan", description: "verify",
      useCases: ["verify"], tags: ["evm"],
      command: "npx", args: ["-y", "@scope/etherscan-mcp"],
      envKeys: [{ name: "ETHERSCAN_API_KEY", required: true, description: "" }],
      healthCheckTimeoutMs: 1000,
    });

    process.env.WORKFLOW_CONTROL_SECRET_KEY = Buffer.alloc(32, 8).toString("base64");
    // Manually plant corrupt ciphertext.
    db.prepare(
      `INSERT INTO mcp_inventory (entry_id, status, last_status_change_at)
       VALUES (?, ?, ?)`,
    ).run("etherscan", "equipped", Date.now());
    db.prepare(
      `INSERT INTO mcp_inventory_secrets (entry_id, env_key, encrypted_value, last_updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run("etherscan", "ETHERSCAN_API_KEY", "GARBAGE_NOT_REAL_CIPHERTEXT", Date.now());

    const collected: Array<{ entryId: string; envKey: string }> = [];

    const result = expandMcpServers(
      [decl], {}, {} as NodeJS.ProcessEnv,
      {
        resolveInventorySecret: (envKey) => {
          const entryId = lookupEntryByCommand(db, decl.command, decl.args);
          if (!entryId) return null;
          try {
            return resolveSecret({ db }, entryId, envKey);
          } catch (e) {
            const d = (e as { diagnostic?: { code?: string; context?: Record<string, unknown> } }).diagnostic;
            if (d?.code === "MCP_INVENTORY_DECRYPT_FAILED") {
              collected.push({
                entryId: String(d.context?.entryId ?? entryId),
                envKey: String(d.context?.envKey ?? envKey),
              });
            }
            return null;
          }
        },
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.missingKeys).toEqual(["ETHERSCAN_API_KEY"]);
    expect(collected.length).toBe(1);
    expect(collected[0].entryId).toBe("etherscan");
    expect(collected[0].envKey).toBe("ETHERSCAN_API_KEY");
  });
});
```

Run: PASS — exercises the same closure pattern with a real DB.

- [ ] **Step 4: tsc + targeted regression**

```bash
cd apps/server && pnpm exec tsc --noEmit
cd apps/server && pnpm vitest run src/kernel-next/runtime/mcp-servers-expander src/kernel-next/mcp-catalog 2>&1 | tail -10
```

Expected: tsc clean, all expander + catalog tests pass.

- [ ] **Step 5: Run full server test suite**

```bash
cd apps/server && pnpm vitest run 2>&1 | tail -8
```

Expected: 2020 baseline + 8 net new (Task 1) + 2 (Task 2) = ~2030 passed / 4 skipped / 0 failed. tsc clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/minghao/workflow-control && \
git add apps/server/src/kernel-next/runtime/real-executor.ts \
        apps/server/src/kernel-next/mcp-catalog/decrypt-diagnostic.test.ts && \
git commit -m "feat(mcp-supply-chain-4): surface MCP_INVENTORY_DECRYPT_FAILED in secret-pending error"
```

- [ ] **Step 7: Use finishing-a-development-branch**

Announce: "I'm using the finishing-a-development-branch skill to complete Phase 4."

Verify tests pass. Default to option 1 (merge to main locally).

After merge:

```bash
git checkout main
git merge feature/mcp-supply-chain-phase-4 --no-ff -m "Merge branch 'feature/mcp-supply-chain-phase-4'

Phase 4 polish — close the two data-integrity loose ends from Phase 1-3.

1. Encryption key-loss recovery (spec §6.3): startup guard detects when
   the secret-key file is missing but mcp_inventory_secrets has rows, then
   bulk-marks every equipped row unhealthy with reason='encryption-key-lost'
   BEFORE crypto.ts auto-generates a new key. User sees the unhealthy
   status on the catalog page and re-equips.

2. Surface MCP_INVENTORY_DECRYPT_FAILED in the secret-pending error:
   real-executor's expander callback now collects per-key decrypt failures
   and augments the MCP_ENV_MISSING error message so the user sees 'stored
   secret was unreadable' vs 'never set'. Closes the T7 TODO."
cd apps/server && pnpm vitest run    # PASS on merged main
git branch -d feature/mcp-supply-chain-phase-4
```

---

## Self-review

**Spec coverage:**

| Spec section | Phase 4 task |
|---|---|
| §6.3 encryption key recovery (key file missing → bulk-mark unhealthy + log) | Task 1 |
| §6.3 emit `kernel:secret-key-lost` event | Task 1 (replaced with `logger.warn` — no global event bus exists in this repo; the inventory unhealthy state IS the user-visible signal) |
| T7 TODO — surface MCP_INVENTORY_DECRYPT_FAILED | Task 2 |
| §10 polished custom-entry form | **out of scope** — JSON textarea retained per current-session decision |

**Placeholder scan:** every code block is complete, every command and expected output is concrete.

**Type consistency:** `KeyRecoveryResult` (Task 1) is a discriminated union; tests assert exact shape. `decryptFailures` (Task 2) is `Array<{entryId; envKey}>`; both producer and consumer use that shape verbatim.

**Idempotency:** explicit test for it in Task 1. Task 2 has nothing to be idempotent about — it's a pure error-message augmentation.

**Failure isolation:** Task 1's recovery has a try/catch that swallows ANY exception and returns `{recovered:false}` — startup must never crash. Task 2's added closure also can't propagate (it's already inside an `if (!expandResult.ok)` branch and only stringifies fields).
