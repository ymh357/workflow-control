// kernel-next SSE event types.
//
// Independent from the legacy packages/shared SSEMessageType: legacy
// events are tied to Task.status (pending/in-progress/done) and
// `stage_change` carrying a single-string stage name. kernel-next has
// parallel stage regions, port writes, and structured error
// diagnostics — force-fitting into the legacy shape would blur the
// semantics on both sides.
//
// The broadcaster is append-only — events reflect facts the runner
// already has. Consumers replay history on subscribe and then receive
// live events in dispatch order.

export type KernelNextSSEEventType =
  | "task_state"         // TaskMachine top-level state change
  | "stage_executing"    // a stage region entered the executing substate
  | "stage_done"         // a stage region reached its `done` final
  | "stage_error"        // a stage region reached its `error` final (NO_ACTIVE_WIRE or executor failure)
  | "stage_retry"        // runner caught RETRY_TO_STAGE: a script failed but retry is in budget, backToStage is being rerun
  | "port_written"       // a single port_values row was written on the live PortRuntime
  | "stage_rolled_back"  // gate-reject rollback: runner pruned one or more stages back to a prior point
  | "run_final"          // top-level machine reached `completed` or `failed`; carries aggregated diagnostics
  | "diagnostics_emitted"; // multi-diagnostic aggregation (runtime stage errors, submit/migrate validation failures)

export type TaskTopLevelState =
  | "idle" | "running" | "completed" | "failed";

export interface KernelNextSSEEvent {
  type: KernelNextSSEEventType;
  taskId: string;
  // ISO 8601 UTC. Assigned at publish time, not at event origin — for
  // in-process runs the skew is sub-millisecond. Consumers should not
  // rely on this for causal ordering; history order is authoritative.
  timestamp: string;
  data: unknown;
  // Per-task monotonic sequence. Callers of `broadcaster.publish`
  // never set this — the broadcaster stamps it. Present on every event
  // observed by subscribers or inspected via `historyFor()`. Typed as
  // optional only so authoring sites don't need to pass a placeholder;
  // the runtime invariant is that every delivered event has a seq.
  seq?: number;
}

export interface TaskStateData {
  state: TaskTopLevelState;
}

export interface StageExecutingData {
  stage: string;
  // Present for gate stages (runner owns the attempt_id). For
  // invoke'd agent/script stages and fanout-orchestrated stages the
  // attempt_id lives inside the executor / orchestrator and is not
  // surfaced to runner at dispatch time; the UI should tolerate its
  // absence and correlate via port_written events or read_port.
  attemptId?: string;
}

export interface StageDoneData {
  stage: string;
  // attemptId is present when the executor opened one. NO_ACTIVE_WIRE
  // paths reach `done` vacuously (gate-skipped targets) without
  // opening an attempt — that case emits a stage_done with attemptId
  // absent rather than inventing a placeholder.
  attemptId?: string;
}

export interface StageErrorData {
  stage: string;
  attemptId?: string;
  message: string;
  // Classifies the cause of the stage reaching its `error` final so
  // UIs can distinguish a wire-topology failure from an executor
  // failure without string-matching `message`. Absent on legacy
  // emitters that pre-date this field; consumers should treat absence
  // as `no_active_wire` for backwards compatibility.
  reason?: "no_active_wire" | "executor_failed";
  // Opaque payload for rich errors (e.g. NO_ACTIVE_WIRE's
  // failedWires[] from runner.buildNoActiveWireError). Kept as
  // `unknown` so callers don't accidentally couple to the internal
  // shape; UIs render what they understand and ignore the rest.
  context?: unknown;
}

export interface StageRetryData {
  // The stage that just failed (the script whose executor errored).
  stage: string;
  // The upstream stage whose execution is being restarted.
  backToStage: string;
  // 0-based retry count as of this retry. 0 = this is the first retry
  // (first failure for this stage), 1 = second, etc. After this retry
  // fires, runner increments retryCounts[stage]; the next failure sees
  // retryIdx = retryCounts[stage] at emission time.
  retryIdx: number;
  // Upper bound on retries for this stage, from ScriptStage.config.retry.
  // When retryIdx + 1 would exceed maxRetries, runner does NOT emit
  // another stage_retry — it lets the stage's STAGE_FAILED transition
  // fall through to the error final (surfacing as stage_error instead).
  maxRetries: number;
  // Concrete executor error message (the same value that would have
  // been surfaced on stage_error.reason=executor_failed if retry were
  // out of budget). Included here so UIs can show "retrying because X".
  errorMessage: string;
}

export interface PortWrittenData {
  stage: string;
  port: string;
  // JSON-stringified value truncated to PREVIEW_BYTES (200). Prevents
  // a large port value from blowing up the event stream; UIs that
  // need the full value can fetch via read_port or query_lineage.
  valuePreview: string;
}

export interface StageRolledBackData {
  // The gate stage whose reject decision triggered the rollback.
  fromGate: string;
  // The earliest stage being re-executed after rollback.
  toStage: string;
  // All stage IDs whose port writes were pruned (toStage … fromGate inclusive).
  affectedStages: string[];
}

export interface RunFinalData {
  finalState: "completed" | "failed";
  // Flattened stage-level errors captured at run end. Matches
  // runner.RunResult.stageErrors shape minus the executor-specific
  // context (we keep the public fields only).
  stageErrors: Array<{ stage: string; message: string }>;
}

// P4.4 / D30 — multi-diagnostic aggregation.
//
// Emitted in parallel with `run_final` (when stageErrors is non-empty)
// and, in later tiers, alongside submit/migrate HTTP failures that
// return >1 diagnostic. The dashboard groups by `code` so users see
// "STORE_SCHEMA_STAGE_MISSING (3)" collapsed rather than three near-
// identical error rows. `source` lets the UI attribute the batch to
// the subsystem that produced it.
export interface DiagnosticsEmittedData {
  source: "submit" | "migrate" | "runtime" | "validator";
  diagnostics: Array<{
    code: string;
    message: string;
    severity?: "error" | "warning";
  }>;
}

// Narrowed event variants. Broadcaster handles KernelNextSSEEvent
// generically; typed helpers at the publish site stay inside runner
// and port-runtime.
export interface KernelNextTaskStateEvent extends KernelNextSSEEvent {
  type: "task_state";
  data: TaskStateData;
}
export interface KernelNextStageExecutingEvent extends KernelNextSSEEvent {
  type: "stage_executing";
  data: StageExecutingData;
}
export interface KernelNextStageDoneEvent extends KernelNextSSEEvent {
  type: "stage_done";
  data: StageDoneData;
}
export interface KernelNextStageErrorEvent extends KernelNextSSEEvent {
  type: "stage_error";
  data: StageErrorData;
}
export interface KernelNextStageRetryEvent extends KernelNextSSEEvent {
  type: "stage_retry";
  data: StageRetryData;
}
export interface KernelNextPortWrittenEvent extends KernelNextSSEEvent {
  type: "port_written";
  data: PortWrittenData;
}
export interface KernelNextStageRolledBackEvent extends KernelNextSSEEvent {
  type: "stage_rolled_back";
  data: StageRolledBackData;
}
export interface KernelNextRunFinalEvent extends KernelNextSSEEvent {
  type: "run_final";
  data: RunFinalData;
}
export interface KernelNextDiagnosticsEmittedEvent extends KernelNextSSEEvent {
  type: "diagnostics_emitted";
  data: DiagnosticsEmittedData;
}

export type AnyKernelNextSSEEvent =
  | KernelNextTaskStateEvent
  | KernelNextStageExecutingEvent
  | KernelNextStageDoneEvent
  | KernelNextStageErrorEvent
  | KernelNextStageRetryEvent
  | KernelNextPortWrittenEvent
  | KernelNextStageRolledBackEvent
  | KernelNextRunFinalEvent
  | KernelNextDiagnosticsEmittedEvent;
