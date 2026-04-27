import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initCatalogSchema } from "./sql.js";
import { initInventorySchema } from "./inventory-sql.js";
import { insertBuiltinEntry } from "./catalog-store.js";
import { equipEntry, getInventoryStatus } from "./inventory.js";
import { resetKeyCacheForTest } from "./crypto.js";
import { runSecretKeyRecovery } from "./key-recovery.js";

const ENV_OVERRIDE = "WORKFLOW_CONTROL_SECRET_KEY";

const ETHERSCAN = {
  id: "etherscan", source: "builtin" as const, schemaVersion: "1" as const,
  name: "Etherscan MCP", description: "verify",
  useCases: ["verify"], tags: ["evm"],
  command: "npx", args: ["-y", "@scope/etherscan"],
  envKeys: [{ name: "ETHERSCAN_API_KEY", required: true, description: "" }],
  healthCheckTimeoutMs: 1000,
};

describe("inventory recovery — equip then simulate key loss", () => {
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env[ENV_OVERRIDE];
    delete process.env[ENV_OVERRIDE];
    process.env[ENV_OVERRIDE] = Buffer.alloc(32, 5).toString("base64");
    resetKeyCacheForTest();
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env[ENV_OVERRIDE];
    else process.env[ENV_OVERRIDE] = prevEnv;
    resetKeyCacheForTest();
  });

  it("equip → key-file disappears → recovery flips status to unhealthy with right reason", async () => {
    const db = new DatabaseSync(":memory:");
    initCatalogSchema(db);
    initInventorySchema(db);
    insertBuiltinEntry(db, ETHERSCAN);

    // 1. Equip with the env-override key.
    const eq = await equipEntry(
      { db, exec: async () => ({ code: 0, stdout: "v", stderr: "", timedOut: false }) },
      { entryId: "etherscan", envValues: { ETHERSCAN_API_KEY: "real-secret" } },
    );
    expect(eq.ok).toBe(true);
    expect(getInventoryStatus(db, "etherscan")?.status).toBe("equipped");

    // 2. Simulate key loss: clear env, claim no key file exists.
    delete process.env[ENV_OVERRIDE];
    resetKeyCacheForTest();
    const r = runSecretKeyRecovery(db, { keyFileExists: () => false });
    expect(r.recovered).toBe(true);
    expect(r.affectedRows).toBe(1);

    // 3. Inventory row is now unhealthy with the right reason.
    const row = getInventoryStatus(db, "etherscan");
    expect(row?.status).toBe("unhealthy");
    expect(row?.lastUnhealthyReason).toBe("encryption-key-lost");
  });
});
