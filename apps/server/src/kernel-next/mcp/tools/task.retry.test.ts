// retry_task MCP tool — D8 (P4.1).
//
// Covers registration, input validation, missing-task / no-failed-stage
// diagnostics, and the happy-path where a previously-errored stage
// attempt is superseded and resume kicks off via startPipelineRun.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPipelineVersion } from "../../ir/sql.js";
import { versionHash } from "../../ir/canonical.js";
import { KernelService } from "../kernel.js";
import { buildTaskTools } from "./task.js";
import type { ToolsDeps, ToolDef } from "../tool-types.js";
import type { PipelineIR } from "../../ir/schema.js";
import { taskRegistry } from "../../runtime/task-registry.js";

function makeIR(): PipelineIR {
  return {
    name: "retry-test",
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

describe("retry_task MCP tool", () => {
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

  it("is registered under name retry_task with an inputSchema", () => {
    const tool = getTool(deps, "retry_task");
    expect(tool).toBeDefined();
    expect(tool!.description.length).toBeGreaterThan(0);
    expect(tool!.inputSchema).toHaveProperty("taskId");
    expect(tool!.inputSchema).toHaveProperty("fromStage");
    expect(tool!.inputSchema).toHaveProperty("actor");
  });

  it("rejects missing taskId", async () => {
    const tool = getTool(deps, "retry_task")!;
    const resp = await tool.handler({});
    expect(resp.isError).toBe(true);
    const payload = parsePayload(resp);
    expect(payload.ok).toBe(false);
    expect(String(payload.error)).toMatch(/taskId/i);
  });

  it("returns TASK_NOT_FOUND when taskId has no stage_attempts", async () => {
    const tool = getTool(deps, "retry_task")!;
    const resp = await tool.handler({ taskId: "missing-task-xyz" });
    const payload = parsePayload(resp);
    expect(payload.ok).toBe(false);
    const diags = payload.diagnostics as Array<{ code: string }> | undefined;
    expect(diags?.[0]?.code).toBe("TASK_NOT_FOUND");
  });

  it("returns NO_FAILED_STAGE when no attempt is in error status and fromStage omitted", async () => {
    // Seed a version + a fully-successful task.
    const ir = makeIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const now = Date.now();
    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, ended_at, status, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'success', 'regular')`,
    ).run("att-A-1", "task-ok", hash, "A", 1, now, now + 10);
    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, ended_at, status, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'success', 'regular')`,
    ).run("att-B-1", "task-ok", hash, "B", 1, now + 20, now + 30);

    const tool = getTool(deps, "retry_task")!;
    const resp = await tool.handler({ taskId: "task-ok" });
    const payload = parsePayload(resp);
    expect(payload.ok).toBe(false);
    const diags = payload.diagnostics as Array<{ code: string }> | undefined;
    expect(diags?.[0]?.code).toBe("NO_FAILED_STAGE");
  });

  it("returns UNKNOWN_STAGE when fromStage is not in the pipeline IR", async () => {
    const ir = makeIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const now = Date.now();
    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, ended_at, status, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'error', 'regular')`,
    ).run("att-A-err", "task-err", hash, "A", 1, now, now + 10);

    const tool = getTool(deps, "retry_task")!;
    const resp = await tool.handler({ taskId: "task-err", fromStage: "Nonexistent" });
    const payload = parsePayload(resp);
    expect(payload.ok).toBe(false);
    const diags = payload.diagnostics as Array<{ code: string }> | undefined;
    expect(diags?.[0]?.code).toBe("UNKNOWN_STAGE");
  });

  it("retries a task from an explicit fromStage and supersedes the failed attempt", async () => {
    // Seed a version + a task with stage A succeeded, stage B failed.
    const ir = makeIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const now = Date.now();
    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, ended_at, status, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'success', 'regular')`,
    ).run("att-A-success", "task-retry-1", hash, "A", 1, now, now + 10);
    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, ended_at, status, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'error', 'regular')`,
    ).run("att-B-error", "task-retry-1", hash, "B", 1, now + 20, now + 30);

    const tool = getTool(deps, "retry_task")!;
    const resp = await tool.handler({ taskId: "task-retry-1", fromStage: "B" });
    const payload = parsePayload(resp);
    expect(payload.ok).toBe(true);
    expect(payload.taskId).toBe("task-retry-1");
    expect(payload.rerunFrom).toBe("B");

    // The failed attempt is now superseded (supersede set included B).
    const row = db.prepare(
      `SELECT status FROM stage_attempts WHERE attempt_id = ?`,
    ).get("att-B-error") as { status: string };
    expect(row.status).toBe("superseded");

    // Stage A upstream untouched.
    const aRow = db.prepare(
      `SELECT status FROM stage_attempts WHERE attempt_id = ?`,
    ).get("att-A-success") as { status: string };
    expect(aRow.status).toBe("success");
  });

  it("auto-resolves the first errored stage when fromStage omitted", async () => {
    const ir = makeIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const now = Date.now();
    // Both A and B errored; B started later. Earliest-by-started_at = A.
    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, ended_at, status, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'error', 'regular')`,
    ).run("att-A-err", "task-auto", hash, "A", 1, now, now + 10);
    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, ended_at, status, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'error', 'regular')`,
    ).run("att-B-err", "task-auto", hash, "B", 1, now + 100, now + 110);

    const tool = getTool(deps, "retry_task")!;
    const resp = await tool.handler({ taskId: "task-auto" });
    const payload = parsePayload(resp);
    expect(payload.ok).toBe(true);
    expect(payload.rerunFrom).toBe("A");
  });
});
