import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { createKernelMcpCatalogRoute } from "./kernel-mcp-catalog.js";
import { initCatalogSchema } from "../kernel-next/mcp-catalog/sql.js";
import { initInventorySchema } from "../kernel-next/mcp-catalog/inventory-sql.js";
import { insertBuiltinEntry } from "../kernel-next/mcp-catalog/catalog-store.js";
import { resetKeyCacheForTest } from "../kernel-next/mcp-catalog/crypto.js";

const FETCH_ENTRY = {
  id: "fetch", source: "builtin" as const, schemaVersion: "1" as const,
  name: "Fetch MCP", description: "http", useCases: ["http"], tags: ["http"],
  command: "npx", args: ["-y", "@scope/fetch-mcp"],
  envKeys: [], healthCheckTimeoutMs: 1000,
};

const ETHERSCAN_ENTRY = {
  id: "etherscan", source: "builtin" as const, schemaVersion: "1" as const,
  name: "Etherscan", description: "verify ethereum",
  useCases: ["verify"], tags: ["evm"],
  command: "npx", args: ["-y", "@scope/etherscan"],
  envKeys: [{ name: "ETHERSCAN_API_KEY", required: true, description: "" }],
  healthCheckTimeoutMs: 1000,
};

function makeApp(envExec: { code: number } = { code: 0 }) {
  process.env.WORKFLOW_CONTROL_SECRET_KEY = Buffer.alloc(32, 1).toString("base64");
  resetKeyCacheForTest();
  const db = new DatabaseSync(":memory:");
  initCatalogSchema(db);
  initInventorySchema(db);
  insertBuiltinEntry(db, FETCH_ENTRY);
  insertBuiltinEntry(db, ETHERSCAN_ENTRY);

  const app = new Hono();
  app.route("/api", createKernelMcpCatalogRoute(() => db, {
    exec: async () => ({ code: envExec.code, stdout: "v", stderr: "", timedOut: false }),
  }));
  return { app, db };
}

describe("kernel-mcp-catalog inventory routes", () => {
  beforeEach(() => {
    delete process.env.ETHERSCAN_API_KEY;
  });

  it("GET /inventory returns empty initially", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/kernel/mcp-catalog/inventory");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.rows).toEqual([]);
  });

  it("POST /equip sets fetch to equipped", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/kernel/mcp-catalog/equip", {
      method: "POST",
      body: JSON.stringify({ entryId: "fetch", envValues: {} }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, status: "equipped" });

    const list = await (await app.request("/api/kernel/mcp-catalog/inventory")).json();
    expect(list.rows.find((r: { entryId: string }) => r.entryId === "fetch")?.status).toBe("equipped");
  });

  it("POST /equip returns pending-secret when required envKey missing", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/kernel/mcp-catalog/equip", {
      method: "POST",
      body: JSON.stringify({ entryId: "etherscan", envValues: {} }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "pending-secret" });
  });

  it("GET /inventory/:id returns readouts without plaintext", async () => {
    const { app } = makeApp();
    await app.request("/api/kernel/mcp-catalog/equip", {
      method: "POST",
      body: JSON.stringify({ entryId: "etherscan", envValues: { ETHERSCAN_API_KEY: "real-secret-xyz" } }),
    });
    const res = await app.request("/api/kernel/mcp-catalog/inventory/etherscan");
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.row.status).toBe("equipped");
    expect(body.readouts.length).toBe(1);
    expect(body.readouts[0].envKey).toBe("ETHERSCAN_API_KEY");
    expect(body.readouts[0].hasValue).toBe(true);
    expect(JSON.stringify(body)).not.toContain("real-secret-xyz");
  });

  it("POST /unequip clears state", async () => {
    const { app } = makeApp();
    await app.request("/api/kernel/mcp-catalog/equip", {
      method: "POST",
      body: JSON.stringify({ entryId: "fetch", envValues: {} }),
    });
    const res = await app.request("/api/kernel/mcp-catalog/unequip", {
      method: "POST",
      body: JSON.stringify({ entryId: "fetch" }),
    });
    expect(res.status).toBe(200);
    const get = await (await app.request("/api/kernel/mcp-catalog/inventory/fetch")).json();
    expect(get.row).toBeNull();
  });

  it("POST /recheck flips equipped → unhealthy when exec fails", async () => {
    const exec = { code: 0 };
    const { app, db: _db } = makeApp(exec);
    await app.request("/api/kernel/mcp-catalog/equip", {
      method: "POST",
      body: JSON.stringify({ entryId: "fetch", envValues: {} }),
    });
    exec.code = 1;
    const res = await app.request("/api/kernel/mcp-catalog/recheck", {
      method: "POST",
      body: JSON.stringify({ entryId: "fetch" }),
    });
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.diagnostics[0].code).toBe("MCP_PROVISION_PACKAGE_NOT_FOUND");
  });

  it("POST /equip returns 404 for unknown entry", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/kernel/mcp-catalog/equip", {
      method: "POST",
      body: JSON.stringify({ entryId: "ghost", envValues: {} }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.diagnostics[0].code).toBe("CATALOG_ENTRY_NOT_FOUND");
  });

  it("POST /equip rejects empty body with 400", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/kernel/mcp-catalog/equip", { method: "POST", body: "" });
    expect(res.status).toBe(400);
  });
});
