// REST route to trigger kernel-next pipeline execution.
//
// POST /api/kernel/tasks/run
//   body: { pipeline: string; taskId?: string }
//
// Async model: the handler submits the IR, kicks off runPipeline in
// the background with the singleton broadcaster injected, and
// immediately returns HTTP 202 + { taskId, versionHash }. Clients
// observe execution via the SSE stream at
// /api/kernel-next/tasks/:taskId/stream.
//
// `pipeline` is a registered builtin name. The registry here is
// intentionally explicit — accepting arbitrary IR in the body would
// need full validation + tscPath wiring, which belongs on the MCP
// surface, not on a dashboard-verification HTTP endpoint. This route
// exists to answer the "how does the engine get triggered in a way
// the dashboard can observe?" question, using mock pipelines only.

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { KernelService } from "../kernel-next/mcp/kernel.js";
import { createKernelMcp } from "../kernel-next/mcp/server.js";
import { getKernelNextDb } from "../lib/kernel-next-db.js";
import { runPipeline } from "../kernel-next/runtime/runner.js";
import { kernelNextBroadcaster } from "../kernel-next/sse/singleton.js";
import { diamondIR } from "../kernel-next/generator-mock/mini-generator.js";
import { slowDiamondHandlers } from "../kernel-next/demo/slow-diamond.js";
import { RealStageExecutor } from "../kernel-next/runtime/real-executor.js";
import { DbPromptResolver } from "../kernel-next/runtime/db-prompt-resolver.js";
import { loadLegacyPipelineIR, LegacyPipelineLoadError } from "../kernel-next/runtime/load-legacy-pipeline.js";
import type { StageExecutor } from "../kernel-next/runtime/executor.js";
import type { PipelineIR } from "../kernel-next/ir/schema.js";
import type { StageHandlerMap } from "../kernel-next/runtime/mock-executor.js";
import { logger } from "../lib/logger.js";

export const kernelRunRoute = new Hono();

const runBodySchema = z.object({
  pipeline: z.string().min(1),
  taskId: z.string().min(1).optional(),
  // Real-executor overrides. Only meaningful when the selected
  // pipeline maps to a real-executor factory; ignored for mock ones.
  model: z.string().min(1).optional(),
  maxTurns: z.number().int().positive().optional(),
  maxBudgetUsd: z.number().positive().optional(),
  // External-input seed values. Keys must cover every externalInputs
  // port on the selected pipeline; missing keys surface via SSE
  // run_final=failed (runner-side SEED_VALUES_MISSING_KEY error).
  seedValues: z.record(z.string(), z.unknown()).optional(),
}).strict();

type RunBodyOverrides = z.infer<typeof runBodySchema>;

interface PipelineRegistration {
  ir: PipelineIR;
  // Mock handlers OR a real executor — exclusive. Mock path keeps
  // handlers+{} + undefined executor; real path provides a factory
  // that materialises an executor against the live DB so MCP can
  // write_port through the dispatcher wired by runner.
  handlers: StageHandlerMap;
  executorFactory?: (
    db: import("node:sqlite").DatabaseSync,
    overrides: RunBodyOverrides,
  ) => StageExecutor;
  // Longer timeout for slow-mock / real variants so the dashboard
  // has time to actually render mid-run state.
  timeoutMs?: number;
}

const DEFAULT_REAL_MODEL = "claude-haiku-4-5";
const DEFAULT_REAL_MAX_TURNS = 10;
const DEFAULT_REAL_BUDGET_USD = 0.2;
const DEFAULT_LEGACY_TIMEOUT_MS = 5 * 60_000;

interface LegacyPipelineRegistrationOpts {
  /** Directory name under src/builtin-pipelines/ (e.g. "tech-research-collector"). */
  pipelineDir: string;
  /** Claude model override; falls back to body override then DEFAULT_REAL_MODEL. */
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Hard timeout for runPipeline (ms). Defaults to 5 minutes. */
  timeoutMs?: number;
}

/**
 * Build a PipelineRegistration factory for a legacy-YAML builtin pipeline.
 *
 * The YAML is located at src/builtin-pipelines/<pipelineDir>/pipeline.yaml.
 * Conversion + KernelService.submit happen eagerly at registry
 * initialisation: readFileSync + convertLegacyYaml run once per process,
 * real prompts from disk are persisted to the kernel-next DB via submit,
 * and the captured versionHash is bound into a DbPromptResolver so the
 * RealStageExecutor reads prompts from SQLite rather than the filesystem.
 *
 * Warnings are logged via logger.info. A hard conversion or submit
 * failure throws at module load so misconfigured fixtures fail fast
 * instead of surfacing as 500s at request time.
 */
function registerLegacyPipeline(
  opts: LegacyPipelineRegistrationOpts,
): () => PipelineRegistration {
  let loaded: ReturnType<typeof loadLegacyPipelineIR>;
  try {
    loaded = loadLegacyPipelineIR(opts.pipelineDir);
  } catch (err) {
    if (err instanceof LegacyPipelineLoadError) {
      throw new Error(
        `legacy pipeline '${opts.pipelineDir}' failed to convert: ${err.diagnostics.map((d) => d.code).join(", ")}`,
      );
    }
    throw err;
  }
  for (const w of loaded.warnings) {
    logger.info({ pipeline: opts.pipelineDir, warning: w }, "converter warning");
  }
  const { ir } = loaded;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LEGACY_TIMEOUT_MS;

  // Submit once at module load so the DB has real prompt rows keyed by
  // versionHash. DbPromptResolver then reads from SQLite at stage
  // execution time — no filesystem round-trip per stage.
  const db = getKernelNextDb();
  const svc = new KernelService(db, { skipTypeCheck: true });
  const submitResult = svc.submit(ir, { prompts: loaded.prompts });
  if (!submitResult.ok) {
    const joined = submitResult.diagnostics
      .map((d) => `${d.code}: ${d.message ?? ""}`)
      .join("; ");
    throw new Error(
      `registerLegacyPipeline('${opts.pipelineDir}'): submit failed: ${joined}`,
    );
  }
  const versionHash = submitResult.versionHash;

  return () => ({
    ir,
    handlers: {},
    executorFactory: (execDb, overrides) =>
      new RealStageExecutor({
        mcpServerFactory: (_dispatcher, portRuntime) =>
          createKernelMcp(execDb, { surface: "combined", portRuntime }),
        promptResolver: new DbPromptResolver(execDb, versionHash),
        model: overrides.model ?? opts.model ?? DEFAULT_REAL_MODEL,
        maxTurns: overrides.maxTurns ?? opts.maxTurns ?? DEFAULT_REAL_MAX_TURNS,
        maxBudgetUsd: overrides.maxBudgetUsd ?? opts.maxBudgetUsd ?? DEFAULT_REAL_BUDGET_USD,
      }),
    timeoutMs,
  });
}

// Registry of pipelines runnable via this route. Keys are the values
// accepted in the `pipeline` body field.
const pipelineRegistry: Record<string, () => PipelineRegistration> = {
  "diamond": () => ({
    ir: diamondIR(),
    handlers: {
      A: () => ({ x: 10 }),
      B: (inputs) => ({ y: `B-got-${inputs.x as number}` }),
      C: (inputs) => ({ z: `C-got-${inputs.x as number}` }),
      D: (inputs) => ({ final: `${inputs.b as string}+${inputs.c as string}` }),
    },
  }),
  "diamond-slow": () => ({
    ir: diamondIR(),
    handlers: slowDiamondHandlers(),
    timeoutMs: 30_000,
  }),
  "diamond-real": () => ({
    ir: diamondIR(),
    handlers: {}, // real executor drives via RealStageExecutor
    executorFactory: (db, overrides) =>
      new RealStageExecutor({
        // Fresh MCP server per stage (SDK MCP transport is single-
        // use). Combined surface so `write_port` is visible to the
        // agent — same rationale as demo/diamond-real.ts.
        mcpServerFactory: (_dispatcher, portRuntime) =>
          createKernelMcp(db, {
            surface: "combined",
            // Reuse the runner's live PortRuntime so the Slice 2
            // onPortWritten hook fires on MCP-initiated writes too
            // (otherwise dashboard sees zero port_written events on
            // real-executor paths — discovered during A7.1 verify).
            portRuntime,
          }),
        model: overrides.model ?? DEFAULT_REAL_MODEL,
        maxTurns: overrides.maxTurns ?? DEFAULT_REAL_MAX_TURNS,
        maxBudgetUsd: overrides.maxBudgetUsd ?? DEFAULT_REAL_BUDGET_USD,
      }),
    // 4 agent calls × up to 10 turns × haiku latency → minutes.
    // Dashboard stays subscribed via SSE reconnect, so a generous
    // upper bound is fine.
    timeoutMs: 5 * 60_000,
  }),
  // A7.4 — smoke-test builtin. Converted from legacy YAML via
  // registerLegacyPipeline so prompts live in SQLite (see Task 10 of
  // the prompts-in-SQLite plan). The IR that convertLegacyYaml
  // produces is hash-identical to the former hand-coded smokeTestIR()
  // (verified by converter/legacy-yaml.test.ts golden).
  "smoke-test": registerLegacyPipeline({
    pipelineDir: "smoke-test",
    timeoutMs: 3 * 60_000,
  }),
  "tech-research-collector": registerLegacyPipeline({
    pipelineDir: "tech-research-collector",
  }),
  "tech-research-writer": registerLegacyPipeline({
    pipelineDir: "tech-research-writer",
  }),
  "pipeline-generator": registerLegacyPipeline({
    pipelineDir: "pipeline-generator",
    maxTurns: 80,
    maxBudgetUsd: 8,
    timeoutMs: 15 * 60_000,  // 15 minutes — genPrompts is the biggest stage
  }),
};

function badRequest(
  c: Context,
  code: "INVALID_JSON_BODY" | "INVALID_REQUEST_BODY" | "UNKNOWN_PIPELINE",
  message: string,
  context?: Record<string, unknown>,
) {
  return c.json(
    {
      ok: false,
      diagnostics: [{ code, message, ...(context ? { context } : {}) }],
    },
    400,
  );
}

kernelRunRoute.post("/kernel/tasks/run", async (c) => {
  const raw = await c.req.text();
  let body: unknown;
  try {
    body = raw.trim().length === 0 ? {} : JSON.parse(raw);
  } catch {
    return badRequest(c, "INVALID_JSON_BODY", "invalid JSON body");
  }

  const parsed = runBodySchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return badRequest(
      c,
      "INVALID_REQUEST_BODY",
      issue?.message ?? "bad request",
      issue ? { path: issue.path } : undefined,
    );
  }

  const factory = pipelineRegistry[parsed.data.pipeline];
  if (!factory) {
    return badRequest(
      c,
      "UNKNOWN_PIPELINE",
      `pipeline '${parsed.data.pipeline}' is not registered`,
      { known: Object.keys(pipelineRegistry) },
    );
  }

  const { ir, handlers, executorFactory, timeoutMs } = factory();
  const db = getKernelNextDb();
  const svc = new KernelService(db, { skipTypeCheck: true });
  // Placeholder prompts for the POST-time re-submit path: legacy
  // pipelines already submitted their real prompts at module load via
  // registerLegacyPipeline (and their RealStageExecutor resolves
  // prompts from the DB via the module-load versionHash). The
  // re-submit here exists so diamond/diamond-slow/diamond-real (which
  // do not go through registerLegacyPipeline) still pass submit; for
  // those, the prompts map is ignored since no AgentStage.promptRef
  // is set. For legacy pipelines, this emits a second (harmless)
  // pipeline_versions row keyed by placeholder content, which the
  // runner uses but the DbPromptResolver does NOT consult.
  const placeholderPrompts: Record<string, string> = {};
  for (const stage of ir.stages) {
    if (stage.type === "agent" && stage.config.promptRef) {
      placeholderPrompts[stage.config.promptRef] = "placeholder";
    }
  }
  const submit = svc.submit(ir, { prompts: placeholderPrompts });
  if (!submit.ok) {
    return c.json(
      { ok: false, diagnostics: submit.diagnostics },
      400,
    );
  }

  const taskId = parsed.data.taskId ?? `kr-${randomUUID()}`;
  const versionHash = submit.versionHash;

  // Real pipelines construct their executor now (after submit, before
  // dispatch) so the closure captures the same `db` handle the runner
  // will use. Mock pipelines leave executor undefined — runner falls
  // back to MockStageExecutor(handlers).
  const executor = executorFactory?.(db, parsed.data);

  // Fire-and-forget. The runner publishes SSE events through the
  // singleton broadcaster; clients observe via /stream. Errors are
  // logged but do not affect the HTTP response (already returned).
  void runPipeline({
    db,
    ir,
    taskId,
    versionHash,
    handlers,
    executor,
    broadcaster: kernelNextBroadcaster,
    seedValues: parsed.data.seedValues,
  }, timeoutMs).then((result) => {
    logger.info(
      { taskId, finalState: result.finalState, stageErrors: result.stageErrors.length },
      "kernel-next run finished",
    );
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ taskId, err: message }, "kernel-next run threw");
    // Surface the failure into the SSE stream so dashboards see a
    // coherent end-of-run event even when the promise rejected
    // outside the state-machine error paths (e.g. timeout).
    try {
      kernelNextBroadcaster.publish({
        type: "run_final",
        taskId,
        timestamp: new Date().toISOString(),
        data: {
          finalState: "failed",
          stageErrors: [{ stage: "<runner>", message }],
        },
      });
    } catch { /* broadcaster self-failure ignored */ }
  });

  return c.json({ ok: true, taskId, versionHash }, 202);
});
