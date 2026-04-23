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
  // EventSource auto-sets Last-Event-ID on reconnect; we let the
  // broadcaster skip events with seq <= the recorded value so the
  // client does not re-render events it already acknowledged.
  const lastEventId = c.req.header("Last-Event-ID") ?? undefined;
  const stream = createKernelNextStream(kernelNextBroadcaster, taskId, { lastEventId });

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");
  return c.body(stream);
});
