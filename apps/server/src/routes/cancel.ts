import { Hono } from "hono";
import { cancelTask_, resumeTask, deleteTask } from "../actions/task-actions.js";
import { actionToResponse } from "./action-helpers.js";

export const cancelRoute = new Hono();

cancelRoute.post("/tasks/:taskId/cancel", async (c) => {
  const taskId = c.req.param("taskId");
  return actionToResponse(c, await cancelTask_(taskId));
});

cancelRoute.post("/tasks/:taskId/resume", async (c) => {
  const taskId = c.req.param("taskId");
  return actionToResponse(c, resumeTask(taskId));
});

cancelRoute.delete("/tasks/:taskId", async (c) => {
  const taskId = c.req.param("taskId");
  return actionToResponse(c, await deleteTask(taskId));
});
