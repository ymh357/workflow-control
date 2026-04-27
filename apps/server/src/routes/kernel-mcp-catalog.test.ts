import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { DatabaseSync } from "node:sqlite";
import { initCatalogSchema } from "../kernel-next/mcp-catalog/sql.js";
import { insertBuiltinEntry } from "../kernel-next/mcp-catalog/catalog-store.js";
import type { CatalogEntry } from "../kernel-next/mcp-catalog/schema.js";
import { createKernelMcpCatalogRoute } from "./kernel-mcp-catalog.js";

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "etherscan", source: "builtin", schemaVersion: "1",
    name: "Etherscan", description: "x",
    useCases: ["verify tx hash"], tags: ["onchain-verification"],
    command: "npx", args: ["-y", "@scope/etherscan"],
    envKeys: [], healthCheckTimeoutMs: 1000,
    ...overrides,
  };
}

function buildApp(db: DatabaseSync): Hono {
  const app = new Hono();
  app.route("/api", createKernelMcpCatalogRoute(() => db));
  return app;
}

describe("kernel-mcp-catalog routes", () => {
  let db: DatabaseSync;
  let app: Hono;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initCatalogSchema(db);
    app = buildApp(db);
  });

  describe("GET /api/kernel/mcp-catalog/entries", () => {
    it("returns empty list initially", async () => {
      const res = await app.fetch(new Request("http://t/api/kernel/mcp-catalog/entries"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true, entries: [] });
    });

    it("returns inserted entries", async () => {
      insertBuiltinEntry(db, entry({ id: "a" }));
      const res = await app.fetch(new Request("http://t/api/kernel/mcp-catalog/entries"));
      const body = await res.json() as { ok: true; entries: CatalogEntry[] };
      expect(body.entries.map((e) => e.id)).toEqual(["a"]);
    });

    it("filters by source query param", async () => {
      insertBuiltinEntry(db, entry({ id: "a" }));
      const res = await app.fetch(new Request("http://t/api/kernel/mcp-catalog/entries?source=custom"));
      const body = await res.json() as { ok: true; entries: CatalogEntry[] };
      expect(body.entries).toEqual([]);
    });
  });

  describe("GET /api/kernel/mcp-catalog/entries/:id", () => {
    it("returns 404 for missing id", async () => {
      const res = await app.fetch(new Request("http://t/api/kernel/mcp-catalog/entries/nope"));
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.diagnostics[0].code).toBe("CATALOG_ENTRY_NOT_FOUND");
    });

    it("returns the entry", async () => {
      insertBuiltinEntry(db, entry({ id: "a" }));
      const res = await app.fetch(new Request("http://t/api/kernel/mcp-catalog/entries/a"));
      const body = await res.json();
      expect(body.entry.id).toBe("a");
    });
  });

  describe("POST /api/kernel/mcp-catalog/entries (create custom)", () => {
    it("creates a custom entry", async () => {
      const e = entry({ id: "my-custom" });
      const res = await app.fetch(new Request("http://t/api/kernel/mcp-catalog/entries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(e),
      }));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.entry.source).toBe("custom");
    });

    it("rejects when id collides with builtin (409)", async () => {
      insertBuiltinEntry(db, entry({ id: "a" }));
      const e = entry({ id: "a" });
      const res = await app.fetch(new Request("http://t/api/kernel/mcp-catalog/entries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(e),
      }));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.diagnostics[0].code).toBe("CATALOG_ENTRY_ID_CONFLICT");
    });

    it("rejects invalid entry (400)", async () => {
      const res = await app.fetch(new Request("http://t/api/kernel/mcp-catalog/entries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "INVALID" }),
      }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.diagnostics[0].code).toBe("CATALOG_INVALID_ENTRY");
    });
  });

  describe("PUT /api/kernel/mcp-catalog/entries/:id", () => {
    it("rejects PUT on builtin (409)", async () => {
      insertBuiltinEntry(db, entry({ id: "a" }));
      const e = entry({ id: "a", name: "modified" });
      const res = await app.fetch(new Request("http://t/api/kernel/mcp-catalog/entries/a", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(e),
      }));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.diagnostics[0].code).toBe("CATALOG_BUILTIN_NOT_WRITABLE");
    });
  });

  describe("DELETE /api/kernel/mcp-catalog/entries/:id", () => {
    it("rejects DELETE on builtin (409)", async () => {
      insertBuiltinEntry(db, entry({ id: "a" }));
      const res = await app.fetch(new Request("http://t/api/kernel/mcp-catalog/entries/a", { method: "DELETE" }));
      expect(res.status).toBe(409);
    });

    it("returns 404 on missing", async () => {
      const res = await app.fetch(new Request("http://t/api/kernel/mcp-catalog/entries/nope", { method: "DELETE" }));
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/kernel/mcp-catalog/recommend", () => {
    it("returns recommendations for a topic", async () => {
      insertBuiltinEntry(db, entry({
        id: "etherscan", useCases: ["verify tx hash on ethereum"], tags: [],
      }));
      const res = await app.fetch(new Request("http://t/api/kernel/mcp-catalog/recommend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: "verify tx hash" }),
      }));
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.recommendations[0].id).toBe("etherscan");
    });

    it("rejects empty topic (400)", async () => {
      const res = await app.fetch(new Request("http://t/api/kernel/mcp-catalog/recommend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: "" }),
      }));
      expect(res.status).toBe(400);
    });
  });
});
