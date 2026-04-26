// secret-gate-e2e.test.ts
//
// F17 secret-gate end-to-end integration test.
//
// PATH A (real runner — deadlock regression test):
//
// Calls runPipeline directly with RealStageExecutor against a pipeline whose
// stage requires F17_E2E_KEY_<suffix> via mcpServers. The envKey is absent
// from process.env and no envValues are provided, so the executor returns
// secret_pending. With the F17 fix (dispatch INTERRUPT on secret_pending),
// runPipeline exits cleanly via the interrupted path. The killer assertion is
// that runPipeline resolves within the test timeout — if the fix is absent,
// the machine stays in `executing` and the test times out (deadlock).
//
// PATH B (direct executor invocation):
//
// Exercises the secret-gate path by invoking RealStageExecutor.executeStage
// directly (bypassing the runner/machine loop). Covers the KernelService
// layer for getTaskStatus / provideTaskSecrets end-to-end.
//
// Acceptance signals (per the task spec):
//  1. After running without F17_TEST_KEY in env, secret_gate_queue row exists
//     with required_keys = '["F17_TEST_KEY"]'.
//  2. getTaskStatus returns status === "secret_pending" with stillMissing
//     containing "F17_TEST_KEY".
//  3. task_finals is NOT written for the paused task.
//  4. After provideTaskSecrets({ F17_TEST_KEY: "fake_value" }), the
//     secret_gate_queue.resolved_at is non-null.
//  5. After provide, getTaskStatus is no longer "secret_pending".
//
// NOTE: F17_TEST_KEY / F17_E2E_KEY_* (not GITHUB_TOKEN) is used as the
// envKey so the test is immune to any real token that may exist in process.env.

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { KernelService } from "../mcp/kernel.js";
import { RealStageExecutor } from "./real-executor.js";
import { PortRuntime, type EventDispatcher } from "./port-runtime.js";
import { runPipeline } from "./runner.js";
import type { PipelineIR } from "../ir/schema.js";

function noopDispatcher(): EventDispatcher {
  return { send: () => {} };
}

// Pipeline with a single agent stage that requires F17_TEST_KEY via mcpServers.
// We use F17_TEST_KEY (not GITHUB_TOKEN) to guarantee process.env cannot
// accidentally satisfy the expansion even on developer machines.
function pipelineNeedingF17TestKey(): PipelineIR {
  return {
    name: "secret-gate-e2e",
    externalInputs: [],
    stages: [
      {
        name: "research",
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
              envKeys: ["F17_TEST_KEY"],
              env: { F17_TEST_KEY: "${F17_TEST_KEY}" },
            },
          ],
        },
      },
    ],
    wires: [],
  };
}

// --- PATH A: real runner deadlock-regression test -------------------

describe("F17 secret-gate end-to-end (Path A — real runner)", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    // Use a unique envKey per run so no real machine token can accidentally
    // satisfy it. The suffix makes the key name unique even if tests run in
    // parallel (vitest worker isolation handles DB; this protects process.env).
    const uniqueKey = `F17_E2E_KEY_${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
    delete process.env[uniqueKey];
    // Store on the instance so the test body can reference it.
    (db as DatabaseSync & { __f17Key?: string }).__f17Key = uniqueKey;
  });

  it("runPipeline resolves (no deadlock) and task_finals is NOT written when stage returns secret_pending", async () => {
    const uniqueKey = (db as DatabaseSync & { __f17Key?: string }).__f17Key!;

    // Build a pipeline with one agent stage that requires the unique envKey.
    const ir: PipelineIR = {
      name: "secret-gate-path-a",
      externalInputs: [],
      stages: [
        {
          name: "gated-stage",
          type: "agent",
          inputs: [],
          outputs: [{ name: "result", type: "string" }],
          config: {
            promptRef: "stub",
            mcpServers: [
              {
                name: "fake-mcp",
                command: "npx",
                args: ["-y", "@fake/mcp-server"],
                envKeys: [uniqueKey],
                env: { [uniqueKey]: `\${${uniqueKey}}` },
              },
            ],
          },
        },
      ],
      wires: [],
    };

    const vh = randomUUID().replace(/-/g, "").slice(0, 40);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });

    const taskId = `path-a-${randomUUID().slice(0, 8)}`;

    const executor = new RealStageExecutor({
      // Never called — secret_pending fires before any MCP transport is started.
      mcpServerFactory: () => ({}),
    });

    // This is the killer assertion: if the INTERRUPT dispatch is absent,
    // runPipeline will never resolve (the XState machine stays in `executing`)
    // and the test times out. With the fix, it resolves promptly.
    const result = await runPipeline({
      db,
      ir,
      taskId,
      versionHash: vh,
      handlers: {},
      executor,
    }, 15_000); // 15 s safety ceiling — real fix makes it resolve in < 1 s

    // The runner exited via the interrupted path (INTERRUPT dispatched on secret_pending).
    // finalState may be "failed" (interrupted verdict), which is correct —
    // the task is paused, not completed.
    expect(result.finalState).toMatch(/^(failed|completed)$/);

    // CRITICAL: task_finals must NOT be written. The task is paused, not terminal.
    const finalsRow = db.prepare(
      `SELECT final_state FROM task_finals WHERE task_id = ?`,
    ).get(taskId);
    expect(finalsRow).toBeUndefined();

    // secret_gate_queue row must exist (executor wrote it before returning secret_pending).
    const sgRow = db.prepare(
      `SELECT required_keys, resolved_at FROM secret_gate_queue WHERE task_id = ? AND resolved_at IS NULL`,
    ).get(taskId) as { required_keys: string; resolved_at: number | null } | undefined;
    expect(sgRow).toBeDefined();
    expect(JSON.parse(sgRow!.required_keys)).toEqual([uniqueKey]);
  }, 20_000);
});

// --- PATH B: direct executor invocation ------------------------------

describe("F17 secret-gate end-to-end (Path B — direct executor invocation)", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    // Guarantee F17_TEST_KEY is absent from process.env for this test.
    // (Deleting an absent key is a no-op in Node; this is defensive.)
    delete process.env["F17_TEST_KEY"];
  });

  it("full loop: secret_pending → getTaskStatus → provideTaskSecrets → resolved", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });

    // --- Setup: submit pipeline so the IR + prompts exist in DB ---
    const ir = pipelineNeedingF17TestKey();
    const submitResult = await svc.submit(ir, { prompts: { stub: "stub prompt" } });
    if (!submitResult.ok) {
      throw new Error(`submit failed: ${JSON.stringify(submitResult.diagnostics)}`);
    }
    const vh = submitResult.versionHash;

    // --- Acceptance signal 1: invoke RealStageExecutor.executeStage ---
    //
    // The executor hits expandMcpServers, finds F17_TEST_KEY missing from
    // both task_env_values (empty — no envValues were provided) and
    // process.env (deleted above), writes a secret_gate_queue row, and
    // returns { status: "secret_pending" }.
    //
    // queryFn is intentionally omitted (and should never be reached):
    // the secret-gate early-return fires before the SDK query() call.
    const taskId = `sg-e2e-${randomUUID().slice(0, 8)}`;
    const portRuntime = new PortRuntime(db, noopDispatcher());

    const executor = new RealStageExecutor({
      // Stub factory — never called because secret_pending fires first.
      // The factory is required by the constructor but the mcpServer it
      // would produce is created inside the try{} block that surrounds
      // expandMcpServers; we verify the early-return fires before any
      // MCP server is used (no SDK transport is established).
      mcpServerFactory: () => ({}),
      // No queryFn override = would use real SDK, but we never reach it.
      // No promptResolver override = TrivialPromptResolver (promptRef as-is).
    });

    const execResult = await executor.executeStage({
      ir,
      stageName: "research",
      taskId,
      versionHash: vh,
      portValues: {},
      handlers: {},
      portRuntime,
    });

    // Verify the executor returned secret_pending.
    expect(execResult.status).toBe("secret_pending");
    if (execResult.status !== "secret_pending") return;
    expect(execResult.missingKeys).toEqual(["F17_TEST_KEY"]);

    // --- Acceptance signal 1: secret_gate_queue row exists ---
    const sgRow = db.prepare(
      `SELECT secret_gate_id, required_keys, resolved_at
       FROM secret_gate_queue
       WHERE task_id = ? AND resolved_at IS NULL`,
    ).get(taskId) as { secret_gate_id: string; required_keys: string; resolved_at: number | null } | undefined;

    expect(sgRow).toBeDefined();
    expect(JSON.parse(sgRow!.required_keys)).toEqual(["F17_TEST_KEY"]);
    expect(sgRow!.resolved_at).toBeNull();
    const secretGateId = sgRow!.secret_gate_id;

    // --- Acceptance signal 2: getTaskStatus returns secret_pending ---
    const status1 = svc.getTaskStatus(taskId);
    expect(status1.ok).toBe(true);
    expect(status1.status).toBe("secret_pending");
    if (status1.status === "secret_pending") {
      const gate = status1.pending[0];
      expect(gate).toBeDefined();
      expect(gate!.stageName).toBe("research");
      expect(gate!.requiredKeys).toEqual(["F17_TEST_KEY"]);
      expect(gate!.stillMissing).toEqual(["F17_TEST_KEY"]);
    }

    // --- Acceptance signal 3: task_finals NOT written ---
    const finalsRow = db.prepare(
      `SELECT final_state FROM task_finals WHERE task_id = ?`,
    ).get(taskId);
    expect(finalsRow).toBeUndefined();

    // --- Acceptance signal 4: provideTaskSecrets resolves the gate ---
    //
    // provideTaskSecrets writes task_env_values, marks resolved_at, then
    // calls retryTaskFromStage -> executeMigration -> startPipelineRun
    // (fire-and-forget background run). The background run may fail (no
    // real F17_TEST_KEY pointing to a real MCP server) but that is
    // irrelevant to this test — resolved_at is committed before the
    // background runner starts.
    const provideResult = await svc.provideTaskSecrets(taskId, { F17_TEST_KEY: "fake_value_for_test" });
    expect(provideResult.ok).toBe(true);
    if (!provideResult.ok) return;
    expect(provideResult.resolved).toBe(true);

    // Verify secret_gate_queue.resolved_at is populated.
    const sgRowAfter = db.prepare(
      `SELECT resolved_at FROM secret_gate_queue WHERE secret_gate_id = ?`,
    ).get(secretGateId) as { resolved_at: number | null } | undefined;
    expect(sgRowAfter).toBeDefined();
    expect(sgRowAfter!.resolved_at).not.toBeNull();

    // --- Acceptance signal 5: getTaskStatus is no longer secret_pending ---
    const status2 = svc.getTaskStatus(taskId);
    expect(status2.ok).toBe(true);
    expect(status2.status).not.toBe("secret_pending");
  });
});
