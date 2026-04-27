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
