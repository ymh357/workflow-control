// Tests for gate-timeout-sweeper (P5.2 / D6).
//
// Covers the opt-in contract: gates without timeout_minutes are never
// swept; gates past their deadline are cancelled via KernelService.cancelTask
// (writes task_finals with final_state='cancelled' + a clear reason).
// Already-answered gates and already-terminal tasks are skipped.

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { versionHash } from "../ir/canonical.js";
import { PipelineIRSchema } from "../ir/schema.js";
import type { PipelineIR } from "../ir/schema.js";
import { sweepTimedOutGates } from "./gate-timeout-sweeper.js";

function parseIR(raw: unknown): PipelineIR {
  return PipelineIRSchema.parse(raw) as unknown as PipelineIR;
}

// Gate pipeline whose timeout_minutes is injected by the caller.
// When timeoutMinutes is undefined, the gate is a no-timeout (opt-out) gate.
function gateIR(timeoutMinutes?: number): PipelineIR {
  const gateConfig: Record<string, unknown> = {
    question: { text: "proceed?" },
    routing: { routes: { approve: "after", reject: "entry" } },
  };
  if (timeoutMinutes !== undefined) gateConfig.timeout_minutes = timeoutMinutes;

  return parseIR({
    name: "gate-timeout-test",
    externalInputs: [{ name: "seed", type: "string" }],
    stages: [
      {
        name: "entry", type: "agent",
        inputs: [{ name: "seed", type: "string" }],
        outputs: [{ name: "payload", type: "string" }],
        config: { promptRef: "p" },
      },
      {
        name: "gate1", type: "gate",
        inputs: [{ name: "__gate_signal", type: "unknown" }],
        outputs: [],
        config: gateConfig,
      },
      {
        name: "after", type: "agent",
        inputs: [{ name: "payload", type: "string" }],
        outputs: [{ name: "done", type: "string" }],
        config: { promptRef: "p" },
      },
    ],
    wires: [
      { from: { source: "external", port: "seed" }, to: { stage: "entry", port: "seed" } },
      { from: { stage: "entry", port: "payload" }, to: { stage: "gate1", port: "__gate_signal" } },
      { from: { stage: "entry", port: "payload" }, to: { stage: "after", port: "payload" } },
    ],
  });
}

interface SeedOpts {
  db: DatabaseSync;
  taskId: string;
  timeoutMinutes?: number;
  gateCreatedAt: number;
  gateAnswered?: boolean;
  gateAttemptId?: string;
  gateId?: string;
  taskAlreadyTerminal?: boolean;
  stageName?: string;
}

// Seeds the minimum rows needed for the sweeper to observe a gate:
// pipeline_versions + a stage_attempts row for the gate stage + a
// gate_queue row. Returns the version_hash so the caller can reuse it.
function seedGate(opts: SeedOpts): string {
  const stageName = opts.stageName ?? "gate1";
  const ir = gateIR(opts.timeoutMinutes);
  const hash = versionHash(ir);
  insertPipelineVersion(opts.db, ir, { versionHash: hash, tsSource: "" });

  const attemptId = opts.gateAttemptId ?? `att-${opts.taskId}`;
  opts.db.prepare(
    `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
     VALUES (?, ?, ?, 0, ?, 'regular', 'running', ?)`,
  ).run(attemptId, opts.taskId, stageName, hash, opts.gateCreatedAt);

  const gateId = opts.gateId ?? `gq-${opts.taskId}`;
  if (opts.gateAnswered) {
    opts.db.prepare(
      `INSERT INTO gate_queue (gate_id, task_id, stage_name, attempt_id, question_json, answer, answered_at, created_at)
       VALUES (?, ?, ?, ?, '{"text":"proceed?"}', 'approve', ?, ?)`,
    ).run(gateId, opts.taskId, stageName, attemptId, opts.gateCreatedAt + 1, opts.gateCreatedAt);
  } else {
    opts.db.prepare(
      `INSERT INTO gate_queue (gate_id, task_id, stage_name, attempt_id, question_json, created_at)
       VALUES (?, ?, ?, ?, '{"text":"proceed?"}', ?)`,
    ).run(gateId, opts.taskId, stageName, attemptId, opts.gateCreatedAt);
  }

  if (opts.taskAlreadyTerminal) {
    // reason is a CHECK enum: use 'natural' to represent an organic
    // completion that beat the sweeper to the task_finals write.
    opts.db.prepare(
      `INSERT INTO task_finals (task_id, version_hash, final_state, reason, detail, ended_at)
       VALUES (?, ?, 'completed', 'natural', 'done', ?)`,
    ).run(opts.taskId, hash, opts.gateCreatedAt + 10);
  }

  return hash;
}

describe("gate-timeout-sweeper", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
  });

  it("does nothing when no gates queued", () => {
    const result = sweepTimedOutGates(db);
    expect(result.swept).toBe(0);
    expect(result.cancelled).toEqual([]);
  });

  it("does not sweep gates whose stage has no timeout_minutes", () => {
    // Very old gate, but no timeout_minutes → opt-out.
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    seedGate({
      db,
      taskId: "t-no-timeout",
      timeoutMinutes: undefined,
      gateCreatedAt: tenDaysAgo,
    });

    const result = sweepTimedOutGates(db);
    expect(result.swept).toBe(0);

    // gate_queue row still unanswered; no task_finals row.
    const gateRow = db.prepare(`SELECT answered_at FROM gate_queue WHERE task_id = ?`).get("t-no-timeout");
    expect(gateRow).toBeDefined();
    const finalRow = db.prepare(`SELECT 1 FROM task_finals WHERE task_id = ?`).get("t-no-timeout");
    expect(finalRow).toBeUndefined();
  });

  it("does not sweep gates still within their timeout window", () => {
    // timeout=60m, created 30m ago → 30m remaining.
    const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
    seedGate({
      db,
      taskId: "t-within",
      timeoutMinutes: 60,
      gateCreatedAt: thirtyMinAgo,
    });

    const result = sweepTimedOutGates(db);
    expect(result.swept).toBe(0);
    const finalRow = db.prepare(`SELECT 1 FROM task_finals WHERE task_id = ?`).get("t-within");
    expect(finalRow).toBeUndefined();
  });

  it("sweeps a gate past its timeout and cancels the task", () => {
    // timeout=60m, created 120m ago → 60m past deadline.
    const twoHoursAgo = Date.now() - 120 * 60 * 1000;
    seedGate({
      db,
      taskId: "t-timed-out",
      timeoutMinutes: 60,
      gateCreatedAt: twoHoursAgo,
    });

    const result = sweepTimedOutGates(db);
    expect(result.swept).toBe(1);
    expect(result.cancelled).toHaveLength(1);
    expect(result.cancelled[0]!.taskId).toBe("t-timed-out");
    expect(result.cancelled[0]!.reason).toContain("gate_timeout");
    expect(result.cancelled[0]!.reason).toContain("gate1");
    expect(result.cancelled[0]!.reason).toContain("60");

    const finalRow = db.prepare(
      `SELECT final_state, reason, detail FROM task_finals WHERE task_id = ?`,
    ).get("t-timed-out") as { final_state: string; reason: string; detail: string };
    expect(finalRow.final_state).toBe("cancelled");
    expect(finalRow.reason).toBe("cancelled");
    expect(finalRow.detail).toContain("gate_timeout");
    expect(finalRow.detail).toContain("gate-timeout-sweeper");
  });

  it("sweeps multiple timed-out gates in one run", () => {
    const threeHoursAgo = Date.now() - 180 * 60 * 1000;
    seedGate({
      db, taskId: "t-a", timeoutMinutes: 60, gateCreatedAt: threeHoursAgo,
      gateAttemptId: "att-a", gateId: "gq-a",
    });
    seedGate({
      db, taskId: "t-b", timeoutMinutes: 30, gateCreatedAt: threeHoursAgo,
      gateAttemptId: "att-b", gateId: "gq-b",
    });

    const result = sweepTimedOutGates(db);
    expect(result.swept).toBe(2);
    const sweptIds = result.cancelled.map((c) => c.taskId).sort();
    expect(sweptIds).toEqual(["t-a", "t-b"]);

    for (const id of ["t-a", "t-b"]) {
      const row = db.prepare(
        `SELECT final_state FROM task_finals WHERE task_id = ?`,
      ).get(id) as { final_state: string } | undefined;
      expect(row?.final_state).toBe("cancelled");
    }
  });

  it("skips already-answered gates even if past their deadline", () => {
    const twoHoursAgo = Date.now() - 120 * 60 * 1000;
    seedGate({
      db,
      taskId: "t-answered",
      timeoutMinutes: 60,
      gateCreatedAt: twoHoursAgo,
      gateAnswered: true,
    });

    const result = sweepTimedOutGates(db);
    expect(result.swept).toBe(0);
    const finalRow = db.prepare(`SELECT 1 FROM task_finals WHERE task_id = ?`).get("t-answered");
    expect(finalRow).toBeUndefined();
  });

  it("skips gates whose task is already terminal (sticky-cancel contract)", () => {
    const twoHoursAgo = Date.now() - 120 * 60 * 1000;
    seedGate({
      db,
      taskId: "t-already-done",
      timeoutMinutes: 60,
      gateCreatedAt: twoHoursAgo,
      taskAlreadyTerminal: true,
    });

    const result = sweepTimedOutGates(db);
    expect(result.swept).toBe(0);
    // Pre-existing task_finals row should be preserved unchanged.
    const finalRow = db.prepare(
      `SELECT final_state FROM task_finals WHERE task_id = ?`,
    ).get("t-already-done") as { final_state: string };
    expect(finalRow.final_state).toBe("completed");
  });
});
