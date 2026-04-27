import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initInventorySchema } from "./inventory-sql.js";
import {
  readInventoryRow,
  readAllInventoryRows,
  writeInventoryStatus,
  deleteInventoryRow,
  writeSecret,
  readSecretRow,
  listSecretReadouts,
  deleteAllSecrets,
  unequipTransaction,
} from "./inventory-store.js";

function newDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initInventorySchema(db);
  return db;
}

describe("inventory-store", () => {
  let db: DatabaseSync;
  beforeEach(() => { db = newDb(); });

  it("readInventoryRow returns null for missing row", () => {
    expect(readInventoryRow(db, "etherscan")).toBeNull();
  });

  it("writeInventoryStatus inserts then updates", () => {
    writeInventoryStatus(db, "etherscan", "pending-secret");
    let row = readInventoryRow(db, "etherscan");
    expect(row?.status).toBe("pending-secret");
    expect(row?.lastUnhealthyAt).toBeUndefined();

    writeInventoryStatus(db, "etherscan", "equipped");
    row = readInventoryRow(db, "etherscan");
    expect(row?.status).toBe("equipped");
  });

  it("writeInventoryStatus stores unhealthy reason and timestamp", () => {
    writeInventoryStatus(db, "etherscan", "unhealthy", { unhealthyReason: "package-not-found" });
    const row = readInventoryRow(db, "etherscan");
    expect(row?.status).toBe("unhealthy");
    expect(row?.lastUnhealthyReason).toBe("package-not-found");
    expect(typeof row?.lastUnhealthyAt).toBe("number");
  });

  it("readAllInventoryRows returns all rows sorted by entryId", () => {
    writeInventoryStatus(db, "github", "equipped");
    writeInventoryStatus(db, "etherscan", "not-equipped");
    const rows = readAllInventoryRows(db);
    expect(rows.map((r) => r.entryId)).toEqual(["etherscan", "github"]);
  });

  it("deleteInventoryRow removes the row", () => {
    writeInventoryStatus(db, "etherscan", "equipped");
    deleteInventoryRow(db, "etherscan");
    expect(readInventoryRow(db, "etherscan")).toBeNull();
  });

  it("writeSecret + readSecretRow round trip", () => {
    writeSecret(db, "etherscan", "ETHERSCAN_API_KEY", "ciphertext-1");
    const row = readSecretRow(db, "etherscan", "ETHERSCAN_API_KEY");
    expect(row?.encryptedValue).toBe("ciphertext-1");
    expect(typeof row?.lastUpdatedAt).toBe("number");
  });

  it("writeSecret upserts on conflict", () => {
    writeSecret(db, "etherscan", "K", "old");
    writeSecret(db, "etherscan", "K", "new");
    expect(readSecretRow(db, "etherscan", "K")?.encryptedValue).toBe("new");
  });

  it("listSecretReadouts returns no plaintext", () => {
    writeSecret(db, "etherscan", "A", "ct-a");
    writeSecret(db, "etherscan", "B", "ct-b");
    const readouts = listSecretReadouts(db, "etherscan");
    expect(readouts.map((r) => r.envKey).sort()).toEqual(["A", "B"]);
    for (const r of readouts) {
      expect(r.hasValue).toBe(true);
      expect(typeof r.lastUpdatedAt).toBe("number");
      expect(JSON.stringify(r)).not.toContain("ct-");
    }
  });

  it("deleteAllSecrets clears one entry's rows only", () => {
    writeSecret(db, "etherscan", "A", "ct1");
    writeSecret(db, "github", "B", "ct2");
    deleteAllSecrets(db, "etherscan");
    expect(listSecretReadouts(db, "etherscan")).toEqual([]);
    expect(listSecretReadouts(db, "github").length).toBe(1);
  });

  it("unequipTransaction deletes inventory + secrets atomically", () => {
    writeInventoryStatus(db, "etherscan", "equipped");
    writeSecret(db, "etherscan", "A", "ct-a");
    writeSecret(db, "etherscan", "B", "ct-b");
    unequipTransaction(db, "etherscan");
    expect(readInventoryRow(db, "etherscan")).toBeNull();
    expect(listSecretReadouts(db, "etherscan")).toEqual([]);
  });
});
