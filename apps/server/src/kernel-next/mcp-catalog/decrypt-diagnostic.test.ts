import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { expandMcpServers } from "../runtime/mcp-servers-expander.js";
import type { McpServerDecl } from "../ir/schema.js";
import { initCatalogSchema } from "./sql.js";
import { initInventorySchema } from "./inventory-sql.js";
import { insertBuiltinEntry, lookupEntryByCommand } from "./catalog-store.js";
import { resolveSecret } from "./inventory.js";

const decl: McpServerDecl = {
  name: "etherscan",
  command: "npx",
  args: ["-y", "@scope/etherscan-mcp"],
  envKeys: ["ETHERSCAN_API_KEY"],
  env: { ETHERSCAN_API_KEY: "${ETHERSCAN_API_KEY}" },
};

describe("expander — caller can collect inventory decrypt diagnostics", () => {
  it("inventoryResolver throwing a typed Error allows the caller to capture and surface", () => {
    // Sanity: confirm the contract — when resolveInventorySecret returns null,
    // the expander reports missingKeys; the CALLER (real-executor) is responsible
    // for surfacing any decrypt diagnostic it collected during the resolver.
    const collected: Array<{ code: string; entryId: string; envKey: string }> = [];
    const result = expandMcpServers(
      [decl], {}, {} as NodeJS.ProcessEnv,
      {
        resolveInventorySecret: (envKey) => {
          // Simulate: reading the stored secret throws the Phase 2 typed error.
          // The caller catches and records the diagnostic.
          try {
            throw Object.assign(
              new Error("MCP_INVENTORY_DECRYPT_FAILED: corrupt"),
              {
                diagnostic: {
                  code: "MCP_INVENTORY_DECRYPT_FAILED",
                  message: `failed to decrypt secret for entry 'etherscan', envKey '${envKey}'`,
                  context: { entryId: "etherscan", envKey },
                },
              },
            );
          } catch (e) {
            const d = (e as { diagnostic?: { code: string; context?: Record<string, unknown> } }).diagnostic;
            if (d) {
              collected.push({
                code: d.code,
                entryId: String(d.context?.entryId ?? ""),
                envKey: String(d.context?.envKey ?? ""),
              });
            }
            return null;
          }
        },
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.missingKeys).toEqual(["ETHERSCAN_API_KEY"]);
    expect(collected.length).toBe(1);
    expect(collected[0]).toEqual({
      code: "MCP_INVENTORY_DECRYPT_FAILED",
      entryId: "etherscan",
      envKey: "ETHERSCAN_API_KEY",
    });
  });
});

describe("expander integration — corrupt ciphertext surfaces decrypt diagnostic", () => {
  it("collects MCP_INVENTORY_DECRYPT_FAILED into a side channel when ciphertext is malformed", () => {
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

    process.env.WORKFLOW_CONTROL_SECRET_KEY = Buffer.alloc(32, 8).toString("base64");
    // Manually plant corrupt ciphertext.
    db.prepare(
      `INSERT INTO mcp_inventory (entry_id, status, last_status_change_at)
       VALUES (?, ?, ?)`,
    ).run("etherscan", "equipped", Date.now());
    db.prepare(
      `INSERT INTO mcp_inventory_secrets (entry_id, env_key, encrypted_value, last_updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run("etherscan", "ETHERSCAN_API_KEY", "GARBAGE_NOT_REAL_CIPHERTEXT", Date.now());

    const collected: Array<{ entryId: string; envKey: string }> = [];

    const result = expandMcpServers(
      [decl], {}, {} as NodeJS.ProcessEnv,
      {
        resolveInventorySecret: (envKey) => {
          const entryId = lookupEntryByCommand(db, decl.command, decl.args);
          if (!entryId) return null;
          try {
            return resolveSecret({ db }, entryId, envKey);
          } catch (e) {
            const d = (e as { diagnostic?: { code?: string; context?: Record<string, unknown> } }).diagnostic;
            if (d?.code === "MCP_INVENTORY_DECRYPT_FAILED") {
              collected.push({
                entryId: String(d.context?.entryId ?? entryId),
                envKey: String(d.context?.envKey ?? envKey),
              });
            }
            return null;
          }
        },
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.missingKeys).toEqual(["ETHERSCAN_API_KEY"]);
    expect(collected.length).toBe(1);
    expect(collected[0].entryId).toBe("etherscan");
    expect(collected[0].envKey).toBe("ETHERSCAN_API_KEY");
  });
});
