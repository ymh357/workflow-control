import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initInventorySchema } from "./inventory-sql.js";

describe("inventory-sql", () => {
  it("creates mcp_inventory + mcp_inventory_secrets tables", () => {
    const db = new DatabaseSync(":memory:");
    initInventorySchema(db);
    const tables = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
    ).all() as { name: string }[]).map((r) => r.name);
    expect(tables).toContain("mcp_inventory");
    expect(tables).toContain("mcp_inventory_secrets");
  });

  it("creates idx_mis_entry index", () => {
    const db = new DatabaseSync(":memory:");
    initInventorySchema(db);
    const indexes = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_mis_entry'`,
    ).all() as { name: string }[]);
    expect(indexes.length).toBe(1);
  });

  it("idempotent — running twice does not throw", () => {
    const db = new DatabaseSync(":memory:");
    initInventorySchema(db);
    expect(() => initInventorySchema(db)).not.toThrow();
  });

  it("status check constraint rejects invalid values", () => {
    const db = new DatabaseSync(":memory:");
    initInventorySchema(db);
    expect(() =>
      db.prepare(
        "INSERT INTO mcp_inventory (entry_id, status, last_status_change_at) VALUES (?, ?, ?)",
      ).run("etherscan", "verifying", 1700000000000),
    ).toThrow();
  });

  it("primary keys enforce uniqueness", () => {
    const db = new DatabaseSync(":memory:");
    initInventorySchema(db);
    db.prepare(
      "INSERT INTO mcp_inventory (entry_id, status, last_status_change_at) VALUES (?, ?, ?)",
    ).run("etherscan", "equipped", 1700000000000);
    expect(() =>
      db.prepare(
        "INSERT INTO mcp_inventory (entry_id, status, last_status_change_at) VALUES (?, ?, ?)",
      ).run("etherscan", "not-equipped", 1700000000001),
    ).toThrow();

    db.prepare(
      "INSERT INTO mcp_inventory_secrets (entry_id, env_key, encrypted_value, last_updated_at) VALUES (?, ?, ?, ?)",
    ).run("etherscan", "K", "ct1", 1700000000000);
    expect(() =>
      db.prepare(
        "INSERT INTO mcp_inventory_secrets (entry_id, env_key, encrypted_value, last_updated_at) VALUES (?, ?, ?, ?)",
      ).run("etherscan", "K", "ct2", 1700000000001),
    ).toThrow();
  });
});
