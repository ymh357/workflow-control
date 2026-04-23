import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { KernelNextBroadcaster } from "../sse/broadcaster.js";
import type { PipelineIR } from "../ir/schema.js";
import type { StageExecutor } from "../runtime/executor.js";
import type { KernelNextSSEEvent, RunFinalData, StageErrorData, StageExecutingData } from "../sse/types.js";
import { KernelService } from "./kernel.js";
import { BuiltinPipelineLoadError } from "../runtime/load-builtin-pipeline.js";
import { readLatestPort } from "../runtime/port-runtime.js";
import { startPipelineRun } from "../runtime/start-pipeline-run.js";
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
    pipelineDir: string;
    warnings: Array<{ code: string; message?: string }>;
    prompts: Record<string, string>;
  };
  // Optional runner injection — tests pass a stub to capture the
  // background-run call without launching a real executor. Production
  // callers omit this and the function delegates to startPipelineRun.
  runner?: (args: {
    db: DatabaseSync;
    ir: PipelineIR;
    taskId: string;
    versionHash: string;
    handlers: Record<string, never>;
    executor: StageExecutor;
    seedValues: Record<string, unknown>;
    broadcaster: KernelNextBroadcaster;
  }) => Promise<unknown>;
  // executorFactory receives the captured versionHash so the caller can
  // construct a DbPromptResolver bound to the exact submitted pipeline
  // version (Task 11 of the prompts-in-SQLite plan). `promptRoot` is
  // still surfaced for callers that have not yet migrated to the DB
  // resolver; new callers should prefer DbPromptResolver(db, versionHash).
  executorFactory?: (args: {
    promptRoot: string;
    versionHash: string;
    db: DatabaseSync;
    model: string;
    maxTurns?: number;
    maxBudgetUsd?: number;
    // Monorepo tsc binary; forwarded into the factory-built MCP server
    // so submit_pipeline's validateTypes avoids the broken tmp-dir `npx
    // tsc` fallback. Without this, structurally valid IRs produced by
    // pipeline-generator are misdiagnosed as WIRE_TYPE_MISMATCH.
    tscPath?: string;
  }) => StageExecutor;
  model: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  // Forwarded to startPipelineRun for MCP server construction in the
  // production path (so monorepo tsc is available to stage agents).
  tscPath?: string;
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
    if (err instanceof BuiltinPipelineLoadError) {
      return { ok: false, error: "CONVERT_FAILED", diagnostics: err.diagnostics };
    }
    return {
      ok: false,
      error: "CONVERT_FAILED",
      diagnostics: [{ code: "LOADER_ERROR", message: (err as Error).message }],
    };
  }

  // Submit IR + prompts atomically so the pipeline_versions row AND
  // the pipeline_prompt_refs / prompt_contents rows are both keyed by
  // the prompts-aware pipelineVersionHash. KernelService.submit is
  // idempotent on repeat calls with identical (ir, prompts).
  let vh: string;
  try {
    const svc = new KernelService(deps.db, { skipTypeCheck: true });
    const submitRes = svc.submit(loaded.ir, { prompts: loaded.prompts });
    if (!submitRes.ok) {
      return {
        ok: false,
        error: "RUN_BOOTSTRAP_FAILED",
        reason: `submit: ${submitRes.diagnostics.map((d) => `${d.code}${d.message ? `: ${d.message}` : ""}`).join("; ")}`,
      };
    }
    vh = submitRes.versionHash;
  } catch (err) {
    return {
      ok: false,
      error: "RUN_BOOTSTRAP_FAILED",
      reason: `submit: ${(err as Error).message}`,
    };
  }

  // Delegate to startPipelineRun for executor construction + background run.
  // Tests that inject a custom runner go through the deps.runner path below
  // instead; production code always uses the shared startPipelineRun.
  if (deps.runner) {
    // Test injection path — build a minimal executor inline, same as before.
    // (Kept to avoid forcing all tests to switch to startPipelineRun.)
    if (!deps.executorFactory) {
      return {
        ok: false,
        error: "RUN_BOOTSTRAP_FAILED",
        reason: "executorFactory is required when runner is injected",
      };
    }
    const taskId = input.taskId ?? randomUUID();
    const executor = deps.executorFactory({
      promptRoot: loaded.promptRoot,
      versionHash: vh,
      db: deps.db,
      model: deps.model,
      maxTurns: deps.maxTurns,
      maxBudgetUsd: deps.maxBudgetUsd,
      tscPath: deps.tscPath,
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
        // Background run failure observed via broadcaster or
        // wait_pipeline_result timeout. Logged for post-mortem visibility.
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

  // Production path — delegate executor construction and background
  // runPipeline to startPipelineRun so pipeline-generator shares one
  // kickoff code path with the MCP run_pipeline tool and the HTTP route.
  const runRes = await startPipelineRun({
    db: deps.db,
    broadcaster: deps.broadcaster,
    versionHash: vh,
    taskId: input.taskId,
    seedValues: { taskDescription: desc },
    model: deps.model,
    maxTurns: deps.maxTurns,
    maxBudgetUsd: deps.maxBudgetUsd,
    tscPath: deps.tscPath,
  });

  if (runRes.ok === false) {
    return {
      ok: false,
      error: "RUN_BOOTSTRAP_FAILED",
      reason: `${runRes.code}: ${runRes.message}`,
    };
  }

  return {
    ok: true,
    taskId: runRes.taskId,
    versionHash: runRes.versionHash,
    pipelineDir: "pipeline-generator",
  };
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

// collectStagePorts returns the latest value of every output port
// written by a given stage for a given task. It mirrors the SQL
// strategy of readLatestPort (see runtime/port-runtime.ts) — same
// ORDER BY (written_at DESC, attempt_idx DESC) — but widens the scope
// from a single (stage, port) to all ports of a stage in one query.
// De-duplication per port_name keeps only the row that readLatestPort
// would have returned if queried individually. We avoid calling
// readLatestPort in a loop because we do not know the full set of
// port names up front (IR declares them but runtime may skip some if
// the stage short-circuits).
function collectStagePorts(
  db: DatabaseSync,
  taskId: string,
  stageName: string,
): Record<string, unknown> {
  const rows = db
    .prepare(
      `SELECT pv.port_name, pv.value_json
       FROM port_values pv
       JOIN stage_attempts sa ON sa.attempt_id = pv.attempt_id
       WHERE sa.task_id = ?
         AND pv.stage_name = ?
         AND pv.direction = 'out'
       ORDER BY pv.written_at DESC, sa.attempt_idx DESC`,
    )
    .all(taskId, stageName) as Array<{ port_name: string; value_json: string }>;

  const snapshot: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.port_name)) continue;
    seen.add(row.port_name);
    try {
      snapshot[row.port_name] = JSON.parse(row.value_json);
    } catch {
      // skip malformed rows
    }
  }
  return snapshot;
}

function assembleDone(db: DatabaseSync, taskId: string): DoneResult {
  const pipelineId = String(readPortValue(db, taskId, "persistResult", "pipelineId") ?? "");
  const pipelineName = String(readPortValue(db, taskId, "pipelineDesign", "pipelineName") ?? "");
  const yamlPath = String(readPortValue(db, taskId, "persistResult", "yamlPath") ?? "");
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
          return;
        }
        if (data.finalState === "failed") {
          const first = data.stageErrors[0];
          settle({
            ok: false,
            status: "error",
            taskId: input.taskId,
            error: first?.message ?? "pipeline run failed",
            ...(first?.stage ? { failedStage: first.stage } : {}),
          });
          return;
        }
        return;
      }
      if (ev.type === "stage_error") {
        // stage_error always means the stage has exhausted retries and reached
        // its final error state — treat as immediate terminal failure.
        const data = ev.data as StageErrorData;
        settle({
          ok: false,
          status: "error",
          taskId: input.taskId,
          error: data.message,
          failedStage: data.stage,
        });
        return;
      }
      if (ev.type === "stage_executing") {
        const data = ev.data as StageExecutingData;
        const stage = deps.ir.stages.find((s) => s.name === data.stage);
        if (stage && stage.type === "gate") {
          const pipelineDesignSnapshot = collectStagePorts(deps.db, input.taskId, "pipelineDesign");
          settle({
            ok: true,
            status: "gate_pending",
            taskId: input.taskId,
            gateName: data.stage,
            gateContext: { pipelineDesign: pipelineDesignSnapshot },
            hint: "Call answer_gate to approve/reject, then wait_pipeline_result again.",
          });
        }
        // Non-gate stage_executing is ignored; wait continues until the next
        // terminal event or timeout.
        return;
      }
      if (ev.type === "stage_rolled_back") {
        // Transient event: pipeline will re-open a gate or reach a new
        // terminal. Do not settle wait.
        return;
      }
      // stage_retry and other non-terminal events are ignored; wait continues until
      // the next terminal event or timeout.
    });

    // If already settled (synchronous history replay resolved the promise),
    // do not arm the timeout.
    if (!settled) {
      timer = setTimeout(() => {
        let currentStage: string | null = null;
        try {
          const row = deps.db
            .prepare(
              "SELECT stage_name FROM stage_attempts WHERE task_id = ? ORDER BY started_at DESC, attempt_idx DESC LIMIT 1",
            )
            .get(input.taskId) as { stage_name: string } | undefined;
          currentStage = row?.stage_name ?? null;
        } catch {
          // table missing or other transient error — keep null
        }
        settle({
          ok: true,
          status: "running",
          taskId: input.taskId,
          currentStage,
          elapsedMs: now() - startedAt,
          hint: "Pipeline still running. Call wait_pipeline_result again to continue waiting.",
        });
      }, timeoutMs);
    }
  });
}
