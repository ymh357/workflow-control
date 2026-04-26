// REST routes for kernel-next task status + A8 hot-update migration.
//
// GET  /api/kernel/tasks/:taskId/status
// POST /api/kernel/tasks/:taskId/migrate     body: { proposalId: string }
// POST /api/kernel/tasks/:taskId/rollback    body: { toVersion: string; actor?: string }
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

const rollbackBodySchema = z.object({
  toVersion: z.string().min(1),
  actor: z.string().min(1).optional(),
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
  const result = await svc.migrateTask(taskId, parsed.data.proposalId);
  if (result.ok) return c.json(result);
  return c.json(result, statusForMigrateDiagnostic(result.diagnostics[0]?.code));
});

// PROPOSAL_NOT_FOUND → 404 ("proposal doesn't exist")
// PROPOSAL_ALREADY_RESOLVED → 409 ("proposal in wrong state")
// PATCH_APPLY_ERROR → 409 (migrate-specific: task not opted in, no
//   attempts yet, orphan proposed version, etc. — all are "conflict
//   between requested action and current state", not server faults)
// MIGRATION_IN_PROGRESS → 409 (another migration is already running for
//   this taskId; caller should retry after a backoff)
// MIGRATION_FAILED → 500 (DB / execution fault — an audit row with
//   status='failed' has already been written to hot_update_events)
// anything else → 500
function statusForMigrateDiagnostic(code: string | undefined): 404 | 409 | 500 {
  if (code === "PROPOSAL_NOT_FOUND") return 404;
  if (code === "PROPOSAL_ALREADY_RESOLVED") return 409;
  if (code === "PATCH_APPLY_ERROR") return 409;
  if (code === "MIGRATION_IN_PROGRESS") return 409;
  if (code === "MIGRATION_FAILED") return 500;
  return 500;
}

// Rollback diagnostic → HTTP status
// VERSION_NOT_IN_HISTORY → 409 (toVersion never migrated for this task)
// PATCH_APPLY_ERROR → 409 (rollback patch couldn't apply — conflict)
// ROLLBACK_EMPTY_DIFF → 409 (nothing to rollback)
// anything else → 500
function statusForRollbackDiagnostic(code: string | undefined): 404 | 409 | 500 {
  if (code === "VERSION_NOT_IN_HISTORY") return 409;
  if (code === "PATCH_APPLY_ERROR") return 409;
  if (code === "ROLLBACK_EMPTY_DIFF") return 409;
  return 500;
}

// 2026-04-27 B5 — cancel a running task from the web UI.
// Diagnostic mapping:
//   TASK_NOT_FOUND        → 404
//   TASK_ALREADY_TERMINAL → 409
kernelTasksRoute.post("/kernel/tasks/:taskId/cancel", async (c) => {
  const taskId = c.req.param("taskId");

  const raw = await c.req.text();
  let body: { reason?: string; actor?: string } = {};
  if (raw.trim().length > 0) {
    try {
      body = JSON.parse(raw) as { reason?: string; actor?: string };
    } catch {
      return badRequest(c, "INVALID_JSON_BODY", "invalid JSON body");
    }
  }

  const svc = new KernelService(getKernelNextDb(), { skipTypeCheck: true });
  const result = svc.cancelTask({
    taskId,
    reason: body.reason,
    actor: body.actor ?? "web",
  });
  if (result.ok) return c.json(result);
  const code = result.diagnostics[0]?.code;
  const status = code === "TASK_NOT_FOUND" ? 404 : code === "TASK_ALREADY_TERMINAL" ? 409 : 500;
  return c.json(result, status);
});

// 2026-04-27 B5 — provide secrets to a task that's paused on a
// secret-gate. Resumes the task automatically once the gate is satisfied.
// Diagnostic mapping:
//   NO_PENDING_SECRET_GATE   → 409
//   SECRET_KEY_NOT_REQUIRED  → 400
const secretsBodySchema = z.object({
  secrets: z.record(z.string().min(1), z.string().min(1)),
}).strict();

kernelTasksRoute.post("/kernel/tasks/:taskId/secrets", async (c) => {
  const taskId = c.req.param("taskId");

  const raw = await c.req.text();
  let body: unknown;
  try {
    body = raw.trim().length === 0 ? {} : JSON.parse(raw);
  } catch {
    return badRequest(c, "INVALID_JSON_BODY", "invalid JSON body");
  }
  const parsed = secretsBodySchema.safeParse(body);
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
  const result = await svc.provideTaskSecrets(taskId, parsed.data.secrets);
  if (result.ok) return c.json(result);
  const code = result.diagnostics[0]?.code;
  const status =
    code === "NO_PENDING_SECRET_GATE" ? 409
    : code === "SECRET_KEY_NOT_REQUIRED" ? 400
    : 500;
  return c.json(result, status);
});

// 2026-04-27 B5 — list pending secret-gates so the dashboard can show
// "task waiting for secrets [GITHUB_TOKEN, SLACK_WEBHOOK]". Read-only;
// 404 only when the task itself doesn't exist.
kernelTasksRoute.get("/kernel/tasks/:taskId/secrets", (c) => {
  const taskId = c.req.param("taskId");
  const svc = new KernelService(getKernelNextDb(), { skipTypeCheck: true });
  const pending = svc.listPendingSecretGates(taskId);
  return c.json({ ok: true, taskId, pending });
});

// 2026-04-27 B5 — retry a failed/stalled task from a specific stage.
// Without `fromStage`, retries from the earliest non-success stage in
// topological order (KernelService default).
const retryBodySchema = z.object({
  fromStage: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
}).strict();

kernelTasksRoute.post("/kernel/tasks/:taskId/retry", async (c) => {
  const taskId = c.req.param("taskId");

  const raw = await c.req.text();
  let body: unknown = {};
  if (raw.trim().length > 0) {
    try { body = JSON.parse(raw); }
    catch { return badRequest(c, "INVALID_JSON_BODY", "invalid JSON body"); }
  }
  const parsed = retryBodySchema.safeParse(body);
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
  const result = await svc.retryTaskFromStage({
    taskId,
    fromStage: parsed.data.fromStage,
    actor: parsed.data.actor ?? "web",
  });
  if (result.ok) return c.json(result);
  const code = result.diagnostics[0]?.code;
  // retryTaskFromStage diagnostic codes:
  //   TASK_NOT_FOUND   → 404 (no stage_attempts row exists)
  //   UNKNOWN_STAGE    → 400 (caller-supplied fromStage not in IR)
  //   NO_FAILED_STAGE  → 409 (auto-resolution found nothing to retry)
  //   PATCH_APPLY_ERROR → 500 (IR was GC'd or rerun_from injection failed)
  const status =
    code === "TASK_NOT_FOUND" ? 404
    : code === "UNKNOWN_STAGE" ? 400
    : code === "NO_FAILED_STAGE" ? 409
    : 500;
  return c.json(result, status);
});

kernelTasksRoute.post("/kernel/tasks/:taskId/rollback", async (c) => {
  const taskId = c.req.param("taskId");

  const raw = await c.req.text();
  let body: unknown;
  try {
    body = raw.trim().length === 0 ? {} : JSON.parse(raw);
  } catch {
    return badRequest(c, "INVALID_JSON_BODY", "invalid JSON body");
  }
  const parsed = rollbackBodySchema.safeParse(body);
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
  const result = await svc.rollbackHotUpdate({
    taskId,
    toVersion: parsed.data.toVersion,
    actor: parsed.data.actor ?? "unknown",
  });
  if (result.ok) return c.json(result);
  return c.json(result, statusForRollbackDiagnostic(result.diagnostics[0]?.code));
});
