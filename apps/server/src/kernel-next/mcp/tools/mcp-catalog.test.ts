import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initCatalogSchema } from "../../mcp-catalog/sql.js";
import { insertBuiltinEntry } from "../../mcp-catalog/catalog-store.js";
import type { CatalogEntry } from "../../mcp-catalog/schema.js";
import { buildMcpCatalogTools } from "./mcp-catalog.js";

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "etherscan", source: "builtin", schemaVersion: "1",
    name: "Etherscan", description: "x",
    useCases: ["verify tx hash"], tags: ["onchain-verification"],
    command: "npx", args: [],
    envKeys: [], healthCheckTimeoutMs: 1000,
    ...overrides,
  };
}

describe("buildMcpCatalogTools", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initCatalogSchema(db);
  });

  it("returns two tools: recommend_mcp_servers and get_mcp_catalog_entry", () => {
    const tools = buildMcpCatalogTools({ db } as any);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_mcp_catalog_entry", "recommend_mcp_servers"]);
  });

  it("recommend_mcp_servers returns recommendations using local recommender", async () => {
    insertBuiltinEntry(db, entry({ id: "etherscan", useCases: ["verify tx hash"] }));
    const tools = buildMcpCatalogTools({ db } as any);
    const tool = tools.find((t) => t.name === "recommend_mcp_servers")!;
    const out = await tool.handler({ topic: "verify tx hash", withLLM: false }) as any;
    expect(out.ok).toBe(true);
    expect(out.recommendations[0].id).toBe("etherscan");
  });

  it("get_mcp_catalog_entry returns the entry by id", async () => {
    insertBuiltinEntry(db, entry({ id: "etherscan" }));
    const tools = buildMcpCatalogTools({ db } as any);
    const tool = tools.find((t) => t.name === "get_mcp_catalog_entry")!;
    const out = await tool.handler({ id: "etherscan" }) as any;
    expect(out.ok).toBe(true);
    expect(out.entry.id).toBe("etherscan");
  });

  it("get_mcp_catalog_entry returns CATALOG_ENTRY_NOT_FOUND for missing id", async () => {
    const tools = buildMcpCatalogTools({ db } as any);
    const tool = tools.find((t) => t.name === "get_mcp_catalog_entry")!;
    const out = await tool.handler({ id: "nope" }) as any;
    expect(out.ok).toBe(false);
    expect(out.diagnostics[0].code).toBe("CATALOG_ENTRY_NOT_FOUND");
  });
});
