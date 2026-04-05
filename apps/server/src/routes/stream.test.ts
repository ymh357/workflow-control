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

describe("stream routes", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route("/", streamRoute);
  });

  it("GET /stream/tasks returns SSE stream with correct headers", async () => {
    const fakeStream = new ReadableStream<Uint8Array>();
    mockTaskListBroadcaster.createStream.mockReturnValue(fakeStream);

    const res = await app.request("/stream/tasks");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("Connection")).toBe("keep-alive");
  });

  it("GET /stream/tasks returns 429 when too many connections", async () => {
    mockTaskListBroadcaster.createStream.mockImplementation(() => {
      throw new Error("Too many connections");
    });

    const res = await app.request("/stream/tasks");
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("RATE_LIMITED");
  });

  it("GET /stream/tasks propagates non-rate-limit errors as 500", async () => {
    mockTaskListBroadcaster.createStream.mockImplementation(() => {
      throw new Error("unexpected error");
    });

    const res = await app.request("/stream/tasks");
    expect(res.status).toBe(500);
  });

  it("GET /stream/:taskId returns SSE stream for valid task", async () => {
    mockGetWorkflow.mockReturnValue({ id: "task-1" });
    const fakeStream = new ReadableStream<Uint8Array>();
    mockSseManager.createStream.mockReturnValue(fakeStream);

    const res = await app.request("/stream/task-1");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(mockSseManager.createStream).toHaveBeenCalledWith("task-1");
  });

  it("GET /stream/:taskId returns SSE when no workflow but has history", async () => {
    mockGetWorkflow.mockReturnValue(null);
    mockRestoreWorkflow.mockReturnValue(null);
    mockSseManager.hasHistory.mockReturnValue(true);
    const fakeStream = new ReadableStream<Uint8Array>();
    mockSseManager.createStream.mockReturnValue(fakeStream);

    const res = await app.request("/stream/task-2");
    expect(res.status).toBe(200);
    expect(mockSseManager.createStream).toHaveBeenCalledWith("task-2");
  });

  it("GET /stream/:taskId returns 404 when task not found and no history", async () => {
    mockGetWorkflow.mockReturnValue(null);
    mockRestoreWorkflow.mockReturnValue(null);
    mockSseManager.hasHistory.mockReturnValue(false);

    const res = await app.request("/stream/nonexistent");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("TASK_NOT_FOUND");
  });

  it("GET /stream/:taskId returns 429 when too many connections", async () => {
    mockGetWorkflow.mockReturnValue({ id: "task-3" });
    mockSseManager.createStream.mockImplementation(() => {
      throw new Error("Too many connections for this task");
    });

    const res = await app.request("/stream/task-3");
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("RATE_LIMITED");
  });

  it("GET /stream/:taskId propagates non-rate-limit errors as 500", async () => {
    mockGetWorkflow.mockReturnValue({ id: "task-4" });
    mockSseManager.createStream.mockImplementation(() => {
      throw new Error("something else");
    });

    const res = await app.request("/stream/task-4");
    expect(res.status).toBe(500);
  });

  it("GET /stream/:taskId sets Connection keep-alive header", async () => {
    mockGetWorkflow.mockReturnValue({ id: "task-5" });
    const fakeStream = new ReadableStream<Uint8Array>();
    mockSseManager.createStream.mockReturnValue(fakeStream);

    const res = await app.request("/stream/task-5");
    expect(res.headers.get("Connection")).toBe("keep-alive");
  });

  it("GET /stream/:taskId attempts restore before returning 404", async () => {
    mockGetWorkflow.mockReturnValue(null);
    mockRestoreWorkflow.mockReturnValue({ id: "restored-task" });
    const fakeStream = new ReadableStream<Uint8Array>();
    mockSseManager.createStream.mockReturnValue(fakeStream);

    const res = await app.request("/stream/task-restore");

    expect(res.status).toBe(200);
    expect(mockRestoreWorkflow).toHaveBeenCalledWith("task-restore");
    expect(mockSseManager.createStream).toHaveBeenCalledWith("task-restore");
  });

  it("GET /stream/tasks body is a ReadableStream", async () => {
    const fakeStream = new ReadableStream<Uint8Array>();
    mockTaskListBroadcaster.createStream.mockReturnValue(fakeStream);

    const res = await app.request("/stream/tasks");
    expect(res.body).toBeInstanceOf(ReadableStream);
  });
});
