import { Hono } from "hono";
import { confirmGate, rejectGate } from "../actions/task-actions.js";
import { validateBody, getValidatedBody, confirmSchema, rejectSchema } from "../middleware/validate.js";
import { actionToResponse } from "./action-helpers.js";

export const confirmRoute = new Hono();

confirmRoute.post("/tasks/:taskId/confirm", validateBody(confirmSchema), async (c) => {
  const taskId = c.req.param("taskId");
  const body = getValidatedBody(c) as { repoName?: string };
  return actionToResponse(c, confirmGate(taskId, { repoName: body.repoName }));
});

confirmRoute.post("/tasks/:taskId/reject", validateBody(rejectSchema), async (c) => {
  const taskId = c.req.param("taskId");
  const body = getValidatedBody(c) as { reason?: string; feedback?: string; targetStage?: string };
  return actionToResponse(c, rejectGate(taskId, body));
});
