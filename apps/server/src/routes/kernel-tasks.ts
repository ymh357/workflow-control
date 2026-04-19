// REST route for kernel-next task status.
//
// GET /api/kernel/tasks/:taskId/status
//
// Response shape mirrors KernelService.getTaskStatus — see §3.3 gate
// lifecycle. Main Claude Code polls this while a task runs; when the
// status becomes 'gated', the handler decides whether to answer the
// gate itself (via answer_gate MCP / POST /api/kernel/gates/:id/answer)
// or relay the question to the end user.

import { Hono } from "hono";
import { KernelService } from "../kernel-next/mcp/kernel.js";
import { getKernelNextDb } from "../lib/kernel-next-db.js";

export const kernelTasksRoute = new Hono();

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
