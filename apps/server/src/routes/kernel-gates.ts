// REST routes for kernel-next gate lifecycle.
//
// GET  /api/kernel/gates?taskId=...&answered=true|false
// POST /api/kernel/gates/:id/answer   body: { answer: string }
//
// See terminal design §3.3 / §8.1. The runner creates gate_queue rows
// when a gate-type stage activates; main Claude Code (or a human via
// web UI / curl) posts the answer here.
//
// Error envelope matches kernel-proposals.ts: every non-2xx response
// is { ok: false, diagnostics: [{ code, message, context? }] }.

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { KernelService } from "../kernel-next/mcp/kernel.js";
import { getKernelNextDb } from "../lib/kernel-next-db.js";
import { taskRegistry } from "../kernel-next/runtime/task-registry.js";

export const kernelGatesRoute = new Hono();

const answerBodySchema = z.object({
  answer: z.string().min(1).max(4096),
}).strict();

function badRequest(
  c: Context,
  code: "INVALID_ANSWERED_PARAM" | "INVALID_JSON_BODY" | "INVALID_REQUEST_BODY",
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

kernelGatesRoute.get("/kernel/gates", (c) => {
  const taskId = c.req.query("taskId");
  const answeredParam = c.req.query("answered");
  let answered: boolean | undefined;
  if (answeredParam !== undefined) {
    if (answeredParam === "true") answered = true;
    else if (answeredParam === "false") answered = false;
    else {
      return badRequest(
        c,
        "INVALID_ANSWERED_PARAM",
        `invalid answered '${answeredParam}' (allowed: true|false)`,
        { received: answeredParam },
      );
    }
  }
  const svc = new KernelService(getKernelNextDb(), { skipTypeCheck: true });
  const gates = svc.listGates({
    taskId: typeof taskId === "string" ? taskId : undefined,
    answered,
  });
  return c.json({ ok: true, gates });
});

kernelGatesRoute.post("/kernel/gates/:id/answer", async (c) => {
  const id = c.req.param("id");

  // Answer is required; reject empty body explicitly.
  const raw = await c.req.text();
  if (raw.trim().length === 0) {
    return badRequest(c, "INVALID_REQUEST_BODY", "request body is required");
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return badRequest(c, "INVALID_JSON_BODY", "invalid JSON body");
  }
  const parsed = answerBodySchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return badRequest(
      c,
      "INVALID_REQUEST_BODY",
      issue?.message ?? "bad request",
      issue ? { path: issue.path } : undefined,
    );
  }

  const svc = new KernelService(getKernelNextDb(), { skipTypeCheck: true });
  const result = svc.answerGate(id, parsed.data.answer);
  if (result.ok) {
    // Dispatch GATE_ANSWERED to the live runner if present. If not (task
    // already completed / process restarted), the persisted answer will
    // be picked up by any rehydration path; REST just returns ok.
    const dispatcher = taskRegistry.get(result.taskId);
    dispatcher?.send({
      type: "GATE_ANSWERED",
      gateId: result.gateId,
      stageName: result.stageName,
      answer: result.answer,
      targetStage: result.targetStage,
    });
    return c.json(result);
  }
  return c.json(result, statusForDiagnostic(result.diagnostics[0]?.code));
});

function statusForDiagnostic(code: string | undefined): 404 | 409 | 422 | 500 {
  if (code === "GATE_NOT_FOUND") return 404;
  if (code === "GATE_ALREADY_ANSWERED") return 409;
  if (code === "GATE_ANSWER_INVALID") return 422;
  return 500;
}
