import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { KernelNextBroadcaster } from "../sse/broadcaster.js";
import type { PipelineIR } from "../ir/schema.js";
import type { StageExecutor } from "../runtime/executor.js";
import type { KernelNextSSEEvent, RunFinalData } from "../sse/types.js";
import { versionHash as computeVersionHash } from "../ir/canonical.js";
import { insertPipelineVersion } from "../ir/sql.js";
import { LegacyPipelineLoadError } from "../runtime/load-legacy-pipeline.js";
import { readLatestPort } from "../runtime/port-runtime.js";
import { logger } from "../../lib/logger.js";

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
      diagnostics: [{ code: "LOADER_ERROR", message: (err as Error).message }],
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
      logger.error({ taskId, err }, "[pg-entry] background runPipeline rejected");
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

// --- handleWaitPipelineResult ---

export interface WaitPipelineResultInput {
  taskId: string;
  timeoutMs?: number;
}

export interface DoneResult {
  pipelineId: string;
  pipelineName: string;
  yamlPath: string;
  promptDir?: string;
  mcpsNeedingKeys?: Array<{ name: string; envVars: string[] }>;
  pipelineDesignSummary: string;
}

export type WaitPipelineResultResult =
  | { ok: true; status: "done"; taskId: string; result: DoneResult }
  | { ok: true; status: "gate_pending"; taskId: string; gateName: string; gateContext: { pipelineDesign: Record<string, unknown> }; hint: string }
  | { ok: true; status: "running"; taskId: string; currentStage: string | null; elapsedMs: number; hint: string }
  | { ok: false; status: "error"; taskId: string; error: string; failedStage?: string };

export interface WaitDeps {
  db: DatabaseSync;
  broadcaster: KernelNextBroadcaster;
  ir: PipelineIR;
  now?: () => number;
}

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 30_000;

function clampTimeout(ms: number | undefined): number {
  const v = ms ?? DEFAULT_TIMEOUT_MS;
  if (v < MIN_TIMEOUT_MS) return MIN_TIMEOUT_MS;
  if (v > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;
  return v;
}

function readPortValue(
  db: DatabaseSync,
  taskId: string,
  stageName: string,
  portName: string,
): unknown {
  const result = readLatestPort(db, stageName, portName, taskId);
  return result?.value;
}

function assembleDone(db: DatabaseSync, taskId: string): DoneResult {
  const pipelineId = String(readPortValue(db, taskId, "persistResult", "pipelineId") ?? "");
  const pipelineName = String(readPortValue(db, taskId, "pipelineDesign", "pipelineName") ?? "");
  const yamlPath = String(readPortValue(db, taskId, "skeletonResult", "yamlPath") ?? "");
  const promptDir = readPortValue(db, taskId, "promptFiles", "outputDir");
  const mcpsNeedingKeys = readPortValue(db, taskId, "persistResult", "mcpsNeedingKeys");
  const descRaw = String(readPortValue(db, taskId, "pipelineDesign", "description") ?? "");
  return {
    pipelineId,
    pipelineName,
    yamlPath,
    ...(typeof promptDir === "string" ? { promptDir } : {}),
    ...(Array.isArray(mcpsNeedingKeys)
      ? { mcpsNeedingKeys: mcpsNeedingKeys as DoneResult["mcpsNeedingKeys"] }
      : {}),
    pipelineDesignSummary: descRaw.slice(0, 500),
  };
}

export async function handleWaitPipelineResult(
  input: WaitPipelineResultInput,
  deps: WaitDeps,
): Promise<WaitPipelineResultResult> {
  const timeoutMs = clampTimeout(input.timeoutMs);
  const now = deps.now ?? Date.now;
  const startedAt = now();

  return new Promise<WaitPipelineResultResult>((resolve) => {
    let settled = false;
    // unsub is declared before subscribe so the closure can reference it
    // even when the listener fires synchronously during history replay.
    let unsub: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (r: WaitPipelineResultResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      // unsub may be undefined when settle is called synchronously during
      // history replay (before subscribe returns). Schedule the unsubscribe
      // for after subscribe returns so we never call undefined.
      if (unsub !== undefined) {
        unsub();
      } else {
        // Will be cleaned up on the next tick after subscribe() assigns unsub.
        Promise.resolve().then(() => unsub?.()).catch(() => undefined);
      }
      resolve(r);
    };

    unsub = deps.broadcaster.subscribe(input.taskId, (ev: KernelNextSSEEvent) => {
      if (ev.type === "run_final") {
        const data = ev.data as RunFinalData;
        if (data.finalState === "completed") {
          settle({
            ok: true,
            status: "done",
            taskId: input.taskId,
            result: assembleDone(deps.db, input.taskId),
          });
        }
        // Error path (finalState === "failed") lands in Task 7.
        return;
      }
      // Other terminal events (gate / error) land in Tasks 7-8.
    });

    // If already settled (synchronous history replay resolved the promise),
    // do not arm the timeout.
    if (!settled) {
      timer = setTimeout(() => {
        // Running path fleshed out in Task 9; for now return a placeholder.
        settle({
          ok: true,
          status: "running",
          taskId: input.taskId,
          currentStage: null,
          elapsedMs: now() - startedAt,
          hint: "Pipeline still running. Call wait_pipeline_result again to continue waiting.",
        });
      }, timeoutMs);
    }
  });
}
