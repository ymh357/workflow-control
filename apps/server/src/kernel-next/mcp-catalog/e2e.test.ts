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
      expect(r.inserted).toBeGreaterThanOrEqual(10);
    }
  });

  it("lists all 12 builtin entries", () => {
    const entries = listEntries(db);
    expect(entries.length).toBeGreaterThanOrEqual(12);
    const ids = entries.map((e) => e.id).sort();
    expect(ids).toContain("etherscan");
    expect(ids).toContain("github");
    expect(ids).toContain("playwright");
  });

  it("recommends etherscan for an EN onchain topic", () => {
    const r = recommendForTopicLocal(db, "verify tx hash on Ethereum");
    expect(r[0].id).toBe("etherscan");
  });

  it("recommends etherscan for a CN onchain topic", () => {
    const r = recommendForTopicLocal(db, "我要验证以太坊上的合约源码");
    expect(r.map((x) => x.id)).toContain("etherscan");
  });

  it("recommends github for a code-research topic", () => {
    const r = recommendForTopicLocal(db, "read source code from a github repo");
    expect(r[0].id).toBe("github");
  });

  it("lookupEntryByCommand reverse-resolves a recommended entry", () => {
    const entry = listEntries(db).find((e) => e.id === "etherscan")!;
    const id = lookupEntryByCommand(db, entry.command, entry.args);
    expect(id).toBe("etherscan");
  });
});
