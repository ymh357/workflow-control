import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { createKernelMcpCatalogRoute } from "../../routes/kernel-mcp-catalog.js";
import { initCatalogSchema } from "./sql.js";
import { initInventorySchema } from "./inventory-sql.js";
import { insertBuiltinEntry, lookupEntryByCommand } from "./catalog-store.js";
import { expandMcpServers } from "../runtime/mcp-servers-expander.js";
import { resolveSecret } from "./inventory.js";
import { resetKeyCacheForTest } from "./crypto.js";

describe("Phase 2 — full path: equip → expand expander reads inventory", () => {
  beforeEach(() => {
    process.env.WORKFLOW_CONTROL_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
    resetKeyCacheForTest();
    delete process.env.ETHERSCAN_API_KEY;
  });

  it("user equips → pipeline launch resolves the secret transparently", async () => {
    const db = new DatabaseSync(":memory:");
    initCatalogSchema(db);
    initInventorySchema(db);
    insertBuiltinEntry(db, {
      id: "etherscan", source: "builtin", schemaVersion: "1",
      name: "Etherscan", description: "verify",
      useCases: ["verify"], tags: ["evm"],
      command: "npx", args: ["-y", "@scope/etherscan-mcp"],
      envKeys: [{ name: "ETHERSCAN_API_KEY", required: true, description: "" }],
      healthCheckTimeoutMs: 1000,
    });

    const app = new Hono().route("/api", createKernelMcpCatalogRoute(() => db, {
      exec: async () => ({ code: 0, stdout: "1.0", stderr: "", timedOut: false }),
    }));

    const equipRes = await app.request("/api/kernel/mcp-catalog/equip", {
      method: "POST",
      body: JSON.stringify({ entryId: "etherscan", envValues: { ETHERSCAN_API_KEY: "REAL_USER_KEY" } }),
    });
    expect(equipRes.status).toBe(200);
    expect(await equipRes.json()).toEqual({ ok: true, status: "equipped" });

    const decl = {
      name: "etherscan",
      command: "npx",
      args: ["-y", "@scope/etherscan-mcp"],
      envKeys: ["ETHERSCAN_API_KEY"],
      env: { ETHERSCAN_API_KEY: "${ETHERSCAN_API_KEY}" },
    };
    const result = expandMcpServers([decl], {}, {} as NodeJS.ProcessEnv, {
      resolveInventorySecret: (envKey) => {
        const eid = lookupEntryByCommand(db, decl.command, decl.args);
        if (!eid) return null;
        return resolveSecret({ db }, eid, envKey);
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    expect(result.servers.etherscan.env?.ETHERSCAN_API_KEY).toBe("REAL_USER_KEY");
  });
});
