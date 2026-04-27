import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initCatalogSchema } from "./sql.js";
import { initInventorySchema } from "./inventory-sql.js";
import { insertBuiltinEntry } from "./catalog-store.js";
import {
  equipEntry,
  unequipEntry,
  recheckEntry,
  listInventory,
  getInventoryStatus,
  hasSecret,
  resolveSecret,
  listSecretReadoutsPublic,
} from "./inventory.js";
import type { CatalogEntry } from "./schema.js";

function newDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initCatalogSchema(db);
  initInventorySchema(db);
  return db;
}

const ETHERSCAN: CatalogEntry = {
  id: "etherscan",
  source: "builtin",
  schemaVersion: "1",
  name: "Etherscan MCP",
  description: "verify ethereum tx and contract source",
  useCases: ["verify tx hash"],
  tags: ["evm"],
  command: "npx",
  args: ["-y", "@scope/etherscan-mcp"],
  envKeys: [{ name: "ETHERSCAN_API_KEY", required: true, description: "" }],
  healthCheckTimeoutMs: 1000,
};

const FETCH: CatalogEntry = {
  id: "fetch",
  source: "builtin",
  schemaVersion: "1",
  name: "Fetch MCP",
  description: "http fetcher",
  useCases: ["fetch url"],
  tags: ["http"],
  command: "npx",
  args: ["-y", "@scope/fetch-mcp"],
  envKeys: [],
  healthCheckTimeoutMs: 1000,
};

const fakeEncrypt = (s: string): string => `enc(${s})`;
const fakeDecrypt = (s: string): string => {
  const m = s.match(/^enc\((.*)\)$/);
  if (!m) throw new Error("decrypt failed");
  return m[1];
};

describe("inventory.equipEntry", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = newDb();
    insertBuiltinEntry(db, ETHERSCAN);
    insertBuiltinEntry(db, FETCH);
  });

  it("equipped when no envKeys required + package check passes", async () => {
    const r = await equipEntry(
      { db, encrypt: fakeEncrypt, decrypt: fakeDecrypt,
        exec: async () => ({ code: 0, stdout: "v", stderr: "", timedOut: false }),
        processEnv: {} },
      { entryId: "fetch", envValues: {} },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.status).toBe("equipped");
    expect(getInventoryStatus(db, "fetch")?.status).toBe("equipped");
  });

  it("equipped when required envKey provided + package check passes", async () => {
    const r = await equipEntry(
      { db, encrypt: fakeEncrypt, decrypt: fakeDecrypt,
        exec: async () => ({ code: 0, stdout: "v", stderr: "", timedOut: false }),
        processEnv: {} },
      { entryId: "etherscan", envValues: { ETHERSCAN_API_KEY: "real-key" } },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.status).toBe("equipped");
    expect(hasSecret(db, "etherscan", "ETHERSCAN_API_KEY")).toBe(true);
    expect(resolveSecret({ db, decrypt: fakeDecrypt }, "etherscan", "ETHERSCAN_API_KEY")).toBe("real-key");
  });

  it("pending-secret when required envKey absent everywhere", async () => {
    const r = await equipEntry(
      { db, encrypt: fakeEncrypt, decrypt: fakeDecrypt,
        exec: async () => ({ code: 0, stdout: "v", stderr: "", timedOut: false }),
        processEnv: {} },
      { entryId: "etherscan", envValues: {} },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.status).toBe("pending-secret");
    expect(getInventoryStatus(db, "etherscan")?.status).toBe("pending-secret");
  });

  it("unhealthy when healthcheck fails", async () => {
    const r = await equipEntry(
      { db, encrypt: fakeEncrypt, decrypt: fakeDecrypt,
        exec: async () => ({ code: 1, stdout: "", stderr: "404", timedOut: false }),
        processEnv: {} },
      { entryId: "fetch", envValues: {} },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.diagnostics[0].code).toBe("MCP_PROVISION_PACKAGE_NOT_FOUND");
    expect(getInventoryStatus(db, "fetch")?.status).toBe("unhealthy");
    expect(getInventoryStatus(db, "fetch")?.lastUnhealthyReason).toContain("MCP_PROVISION_PACKAGE_NOT_FOUND");
  });

  it("treats process.env as a valid source for required envKeys", async () => {
    const r = await equipEntry(
      { db, encrypt: fakeEncrypt, decrypt: fakeDecrypt,
        exec: async () => ({ code: 0, stdout: "v", stderr: "", timedOut: false }),
        processEnv: { ETHERSCAN_API_KEY: "from-env" } },
      { entryId: "etherscan", envValues: {} },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.status).toBe("equipped");
    expect(hasSecret(db, "etherscan", "ETHERSCAN_API_KEY")).toBe(false);
  });

  it("CATALOG_ENTRY_NOT_FOUND for unknown entry", async () => {
    const r = await equipEntry(
      { db, encrypt: fakeEncrypt, decrypt: fakeDecrypt,
        exec: async () => ({ code: 0, stdout: "v", stderr: "", timedOut: false }),
        processEnv: {} },
      { entryId: "ghost", envValues: {} },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.diagnostics[0].code).toBe("CATALOG_ENTRY_NOT_FOUND");
  });
});

describe("inventory.unequipEntry", () => {
  it("removes inventory + secrets", async () => {
    const db = newDb();
    insertBuiltinEntry(db, ETHERSCAN);
    await equipEntry(
      { db, encrypt: fakeEncrypt, decrypt: fakeDecrypt,
        exec: async () => ({ code: 0, stdout: "v", stderr: "", timedOut: false }),
        processEnv: {} },
      { entryId: "etherscan", envValues: { ETHERSCAN_API_KEY: "x" } },
    );
    const r = unequipEntry(db, "etherscan");
    expect(r.ok).toBe(true);
    expect(getInventoryStatus(db, "etherscan")).toBeNull();
    expect(hasSecret(db, "etherscan", "ETHERSCAN_API_KEY")).toBe(false);
  });
});

describe("inventory.recheckEntry", () => {
  it("equipped → unhealthy on failed recheck", async () => {
    const db = newDb();
    insertBuiltinEntry(db, FETCH);
    let nextCode = 0;
    const exec = async () => ({ code: nextCode, stdout: "", stderr: "", timedOut: false });
    await equipEntry({ db, encrypt: fakeEncrypt, decrypt: fakeDecrypt, exec, processEnv: {} },
      { entryId: "fetch", envValues: {} });
    expect(getInventoryStatus(db, "fetch")?.status).toBe("equipped");

    nextCode = 1;
    const r = await recheckEntry({ db, encrypt: fakeEncrypt, decrypt: fakeDecrypt, exec, processEnv: {} }, "fetch");
    expect(r.ok).toBe(false);
    expect(getInventoryStatus(db, "fetch")?.status).toBe("unhealthy");
  });

  it("unhealthy → equipped on successful recheck", async () => {
    const db = newDb();
    insertBuiltinEntry(db, FETCH);
    let code = 1;
    const exec = async () => ({ code, stdout: "", stderr: "", timedOut: false });
    await equipEntry({ db, encrypt: fakeEncrypt, decrypt: fakeDecrypt, exec, processEnv: {} },
      { entryId: "fetch", envValues: {} });
    expect(getInventoryStatus(db, "fetch")?.status).toBe("unhealthy");

    code = 0;
    const r = await recheckEntry({ db, encrypt: fakeEncrypt, decrypt: fakeDecrypt, exec, processEnv: {} }, "fetch");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.status).toBe("equipped");
  });
});

describe("inventory.resolveSecret", () => {
  it("returns null when entry not equipped", () => {
    const db = newDb();
    expect(resolveSecret({ db, decrypt: fakeDecrypt }, "etherscan", "ETHERSCAN_API_KEY")).toBeNull();
  });

  it("returns plaintext after equip", async () => {
    const db = newDb();
    insertBuiltinEntry(db, ETHERSCAN);
    await equipEntry(
      { db, encrypt: fakeEncrypt, decrypt: fakeDecrypt,
        exec: async () => ({ code: 0, stdout: "v", stderr: "", timedOut: false }),
        processEnv: {} },
      { entryId: "etherscan", envValues: { ETHERSCAN_API_KEY: "secret-xyz" } },
    );
    expect(resolveSecret({ db, decrypt: fakeDecrypt }, "etherscan", "ETHERSCAN_API_KEY")).toBe("secret-xyz");
  });

  it("MCP_INVENTORY_DECRYPT_FAILED surfaces if ciphertext malformed", async () => {
    const db = newDb();
    insertBuiltinEntry(db, ETHERSCAN);
    db.prepare(
      `INSERT INTO mcp_inventory_secrets (entry_id, env_key, encrypted_value, last_updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run("etherscan", "ETHERSCAN_API_KEY", "GARBAGE_NOT_ENC", Date.now());

    expect(() => resolveSecret({ db, decrypt: fakeDecrypt }, "etherscan", "ETHERSCAN_API_KEY")).toThrow();
  });
});

describe("inventory.listInventory + listSecretReadoutsPublic", () => {
  it("listInventory returns all rows sorted by entryId", async () => {
    const db = newDb();
    insertBuiltinEntry(db, ETHERSCAN);
    insertBuiltinEntry(db, FETCH);
    await equipEntry(
      { db, encrypt: fakeEncrypt, decrypt: fakeDecrypt,
        exec: async () => ({ code: 0, stdout: "v", stderr: "", timedOut: false }),
        processEnv: {} },
      { entryId: "fetch", envValues: {} },
    );
    await equipEntry(
      { db, encrypt: fakeEncrypt, decrypt: fakeDecrypt,
        exec: async () => ({ code: 0, stdout: "v", stderr: "", timedOut: false }),
        processEnv: {} },
      { entryId: "etherscan", envValues: { ETHERSCAN_API_KEY: "k" } },
    );
    const rows = listInventory(db);
    expect(rows.map((r) => r.entryId)).toEqual(["etherscan", "fetch"]);
  });

  it("listSecretReadoutsPublic returns metadata only, never plaintext", async () => {
    const db = newDb();
    insertBuiltinEntry(db, ETHERSCAN);
    await equipEntry(
      { db, encrypt: fakeEncrypt, decrypt: fakeDecrypt,
        exec: async () => ({ code: 0, stdout: "v", stderr: "", timedOut: false }),
        processEnv: {} },
      { entryId: "etherscan", envValues: { ETHERSCAN_API_KEY: "secret-zzz" } },
    );
    const readouts = listSecretReadoutsPublic(db, "etherscan");
    expect(readouts.length).toBe(1);
    expect(readouts[0].envKey).toBe("ETHERSCAN_API_KEY");
    expect(readouts[0].hasValue).toBe(true);
    expect(JSON.stringify(readouts)).not.toContain("secret-zzz");
  });
});

describe("inventory.resolveSecret — decrypt failure carries diagnostic", () => {
  it("thrown error has .diagnostic with MCP_INVENTORY_DECRYPT_FAILED", async () => {
    const db = newDb();
    insertBuiltinEntry(db, ETHERSCAN);
    db.prepare(
      `INSERT INTO mcp_inventory_secrets (entry_id, env_key, encrypted_value, last_updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run("etherscan", "ETHERSCAN_API_KEY", "GARBAGE_NOT_ENC", Date.now());

    let caught: unknown;
    try {
      resolveSecret({ db, decrypt: fakeDecrypt }, "etherscan", "ETHERSCAN_API_KEY");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const diag = (caught as Error & { diagnostic?: { code: string } }).diagnostic;
    expect(diag?.code).toBe("MCP_INVENTORY_DECRYPT_FAILED");
  });
});
