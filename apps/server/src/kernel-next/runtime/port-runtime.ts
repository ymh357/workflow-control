// Port-runtime: bridges executor outputs to both persistent lineage storage
// (SQLite port_values / stage_attempts tables) and in-memory XState machine
// context (via PORT_WRITTEN events).
//
// Responsibilities:
//   1. Start a stage attempt: insert a stage_attempts row with auto-incrementing
//      attempt_idx (retry N -> attempt_idx N+1 for the same (task, stage)).
//   2. Record input reads: when executor reads an input port, log a
//      port_values row with direction='in'.
//   3. Record output writes: when executor produces an output, log a
//      port_values row with direction='out' AND dispatch PORT_WRITTEN to
//      the XState actor so downstream stages' waiting guards can re-evaluate.
//   4. Finalize a stage attempt: update ended_at + status.
//
// This module does NOT decide whether a stage has finished executing — that is
// the mock-executor's job (or the real agent's in phase 2). It just faithfully
// records what happened and notifies the machine.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { ActorRef } from "xstate";
import type { MachineEvent } from "../compiler/ir-to-machine.js";

export type AttemptStatus = "running" | "success" | "error" | "superseded";

export interface StartAttemptArgs {
  taskId: string;
  versionHash: string;
  stageName: string;
}

export interface StartAttemptResult {
  attemptId: string;
  attemptIdx: number;
}

export interface PortWriteArgs {
  attemptId: string;
  stageName: string;
  portName: string;
  value: unknown;
}

export interface PortReadArgs {
  attemptId: string;
  stageName: string;
  portName: string;
  value: unknown;
}

// Minimal actor-like shape — avoids depending on a specific XState actor type.
export interface EventDispatcher {
  send(event: MachineEvent): void;
}

export function createActorDispatcher(actor: ActorRef<never, never>): EventDispatcher {
  return {
    send(event) {
      // XState 5 actor.send is typed against the machine's event set. Callers
      // pass MachineEvent; at runtime this is a plain forward.
      (actor as unknown as { send(e: MachineEvent): void }).send(event);
    },
  };
}

export class PortRuntime {
  constructor(
    private readonly db: DatabaseSync,
    private readonly dispatcher: EventDispatcher,
  ) {}

  /**
   * Start a new attempt for a stage. Returns the attempt_id and the
   * 1-based attempt_idx (retries bump the idx).
   */
  startAttempt(args: StartAttemptArgs): StartAttemptResult {
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(attempt_idx), 0) AS max_idx
       FROM stage_attempts
       WHERE task_id = ? AND stage_name = ?`,
    ).get(args.taskId, args.stageName) as { max_idx: number };

    const attemptIdx = row.max_idx + 1;
    const attemptId = randomUUID();

    this.db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'running')`,
    ).run(attemptId, args.taskId, args.versionHash, args.stageName, attemptIdx, Date.now());

    return { attemptId, attemptIdx };
  }

  /**
   * Record that the executor read an input port. Pure lineage — no event
   * dispatch (reads don't unblock anyone).
   */
  recordRead(args: PortReadArgs): void {
    this.db.prepare(
      `INSERT INTO port_values
       (value_id, attempt_id, stage_name, port_name, direction, value_json, written_at)
       VALUES (?, ?, ?, ?, 'in', ?, ?)`,
    ).run(
      randomUUID(),
      args.attemptId,
      args.stageName,
      args.portName,
      JSON.stringify(args.value),
      Date.now(),
    );
  }

  /**
   * Record an output write AND dispatch PORT_WRITTEN to the machine so
   * downstream stages' waiting guards re-evaluate.
   */
  writePort(args: PortWriteArgs): void {
    this.db.prepare(
      `INSERT INTO port_values
       (value_id, attempt_id, stage_name, port_name, direction, value_json, written_at)
       VALUES (?, ?, ?, ?, 'out', ?, ?)`,
    ).run(
      randomUUID(),
      args.attemptId,
      args.stageName,
      args.portName,
      JSON.stringify(args.value),
      Date.now(),
    );

    this.dispatcher.send({
      type: "PORT_WRITTEN",
      key: `${args.stageName}.${args.portName}`,
      value: args.value,
    });
  }

  /**
   * Finalize a stage attempt. `success` means the executor returned without
   * error; `error` is a controlled failure (retry-eligible); `superseded` is
   * reserved for hot-update phase 2.
   *
   * On `error`, the runtime ALSO dispatches STAGE_FAILED so the machine can
   * transition the stage region to its error terminal. Without this event,
   * the stage would stay stuck in `executing`.
   */
  finishAttempt(
    attemptId: string,
    status: AttemptStatus,
    errorMessage?: string,
  ): void {
    this.db.prepare(
      `UPDATE stage_attempts SET ended_at = ?, status = ? WHERE attempt_id = ?`,
    ).run(Date.now(), status, attemptId);

    if (status === "error") {
      // Look up the stage name for the event payload.
      const row = this.db.prepare(
        `SELECT stage_name FROM stage_attempts WHERE attempt_id = ?`,
      ).get(attemptId) as { stage_name: string } | undefined;
      if (row) {
        this.dispatcher.send({
          type: "STAGE_FAILED",
          stage: row.stage_name,
          error: errorMessage ?? "unspecified",
        });
      }
    }
  }
}

/**
 * Returns the latest port_value row (direction='out') for a (stage, port),
 * scoped to the latest successful attempt. Used by tests and by read_port
 * (M4) as the "current value" resolver.
 */
export function readLatestPort(
  db: DatabaseSync,
  stageName: string,
  portName: string,
  taskId?: string,
): { value: unknown; attemptId: string; attemptIdx: number; writtenAt: number } | null {
  const sql = taskId
    ? `SELECT pv.value_json, pv.attempt_id, pv.written_at, sa.attempt_idx
       FROM port_values pv
       JOIN stage_attempts sa ON sa.attempt_id = pv.attempt_id
       WHERE pv.stage_name = ? AND pv.port_name = ? AND pv.direction = 'out'
         AND sa.task_id = ?
       ORDER BY pv.written_at DESC LIMIT 1`
    : `SELECT pv.value_json, pv.attempt_id, pv.written_at, sa.attempt_idx
       FROM port_values pv
       JOIN stage_attempts sa ON sa.attempt_id = pv.attempt_id
       WHERE pv.stage_name = ? AND pv.port_name = ? AND pv.direction = 'out'
       ORDER BY pv.written_at DESC LIMIT 1`;
  const row = taskId
    ? (db.prepare(sql).get(stageName, portName, taskId) as { value_json: string; attempt_id: string; written_at: number; attempt_idx: number } | undefined)
    : (db.prepare(sql).get(stageName, portName) as { value_json: string; attempt_id: string; written_at: number; attempt_idx: number } | undefined);
  if (!row) return null;
  return {
    value: JSON.parse(row.value_json),
    attemptId: row.attempt_id,
    attemptIdx: row.attempt_idx,
    writtenAt: row.written_at,
  };
}
