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
import { getKernelNextDb } from "../lib/kernel-next-db.js";
import { runPipeline } from "../kernel-next/runtime/runner.js";
import { kernelNextBroadcaster } from "../kernel-next/sse/singleton.js";
import { diamondIR } from "../kernel-next/generator-mock/mini-generator.js";
import { slowDiamondHandlers } from "../kernel-next/demo/slow-diamond.js";
import type { PipelineIR } from "../kernel-next/ir/schema.js";
import type { StageHandlerMap } from "../kernel-next/runtime/mock-executor.js";
import { logger } from "../lib/logger.js";

export const kernelRunRoute = new Hono();

const runBodySchema = z.object({
  pipeline: z.string().min(1),
  taskId: z.string().min(1).optional(),
}).strict();

interface PipelineRegistration {
  ir: PipelineIR;
  handlers: StageHandlerMap;
  // Longer timeout for slow-mock variants so the dashboard has time
  // to actually render mid-run state.
  timeoutMs?: number;
}

// Registry of pipelines runnable via this route. Keys are the values
// accepted in the `pipeline` body field. Names chosen so future
// builtin pipelines can be added without colliding.
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

  const { ir, handlers, timeoutMs } = factory();
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

  // Fire-and-forget. The runner publishes SSE events through the
  // singleton broadcaster; clients observe via /stream. Errors are
  // logged but do not affect the HTTP response (already returned).
  void runPipeline({
    db,
    ir,
    taskId,
    versionHash,
    handlers,
    broadcaster: kernelNextBroadcaster,
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
