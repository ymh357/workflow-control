import type { DatabaseSync } from "node:sqlite";
import { getEntry } from "./catalog-store.js";
import {
  readInventoryRow,
  readAllInventoryRows,
  writeInventoryStatus,
  writeSecret,
  readSecretRow,
  listSecretReadouts as storeListSecretReadouts,
  unequipTransaction,
} from "./inventory-store.js";
import {
  checkEnvKeys,
  checkPackage,
  resolvePackageName,
  type ExecFn,
} from "./healthcheck.js";
import { encryptValue, decryptValue } from "./crypto.js";
import type {
  InventoryRow,
  InventorySecretReadout,
  InventoryStatus,
} from "./inventory-types.js";
import type { Diagnostic } from "../ir/schema.js";

export type InventoryDeps = {
  db: DatabaseSync;
  encrypt?: (s: string) => string;
  decrypt?: (s: string) => string;
  exec?: ExecFn;
  processEnv?: NodeJS.ProcessEnv;
};

export function listInventory(db: DatabaseSync): InventoryRow[] {
  return readAllInventoryRows(db);
}

export function getInventoryStatus(db: DatabaseSync, entryId: string): InventoryRow | null {
  return readInventoryRow(db, entryId);
}

export function hasSecret(db: DatabaseSync, entryId: string, envKey: string): boolean {
  return readSecretRow(db, entryId, envKey) !== null;
}

export function listSecretReadoutsPublic(db: DatabaseSync, entryId: string): InventorySecretReadout[] {
  return storeListSecretReadouts(db, entryId);
}

function entryMissing(entryId: string): { ok: false; diagnostics: Diagnostic[] } {
  return {
    ok: false,
    diagnostics: [{
      code: "CATALOG_ENTRY_NOT_FOUND",
      message: `entry '${entryId}' not found`,
      context: { entryId },
    }],
  };
}

export async function equipEntry(
  deps: InventoryDeps,
  args: { entryId: string; envValues: Record<string, string>; healthCheckTimeoutMs?: number },
): Promise<
  | { ok: true; status: "equipped" | "pending-secret" }
  | { ok: false; diagnostics: Diagnostic[] }
> {
  const entry = getEntry(deps.db, args.entryId);
  if (!entry) return entryMissing(args.entryId);

  const encrypt = deps.encrypt ?? encryptValue;
  const exec = deps.exec;
  const processEnv = deps.processEnv ?? process.env;

  // Bug 46 (c12+ review): pre-fix this loop wrote any envValue key
  // unconditionally — including keys NOT in entry.envKeys[]. Result:
  // (1) the inventory accumulated ghost rows for keys the catalog
  // entry never declared, (2) typos like CLAUDE_KEY vs CLAUDE_API_KEY
  // silently leaked into the inventory under both names, doubling
  // storage and confusing audit, (3) malicious or buggy callers
  // could persist arbitrary key names.
  // Reject keys that aren't in the entry's declared envKeys; the
  // declared list is the contract the catalog entry author publishes.
  const declaredKeys = new Set(entry.envKeys.map((k) => k.name));
  const undeclared = Object.keys(args.envValues).filter((k) => !declaredKeys.has(k));
  if (undeclared.length > 0) {
    return {
      ok: false,
      diagnostics: [{
        code: "CATALOG_INVALID_ENTRY",
        message:
          `entry '${args.entryId}' does not declare envKeys [${undeclared.join(", ")}]; ` +
          `declared keys are [${[...declaredKeys].join(", ")}]`,
        context: { entryId: args.entryId, undeclared, declared: [...declaredKeys] },
      }],
    };
  }
  for (const [k, v] of Object.entries(args.envValues)) {
    if (v.length === 0) continue;
    writeSecret(deps.db, args.entryId, k, encrypt(v));
  }

  const inventoryHave = new Set(
    storeListSecretReadouts(deps.db, args.entryId).filter((r) => r.hasValue).map((r) => r.envKey),
  );
  const envHave = new Set(
    Object.entries(processEnv).filter(([, v]) => typeof v === "string" && v.length > 0).map(([k]) => k),
  );
  const haveValues = new Set([...inventoryHave, ...envHave]);

  const envCheck = checkEnvKeys({ envKeys: entry.envKeys, haveValues });
  if (!envCheck.ok) {
    writeInventoryStatus(deps.db, args.entryId, "pending-secret");
    return { ok: true, status: "pending-secret" };
  }

  const pkg = resolvePackageName({ packageName: entry.packageName, args: entry.args });
  if (!pkg) {
    writeInventoryStatus(deps.db, args.entryId, "unhealthy", {
      unhealthyReason: "MCP_PROVISION_PACKAGE_NOT_FOUND: cannot resolve package name from entry.args",
    });
    return {
      ok: false,
      diagnostics: [{
        code: "MCP_PROVISION_PACKAGE_NOT_FOUND",
        message: `cannot resolve package name for entry '${args.entryId}'`,
        context: { entryId: args.entryId, args: entry.args },
      }],
    };
  }

  const pkgCheck = await checkPackage({
    packageName: pkg,
    timeoutMs: args.healthCheckTimeoutMs ?? entry.healthCheckTimeoutMs,
    exec,
  });
  if (!pkgCheck.ok) {
    const diag = pkgCheck.diagnostics[0];
    writeInventoryStatus(deps.db, args.entryId, "unhealthy", {
      unhealthyReason: `${diag.code}: ${diag.message.slice(0, 200)}`,
    });
    return pkgCheck;
  }

  writeInventoryStatus(deps.db, args.entryId, "equipped");
  return { ok: true, status: "equipped" };
}

export function unequipEntry(
  db: DatabaseSync, entryId: string,
): { ok: true } | { ok: false; diagnostics: Diagnostic[] } {
  unequipTransaction(db, entryId);
  return { ok: true };
}

export async function recheckEntry(
  deps: InventoryDeps, entryId: string,
): Promise<
  | { ok: true; status: InventoryStatus }
  | { ok: false; diagnostics: Diagnostic[] }
> {
  const entry = getEntry(deps.db, entryId);
  if (!entry) return entryMissing(entryId);

  const processEnv = deps.processEnv ?? process.env;
  const inventoryHave = new Set(
    storeListSecretReadouts(deps.db, entryId).filter((r) => r.hasValue).map((r) => r.envKey),
  );
  const envHave = new Set(
    Object.entries(processEnv).filter(([, v]) => typeof v === "string" && v.length > 0).map(([k]) => k),
  );
  const haveValues = new Set([...inventoryHave, ...envHave]);

  const envCheck = checkEnvKeys({ envKeys: entry.envKeys, haveValues });
  if (!envCheck.ok) {
    writeInventoryStatus(deps.db, entryId, "unhealthy", {
      unhealthyReason: "MCP_PROVISION_ENVKEY_MISSING",
    });
    return envCheck;
  }

  const pkg = resolvePackageName({ packageName: entry.packageName, args: entry.args });
  if (!pkg) {
    writeInventoryStatus(deps.db, entryId, "unhealthy", {
      unhealthyReason: "MCP_PROVISION_PACKAGE_NOT_FOUND: cannot resolve package name",
    });
    return {
      ok: false,
      diagnostics: [{
        code: "MCP_PROVISION_PACKAGE_NOT_FOUND",
        message: `cannot resolve package name for entry '${entryId}'`,
        context: { entryId, args: entry.args },
      }],
    };
  }

  const pkgCheck = await checkPackage({
    packageName: pkg,
    timeoutMs: entry.healthCheckTimeoutMs,
    exec: deps.exec,
  });
  if (!pkgCheck.ok) {
    const diag = pkgCheck.diagnostics[0];
    writeInventoryStatus(deps.db, entryId, "unhealthy", {
      unhealthyReason: `${diag.code}: ${diag.message.slice(0, 200)}`,
    });
    return pkgCheck;
  }

  writeInventoryStatus(deps.db, entryId, "equipped");
  return { ok: true, status: "equipped" };
}

/**
 * Throws a `Error & { diagnostic: Diagnostic }` with code `MCP_INVENTORY_DECRYPT_FAILED`
 * when the underlying decrypt call fails (corrupt ciphertext, wrong key, etc.).
 * Returns null when no row exists. Returns plaintext on success.
 *
 * Callers (mcp-servers-expander, REST routes) must catch this and surface
 * the diagnostic; the kernel currently has no graceful path to "key lost"
 * recovery (see spec §6.3 — deferred).
 */
export function resolveSecret(
  deps: { db: DatabaseSync; decrypt?: (s: string) => string },
  entryId: string,
  envKey: string,
): string | null {
  const row = readSecretRow(deps.db, entryId, envKey);
  if (!row) return null;
  const decrypt = deps.decrypt ?? decryptValue;
  try {
    return decrypt(row.encryptedValue);
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    const err = new Error(
      `MCP_INVENTORY_DECRYPT_FAILED: failed to decrypt secret '${envKey}' for entry '${entryId}': ${cause}`,
    ) as Error & { diagnostic: Diagnostic };
    err.diagnostic = {
      code: "MCP_INVENTORY_DECRYPT_FAILED",
      message: `failed to decrypt secret for entry '${entryId}', envKey '${envKey}'`,
      context: { entryId, envKey },
    };
    throw err;
  }
}
