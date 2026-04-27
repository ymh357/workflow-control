import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { insertBuiltinEntry } from "../mcp-catalog/catalog-store.js";
import { KernelService } from "./kernel.js";
import { hasSecret, getInventoryStatus } from "../mcp-catalog/inventory.js";
import { resetKeyCacheForTest } from "../mcp-catalog/crypto.js";
import { diamondIR } from "../generator-mock/mini-generator.js";
import { randomUUID } from "node:crypto";

const ETHERSCAN = {
  id: "etherscan", source: "builtin" as const, schemaVersion: "1" as const,
  name: "Etherscan", description: "verify",
  useCases: ["x"], tags: ["evm"],
  command: "npx", args: ["-y", "@scope/etherscan"],
  envKeys: [{ name: "ETHERSCAN_API_KEY", required: true, description: "" }],
  healthCheckTimeoutMs: 1000,
};

function diamondPrompts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of diamondIR().stages) {
    if (s.type === "agent") out[s.config.promptRef] = "dummy";
  }
  return out;
}

function newDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

/** Seed a secret_gate_queue row using a real submitted pipeline so FK constraints are satisfied. */
async function seedGate(
  db: DatabaseSync,
  svc: KernelService,
  taskId: string,
): Promise<{ versionHash: string; attemptId: string; secretGateId: string }> {
  const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
  if (!submitted.ok) throw new Error("setup: submit failed");
  const vh = submitted.versionHash;
  const attemptId = randomUUID();
  const secretGateId = randomUUID();
  db.prepare(
    `INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status)
       VALUES (?, ?, ?, 'A', 0, ?, 'secret_pending')`,
  ).run(attemptId, taskId, vh, Date.now());
  db.prepare(
    `INSERT INTO secret_gate_queue (secret_gate_id, task_id, stage_name, attempt_id, required_keys, created_at)
       VALUES (?, ?, 'A', ?, ?, ?)`,
  ).run(secretGateId, taskId, attemptId, JSON.stringify(["ETHERSCAN_API_KEY"]), Date.now());
  return { versionHash: vh, attemptId, secretGateId };
}

describe("KernelService.provideTaskSecrets — persistAs", () => {
  beforeEach(() => {
    process.env.WORKFLOW_CONTROL_SECRET_KEY = Buffer.alloc(32, 9).toString("base64");
    resetKeyCacheForTest();
  });

  it("without persistAs: no inventory write (legacy behavior)", async () => {
    const db = newDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    await seedGate(db, svc, "t1");

    const r = await svc.provideTaskSecrets("t1", { ETHERSCAN_API_KEY: "kkk" });
    expect(r.ok).toBe(true);
    expect(hasSecret(db, "etherscan", "ETHERSCAN_API_KEY")).toBe(false);
  });

  it("with persistAs: writes encrypted inventory secret + equips entry", async () => {
    const db = newDb();
    insertBuiltinEntry(db, ETHERSCAN);
    const svc = new KernelService(db, {
      skipTypeCheck: true,
      catalogExec: async () => ({ code: 0, stdout: "v", stderr: "", timedOut: false }),
    });
    await seedGate(db, svc, "t2");

    const r = await svc.provideTaskSecrets(
      "t2",
      { ETHERSCAN_API_KEY: "secret-2" },
      { persistAs: { ETHERSCAN_API_KEY: { entryId: "etherscan" } } },
    );
    expect(r.ok).toBe(true);
    expect(hasSecret(db, "etherscan", "ETHERSCAN_API_KEY")).toBe(true);
    expect(getInventoryStatus(db, "etherscan")?.status).toBe("equipped");
  });

  it("persistAs envKey not in secrets → ignored (no error)", async () => {
    const db = newDb();
    insertBuiltinEntry(db, ETHERSCAN);
    const svc = new KernelService(db, { skipTypeCheck: true });
    await seedGate(db, svc, "t3");

    const r = await svc.provideTaskSecrets(
      "t3",
      { ETHERSCAN_API_KEY: "x" },
      { persistAs: { OTHER_KEY: { entryId: "etherscan" } } },
    );
    expect(r.ok).toBe(true);
    expect(hasSecret(db, "etherscan", "ETHERSCAN_API_KEY")).toBe(false);
  });

  it("equipEntry failure during persistAs → gate still resolves ok:true", async () => {
    const db = newDb();
    insertBuiltinEntry(db, ETHERSCAN);

    // Patch the encrypt path to throw. The test exercises the catch in
    // provideTaskSecrets's persistAs block: if equipEntry throws (any reason),
    // the gate resolve must not be invalidated.
    //
    // Simplest reliable break: temporarily set WORKFLOW_CONTROL_SECRET_KEY to
    // a malformed value AFTER setting up the gate-seeding, then reset the
    // crypto cache. encryptValue → loadKey will throw on length mismatch.

    const svc = new KernelService(db, { skipTypeCheck: true });
    await seedGate(db, svc, "t4");

    process.env.WORKFLOW_CONTROL_SECRET_KEY = "not-32-bytes-base64";
    resetKeyCacheForTest();

    const r = await svc.provideTaskSecrets(
      "t4",
      { ETHERSCAN_API_KEY: "secret-recover" },
      { persistAs: { ETHERSCAN_API_KEY: { entryId: "etherscan" } } },
    );

    expect(r.ok).toBe(true);
    expect(hasSecret(db, "etherscan", "ETHERSCAN_API_KEY")).toBe(false);

    // Restore the cache for downstream tests in the same worker.
    process.env.WORKFLOW_CONTROL_SECRET_KEY = Buffer.alloc(32, 9).toString("base64");
    resetKeyCacheForTest();
  });
});
