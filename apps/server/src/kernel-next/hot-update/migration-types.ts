// Shared types for Stage 5B migration execution engine.

export interface TerminationReason {
  kind: "natural" | "interrupted" | "error" | "never_started";
  detail?: string;
}

export interface PreSupersedeSnapshot {
  attemptId: string;
  stageName: string;
  status: "success" | "running" | "error";
}

export type MigrationOutcome =
  | {
      ok: true;
      eventId: string;
      taskId: string;
      fromVersion: string;
      toVersion: string;
      supersededStages: string[];
      resumedFromStage: string | null;
      interruptWaitMs: number;
      newRunnerStarted: boolean;
    }
  | {
      ok: false;
      code:
        | "MIGRATION_INTERRUPT_TIMEOUT"
        | "MIGRATION_RESUME_FAILED"
        | "MIGRATION_IN_PROGRESS"
        | "PROPOSAL_NOT_FOUND"
        | "PROPOSAL_ALREADY_RESOLVED"
        | "PATCH_APPLY_ERROR";
      message: string;
      context?: Record<string, unknown>;
    };
