import { Hono } from "hono";
import type { CreateTaskResponse } from "../types/index.js";
import { createTask, launch } from "../actions/task-actions.js";
import { validateBody, getValidatedBody, createTaskSchema } from "../middleware/validate.js";
import { errorResponse, ErrorCode } from "../lib/error-response.js";
import { actionToResponse } from "./action-helpers.js";

export const triggerRoute = new Hono();

// POST /api/tasks — create a new task draft (zero token consumption)
triggerRoute.post("/tasks", validateBody(createTaskSchema), async (c) => {
  const body = getValidatedBody(c) as { taskText: string; repoName?: string; pipelineName?: string; edge?: boolean };

  const result = createTask(body);
  if (!result.ok) {
    if (result.code === "INVALID_STATE") {
      return errorResponse(c, 409, ErrorCode.INVALID_STATE, result.message);
    }
    if (result.code === "INVALID_CONFIG") {
      return errorResponse(c, 400, ErrorCode.INVALID_CONFIG, result.message);
    }
    return actionToResponse(c, result);
  }

  return c.json<CreateTaskResponse>({ taskId: result.data.taskId }, 201);
});

// POST /api/tasks/:id/launch — start the workflow for a draft
triggerRoute.post("/tasks/:id/launch", async (c) => {
  const taskId = c.req.param("id");
  return actionToResponse(c, launch(taskId));
});
