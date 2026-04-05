import { Hono } from "hono";
import { retryTask } from "../actions/task-actions.js";
import { actionToResponse } from "./action-helpers.js";
import { errorResponse, ErrorCode } from "../lib/error-response.js";
import { retrySchema } from "../middleware/validate.js";

export const retryRoute = new Hono();

retryRoute.post("/tasks/:taskId/retry", async (c) => {
  const taskId = c.req.param("taskId");
  let raw: unknown;
  try {
    const text = await c.req.text();
    if (!text || text.trim() === "") {
      return actionToResponse(c, retryTask(taskId, {}));
    }
    raw = JSON.parse(text);
  } catch {
    return errorResponse(c, 400, ErrorCode.VALIDATION_FAILED, "Invalid JSON body");
  }

  const parsed = retrySchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    return errorResponse(c, 400, ErrorCode.VALIDATION_FAILED, "Validation failed", details);
  }

  return actionToResponse(c, retryTask(taskId, { sync: parsed.data.sync }));
});
