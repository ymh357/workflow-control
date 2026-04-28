// inventory persistAs end-to-end test (continuation 3, Open issue #1).
//
// Covers the "save to inventory" code path of provideTaskSecrets that
// the dogfood-2026-04-28 Step 8 verification skipped: when the user
// supplies persistAs alongside the secret values, the kernel must
// also write the secret into mcp_inventory_secrets so a subsequent
// task using the same MCP entry can be resolved without a second
// prompt. The HTTP-route schema validation already exists; this test
// pins the runtime behaviour at the KernelService layer.
//
// Acceptance signals:
//   1. Before persistAs: mcp_inventory has no row for the entry id.
//   2. After provideTaskSecrets({secret}, {persistAs:{KEY:{entryId}}}):
//      - secret_gate_queue.resolved_at populated (gate resolved)
//      - mcp_inventory row exists with status='equipped'
//      - mcp_inventory_secrets row exists with the encrypted secret
//   3. Second pipeline run for the same envKey resolves from
//      inventory without a fresh secret_gate row (no prompt).
//
// We stub the catalog exec so checkPackage('npm view') returns
// success without hitting the network — the test is about the
// persistence + lookup path, not health-checking npm.

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import { initKernelNextSchema } from "../ir/sql.js";
import { KernelService } from "../mcp/kernel.js";
import { RealStageExecutor } from "./real-executor.js";
import { PortRuntime, type EventDispatcher } from "./port-runtime.js";
import { upsertCustomEntry } from "../mcp-catalog/catalog-store.js";
import type { CatalogEntry } from "../mcp-catalog/schema.js";
import type { ExecFn } from "../mcp-catalog/healthcheck.js";
import type { PipelineIR } from "../ir/schema.js";

function noopDispatcher(): EventDispatcher {
  return { send: () => {} };
}

// Stub exec — `npm view <pkg> version` always succeeds with a fake
// version. Real network never touched.
const fakeExec: ExecFn = async () => ({
  code: 0,
  stdout: "1.0.0\n",
  stderr: "",
  timedOut: false,
});

// Pipeline whose only stage requires a unique envKey via an MCP server.
// The MCP server itself never runs (secret_pending fires first), so the
// command/args/package are placeholders.
function pipelineNeeding(envKey: string): PipelineIR {
  return {
    name: "persist-as-e2e",
    externalInputs: [],
    stages: [
      {
        name: "needsSecret",
        type: "agent",
        inputs: [],
        outputs: [{ name: "summary", type: "string" }],
        config: {
          promptRef: "stub",
          mcpServers: [
            {
              name: "fake-mcp",
              command: "npx",
              args: ["-y", "@fake/mcp-server"],
              envKeys: [envKey],
              env: { [envKey]: `\${${envKey}}` },
            },
          ],
        },
      },
    ],
    wires: [],
  };
}

// Build a minimal CatalogEntry pointing at our fake MCP server. The
// `id` is the entryId persistAs will reference. envKeys.name must
// equal the envKey the pipeline declares so resolveSecret/equipEntry
// know which key to materialise from inventory.
function makeCatalogEntry(envKey: string): CatalogEntry {
  return {
    id: "fake-mcp-entry",
    source: "custom",
    schemaVersion: "1",
    name: "Fake MCP",
    description: "Test-only entry for persistAs e2e — never executed",
    useCases: ["test"],
    tags: ["test"],
    command: "npx",
    args: ["-y", "@fake/mcp-server"],
    packageName: "@fake/mcp-server",
    envKeys: [
      {
        name: envKey,
        required: true,
        description: `Test-only envKey for persistAs verification`,
      },
    ],
    healthCheckTimeoutMs: 5_000,
  };
}

describe("inventory persistAs e2e (Open issue #1)", () => {
  let db: DatabaseSync;
  let envKey: string;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    envKey = `PERSIST_AS_E2E_${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
    delete process.env[envKey];
  });

  it(
    "provideTaskSecrets with persistAs writes inventory + a second run resolves without re-prompting",
    { timeout: 30_000 },
    async () => {
    const entry = makeCatalogEntry(envKey);
    upsertCustomEntry(db, entry);

    // Pre-state: no inventory row yet.
    const preInventory = db.prepare(
      `SELECT entry_id FROM mcp_inventory WHERE entry_id = ?`,
    ).get(entry.id) as { entry_id: string } | undefined;
    expect(preInventory).toBeUndefined();

    // --- Run 1 — triggers secret_pending ---
    const ir = pipelineNeeding(envKey);
    const svc = new KernelService(db, { skipTypeCheck: true, catalogExec: fakeExec });
    const sub = await svc.submit(ir, { prompts: { stub: "stub prompt" } });
    if (!sub.ok) throw new Error(`submit failed: ${JSON.stringify(sub.diagnostics)}`);

    const taskId1 = `persist-as-1-${randomUUID().slice(0, 8)}`;
    const portRuntime1 = new PortRuntime(db, noopDispatcher());
    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
    });
    const exec1 = await executor.executeStage({
      ir,
      stageName: "needsSecret",
      taskId: taskId1,
      versionHash: sub.versionHash,
      portValues: {},
      handlers: {},
      portRuntime: portRuntime1,
    });
    expect(exec1.status).toBe("secret_pending");

    // --- Provide secret with persistAs ---
    const provideResult = await svc.provideTaskSecrets(
      taskId1,
      { [envKey]: "real-secret-value" },
      { persistAs: { [envKey]: { entryId: entry.id } } },
    );
    expect(provideResult.ok).toBe(true);
    if (!provideResult.ok) return;
    expect(provideResult.resolved).toBe(true);

    // Acceptance signal: secret_gate_queue resolved.
    const gateRow = db.prepare(
      `SELECT resolved_at FROM secret_gate_queue WHERE task_id = ?`,
    ).get(taskId1) as { resolved_at: number | null };
    expect(gateRow.resolved_at).not.toBeNull();

    // Acceptance signal: mcp_inventory row written with status='equipped'.
    const inventoryRow = db.prepare(
      `SELECT entry_id, status FROM mcp_inventory WHERE entry_id = ?`,
    ).get(entry.id) as { entry_id: string; status: string } | undefined;
    expect(inventoryRow).toBeDefined();
    expect(inventoryRow!.status).toBe("equipped");

    // Acceptance signal: mcp_inventory_secrets has the encrypted value
    // for our envKey under this entry.
    const secretRow = db.prepare(
      `SELECT env_key, encrypted_value FROM mcp_inventory_secrets
       WHERE entry_id = ? AND env_key = ?`,
    ).get(entry.id, envKey) as { env_key: string; encrypted_value: string } | undefined;
    expect(secretRow).toBeDefined();
    expect(secretRow!.encrypted_value.length).toBeGreaterThan(0);

    // --- Run 2 — same envKey, fresh task, should resolve from inventory ---
    // We re-run executor.executeStage on the same IR with a NEW task id.
    // The secret-gate path consults inventory before raising secret_pending,
    // so this run should NOT enter secret_pending again (the inventory row
    // satisfies the envKey).
    const taskId2 = `persist-as-2-${randomUUID().slice(0, 8)}`;
    const portRuntime2 = new PortRuntime(db, noopDispatcher());
    const exec2 = await executor.executeStage({
      ir,
      stageName: "needsSecret",
      taskId: taskId2,
      versionHash: sub.versionHash,
      portValues: {},
      handlers: {},
      portRuntime: portRuntime2,
    });
    // The executor will go past the secret-gate (envKey now satisfied
    // by inventory) and try to actually start the MCP server, which
    // fails (it's a fake package). We accept any non-secret_pending
    // outcome — what matters is that no NEW secret_gate_queue row was
    // written.
    expect(exec2.status).not.toBe("secret_pending");

    // Acceptance signal: no new unresolved secret_gate row for taskId2.
    const newGate = db.prepare(
      `SELECT secret_gate_id FROM secret_gate_queue
       WHERE task_id = ? AND resolved_at IS NULL`,
    ).get(taskId2) as { secret_gate_id: string } | undefined;
    expect(newGate).toBeUndefined();
    },
  );
});
