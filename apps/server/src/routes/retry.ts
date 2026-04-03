import { Hono } from "hono";
import { retryTask } from "../actions/task-actions.js";
import { actionToResponse } from "./action-helpers.js";

export const retryRoute = new Hono();

retryRoute.post("/tasks/:taskId/retry", async (c) => {
  const taskId = c.req.param("taskId");
  const body = await c.req.json<{ sync?: boolean }>().catch(() => ({})) as { sync?: boolean };
  return actionToResponse(c, retryTask(taskId, { sync: body.sync }));
});
