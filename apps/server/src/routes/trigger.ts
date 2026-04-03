import { Hono } from "hono";
import type { CreateTaskResponse } from "../types/index.js";
import { createTask, launch } from "../actions/task-actions.js";
import { validateBody, getValidatedBody, createTaskSchema } from "../middleware/validate.js";
import { errorResponse, ErrorCode } from "../lib/error-response.js";

export const triggerRoute = new Hono();

// POST /api/tasks — create a new task draft (zero token consumption)
triggerRoute.post("/tasks", validateBody(createTaskSchema), async (c) => {
  const body = getValidatedBody(c) as { taskText: string; repoName?: string; pipelineName?: string; edge?: boolean };

  const result = createTask(body);
  if (!result.ok) {
    const msg = result.message;
    if (msg.includes("already in progress") || msg.includes("already exists")) {
      return errorResponse(c, 409, ErrorCode.INVALID_STATE, msg);
    }
    if (msg.includes("not found")) {
      return errorResponse(c, 400, ErrorCode.INVALID_CONFIG, msg);
    }
    return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, msg);
  }

  return c.json<CreateTaskResponse>({ taskId: result.data.taskId }, 201);
});

// POST /api/tasks/:id/launch — start the workflow for a draft
triggerRoute.post("/tasks/:id/launch", async (c) => {
  const taskId = c.req.param("id");
  const result = launch(taskId);
  if (!result.ok) {
    return errorResponse(c, 404, ErrorCode.TASK_NOT_FOUND, result.message);
  }
  return c.json({ ok: true });
});
