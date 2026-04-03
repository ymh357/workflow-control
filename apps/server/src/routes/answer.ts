import { Hono } from "hono";
import { answerQuestion } from "../actions/task-actions.js";
import { validateBody, getValidatedBody, answerSchema } from "../middleware/validate.js";
import { actionToResponse } from "./action-helpers.js";

export const answerRoute = new Hono();

answerRoute.post("/tasks/:taskId/answer", validateBody(answerSchema), async (c) => {
  const taskId = c.req.param("taskId");
  const body = getValidatedBody(c) as { questionId: string; answer: string };
  return actionToResponse(c, answerQuestion(taskId, body.questionId, body.answer));
});
