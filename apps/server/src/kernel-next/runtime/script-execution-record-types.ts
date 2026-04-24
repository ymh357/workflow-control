// Types for kernel-next script execution sidecar.
// Parallel to execution-record-types.ts (agent sidecar).
//
// NOTE on columns pre-provisioned for future executor modes:
//   - stdout / stderr / exit_code are reserved for a future ScriptStage
//     execution model where the script runs as a child process or uses a
//     ctx.logger API. Today's TS-function ScriptModule leaves them NULL.
//     The writer exposes append/set methods so executor evolution does
//     not require schema migration.

export type ScriptTerminationReason =
  | "natural_completion"
  | "error"
  | "compile_error"
  | "module_not_found"
  | "superseded";

export interface OpenScriptWriterInput {
  attemptId: string;
  moduleId: string;
  inputs: Record<string, unknown>;
}

export interface CloseScriptWriterInput {
  terminationReason: ScriptTerminationReason;
  outputs?: Record<string, unknown>;
  errorMessage?: string | null;
  errorStack?: string | null;
  exitCode?: number | null;
}
