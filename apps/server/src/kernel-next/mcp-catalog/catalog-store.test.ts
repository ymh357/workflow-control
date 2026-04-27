import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initCatalogSchema } from "./sql.js";
import {
  listEntries,
  getEntry,
  upsertCustomEntry,
  deleteCustomEntry,
  lookupEntryByCommand,
  insertBuiltinEntry,
  markBuiltinDeprecated,
} from "./catalog-store.js";
import type { CatalogEntry } from "./schema.js";

function makeEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "etherscan",
    source: "builtin",
    schemaVersion: "1",
    name: "Etherscan",
    description: "Read Ethereum onchain data",
    useCases: ["verify tx hash"],
    tags: ["onchain-verification"],
    command: "npx",
    args: ["-y", "@scope/etherscan-mcp"],
    envKeys: [],
    healthCheckTimeoutMs: 10000,
    ...overrides,
  };
}

describe("catalog-store", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initCatalogSchema(db);
  });

  describe("listEntries / getEntry", () => {
    it("returns empty list initially", () => {
      expect(listEntries(db)).toEqual([]);
    });

    it("listEntries skips deprecated by default", () => {
      insertBuiltinEntry(db, makeEntry({ id: "a" }));
      insertBuiltinEntry(db, makeEntry({ id: "b" }));
      markBuiltinDeprecated(db, "b", 12345);

      const list = listEntries(db);
      expect(list.map((e) => e.id)).toEqual(["a"]);
    });

    it("listEntries with includeDeprecated=true returns all", () => {
      insertBuiltinEntry(db, makeEntry({ id: "a" }));
      insertBuiltinEntry(db, makeEntry({ id: "b" }));
      markBuiltinDeprecated(db, "b", 12345);

      const list = listEntries(db, { includeDeprecated: true });
      expect(list.map((e) => e.id).sort()).toEqual(["a", "b"]);
    });

    it("listEntries filters by source", () => {
      insertBuiltinEntry(db, makeEntry({ id: "a" }));
      upsertCustomEntry(db, makeEntry({ id: "b", source: "custom" }));

      expect(listEntries(db, { source: "builtin" }).map((e) => e.id)).toEqual(["a"]);
      expect(listEntries(db, { source: "custom" }).map((e) => e.id)).toEqual(["b"]);
    });

    it("getEntry returns null for missing id", () => {
      expect(getEntry(db, "nope")).toBeNull();
    });

    it("getEntry returns deprecated entries only with includeDeprecated", () => {
      insertBuiltinEntry(db, makeEntry({ id: "a" }));
      markBuiltinDeprecated(db, "a", 1);

      expect(getEntry(db, "a")).toBeNull();
      expect(getEntry(db, "a", { includeDeprecated: true })?.id).toBe("a");
    });
  });

  describe("upsertCustomEntry", () => {
    it("inserts a custom entry", () => {
      const r = upsertCustomEntry(db, makeEntry({ id: "x", source: "custom" }));
      expect(r.ok).toBe(true);
      expect(getEntry(db, "x")?.source).toBe("custom");
    });

    it("rejects when id collides with builtin", () => {
      insertBuiltinEntry(db, makeEntry({ id: "a", source: "builtin" }));
      const r = upsertCustomEntry(db, makeEntry({ id: "a", source: "custom" }));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.diagnostics[0].code).toBe("CATALOG_ENTRY_ID_CONFLICT");
      }
    });

    it("forces source='custom' regardless of input", () => {
      const r = upsertCustomEntry(db, makeEntry({ id: "x", source: "builtin" }));
      expect(r.ok).toBe(true);
      expect(getEntry(db, "x")?.source).toBe("custom");
    });

    it("updates existing custom entry on second call", () => {
      upsertCustomEntry(db, makeEntry({ id: "x", source: "custom", name: "v1" }));
      upsertCustomEntry(db, makeEntry({ id: "x", source: "custom", name: "v2" }));
      expect(getEntry(db, "x")?.name).toBe("v2");
    });
  });

  describe("deleteCustomEntry", () => {
    it("deletes a custom entry", () => {
      upsertCustomEntry(db, makeEntry({ id: "x", source: "custom" }));
      const r = deleteCustomEntry(db, "x");
      expect(r.ok).toBe(true);
      expect(getEntry(db, "x")).toBeNull();
    });

    it("rejects deletion of builtin", () => {
      insertBuiltinEntry(db, makeEntry({ id: "a" }));
      const r = deleteCustomEntry(db, "a");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.diagnostics[0].code).toBe("CATALOG_BUILTIN_NOT_WRITABLE");
      }
    });

    it("returns CATALOG_ENTRY_NOT_FOUND for missing id", () => {
      const r = deleteCustomEntry(db, "nope");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.diagnostics[0].code).toBe("CATALOG_ENTRY_NOT_FOUND");
      }
    });
  });

  describe("lookupEntryByCommand", () => {
    it("returns entry id when command+args match exactly", () => {
      insertBuiltinEntry(db, makeEntry({
        id: "etherscan",
        command: "npx",
        args: ["-y", "@scope/etherscan-mcp"],
      }));

      const id = lookupEntryByCommand(db, "npx", ["-y", "@scope/etherscan-mcp"]);
      expect(id).toBe("etherscan");
    });

    it("returns null when no entry matches", () => {
      insertBuiltinEntry(db, makeEntry({
        id: "etherscan",
        command: "npx",
        args: ["-y", "@scope/etherscan-mcp"],
      }));

      expect(lookupEntryByCommand(db, "npx", ["-y", "@other/mcp"])).toBeNull();
      expect(lookupEntryByCommand(db, "node", ["-y", "@scope/etherscan-mcp"])).toBeNull();
    });

    it("does not match deprecated entries", () => {
      insertBuiltinEntry(db, makeEntry({
        id: "etherscan",
        command: "npx",
        args: ["-y", "@scope/etherscan-mcp"],
      }));
      markBuiltinDeprecated(db, "etherscan", 1);

      expect(lookupEntryByCommand(db, "npx", ["-y", "@scope/etherscan-mcp"])).toBeNull();
    });
  });
});
