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

export function resolveSecret(
  deps: { db: DatabaseSync; decrypt?: (s: string) => string },
  entryId: string,
  envKey: string,
): string | null {
  const row = readSecretRow(deps.db, entryId, envKey);
  if (!row) return null;
  const decrypt = deps.decrypt ?? decryptValue;
  return decrypt(row.encryptedValue);
}
