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
    writeInventoryStatus(db, "linear", "pending-secret");
    // pending-secret rows must also be flipped to unhealthy on key loss —
    // they had a partial config; after key loss, that partial config is
    // unverifiable just like equipped rows.

    const r = runSecretKeyRecovery(db, { keyFileExists: () => false });
    expect(r.recovered).toBe(true);
    expect(r.affectedRows).toBe(4);

    expect(readInventoryRow(db, "etherscan")?.status).toBe("unhealthy");
    expect(readInventoryRow(db, "etherscan")?.lastUnhealthyReason).toBe("encryption-key-lost");
    expect(readInventoryRow(db, "github")?.status).toBe("unhealthy");
    expect(readInventoryRow(db, "github")?.lastUnhealthyReason).toBe("encryption-key-lost");
    expect(readInventoryRow(db, "playwright")?.status).toBe("unhealthy");
    expect(readInventoryRow(db, "linear")?.status).toBe("unhealthy");
    expect(readInventoryRow(db, "linear")?.lastUnhealthyReason).toBe("encryption-key-lost");
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
