import { Hono } from "hono";
import { sseManager } from "../sse/manager.js";
import { taskListBroadcaster } from "../sse/task-list-broadcaster.js";
import { getWorkflow, restoreWorkflow } from "../machine/workflow.js";
import { errorResponse, ErrorCode } from "../lib/error-response.js";

export const streamRoute = new Hono();

// Global task list SSE — must be registered before /stream/:taskId
streamRoute.get("/stream/tasks", (c) => {
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = taskListBroadcaster.createStream();
  } catch (err) {
    if (err instanceof Error && err.message.includes("Too many")) {
      return errorResponse(c, 429, ErrorCode.RATE_LIMITED, err.message);
    }
    throw err;
  }

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");
  return c.body(stream);
});

streamRoute.get("/stream/:taskId", (c) => {
  const taskId = c.req.param("taskId");
  const workflow = getWorkflow(taskId) ?? restoreWorkflow(taskId);

  if (!workflow && !sseManager.hasHistory(taskId)) {
    return errorResponse(c, 404, ErrorCode.TASK_NOT_FOUND, "Task not found");
  }

  let stream: ReadableStream<Uint8Array>;
  try {
    stream = sseManager.createStream(taskId);
  } catch (err) {
    if (err instanceof Error && err.message.includes("Too many connections")) {
      return errorResponse(c, 429, ErrorCode.RATE_LIMITED, err.message);
    }
    throw err;
  }

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");
  return c.body(stream);
});
