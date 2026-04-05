import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const mockSseManager = vi.hoisted(() => ({
  createStream: vi.fn(),
  hasHistory: vi.fn(),
}));

const mockTaskListBroadcaster = vi.hoisted(() => ({
  createStream: vi.fn(),
}));

const mockGetWorkflow = vi.hoisted(() => vi.fn());
const mockRestoreWorkflow = vi.hoisted(() => vi.fn());

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock("../sse/manager.js", () => ({
  sseManager: mockSseManager,
}));

vi.mock("../sse/task-list-broadcaster.js", () => ({
  taskListBroadcaster: mockTaskListBroadcaster,
}));

vi.mock("../machine/workflow.js", () => ({
  getWorkflow: (...args: unknown[]) => mockGetWorkflow(...args),
  restoreWorkflow: (...args: unknown[]) => mockRestoreWorkflow(...args),
}));

import { streamRoute } from "./stream.js";

describe("stream routes — adversarial", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route("/", streamRoute);
  });

  it("GET /stream/:taskId with path traversal in taskId", async () => {
    mockGetWorkflow.mockReturnValue(null);
    mockRestoreWorkflow.mockReturnValue(null);
    mockSseManager.hasHistory.mockReturnValue(false);

    const res = await app.request("/stream/../../etc/passwd");
    // Hono routing treats this as a single param segment
    expect(res.status).toBe(404);
  });

  it("GET /stream/:taskId — non-Error throw from createStream propagates", async () => {
    mockGetWorkflow.mockReturnValue({ id: "t1" });
    mockSseManager.createStream.mockImplementation(() => {
      throw new Error("unexpected internal error");
    });

    // Non-rate-limit Error is re-thrown, Hono catches it as 500
    const res = await app.request("/stream/t1");
    expect(res.status).toBe(500);
  });

  it("GET /stream/tasks — Error without 'Too many' in message rethrows as 500", async () => {
    mockTaskListBroadcaster.createStream.mockImplementation(() => {
      throw new Error("some other failure");
    });

    const res = await app.request("/stream/tasks");
    expect(res.status).toBe(500);
  });

  it("GET /stream/:taskId distinguishes 'Too many connections' exactly", async () => {
    mockGetWorkflow.mockReturnValue({ id: "t1" });
    mockSseManager.createStream.mockImplementation(() => {
      throw new Error("Limit exceeded");
    });

    // "Limit exceeded" does NOT include "Too many connections"
    const res = await app.request("/stream/t1");
    // Should NOT be 429 since the message doesn't match
    expect(res.status).toBe(500);
  });

  it("GET /stream/tasks route takes priority over /stream/:taskId for literal 'tasks'", async () => {
    const fakeStream = new ReadableStream<Uint8Array>();
    mockTaskListBroadcaster.createStream.mockReturnValue(fakeStream);

    const res = await app.request("/stream/tasks");
    expect(res.status).toBe(200);
    expect(mockTaskListBroadcaster.createStream).toHaveBeenCalled();
    // Ensure it didn't hit the per-task route
    expect(mockGetWorkflow).not.toHaveBeenCalled();
  });

  it("GET /stream/:taskId with empty string taskId does not match", async () => {
    const res = await app.request("/stream/");
    expect(res.status).toBe(404);
  });

  it("POST /stream/:taskId is method not allowed (only GET defined)", async () => {
    const res = await app.request("/stream/task-1", { method: "POST" });
    // Hono returns 404 for unregistered method+path combos
    expect(res.status).toBe(404);
  });

  it("GET /stream/:taskId with very long taskId doesn't crash", async () => {
    const longId = "a".repeat(10_000);
    mockGetWorkflow.mockReturnValue(null);
    mockRestoreWorkflow.mockReturnValue(null);
    mockSseManager.hasHistory.mockReturnValue(false);

    const res = await app.request(`/stream/${longId}`);
    expect(res.status).toBe(404);
  });
});
