import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { openScriptExecutionRecordWriter } from "./script-execution-record-writer.js";

function seedAttempt(db: DatabaseSync, attemptId: string): void {
  db.prepare(
    `INSERT INTO pipeline_versions (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
     VALUES ('v1','t',0,NULL,'{}','')`,
  ).run();
  db.prepare(
    `INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status)
     VALUES (?, 'tk', 'v1', 'S', 1, 0, 'running')`,
  ).run(attemptId);
}

describe("script-execution-record-writer", () => {
  it("opens a row with module_id + inputs snapshot + started_at", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seedAttempt(db, "a1");

    const w = openScriptExecutionRecordWriter(db, {
      attemptId: "a1",
      moduleId: "double",
      inputs: { x: 21 },
    });

    const row = db.prepare(
      "SELECT * FROM script_execution_details WHERE attempt_id = ?",
    ).get("a1") as Record<string, unknown>;
    expect(row.module_id).toBe("double");
    expect(JSON.parse(row.inputs_json as string)).toEqual({ x: 21 });
    expect(row.outputs_json).toBe("{}");
    expect(Number(row.started_at)).toBeGreaterThan(0);
    expect(row.ended_at).toBeNull();

    w.close({ terminationReason: "natural_completion", outputs: { y: 42 } });
  });

  it("close writes outputs_json + ended_at + duration_ms + termination_reason", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seedAttempt(db, "a2");
    const w = openScriptExecutionRecordWriter(db, {
      attemptId: "a2", moduleId: "m", inputs: { a: 1 },
    });
    w.close({
      terminationReason: "natural_completion",
      outputs: { y: 1, extra: "kept" },
    });
    const row = db.prepare(
      "SELECT * FROM script_execution_details WHERE attempt_id = ?",
    ).get("a2") as Record<string, unknown>;
    expect(row.termination_reason).toBe("natural_completion");
    expect(JSON.parse(row.outputs_json as string)).toEqual({ y: 1, extra: "kept" });
    expect(Number(row.ended_at)).toBeGreaterThanOrEqual(Number(row.started_at));
    expect(Number(row.duration_ms)).toBeGreaterThanOrEqual(0);
  });

  it("close with error captures error_message + error_stack", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seedAttempt(db, "a3");
    const w = openScriptExecutionRecordWriter(db, {
      attemptId: "a3", moduleId: "m", inputs: {},
    });
    w.close({
      terminationReason: "error",
      errorMessage: "boom",
      errorStack: "at foo (x:1:1)",
    });
    const row = db.prepare(
      "SELECT termination_reason, error_message, error_stack FROM script_execution_details WHERE attempt_id = ?",
    ).get("a3") as { termination_reason: string; error_message: string; error_stack: string };
    expect(row.termination_reason).toBe("error");
    expect(row.error_message).toBe("boom");
    expect(row.error_stack).toBe("at foo (x:1:1)");
  });

  it("close with module_not_found reason", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seedAttempt(db, "a4");
    const w = openScriptExecutionRecordWriter(db, {
      attemptId: "a4", moduleId: "missing", inputs: {},
    });
    w.close({
      terminationReason: "module_not_found",
      errorMessage: "Script module 'missing' not found",
    });
    const row = db.prepare(
      "SELECT termination_reason FROM script_execution_details WHERE attempt_id = ?",
    ).get("a4") as { termination_reason: string };
    expect(row.termination_reason).toBe("module_not_found");
  });

  it("close is idempotent (second call is a no-op)", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seedAttempt(db, "a5");
    const w = openScriptExecutionRecordWriter(db, {
      attemptId: "a5", moduleId: "m", inputs: {},
    });
    w.close({ terminationReason: "natural_completion", outputs: { y: 1 } });
    const row1 = db.prepare(
      "SELECT ended_at, termination_reason FROM script_execution_details WHERE attempt_id = ?",
    ).get("a5") as { ended_at: number; termination_reason: string };

    w.close({ terminationReason: "error", errorMessage: "late" });
    const row2 = db.prepare(
      "SELECT ended_at, termination_reason, error_message FROM script_execution_details WHERE attempt_id = ?",
    ).get("a5") as { ended_at: number; termination_reason: string; error_message: string | null };

    expect(row2.ended_at).toBe(row1.ended_at);
    expect(row2.termination_reason).toBe(row1.termination_reason);
    expect(row2.error_message).toBeNull();
  });

  it("append/set methods persist stdout/stderr/exit_code via flush", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seedAttempt(db, "a6");
    const w = openScriptExecutionRecordWriter(db, {
      attemptId: "a6", moduleId: "m", inputs: {},
    });
    w.appendStdout("line1\n");
    w.appendStdout("line2\n");
    w.appendStderr("warn\n");
    w.setExitCode(0);
    w.close({ terminationReason: "natural_completion" });
    const row = db.prepare(
      "SELECT stdout, stderr, exit_code FROM script_execution_details WHERE attempt_id = ?",
    ).get("a6") as { stdout: string; stderr: string; exit_code: number };
    expect(row.stdout).toBe("line1\nline2\n");
    expect(row.stderr).toBe("warn\n");
    expect(row.exit_code).toBe(0);
  });

  it("returns no-op writer + logs warning when FK violates (missing stage_attempts row)", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);

    const w = openScriptExecutionRecordWriter(db, {
      attemptId: "missing-attempt",
      moduleId: "m",
      inputs: {},
    });
    expect(() => {
      w.appendStdout("x");
      w.appendStderr("y");
      w.setExitCode(1);
      w.close({ terminationReason: "error", errorMessage: "x" });
    }).not.toThrow();
    const row = db.prepare(
      "SELECT COUNT(*) AS n FROM script_execution_details WHERE attempt_id = ?",
    ).get("missing-attempt") as { n: number };
    expect(row.n).toBe(0);
  });

  it("inputs snapshot that is not JSON-serializable is replaced with a marker, not thrown", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seedAttempt(db, "a7");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => {
      const w = openScriptExecutionRecordWriter(db, {
        attemptId: "a7",
        moduleId: "m",
        inputs: cyclic,
      });
      w.close({ terminationReason: "natural_completion" });
    }).not.toThrow();

    const row = db.prepare(
      "SELECT inputs_json FROM script_execution_details WHERE attempt_id = ?",
    ).get("a7") as { inputs_json: string };
    expect(row.inputs_json).toMatch(/unserializable/);
  });
});
