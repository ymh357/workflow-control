// prune_records MCP tool — P4.2 (D9).
//
// Covers: registration, schema shape, dry-run preview vs actual delete,
// default olderThanDays=30 coercion, and error handling.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../../ir/sql.js";
import { KernelService } from "../kernel.js";
import { buildAdminTools } from "./admin.js";
import type { ToolsDeps, ToolDef } from "../tool-types.js";

function buildDeps(db: DatabaseSync): ToolsDeps {
  const kernel = new KernelService(db, { skipTypeCheck: true });
  return {
    db,
    kernel,
    maxBytesDefault: 65_536,
    createMcpServer: () => ({ name: "stub", version: "0", tools: [] }),
  } as ToolsDeps;
}

function getPruneTool(deps: ToolsDeps): ToolDef {
  const tool = buildAdminTools(deps).find((t) => t.name === "prune_records");
  if (!tool) throw new Error("prune_records not found");
  return tool;
}

function parsePayload(resp: unknown): Record<string, unknown> {
  const content = (resp as { content: Array<{ text?: string }> }).content;
  return JSON.parse(content[0]!.text!) as Record<string, unknown>;
}

/** Insert a stage_attempt row with the given started_at offset from now. */
function seedAttempt(
  db: DatabaseSync,
  opts: {
    attemptId: string;
    taskId: string;
    stageName?: string;
    startedAtOffset: number; // negative = in the past
  },
): void {
  db.prepare(
    `INSERT INTO stage_attempts
     (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status)
     VALUES (?, ?, 'v-stub', ?, 1, ?, 'success')`,
  ).run(
    opts.attemptId,
    opts.taskId,
    opts.stageName ?? "S",
    Date.now() + opts.startedAtOffset,
  );
}

describe("prune_records MCP tool", () => {
  let db: DatabaseSync;
  let deps: ToolsDeps;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    deps = buildDeps(db);
  });

  afterEach(() => {
    db.close();
  });

  it("is registered with name prune_records", () => {
    const tools = buildAdminTools(deps);
    expect(tools.find((t) => t.name === "prune_records")).toBeDefined();
  });

  it("has olderThanDays and dryRun in inputSchema", () => {
    const tool = getPruneTool(deps);
    expect(tool.inputSchema).toHaveProperty("olderThanDays");
    expect(tool.inputSchema).toHaveProperty("dryRun");
  });

  it("description is non-empty", () => {
    const tool = getPruneTool(deps);
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it("dry-run returns attempt count and does not alter DB", async () => {
    // Seed one row older than 30 days
    const thirtyOneDaysMs = 31 * 86_400_000;
    seedAttempt(db, {
      attemptId: "old-1",
      taskId: "task-old",
      startedAtOffset: -thirtyOneDaysMs,
    });
    // Seed one recent row (should NOT be counted)
    seedAttempt(db, {
      attemptId: "recent-1",
      taskId: "task-recent",
      startedAtOffset: -1000,
    });

    const tool = getPruneTool(deps);
    const resp = await tool.handler({ olderThanDays: 30, dryRun: true });
    const payload = parsePayload(resp);

    expect(payload.ok).toBe(true);
    expect(payload.dryRun).toBe(true);
    expect((payload.wouldDelete as Record<string, number>).attempts).toBe(1);

    // Both rows still present — dry-run must not delete
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM stage_attempts").get() as { n: number }
    ).n;
    expect(count).toBe(2);
  });

  it("actual prune deletes old rows and returns counts", async () => {
    const thirtyOneDaysMs = 31 * 86_400_000;
    seedAttempt(db, {
      attemptId: "old-a",
      taskId: "task-prune",
      startedAtOffset: -thirtyOneDaysMs,
    });
    seedAttempt(db, {
      attemptId: "recent-b",
      taskId: "task-prune",
      startedAtOffset: -1000,
    });

    const tool = getPruneTool(deps);
    const resp = await tool.handler({ olderThanDays: 30, dryRun: false });
    const payload = parsePayload(resp);

    expect(payload.ok).toBe(true);
    expect(payload.dryRun).toBe(false);
    const deleted = payload.deleted as Record<string, number>;
    expect(deleted.attempts).toBe(1);

    // Only the recent row remains
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM stage_attempts").get() as { n: number }
    ).n;
    expect(count).toBe(1);
    const remaining = db
      .prepare("SELECT attempt_id FROM stage_attempts")
      .get() as { attempt_id: string };
    expect(remaining.attempt_id).toBe("recent-b");
  });

  it("defaults olderThanDays to 30 when not supplied", async () => {
    // A row from 31 days ago should be caught by the default threshold
    const thirtyOneDaysMs = 31 * 86_400_000;
    seedAttempt(db, {
      attemptId: "old-default",
      taskId: "task-default",
      startedAtOffset: -thirtyOneDaysMs,
    });

    const tool = getPruneTool(deps);
    // omit olderThanDays — handler must default to 30
    const resp = await tool.handler({ dryRun: true });
    const payload = parsePayload(resp);

    expect(payload.ok).toBe(true);
    expect(payload.olderThanDays).toBe(30);
    expect((payload.wouldDelete as Record<string, number>).attempts).toBe(1);
  });

  it("returns ok:true with zero counts when no rows qualify", async () => {
    seedAttempt(db, {
      attemptId: "recent-only",
      taskId: "task-new",
      startedAtOffset: -1000,
    });

    const tool = getPruneTool(deps);
    const resp = await tool.handler({ olderThanDays: 30, dryRun: false });
    const payload = parsePayload(resp);

    expect(payload.ok).toBe(true);
    const deleted = payload.deleted as Record<string, number>;
    expect(deleted.attempts).toBe(0);

    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM stage_attempts").get() as { n: number }
    ).n;
    expect(count).toBe(1);
  });
});
