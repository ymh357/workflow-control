import { Hono } from "hono";
import { kernelNextBroadcaster } from "../kernel-next/sse/singleton.js";
import { createKernelNextStream } from "../kernel-next/sse/http.js";

export const kernelNextStreamRoute = new Hono();

// GET /kernel-next/tasks/:taskId/stream
// text/event-stream of KernelNextSSEEvent for a single task. Clients
// receive broadcaster history on connect, then live events until
// they disconnect.
kernelNextStreamRoute.get("/kernel-next/tasks/:taskId/stream", (c) => {
  const taskId = c.req.param("taskId");
  const stream = createKernelNextStream(kernelNextBroadcaster, taskId);

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");
  return c.body(stream);
});
