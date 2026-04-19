// REST routes for kernel-next task status + A8 hot-update migration.
//
// GET  /api/kernel/tasks/:taskId/status
// POST /api/kernel/tasks/:taskId/migrate     body: { proposalId: string }
//
// Status shape mirrors KernelService.getTaskStatus — see §3.3 gate
// lifecycle. Main Claude Code polls this while a task runs; when the
// status becomes 'gated', the handler decides whether to answer the
// gate itself (via answer_gate MCP / POST /api/kernel/gates/:id/answer)
// or relay the question to the end user.
//
// Migrate triggers the A8 forward-migration happy path (§10.5). The
// proposal must be approved AND this task must be in its
// migrateRunningTasks opt-in list; failures come back with the same
// error envelope used by kernel-proposals so clients branch on
// diagnostic codes, not body shape.

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { KernelService } from "../kernel-next/mcp/kernel.js";
import { getKernelNextDb } from "../lib/kernel-next-db.js";

export const kernelTasksRoute = new Hono();

const migrateBodySchema = z.object({
  proposalId: z.string().min(1),
}).strict();

function badRequest(
  c: Context,
  code: "INVALID_JSON_BODY" | "INVALID_REQUEST_BODY",
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

kernelTasksRoute.get("/kernel/tasks/:taskId/status", (c) => {
  const taskId = c.req.param("taskId");
  const svc = new KernelService(getKernelNextDb(), { skipTypeCheck: true });
  const report = svc.getTaskStatus(taskId);
  // report.status === 'not_found' is still an "ok: true" shape by
  // design — callers that just want "does this task exist?" can switch
  // on the status string without catching a 404 envelope. To match the
  // REST convention though, 'not_found' is surfaced with HTTP 404.
  if (report.status === "not_found") {
    return c.json(report, 404);
  }
  return c.json(report);
});

kernelTasksRoute.post("/kernel/tasks/:taskId/migrate", async (c) => {
  const taskId = c.req.param("taskId");

  const raw = await c.req.text();
  let body: unknown;
  try {
    body = raw.trim().length === 0 ? {} : JSON.parse(raw);
  } catch {
    return badRequest(c, "INVALID_JSON_BODY", "invalid JSON body");
  }
  const parsed = migrateBodySchema.safeParse(body);
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
  const result = svc.migrateTask(taskId, parsed.data.proposalId);
  if (result.ok) return c.json(result);
  return c.json(result, statusForMigrateDiagnostic(result.diagnostics[0]?.code));
});

// PROPOSAL_NOT_FOUND → 404 ("proposal doesn't exist")
// PROPOSAL_ALREADY_RESOLVED → 409 ("proposal in wrong state")
// PATCH_APPLY_ERROR → 409 (migrate-specific: task not opted in, no
//   attempts yet, orphan proposed version, etc. — all are "conflict
//   between requested action and current state", not server faults)
// anything else → 500
function statusForMigrateDiagnostic(code: string | undefined): 404 | 409 | 500 {
  if (code === "PROPOSAL_NOT_FOUND") return 404;
  if (code === "PROPOSAL_ALREADY_RESOLVED") return 409;
  if (code === "PATCH_APPLY_ERROR") return 409;
  return 500;
}
