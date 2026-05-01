// REST route to trigger kernel-next pipeline execution.
//
// POST /api/kernel/tasks/run
//   body: { pipeline?: string; name?: string; versionHash?: string;
//           taskId?: string; model?: string; maxTurns?: number;
//           maxBudgetUsd?: number; seedValues?: object; policy?: unknown }
//
// Async model: the handler delegates to startPipelineRun, which resolves
// {name, versionHash} against pipeline_versions, constructs the executor,
// and kicks off runPipeline in the background. Returns HTTP 202 with
// { ok: true, taskId, versionHash } on success, 400 with a diagnostic on
// failure. Clients observe execution via the SSE stream at
// /api/kernel-next/tasks/:taskId/stream.
//
// Builtin pipelines (smoke-test, tech-research-collector,
// tech-research-writer, pipeline-generator) are seeded into
// pipeline_versions at module load via seedBuiltinPipelineByName so
// startPipelineRun can resolve them by name. Mock pipelines (diamond
// family) are seeded on-demand by startPipelineRun via
// MOCK_HANDLER_REGISTRY.

import { Hono } from "hono";
import { z } from "zod";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { KernelService } from "../kernel-next/mcp/kernel.js";
import { getKernelNextDb } from "../lib/kernel-next-db.js";
import { kernelNextBroadcaster } from "../kernel-next/sse/singleton.js";
import { loadBuiltinPipelineIR } from "../kernel-next/runtime/load-builtin-pipeline.js";
import { startPipelineRun } from "../kernel-next/runtime/start-pipeline-run.js";
import { logger } from "../lib/logger.js";

// Resolve the monorepo's tsc binary so that submit_pipeline's wire type
// validation works regardless of where the executor's temp codegen dir
// sits. Without this, `npx tsc` resolved from the temp dir prints
// "This is not the tsc command you are looking for" and the MCP
// submit_pipeline returns a bogus WIRE_TYPE_MISMATCH. Passed to
// startPipelineRun so the per-stage createKernelMcp call threads it
// into the combined-surface MCP server.
// Exported so the resumability boot path (index.ts → bootResumability)
// can thread the same tsc binary into its resumed startPipelineRun
// calls. Without that, resumed tasks hit the npx tsc fallback and the
// PG persisting stage misdiagnoses a structurally-valid IR as
// WIRE_TYPE_MISMATCH.
export const MONOREPO_TSC_PATH: string | undefined = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  // routes/ -> src/ -> server/ -> node_modules/.bin/tsc
  const candidate = join(here, "..", "..", "node_modules", ".bin", "tsc");
  return existsSync(candidate) ? candidate : undefined;
})();

export const kernelRunRoute = new Hono();

const runBodySchema = z.object({
  pipeline: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  versionHash: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  maxTurns: z.number().int().positive().optional(),
  maxBudgetUsd: z.number().positive().optional(),
  seedValues: z.record(z.string(), z.unknown()).optional(),
  policy: z.unknown().optional(),
  envValues: z.record(z.string(), z.string()).optional(),
}).strict();

kernelRunRoute.post("/kernel/tasks/run", async (c) => {
  const rawBody = await c.req.json().catch(() => null);
  const parsed = runBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({
      ok: false,
      diagnostics: parsed.error.issues.map((i) => ({
        code: "ZOD_PARSE_ERROR",
        message: `${i.path.join(".") || "<root>"}: ${i.message}`,
      })),
    }, 400);
  }

  // Bug 49 (c12+ review): wait for builtin pipeline seeding to settle
  // before resolving any name. Pre-fix, an HTTP request landing during
  // boot could resolve a builtin name before its INSERT had committed
  // and got a mysterious NAME_NOT_FOUND. allSettled — we accept any
  // single seed failure (logger already recorded it) but never start
  // resolution until the seed phase has had its chance.
  await seedBuiltinPipelinesPromise;

  const body = parsed.data;
  const name = body.name ?? body.pipeline;

  const db = getKernelNextDb();
  const res = await startPipelineRun({
    db,
    broadcaster: kernelNextBroadcaster,
    name,
    versionHash: body.versionHash,
    taskId: body.taskId,
    seedValues: body.seedValues,
    policy: body.policy as never,
    model: body.model,
    maxTurns: body.maxTurns,
    maxBudgetUsd: body.maxBudgetUsd,
    tscPath: MONOREPO_TSC_PATH,
    envValues: body.envValues,
  });

  if (res.ok === false) {
    return c.json({
      ok: false,
      diagnostics: [{ code: res.code, message: res.message, context: res.context }],
    }, 400);
  }

  // C10 Bug F2 (2026-04-30): forward missingEnvKeys + provide_task_secrets
  // hint when startPipelineRun's pre-flight scan flagged stages with
  // unsatisfied envKeys. Without this, HTTP callers (dashboard, dogfood
  // scripts) get no early signal — they only discover the missing key
  // when the affected stage hits secret_pending mid-run. The MCP tool
  // run_pipeline already surfaces this; here we mirror it for HTTP
  // parity.
  const responseBody: Record<string, unknown> = {
    ok: true,
    taskId: res.taskId,
    versionHash: res.versionHash,
  };
  if (res.missingEnvKeys && res.missingEnvKeys.length > 0) {
    responseBody.missingEnvKeys = res.missingEnvKeys;
    responseBody.hint =
      `Task created but ${res.missingEnvKeys.length} envKey(s) are missing: ` +
      `[${res.missingEnvKeys.join(", ")}]. ` +
      `POST /api/kernel/tasks/${res.taskId}/secrets with body { secrets: { KEY: "value", ... } } ` +
      `to supply them, or call the MCP tool provide_task_secrets. ` +
      `Affected stages will pause with status='secret_pending' until secrets land.`;
  }
  return c.json(responseBody, 202);
});

// Seed builtin pipelines into pipeline_versions at module load so they
// can be resolved by name via startPipelineRun. No longer stored in a
// runtime registry — SQLite is the only lookup path for real pipelines.
// Mock pipelines (diamond family) are seeded on-demand by
// startPipelineRun via MOCK_HANDLER_REGISTRY.
async function seedBuiltinPipelineByName(pipelineDir: string): Promise<void> {
  try {
    const loaded = loadBuiltinPipelineIR(pipelineDir);
    const db = getKernelNextDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const res = await svc.submit(loaded.ir, { prompts: loaded.prompts });
    if (!res.ok) {
      throw new Error(
        `seedBuiltinPipelineByName('${pipelineDir}'): submit failed: ${res.diagnostics.map((d) => `${d.code}: ${d.message ?? ""}`).join("; ")}`,
      );
    }
  } catch (err) {
    logger.error(
      { pipelineDir, err: (err as Error).message },
      "[kernel-run] seedBuiltinPipelineByName failed",
    );
    throw err;
  }
}

// Bug 49 (c12+ review): pre-fix these were `void seed...`, fire-and-
// forget. An HTTP request landing during boot could resolve a
// builtin pipeline name BEFORE its INSERT had committed and got a
// mysterious NAME_NOT_FOUND. Worse, any seed rejection was swallowed
// (logger.error fired but the promise was lost), so missing builtins
// stayed broken silently.
//
// The fix: kick all seeds in parallel and expose a single awaitable
// `seedBuiltinPipelinesPromise` that the route's request handler
// awaits before resolving names. Errors are still logged per-seed
// inside seedBuiltinPipelineByName; failures of one seed don't block
// the others (Promise.allSettled).
const BUILTIN_PIPELINE_NAMES = [
  "smoke-test",
  "tech-research-collector",
  "tech-research-writer",
  "pipeline-generator",
  "pr-description-generator",
  "pipeline-modifier",
] as const;

export const seedBuiltinPipelinesPromise: Promise<unknown> = Promise.allSettled(
  BUILTIN_PIPELINE_NAMES.map((name) => seedBuiltinPipelineByName(name)),
);
