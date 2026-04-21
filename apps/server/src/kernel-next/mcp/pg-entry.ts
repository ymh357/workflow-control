import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { KernelNextBroadcaster } from "../sse/broadcaster.js";
import type { PipelineIR } from "../ir/schema.js";
import type { StageExecutor } from "../runtime/executor.js";
import { versionHash as computeVersionHash } from "../ir/canonical.js";
import { insertPipelineVersion } from "../ir/sql.js";
import { LegacyPipelineLoadError } from "../runtime/load-legacy-pipeline.js";

export interface StartPipelineGeneratorInput {
  description: string;
  taskId?: string;
}

export type StartPipelineGeneratorResult =
  | { ok: true; taskId: string; versionHash: string; pipelineDir: string }
  | { ok: false; error: "INVALID_DESCRIPTION"; reason: "empty" | "too_long" }
  | { ok: false; error: "CONVERT_FAILED"; diagnostics: Array<{ code: string; message?: string }> }
  | { ok: false; error: "RUN_BOOTSTRAP_FAILED"; reason: string };

export interface PgEntryDeps {
  db: DatabaseSync;
  broadcaster: KernelNextBroadcaster;
  loader: (pipelineDir: string) => {
    ir: PipelineIR;
    promptRoot: string;
    yamlFilePath: string;
    warnings: Array<{ code: string; message?: string }>;
  };
  runner: (args: {
    db: DatabaseSync;
    ir: PipelineIR;
    taskId: string;
    versionHash: string;
    handlers: Record<string, never>;
    executor: StageExecutor;
    seedValues: Record<string, unknown>;
    broadcaster: KernelNextBroadcaster;
  }) => Promise<unknown>;
  executorFactory?: (args: {
    promptRoot: string;
    db: DatabaseSync;
    model: string;
    maxTurns?: number;
    maxBudgetUsd?: number;
  }) => StageExecutor;
  model: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
}

const MAX_DESCRIPTION_LEN = 8000;

export async function handleStartPipelineGenerator(
  input: StartPipelineGeneratorInput,
  deps: PgEntryDeps,
): Promise<StartPipelineGeneratorResult> {
  const desc = input.description?.trim() ?? "";
  if (desc.length === 0) {
    return { ok: false, error: "INVALID_DESCRIPTION", reason: "empty" };
  }
  if (desc.length > MAX_DESCRIPTION_LEN) {
    return { ok: false, error: "INVALID_DESCRIPTION", reason: "too_long" };
  }

  let loaded;
  try {
    loaded = deps.loader("pipeline-generator");
  } catch (err) {
    if (err instanceof LegacyPipelineLoadError) {
      return { ok: false, error: "CONVERT_FAILED", diagnostics: err.diagnostics };
    }
    return {
      ok: false,
      error: "CONVERT_FAILED",
      diagnostics: [{ code: "UNKNOWN", message: (err as Error).message }],
    };
  }

  const vh = computeVersionHash(loaded.ir);
  try {
    insertPipelineVersion(deps.db, loaded.ir, { versionHash: vh, tsSource: "" });
  } catch (err) {
    return {
      ok: false,
      error: "RUN_BOOTSTRAP_FAILED",
      reason: `insertPipelineVersion: ${(err as Error).message}`,
    };
  }

  if (!deps.executorFactory) {
    return {
      ok: false,
      error: "RUN_BOOTSTRAP_FAILED",
      reason: "executorFactory is required",
    };
  }

  const taskId = input.taskId ?? randomUUID();
  const executor = deps.executorFactory({
    promptRoot: loaded.promptRoot,
    db: deps.db,
    model: deps.model,
    maxTurns: deps.maxTurns,
    maxBudgetUsd: deps.maxBudgetUsd,
  });

  try {
    const p = deps.runner({
      db: deps.db,
      ir: loaded.ir,
      taskId,
      versionHash: vh,
      handlers: {},
      executor,
      seedValues: { taskDescription: desc },
      broadcaster: deps.broadcaster,
    });
    void p.catch((err: unknown) => {
      // Background run failure observed via broadcaster or wait_pipeline_result timeout.
      // Logged here for post-mortem visibility.
      console.error("[pg-entry] background runPipeline rejected", { taskId, err });
    });
  } catch (err) {
    return {
      ok: false,
      error: "RUN_BOOTSTRAP_FAILED",
      reason: (err as Error).message,
    };
  }

  return { ok: true, taskId, versionHash: vh, pipelineDir: "pipeline-generator" };
}
