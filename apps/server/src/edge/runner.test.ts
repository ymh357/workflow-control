import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseArgs } from "node:util";

// ---- Helpers extracted / re-implemented for testing ----
// Since runner.ts is a script with side effects (top-level imports of node-pty,
// fs reads, import.meta usage), we replicate the pure logic here and test it
// in isolation rather than importing the module directly.

const DEFAULT_SERVER_URL = "http://localhost:3001";

type Engine = "claude" | "gemini";

interface RunnerArgs {
  taskId?: string;
  trigger?: string;
  pipeline?: string;
  engine: Engine;
  serverUrl: string;
}

function parseCliArgs(argv: string[]): RunnerArgs {
  const rawArgs = argv.slice(0);
  while (rawArgs.length > 0 && rawArgs[0] === "--") rawArgs.shift();

  const { values, positionals } = parseArgs({
    args: rawArgs,
    allowPositionals: true,
    options: {
      trigger: { type: "string" },
      pipeline: { type: "string" },
      engine: { type: "string", default: "claude" },
      server: { type: "string", default: DEFAULT_SERVER_URL },
    },
  });

  return {
    taskId: positionals[0],
    trigger: values.trigger,
    pipeline: values.pipeline,
    engine: (values.engine as Engine) ?? "claude",
    serverUrl: values.server ?? DEFAULT_SERVER_URL,
  };
}

// fetchJson replica
async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// triggerNewTask replica
async function triggerNewTask(
  serverUrl: string,
  pipeline: string,
  taskText: string,
): Promise<string> {
  const { taskId } = await fetchJson<{ taskId: string }>(`${serverUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskText, pipelineName: pipeline, edge: true }),
  });
  await fetchJson(`${serverUrl}/api/tasks/${taskId}/launch`, { method: "POST" });
  return taskId;
}

// Model validation replica
const KNOWN_CLAUDE_MODELS = [
  "haiku", "sonnet", "opus",
  "claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-6",
];
const KNOWN_GEMINI_MODELS = [
  "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash",
];

function resolveModelSync(configured: string | undefined, engine: Engine): string | undefined {
  if (!configured) return undefined;
  const known = engine === "gemini" ? KNOWN_GEMINI_MODELS : KNOWN_CLAUDE_MODELS;
  if (known.includes(configured)) return configured;
  // In non-interactive mode, return as-is
  return configured;
}

// SSE line parser replica
interface EdgeEvent {
  event: string;
  data: Record<string, unknown>;
}

function parseSseChunk(chunk: string): EdgeEvent[] {
  const events: EdgeEvent[] = [];
  const lines = chunk.split("\n");
  let currentEvent = "";

  for (const line of lines) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith("data: ") && currentEvent) {
      try {
        const data = JSON.parse(line.slice(6));
        events.push({ event: currentEvent, data });
      } catch { /* malformed */ }
      currentEvent = "";
    } else if (line === "" || line.startsWith(":")) {
      currentEvent = "";
    }
  }

  return events;
}

// writeMcpConfig replica
function buildMcpConfig(serverUrl: string): object {
  return {
    mcpServers: { "workflow-control": { type: "http", url: `${serverUrl}/mcp` } },
  };
}

// ---- Tests ----

describe("parseCliArgs", () => {
  it("parses a positional task ID", () => {
    const args = parseCliArgs(["abc-123"]);
    expect(args.taskId).toBe("abc-123");
    expect(args.engine).toBe("claude");
    expect(args.serverUrl).toBe(DEFAULT_SERVER_URL);
  });

  it("parses --trigger and --pipeline", () => {
    const args = parseCliArgs(["--trigger", "do something", "--pipeline", "my-pipe"]);
    expect(args.trigger).toBe("do something");
    expect(args.pipeline).toBe("my-pipe");
    expect(args.taskId).toBeUndefined();
  });

  it("parses --engine gemini", () => {
    const args = parseCliArgs(["task-1", "--engine", "gemini"]);
    expect(args.engine).toBe("gemini");
  });

  it("parses custom --server URL", () => {
    const args = parseCliArgs(["task-1", "--server", "http://remote:4000"]);
    expect(args.serverUrl).toBe("http://remote:4000");
  });

  it("strips leading -- separators injected by pnpm", () => {
    const args = parseCliArgs(["--", "--", "task-42"]);
    expect(args.taskId).toBe("task-42");
  });

  it("defaults engine to claude when not specified", () => {
    const args = parseCliArgs(["task-1"]);
    expect(args.engine).toBe("claude");
  });
});

describe("fetchJson", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed JSON on success", async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({ id: 1 }), text: () => Promise.resolve("") };
    vi.mocked(fetch).mockResolvedValue(mockResponse as unknown as Response);

    const result = await fetchJson<{ id: number }>("http://localhost/api/test");
    expect(result).toEqual({ id: 1 });
    expect(fetch).toHaveBeenCalledWith("http://localhost/api/test", undefined);
  });

  it("throws on non-ok response with status and body", async () => {
    const mockResponse = { ok: false, status: 404, text: () => Promise.resolve("Not Found") };
    vi.mocked(fetch).mockResolvedValue(mockResponse as unknown as Response);

    await expect(fetchJson("http://localhost/api/missing")).rejects.toThrow("HTTP 404: Not Found");
  });

  it("handles text() failure gracefully", async () => {
    const mockResponse = { ok: false, status: 500, text: () => Promise.reject(new Error("stream error")) };
    vi.mocked(fetch).mockResolvedValue(mockResponse as unknown as Response);

    await expect(fetchJson("http://localhost/api/broken")).rejects.toThrow("HTTP 500: ");
  });
});

describe("triggerNewTask", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates and launches a task", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ taskId: "new-task-1" }),
        text: () => Promise.resolve(""),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      } as unknown as Response);

    const taskId = await triggerNewTask("http://localhost:3001", "test-pipe", "build something");

    expect(taskId).toBe("new-task-1");
    expect(fetch).toHaveBeenCalledTimes(2);

    const [createUrl, createInit] = vi.mocked(fetch).mock.calls[0];
    expect(createUrl).toBe("http://localhost:3001/api/tasks");
    expect(createInit?.method).toBe("POST");
    const body = JSON.parse(createInit?.body as string);
    expect(body.taskText).toBe("build something");
    expect(body.pipelineName).toBe("test-pipe");
    expect(body.edge).toBe(true);

    const [launchUrl] = vi.mocked(fetch).mock.calls[1];
    expect(launchUrl).toBe("http://localhost:3001/api/tasks/new-task-1/launch");
  });
});

describe("resolveModel", () => {
  it("returns undefined when no model is configured", () => {
    expect(resolveModelSync(undefined, "claude")).toBeUndefined();
  });

  it("returns known claude model as-is", () => {
    expect(resolveModelSync("sonnet", "claude")).toBe("sonnet");
    expect(resolveModelSync("claude-opus-4-6", "claude")).toBe("claude-opus-4-6");
  });

  it("returns known gemini model as-is", () => {
    expect(resolveModelSync("gemini-2.5-pro", "gemini")).toBe("gemini-2.5-pro");
  });

  it("returns unknown model as-is in non-interactive mode", () => {
    expect(resolveModelSync("custom-model-v99", "claude")).toBe("custom-model-v99");
  });
});

describe("parseSseChunk", () => {
  it("parses a well-formed SSE chunk", () => {
    const chunk = "event: status_changed\ndata: {\"status\":\"running\"}\n\n";
    const events = parseSseChunk(chunk);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("status_changed");
    expect(events[0].data).toEqual({ status: "running" });
  });

  it("handles multiple events in one chunk", () => {
    const chunk = [
      "event: slot_created",
      'data: {"slot":"A"}',
      "",
      "event: task_terminated",
      'data: {"reason":"done"}',
      "",
    ].join("\n");

    const events = parseSseChunk(chunk);
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe("slot_created");
    expect(events[1].event).toBe("task_terminated");
  });

  it("skips malformed JSON data", () => {
    const chunk = "event: broken\ndata: not-json\n\n";
    const events = parseSseChunk(chunk);
    expect(events).toHaveLength(0);
  });

  it("resets current event on empty lines and comments", () => {
    const chunk = "event: orphan\n\ndata: {\"x\":1}\n";
    const events = parseSseChunk(chunk);
    // data line has no currentEvent because empty line reset it
    expect(events).toHaveLength(0);
  });
});

describe("buildMcpConfig", () => {
  it("builds correct MCP config structure", () => {
    const config = buildMcpConfig("http://my-server:5000");
    expect(config).toEqual({
      mcpServers: {
        "workflow-control": { type: "http", url: "http://my-server:5000/mcp" },
      },
    });
  });
});
