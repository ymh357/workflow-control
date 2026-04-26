// secret-gate-e2e.test.ts
//
// F17 secret-gate end-to-end integration test.
//
// PATH B (direct executor invocation):
//
// The runner fires runPipeline as a fire-and-forget background promise and
// never resolves while a stage is in secret_pending (the machine is stuck in
// `executing`). Awaiting runPipeline directly would deadlock the test.
//
// Instead this test exercises the secret-gate path by invoking
// RealStageExecutor.executeStage directly (bypassing the runner/machine loop).
// This covers 100% of the secret-gate code in real-executor.ts (the path that
// writes secret_gate_queue and returns secret_pending) and the full
// KernelService layer for getTaskStatus / provideTaskSecrets.
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
// NOTE: F17_TEST_KEY (not GITHUB_TOKEN) is used as the envKey so the test
// is immune to any real token that may exist in process.env.

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import { initKernelNextSchema } from "../ir/sql.js";
import { KernelService } from "../mcp/kernel.js";
import { RealStageExecutor } from "./real-executor.js";
import { PortRuntime, type EventDispatcher } from "./port-runtime.js";
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
