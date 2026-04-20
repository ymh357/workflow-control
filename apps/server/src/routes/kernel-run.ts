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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KernelService } from "../kernel-next/mcp/kernel.js";
import { createKernelMcp } from "../kernel-next/mcp/server.js";
import { getKernelNextDb } from "../lib/kernel-next-db.js";
import { runPipeline } from "../kernel-next/runtime/runner.js";
import { kernelNextBroadcaster } from "../kernel-next/sse/singleton.js";
import { diamondIR } from "../kernel-next/generator-mock/mini-generator.js";
import { slowDiamondHandlers } from "../kernel-next/demo/slow-diamond.js";
import { RealStageExecutor } from "../kernel-next/runtime/real-executor.js";
import { FsPromptResolver } from "../kernel-next/runtime/fs-prompt-resolver.js";
import { smokeTestIR, smokeTestPromptRoot } from "../kernel-next/builtins/smoke-test.js";
import { convertLegacyYaml } from "../kernel-next/converter/legacy-yaml.js";
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
 * The YAML is located at src/builtin-pipelines/<pipelineDir>/pipeline.yaml
 * (resolved relative to this module, matching smokeTestPromptRoot()'s
 * layout-anchoring convention). Conversion happens eagerly at registry
 * initialisation — readFileSync + convertLegacyYaml run once per process,
 * not once per POST. Warnings are logged via logger.info; a hard
 * conversion failure throws at module load so misconfigured fixtures
 * fail fast instead of surfacing as 500s at request time.
 *
 * The returned factory is invoked per POST and constructs a fresh
 * RealStageExecutor against the live DB so write_port goes through the
 * runner's PortRuntime (same rationale as the diamond-real / smoke-test
 * entries).
 */
function registerLegacyPipeline(
  opts: LegacyPipelineRegistrationOpts,
): () => PipelineRegistration {
  const yamlPath = join(
    new URL(".", import.meta.url).pathname,
    "..", "builtin-pipelines", opts.pipelineDir, "pipeline.yaml",
  );
  const yamlText = readFileSync(yamlPath, "utf-8");
  const conv = convertLegacyYaml(yamlText, { yamlFilePath: yamlPath });
  if (!conv.ok) {
    throw new Error(
      `legacy pipeline '${opts.pipelineDir}' failed to convert: ${conv.diagnostics.map((d) => d.code).join(", ")}`,
    );
  }
  for (const w of conv.warnings) {
    logger.info({ pipeline: opts.pipelineDir, warning: w }, "converter warning");
  }
  const ir = conv.ir;
  const promptRoot = conv.promptRoot!;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LEGACY_TIMEOUT_MS;

  return () => ({
    ir,
    handlers: {},
    executorFactory: (db, overrides) =>
      new RealStageExecutor({
        mcpServerFactory: (_dispatcher, portRuntime) =>
          createKernelMcp(db, { surface: "combined", portRuntime }),
        promptResolver: new FsPromptResolver({ rootDir: promptRoot }),
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
  "smoke-test": () => ({
    // A7.4 — hand-ported from legacy YAML. greet → echoBack, each
    // legacy store_schema field becomes a kernel-next port. Legacy
    // prompts reused verbatim; buildSystemPromptAppend supplies the
    // kernel-next port contract at invocation time so the agent
    // knows to call write_port rather than the legacy `writes` API.
    ir: smokeTestIR(),
    handlers: {},
    executorFactory: (db, overrides) =>
      new RealStageExecutor({
        mcpServerFactory: (_dispatcher, portRuntime) =>
          createKernelMcp(db, { surface: "combined", portRuntime }),
        promptResolver: new FsPromptResolver({ rootDir: smokeTestPromptRoot() }),
        model: overrides.model ?? DEFAULT_REAL_MODEL,
        maxTurns: overrides.maxTurns ?? DEFAULT_REAL_MAX_TURNS,
        maxBudgetUsd: overrides.maxBudgetUsd ?? DEFAULT_REAL_BUDGET_USD,
      }),
    timeoutMs: 3 * 60_000,
  }),
  "tech-research-collector": registerLegacyPipeline({
    pipelineDir: "tech-research-collector",
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
  const submit = svc.submit(ir);
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
