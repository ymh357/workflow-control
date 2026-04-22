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

// Debt #7 — attempt provenance. `regular` is the default (single-execution
// stage attempt, including gates and retries). `fanout_element` tags the
// per-element silent attempts opened by runner.orchestrateFanoutStage; they
// write lineage but do not advance the machine. `fanout_aggregate` tags
// the single aggregate attempt that writes the fanout stage's declared
// output arrays. `external` tags the single seed-phase attempt opened by
// runner before actor.start(), whose port_values rows carry the
// externalInputs values (§4.7 of the legacy-yaml-converter spec). Callers
// that care about attempt provenance (diff_runs, future UI) filter on
// this column instead of inferring from stage shape.
export type AttemptKind =
  | "regular"
  | "fanout_element"
  | "fanout_aggregate"
  | "external"
  | "replay"
  | "dry_run";

export interface StartAttemptArgs {
  taskId: string;
  versionHash: string;
  stageName: string;
  // Optional per-call override. When unset, the PortRuntime's
  // constructor-supplied `defaultKind` (or 'regular' if none) is used.
  kind?: AttemptKind;
  // When true, skip firing AttemptHooks.onAttemptStarted for this
  // attempt. Used by callers for attempts whose end-of-life does not
  // go through finishAttempt (gates finalised via raw SQL in
  // KernelService.answerGate) or whose lifespan is synchronous and
  // observationally uninteresting (external-seed attempt, fanout
  // aggregate). Since captureAfter treats a missing row as a no-op,
  // suppressing the start hook cleanly prevents dangling 'capturing'
  // rows without needing a separate finish-hook suppression signal.
  suppressHooks?: boolean;
  // A4 replay_stage: when this attempt reproduces an earlier attempt,
  // points back at that attempt's id. NULL for non-replay attempts.
  replayedFromAttemptId?: string;
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

export interface PortWrittenHook {
  (args: { stageName: string; portName: string; value: unknown }): void;
}

// Fire-and-forget hooks invoked by startAttempt / finishAttempt so the
// runner can thread checkpoint capture (and any future observational
// side-effect) around the lifecycle without the PortRuntime having to
// know about it. Hooks return `void` and MUST handle their own errors
// — PortRuntime does not await or catch.
export interface AttemptHooks {
  onAttemptStarted?: (attemptId: string, args: StartAttemptArgs) => void;
  onAttemptFinishing?: (attemptId: string) => void;
}

export class PortRuntime {
  constructor(
    private readonly db: DatabaseSync,
    private readonly dispatcher: EventDispatcher,
    // Debt #7 — per-runtime default for stage_attempts.kind. runner's
    // orchestrateFanoutStage constructs a silent PortRuntime with
    // defaultKind='fanout_element' so every per-element attempt carries
    // the tag without each executor having to thread it through.
    private readonly defaultKind: AttemptKind = "regular",
    // Slice 2 — observability hook. Invoked synchronously after a
    // successful writePort, AFTER the DB row is inserted and AFTER
    // the machine dispatcher has delivered PORT_WRITTEN. The runner
    // attaches this on the live PortRuntime to publish SSE
    // port_written events; silent runtimes (fanout element) do not
    // pass it, so intermediate element writes are not broadcast.
    private readonly onPortWritten?: PortWrittenHook,
    // Phase 4.5 — checkpoint lifecycle hooks. onAttemptStarted fires at
    // the end of startAttempt (after the stage_attempts INSERT has
    // landed, so FK-bearing writes like checkpoint INSERTs succeed).
    // onAttemptFinishing fires at the top of finishAttempt (before the
    // UPDATE, so hook consumers see status='running'). Both are
    // synchronous void; errors are swallowed.
    private readonly hooks: AttemptHooks = {},
  ) {}

  /**
   * Expose the dispatcher so higher layers (e.g. RealStageExecutor) can
   * hand the same machine-bound dispatcher to out-of-band writers like
   * the MCP `write_port` tool. Without this, tool-driven port writes go
   * to an inert dispatcher and the machine never receives PORT_WRITTEN.
   */
  getDispatcher(): EventDispatcher {
    return this.dispatcher;
  }

  /**
   * Kernel-next DB handle. Used by executors that write sidecar tables
   * (e.g. RealStageExecutor + execution-record-writer for
   * agent_execution_details rows). All sidecar writers share the same
   * underlying connection so FK constraints into stage_attempts resolve.
   */
  getDb(): DatabaseSync {
    return this.db;
  }

  /**
   * Read all direction='out' port_values rows written during a specific
   * attempt. Used by executors to verify that agent-side tool calls (e.g.
   * MCP `write_port`) produced the expected outputs for the attempt,
   * without leaking the db handle.
   */
  readWritesForAttempt(attemptId: string): Array<{ port: string; value: unknown }> {
    const rows = this.db.prepare(
      `SELECT port_name, value_json FROM port_values
       WHERE attempt_id = ? AND direction = 'out'
       ORDER BY written_at ASC`,
    ).all(attemptId) as Array<{ port_name: string; value_json: string }>;
    return rows.map((r) => ({ port: r.port_name, value: JSON.parse(r.value_json) }));
  }

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
    const kind = args.kind ?? this.defaultKind;

    this.db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx,
        started_at, status, kind, replayed_from_attempt_id)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
    ).run(
      attemptId,
      args.taskId,
      args.versionHash,
      args.stageName,
      attemptIdx,
      Date.now(),
      kind,
      args.replayedFromAttemptId ?? null,
    );

    if (this.hooks.onAttemptStarted && !args.suppressHooks) {
      try {
        this.hooks.onAttemptStarted(attemptId, args);
      } catch {
        // Synchronous hook errors must not break startAttempt.
        // Hook owners handle their own async errors internally.
      }
    }
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

    // Slice 2 — observability hook. After the DB row is persisted
    // and the machine has seen PORT_WRITTEN, notify any attached
    // observer. Errors in the hook are caught here because the hook
    // runs on the writePort hot path and a broken observer must not
    // break port delivery.
    if (this.onPortWritten) {
      try {
        this.onPortWritten({
          stageName: args.stageName,
          portName: args.portName,
          value: args.value,
        });
      } catch { /* observer failure isolated from write path */ }
    }
  }

  /**
   * Finalize a stage attempt. `success` means the executor returned without
   * error; `error` is a controlled failure (retry-eligible); `superseded` is
   * reserved for hot-update phase 2.
   *
   * On `error`, the runtime ALSO dispatches STAGE_FAILED so the machine can
   * transition the stage region to its error terminal. Without this event,
   * the stage would stay stuck in `executing`.
   *
   * Pass `options.silent: true` for intermediate-retry failures: the DB row
   * is still updated to status='error' (lineage stays accurate), but no
   * STAGE_FAILED event is dispatched. The machine remains in `executing`,
   * allowing the caller to start a fresh attempt for the same stage. Used
   * by RealStageExecutor's internal retry loop.
   */
  finishAttempt(
    attemptId: string,
    status: AttemptStatus,
    errorMessage?: string,
    options?: { silent?: boolean },
  ): void {
    if (this.hooks.onAttemptFinishing) {
      try {
        this.hooks.onAttemptFinishing(attemptId);
      } catch {
        // see startAttempt — swallow synchronous errors so the
        // lineage UPDATE is never skipped by a broken hook.
      }
    }

    this.db.prepare(
      `UPDATE stage_attempts SET ended_at = ?, status = ? WHERE attempt_id = ?`,
    ).run(Date.now(), status, attemptId);

    if (status === "error" && !options?.silent) {
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
  // Secondary ORDER BY sa.attempt_idx DESC tie-breaks same-ms writes to
  // the highest attempt_idx. Critical for fanout: per-element +
  // aggregate attempts may share a millisecond; the aggregate (highest
  // idx) is the current value that downstream stages consumed.
  const sql = taskId
    ? `SELECT pv.value_json, pv.attempt_id, pv.written_at, sa.attempt_idx
       FROM port_values pv
       JOIN stage_attempts sa ON sa.attempt_id = pv.attempt_id
       WHERE pv.stage_name = ? AND pv.port_name = ? AND pv.direction = 'out'
         AND sa.task_id = ?
       ORDER BY pv.written_at DESC, sa.attempt_idx DESC LIMIT 1`
    : `SELECT pv.value_json, pv.attempt_id, pv.written_at, sa.attempt_idx
       FROM port_values pv
       JOIN stage_attempts sa ON sa.attempt_id = pv.attempt_id
       WHERE pv.stage_name = ? AND pv.port_name = ? AND pv.direction = 'out'
       ORDER BY pv.written_at DESC, sa.attempt_idx DESC LIMIT 1`;
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
