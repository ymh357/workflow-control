// Checkpoint module — shared types.
//
// Row lifecycle:
//   capturing       → captureBefore inserted, waiting for captureAfter
//   captured        → captureAfter completed happy-path
//   before_failed   → captureBefore could not resolve before_sha (terminal)
//   after_failed    → captureBefore OK; captureAfter saw error
//   not_a_repo      → workdir exists but is not a git repository (terminal)
//   disabled        → workdir missing at hook-fire time (terminal)
//   diff_too_large  → diff exceeded MAX_DIFF_BYTES cap; before/after SHAs kept

export type CheckpointStatus =
  | "capturing"
  | "captured"
  | "before_failed"
  | "after_failed"
  | "not_a_repo"
  | "disabled"
  | "diff_too_large";

export interface CheckpointTimeouts {
  revParseMs: number;
  snapshotMs: number;
  diffMs: number;
}

export interface CheckpointConfig {
  enabled?: boolean;
  workdir?: string;
  maxDiffBytes?: number;
  timeouts?: Partial<CheckpointTimeouts>;
}

export interface ResolvedCheckpointConfig {
  enabled: boolean;
  workdir: string;
  maxDiffBytes: number;
  timeouts: CheckpointTimeouts;
}

export interface CheckpointRow {
  attempt_id: string;
  workdir: string;
  before_sha: string | null;
  after_sha: string | null;
  diff_text: string | null;
  diff_bytes: number | null;
  status: CheckpointStatus;
  diagnostic: string | null;
  captured_before_at: number;
  captured_after_at: number | null;
}

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export const DEFAULT_CHECKPOINT_TIMEOUTS: CheckpointTimeouts = {
  revParseMs: 5_000,
  snapshotMs: 10_000,
  diffMs: 10_000,
};

export const DEFAULT_MAX_DIFF_BYTES = 5 * 1024 * 1024;
