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
// Legacy-YAML builtins (smoke-test, tech-research-collector,
// tech-research-writer, pipeline-generator) are seeded into
// pipeline_versions at module load via seedLegacyPipelineByName so
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
import { loadLegacyPipelineIR } from "../kernel-next/runtime/load-legacy-pipeline.js";
import { startPipelineRun } from "../kernel-next/runtime/start-pipeline-run.js";
import { logger } from "../lib/logger.js";

// Resolve the monorepo's tsc binary so that submit_pipeline's wire type
// validation works regardless of where the executor's temp codegen dir
// sits. Without this, `npx tsc` resolved from the temp dir prints
// "This is not the tsc command you are looking for" and the MCP
// submit_pipeline returns a bogus WIRE_TYPE_MISMATCH. Passed to
// startPipelineRun so the per-stage createKernelMcp call threads it
// into the combined-surface MCP server.
const MONOREPO_TSC_PATH = (() => {
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
  });

  if (res.ok === false) {
    return c.json({
      ok: false,
      diagnostics: [{ code: res.code, message: res.message, context: res.context }],
    }, 400);
  }

  return c.json({ ok: true, taskId: res.taskId, versionHash: res.versionHash }, 202);
});

// Seed legacy-YAML builtins into pipeline_versions at module load so they
// can be resolved by name via startPipelineRun. No longer stored in a
// runtime registry — SQLite is the only lookup path for real pipelines.
// Mock pipelines (diamond family) are seeded on-demand by
// startPipelineRun via MOCK_HANDLER_REGISTRY.
function seedLegacyPipelineByName(pipelineDir: string): void {
  try {
    const loaded = loadLegacyPipelineIR(pipelineDir);
    const db = getKernelNextDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const res = svc.submit(loaded.ir, { prompts: loaded.prompts });
    if (!res.ok) {
      throw new Error(
        `seedLegacyPipelineByName('${pipelineDir}'): submit failed: ${res.diagnostics.map((d) => `${d.code}: ${d.message ?? ""}`).join("; ")}`,
      );
    }
  } catch (err) {
    logger.error(
      { pipelineDir, err: (err as Error).message },
      "[kernel-run] seedLegacyPipelineByName failed",
    );
    throw err;
  }
}

seedLegacyPipelineByName("smoke-test");
seedLegacyPipelineByName("tech-research-collector");
seedLegacyPipelineByName("tech-research-writer");
seedLegacyPipelineByName("pipeline-generator");
