import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { kernelNextStreamRoute } from "./kernel-next-stream.js";
import { kernelNextBroadcaster } from "../kernel-next/sse/singleton.js";

describe("GET /kernel-next/tasks/:taskId/stream", () => {
  let app: Hono;

  beforeEach(() => {
    app = new Hono();
    app.route("/", kernelNextStreamRoute);
    // Route shares the singleton broadcaster with the running engine.
    // Clear any residual state so each test's subscriberCount starts
    // at a known value.
    kernelNextBroadcaster.clearTask("http-route-test");
  });

  it("responds 200 with text/event-stream headers", async () => {
    const res = await app.request("/kernel-next/tasks/http-route-test/stream");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("Connection")).toBe("keep-alive");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");

    // Drain the body so the underlying ReadableStream's cancel()
    // runs and detaches the subscriber.
    const reader = res.body!.getReader();
    await reader.cancel();
  });

  it("connecting registers a broadcaster subscriber; cancelling the body detaches it", async () => {
    expect(kernelNextBroadcaster.subscriberCount("http-route-test")).toBe(0);

    const res = await app.request("/kernel-next/tasks/http-route-test/stream");
    expect(kernelNextBroadcaster.subscriberCount("http-route-test")).toBe(1);

    await res.body!.cancel();
    // Give microtasks a tick to flush the cancel path.
    await new Promise((r) => setTimeout(r, 10));
    expect(kernelNextBroadcaster.subscriberCount("http-route-test")).toBe(0);
  });

  it("live events published to the singleton reach the route's body", async () => {
    const res = await app.request("/kernel-next/tasks/http-route-test/stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Publish a live event after connect.
    kernelNextBroadcaster.publish({
      type: "task_state",
      taskId: "http-route-test",
      timestamp: new Date().toISOString(),
      data: { state: "running" },
    });

    await new Promise((r) => setTimeout(r, 20));
    const { value } = await reader.read();
    reader.cancel();
    const text = decoder.decode(value);
    expect(text).toContain("event: task_state");
    expect(text).toContain('"state":"running"');
  });
});
