// cancel_task MCP tool — D4 (P4.3).
//
// Covers registration, input validation, TASK_NOT_FOUND /
// TASK_ALREADY_TERMINAL diagnostics, task_finals + task_env_values side
// effects, and best-effort INTERRUPT dispatch when a live dispatcher is
// registered.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPipelineVersion } from "../../ir/sql.js";
import { versionHash } from "../../ir/canonical.js";
import { KernelService } from "../kernel.js";
import { buildTaskTools } from "./task.js";
import type { ToolsDeps, ToolDef } from "../tool-types.js";
import type { PipelineIR } from "../../ir/schema.js";
import { taskRegistry } from "../../runtime/task-registry.js";
import { storeTaskEnvValues } from "../../runtime/task-env-values.js";

function makeIR(): PipelineIR {
  return {
    name: "cancel-test",
    stages: [
      {
        name: "A",
        type: "agent" as const,
        inputs: [],
        outputs: [{ name: "out", type: "unknown" }],
        config: { promptRef: "p" },
      },
      {
        name: "B",
        type: "agent" as const,
        inputs: [{ name: "in", type: "unknown" }],
        outputs: [],
        config: { promptRef: "p" },
      },
    ],
    wires: [
      { from: { source: "stage", stage: "A", port: "out" }, to: { stage: "B", port: "in" } },
    ],
  } as unknown as PipelineIR;
}

function buildDeps(db: DatabaseSync, kernel: KernelService): ToolsDeps {
  return {
    db,
    kernel,
    maxBytesDefault: 65_536,
    createMcpServer: () => ({ name: "stub", version: "0", tools: [] }),
  } as ToolsDeps;
}

function getTool(deps: ToolsDeps, name: string): ToolDef | undefined {
  return buildTaskTools(deps).find((t) => t.name === name);
}

function parsePayload(resp: unknown): Record<string, unknown> {
  const content = (resp as { content: Array<{ text?: string }> }).content;
  return JSON.parse(content[0]!.text!) as Record<string, unknown>;
}

/** Seed a running stage attempt row so the task has identity for cancel. */
function seedRunningAttempt(
  db: DatabaseSync,
  opts: { taskId: string; versionHash: string; stageName?: string },
): string {
  const attemptId = `att-${opts.taskId}-${opts.stageName ?? "A"}-1`;
  db.prepare(
    `INSERT INTO stage_attempts
     (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status, kind)
     VALUES (?, ?, ?, ?, 1, ?, 'running', 'regular')`,
  ).run(
    attemptId,
    opts.taskId,
    opts.versionHash,
    opts.stageName ?? "A",
    Date.now(),
  );
  return attemptId;
}

describe("cancel_task MCP tool", () => {
  let db: DatabaseSync;
  let kernel: KernelService;
  let deps: ToolsDeps;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    kernel = new KernelService(db, { skipTypeCheck: true });
    deps = buildDeps(db, kernel);
  });

  afterEach(() => {
    taskRegistry.__clearForTest();
    db.close();
  });

  it("is registered under name cancel_task with an inputSchema", () => {
    const tool = getTool(deps, "cancel_task");
    expect(tool).toBeDefined();
    expect(tool!.description.length).toBeGreaterThan(0);
    expect(tool!.inputSchema).toHaveProperty("taskId");
    expect(tool!.inputSchema).toHaveProperty("reason");
    expect(tool!.inputSchema).toHaveProperty("actor");
  });

  it("rejects missing taskId", async () => {
    const tool = getTool(deps, "cancel_task")!;
    const resp = await tool.handler({});
    expect(resp.isError).toBe(true);
    const payload = parsePayload(resp);
    expect(payload.ok).toBe(false);
    expect(String(payload.error)).toMatch(/taskId/i);
  });

  it("returns TASK_NOT_FOUND when taskId has no stage_attempts", async () => {
    const tool = getTool(deps, "cancel_task")!;
    const resp = await tool.handler({ taskId: "missing-task-xyz" });
    const payload = parsePayload(resp);
    expect(payload.ok).toBe(false);
    const diags = payload.diagnostics as Array<{ code: string }> | undefined;
    expect(diags?.[0]?.code).toBe("TASK_NOT_FOUND");
  });

  it("returns TASK_ALREADY_TERMINAL when a task_finals row already exists", async () => {
    const ir = makeIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const taskId = "task-already-done";
    seedRunningAttempt(db, { taskId, versionHash: hash });
    db.prepare(
      `INSERT INTO task_finals (task_id, version_hash, final_state, reason, detail, ended_at)
       VALUES (?, ?, 'completed', 'natural', NULL, ?)`,
    ).run(taskId, hash, Date.now());

    const tool = getTool(deps, "cancel_task")!;
    const resp = await tool.handler({ taskId });
    const payload = parsePayload(resp);
    expect(payload.ok).toBe(false);
    const diags = payload.diagnostics as Array<{ code: string; context?: { currentFinalState?: string } }> | undefined;
    expect(diags?.[0]?.code).toBe("TASK_ALREADY_TERMINAL");
    expect(diags?.[0]?.context?.currentFinalState).toBe("completed");
  });

  it("writes task_finals.final_state='cancelled' for a known non-running task", async () => {
    const ir = makeIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const taskId = "task-cancel-1";
    seedRunningAttempt(db, { taskId, versionHash: hash });

    const tool = getTool(deps, "cancel_task")!;
    const resp = await tool.handler({ taskId });
    const payload = parsePayload(resp);
    expect(payload.ok).toBe(true);
    expect(payload.taskId).toBe(taskId);
    expect(payload.wasRunning).toBe(false);

    const row = db.prepare(
      `SELECT final_state, reason, detail, version_hash FROM task_finals WHERE task_id = ?`,
    ).get(taskId) as { final_state: string; reason: string; detail: string | null; version_hash: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.final_state).toBe("cancelled");
    expect(row!.reason).toBe("cancelled");
    expect(row!.version_hash).toBe(hash);
    expect(row!.detail).toMatch(/cancelled via MCP/);
    expect(row!.detail).toMatch(/actor=mcp-cancel/);
  });

  it("deletes task_env_values as part of the cancel path (P3.6)", async () => {
    const ir = makeIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const taskId = "task-env-cleanup";
    seedRunningAttempt(db, { taskId, versionHash: hash });
    storeTaskEnvValues(db, taskId, { API_KEY: "secret-token" });

    // Sanity check seed
    const before = db.prepare(
      `SELECT COUNT(*) as n FROM task_env_values WHERE task_id = ?`,
    ).get(taskId) as { n: number };
    expect(before.n).toBe(1);

    const tool = getTool(deps, "cancel_task")!;
    const resp = await tool.handler({ taskId });
    const payload = parsePayload(resp);
    expect(payload.ok).toBe(true);

    const after = db.prepare(
      `SELECT COUNT(*) as n FROM task_env_values WHERE task_id = ?`,
    ).get(taskId) as { n: number };
    expect(after.n).toBe(0);
  });

  it("dispatches INTERRUPT when the task has a live dispatcher registered", async () => {
    const ir = makeIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const taskId = "task-running";
    seedRunningAttempt(db, { taskId, versionHash: hash });

    const captured: unknown[] = [];
    taskRegistry.register(taskId, {
      send: (ev: unknown) => captured.push(ev),
    } as never);

    const tool = getTool(deps, "cancel_task")!;
    const resp = await tool.handler({ taskId, reason: "user pressed stop", actor: "dashboard" });
    const payload = parsePayload(resp);
    expect(payload.ok).toBe(true);
    expect(payload.wasRunning).toBe(true);

    // INTERRUPT was delivered to the registered dispatcher.
    expect(captured).toHaveLength(1);
    const ev = captured[0] as Record<string, unknown>;
    expect(ev["type"]).toBe("INTERRUPT");

    // task_finals stamped cancelled + audit info threaded through detail.
    const row = db.prepare(
      `SELECT final_state, reason, detail FROM task_finals WHERE task_id = ?`,
    ).get(taskId) as { final_state: string; reason: string; detail: string | null };
    expect(row.final_state).toBe("cancelled");
    expect(row.reason).toBe("cancelled");
    expect(row.detail).toMatch(/user pressed stop/);
    expect(row.detail).toMatch(/actor=dashboard/);
  });

  it("does not throw when the dispatcher itself throws (best-effort INTERRUPT)", async () => {
    const ir = makeIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const taskId = "task-throwing-dispatcher";
    seedRunningAttempt(db, { taskId, versionHash: hash });

    taskRegistry.register(taskId, {
      send: () => {
        throw new Error("dispatcher exploded");
      },
    } as never);

    const tool = getTool(deps, "cancel_task")!;
    const resp = await tool.handler({ taskId });
    const payload = parsePayload(resp);
    expect(payload.ok).toBe(true);

    // task_finals still written despite dispatcher failure.
    const row = db.prepare(
      `SELECT final_state FROM task_finals WHERE task_id = ?`,
    ).get(taskId) as { final_state: string };
    expect(row.final_state).toBe("cancelled");
  });
});
