// kernel-next script execution sidecar writer. Parallel to
// execution-record-writer.ts (agent sidecar). See CLAUDE.md §"Hard
// invariants": script executor MUST NOT be blocked by a failing sidecar.
//
// Writer contract:
//   * INSERT one row at open time (module_id, inputs snapshot, started_at).
//   * append*/set* methods buffer stdout / stderr / exit_code in memory and
//     flush on heartbeat() or close().
//   * close() UPDATEs terminating columns (outputs_json, duration_ms,
//     ended_at, termination_reason, error*).
//   * Never throws: FK violation at open → NoopWriter. Any later DB error
//     logs + swallows.
//   * close() is idempotent (first call wins).

import type { DatabaseSync } from "node:sqlite";
import { logger } from "../../lib/logger.js";
import type {
  CloseScriptWriterInput,
  OpenScriptWriterInput,
} from "./script-execution-record-types.js";

export interface ScriptExecutionRecordWriter {
  readonly attemptId: string;
  appendStdout(chunk: string): void;
  appendStderr(chunk: string): void;
  setExitCode(code: number | null): void;
  heartbeat(): void;
  close(input: CloseScriptWriterInput): void;
}

class NoopScriptWriter implements ScriptExecutionRecordWriter {
  constructor(public readonly attemptId: string) {}
  appendStdout(): void {}
  appendStderr(): void {}
  setExitCode(): void {}
  heartbeat(): void {}
  close(): void {}
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch (err) {
    return JSON.stringify({
      __unserializable: true,
      reason: (err as Error).message,
    });
  }
}

class ActiveScriptWriter implements ScriptExecutionRecordWriter {
  readonly attemptId: string;
  private readonly db: DatabaseSync;
  private readonly startedAt: number;
  private stdout: string | null = null;
  private stderr: string | null = null;
  private exitCode: number | null = null;
  private closed = false;

  constructor(db: DatabaseSync, attemptId: string, startedAt: number) {
    this.db = db;
    this.attemptId = attemptId;
    this.startedAt = startedAt;
  }

  appendStdout(chunk: string): void {
    if (this.closed) return;
    this.stdout = (this.stdout ?? "") + chunk;
  }

  appendStderr(chunk: string): void {
    if (this.closed) return;
    this.stderr = (this.stderr ?? "") + chunk;
  }

  setExitCode(code: number | null): void {
    if (this.closed) return;
    this.exitCode = code;
  }

  heartbeat(): void {
    if (this.closed) return;
    this.flushProgress();
  }

  close(input: CloseScriptWriterInput): void {
    if (this.closed) return;
    this.closed = true;
    const endedAt = Date.now();
    try {
      this.db.prepare(
        `UPDATE script_execution_details
         SET outputs_json       = ?,
             stdout             = ?,
             stderr             = ?,
             exit_code          = ?,
             error_message      = ?,
             error_stack        = ?,
             ended_at           = ?,
             duration_ms        = ?,
             termination_reason = ?
         WHERE attempt_id = ?`,
      ).run(
        safeStringify(input.outputs ?? {}),
        this.stdout,
        this.stderr,
        input.exitCode !== undefined ? input.exitCode : this.exitCode,
        input.errorMessage ?? null,
        input.errorStack ?? null,
        endedAt,
        endedAt - this.startedAt,
        input.terminationReason,
        this.attemptId,
      );
    } catch (err) {
      logger.error(
        { attemptId: this.attemptId, err: (err as Error).message },
        "[script-execution-record-writer] close failed",
      );
    }
  }

  private flushProgress(): void {
    if (this.closed) return;
    try {
      this.db.prepare(
        `UPDATE script_execution_details
         SET stdout = ?, stderr = ?, exit_code = ?
         WHERE attempt_id = ?`,
      ).run(this.stdout, this.stderr, this.exitCode, this.attemptId);
    } catch (err) {
      logger.error(
        { attemptId: this.attemptId, err: (err as Error).message },
        "[script-execution-record-writer] heartbeat flush failed",
      );
    }
  }
}

export function openScriptExecutionRecordWriter(
  db: DatabaseSync,
  input: OpenScriptWriterInput,
): ScriptExecutionRecordWriter {
  const startedAt = Date.now();
  try {
    db.prepare(
      `INSERT INTO script_execution_details
       (attempt_id, module_id, inputs_json, started_at)
       VALUES (?, ?, ?, ?)`,
    ).run(
      input.attemptId,
      input.moduleId,
      safeStringify(input.inputs),
      startedAt,
    );
    return new ActiveScriptWriter(db, input.attemptId, startedAt);
  } catch (err) {
    logger.warn(
      { attemptId: input.attemptId, err: (err as Error).message },
      "[script-execution-record-writer] open failed; falling back to no-op writer",
    );
    return new NoopScriptWriter(input.attemptId);
  }
}
