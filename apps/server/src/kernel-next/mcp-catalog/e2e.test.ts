import { describe, it, expect, beforeAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initCatalogSchema } from "./sql.js";
import { seedBuiltinFromJson } from "./seed.js";
import { listEntries, lookupEntryByCommand } from "./catalog-store.js";
import { recommendForTopicLocal } from "./recommender.js";
import { join } from "node:path";

describe("mcp-catalog E2E", () => {
  let db: DatabaseSync;

  beforeAll(() => {
    db = new DatabaseSync(":memory:");
    initCatalogSchema(db);
    const path = join(import.meta.dirname, "entries.json");
    const r = seedBuiltinFromJson(db, path);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.inserted).toBeGreaterThanOrEqual(5);
    }
  });

  it("lists builtin entries", () => {
    const entries = listEntries(db);
    expect(entries.length).toBeGreaterThanOrEqual(5);
    const ids = entries.map((e) => e.id).sort();
    expect(ids).toContain("github");
    expect(ids).toContain("playwright");
    expect(ids).toContain("postgres");
  });

  it("recommends github for a code-research topic", () => {
    const r = recommendForTopicLocal(db, "read source code from a github repo");
    expect(r[0].id).toBe("github");
  });

  it("recommends playwright for a browser-automation topic", () => {
    const r = recommendForTopicLocal(db, "automate browser interaction with a web page");
    expect(r.map((x) => x.id)).toContain("playwright");
  });

  it("lookupEntryByCommand reverse-resolves a recommended entry", () => {
    const entry = listEntries(db).find((e) => e.id === "github")!;
    const id = lookupEntryByCommand(db, entry.command, entry.args);
    expect(id).toBe("github");
  });
});
