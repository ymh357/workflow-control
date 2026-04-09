import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

// --- Mocks ---

vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockSpawn = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}));

const mockExistsSync = vi.fn((..._: any[]) => false);
const mockMkdirSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockRmSync = vi.fn();
const mockReaddirSync = vi.fn((..._: any[]) => [] as string[]);
const mockStatSync = vi.fn();
vi.mock("node:fs", () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  mkdirSync: (...args: any[]) => mockMkdirSync(...args),
  writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
  rmSync: (...args: any[]) => mockRmSync(...args),
  readdirSync: (...args: any[]) => mockReaddirSync(...args),
  statSync: (...args: any[]) => mockStatSync(...args),
}));

// Helper: create a fake child process with controllable stdout/stderr
function createFakeChild() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    pid: number;
    exitCode: number | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.pid = 12345;
  child.exitCode = null;
  child.kill = vi.fn();
  return child;
}

let queryGemini: typeof import("./gemini-executor.js").queryGemini;

beforeEach(async () => {
  vi.clearAllMocks();
  // Re-import to get fresh module state
  const mod = await import("./gemini-executor.js");
  queryGemini = mod.queryGemini;
});

describe("queryGemini argument building", () => {
  it("builds base args with prompt and stream-json output format", () => {
    const fakeChild = createFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    queryGemini({
      prompt: "Hello world",
      options: { geminiPath: "/usr/bin/gemini" },
    });

    // Generator is lazy; trigger iteration to spawn
    const iter = queryGemini({
      prompt: "Hello world",
      options: { geminiPath: "/usr/bin/gemini" },
    });
    // Start iterating to trigger spawn
    const iterator = iter[Symbol.asyncIterator]();
    iterator.next(); // triggers spawn

    expect(mockSpawn).toHaveBeenCalled();
    const [path, args] = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1];
    expect(path).toBe("/usr/bin/gemini");
    expect(args).toContain("--prompt");
    expect(args).toContain("Hello world");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");

    // Clean up
    fakeChild.stdout.emit("end");
    fakeChild.emit("exit", 0, null);
  });

  it("includes --model when model option is provided", () => {
    const fakeChild = createFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    const iter = queryGemini({
      prompt: "test",
      options: { geminiPath: "/usr/bin/gemini", model: "gemini-2.0-flash" },
    });
    iter[Symbol.asyncIterator]().next();

    const [, args] = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1];
    expect(args).toContain("--model");
    expect(args).toContain("gemini-2.0-flash");

    fakeChild.stdout.emit("end");
    fakeChild.emit("exit", 0, null);
  });

  it("includes --yolo flag when yolo is true and no approvalMode", () => {
    const fakeChild = createFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    const iter = queryGemini({
      prompt: "test",
      options: { geminiPath: "/usr/bin/gemini", yolo: true },
    });
    iter[Symbol.asyncIterator]().next();

    const [, args] = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1];
    expect(args).toContain("--yolo");
    expect(args).not.toContain("--approval-mode");

    fakeChild.stdout.emit("end");
    fakeChild.emit("exit", 0, null);
  });

  it("prefers --approval-mode over --yolo when both are set", () => {
    const fakeChild = createFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    const iter = queryGemini({
      prompt: "test",
      options: { geminiPath: "/usr/bin/gemini", yolo: true, approvalMode: "auto_edit" },
    });
    iter[Symbol.asyncIterator]().next();

    const [, args] = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1];
    expect(args).toContain("--approval-mode");
    expect(args).toContain("auto_edit");
    expect(args).not.toContain("--yolo");

    fakeChild.stdout.emit("end");
    fakeChild.emit("exit", 0, null);
  });

  it("includes --resume when resume option is provided", () => {
    const fakeChild = createFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    const iter = queryGemini({
      prompt: "test",
      options: { geminiPath: "/usr/bin/gemini", resume: "session-abc" },
    });
    iter[Symbol.asyncIterator]().next();

    const [, args] = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1];
    expect(args).toContain("--resume");
    expect(args).toContain("session-abc");

    fakeChild.stdout.emit("end");
    fakeChild.emit("exit", 0, null);
  });
});

describe("mapGeminiMessage (via stdout parsing)", () => {
  it("parses init message", async () => {
    const fakeChild = createFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    const iter = queryGemini({
      prompt: "test",
      options: { geminiPath: "/usr/bin/gemini" },
    });
    const iterator = iter[Symbol.asyncIterator]();
    const nextPromise = iterator.next();

    fakeChild.stdout.emit("data", Buffer.from(JSON.stringify({ type: "init", session_id: "s1" }) + "\n"));

    const { value } = await nextPromise;
    expect(value).toEqual({ type: "init", session_id: "s1" });

    fakeChild.stdout.emit("end");
    fakeChild.emit("exit", 0, null);
  });

  it("parses assistant message", async () => {
    const fakeChild = createFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    const iter = queryGemini({
      prompt: "test",
      options: { geminiPath: "/usr/bin/gemini" },
    });
    const iterator = iter[Symbol.asyncIterator]();
    const nextPromise = iterator.next();

    fakeChild.stdout.emit("data", Buffer.from(
      JSON.stringify({ type: "message", role: "assistant", content: "Hello!" }) + "\n"
    ));

    const { value } = await nextPromise;
    expect(value.type).toBe("assistant");
    expect(value.message.content[0].type).toBe("text");
    expect(value.message.content[0].text).toBe("Hello!");

    fakeChild.stdout.emit("end");
    fakeChild.emit("exit", 0, null);
  });

  it("parses result message with stats", async () => {
    const fakeChild = createFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    const iter = queryGemini({
      prompt: "test",
      options: { geminiPath: "/usr/bin/gemini" },
    });
    const iterator = iter[Symbol.asyncIterator]();
    const nextPromise = iterator.next();

    fakeChild.stdout.emit("data", Buffer.from(
      JSON.stringify({
        type: "result",
        status: "success",
        session_id: "s2",
        result: "Done!",
        stats: { cost_usd: 0.01, duration_ms: 500 },
      }) + "\n"
    ));

    const { value } = await nextPromise;
    expect(value.type).toBe("result");
    expect(value.status).toBe("success");
    expect(value.result).toBe("Done!");
    expect(value.total_cost_usd).toBe(0.01);
    expect(value.duration_ms).toBe(500);
    expect(value.session_id).toBe("s2");

    fakeChild.stdout.emit("end");
    fakeChild.emit("exit", 0, null);
  });

  it("parses tool_use message", async () => {
    const fakeChild = createFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    const iter = queryGemini({
      prompt: "test",
      options: { geminiPath: "/usr/bin/gemini" },
    });
    const iterator = iter[Symbol.asyncIterator]();
    const nextPromise = iterator.next();

    fakeChild.stdout.emit("data", Buffer.from(
      JSON.stringify({ type: "tool_use", tool_name: "read_file", parameters: { path: "/tmp/x" } }) + "\n"
    ));

    const { value } = await nextPromise;
    expect(value.type).toBe("assistant");
    expect(value.message.content[0].type).toBe("tool_use");
    expect(value.message.content[0].name).toBe("read_file");
    expect(value.message.content[0].input).toEqual({ path: "/tmp/x" });

    fakeChild.stdout.emit("end");
    fakeChild.emit("exit", 0, null);
  });

  it("strips non-JSON prefix from lines", async () => {
    const fakeChild = createFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    const iter = queryGemini({
      prompt: "test",
      options: { geminiPath: "/usr/bin/gemini" },
    });
    const iterator = iter[Symbol.asyncIterator]();
    const nextPromise = iterator.next();

    // Gemini CLI sometimes prepends non-JSON text
    fakeChild.stdout.emit("data", Buffer.from(
      'MCP issues detected...' + JSON.stringify({ type: "init", session_id: "s3" }) + "\n"
    ));

    const { value } = await nextPromise;
    expect(value.type).toBe("init");
    expect(value.session_id).toBe("s3");

    fakeChild.stdout.emit("end");
    fakeChild.emit("exit", 0, null);
  });
});

describe("result with accumulated text fallback", () => {
  it("injects accumulated assistant text into result when result field is empty", async () => {
    const fakeChild = createFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    const iter = queryGemini({
      prompt: "test",
      options: { geminiPath: "/usr/bin/gemini" },
    });
    const iterator = iter[Symbol.asyncIterator]();

    // First: assistant message that accumulates text
    const p1 = iterator.next();
    fakeChild.stdout.emit("data", Buffer.from(
      JSON.stringify({ type: "message", role: "assistant", content: "Accumulated text" }) + "\n"
    ));
    await p1;

    // Then: result with no result field
    const p2 = iterator.next();
    fakeChild.stdout.emit("data", Buffer.from(
      JSON.stringify({ type: "result", status: "success" }) + "\n"
    ));
    const { value } = await p2;

    expect(value.type).toBe("result");
    expect(value.result).toBe("Accumulated text");

    fakeChild.stdout.emit("end");
    fakeChild.emit("exit", 0, null);
  });
});

describe("error handling", () => {
  it("ends iteration when child process emits error", async () => {
    const fakeChild = createFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    const iter = queryGemini({
      prompt: "test",
      options: { geminiPath: "/usr/bin/gemini" },
    });
    const iterator = iter[Symbol.asyncIterator]();
    const nextPromise = iterator.next();

    fakeChild.emit("error", new Error("spawn ENOENT"));

    const { done } = await nextPromise;
    expect(done).toBe(true);
  });

  it("throws when stdout/stderr are not available", async () => {
    const fakeChild = createFakeChild();
    (fakeChild as any).stdout = null;
    mockSpawn.mockReturnValue(fakeChild);

    const iter = queryGemini({
      prompt: "test",
      options: { geminiPath: "/usr/bin/gemini" },
    });
    const iterator = iter[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow("Failed to spawn gemini process");
  });
});

describe("MCP server injection", () => {
  it("writes MCP servers to project-level .gemini/settings.json", () => {
    const fakeChild = createFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    const mcpServers = {
      "my-mcp": { command: "node", args: ["server.js"] },
    };

    const iter = queryGemini({
      prompt: "test",
      options: { geminiPath: "/usr/bin/gemini", cwd: "/projects/repo", mcpServers },
    });
    iter[Symbol.asyncIterator]().next();

    expect(mockMkdirSync).toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalled();

    const [settingsPath, content] = mockWriteFileSync.mock.calls[0];
    expect(settingsPath).toContain(".gemini/settings.json");
    const parsed = JSON.parse(content);
    expect(parsed.mcpServers).toEqual(mcpServers);

    // Should include --allowed-mcp-server-names in args
    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain("--allowed-mcp-server-names");
    expect(args).toContain("my-mcp");

    fakeChild.stdout.emit("end");
    fakeChild.emit("exit", 0, null);
  });

  it("creates a temp directory when no cwd is provided and mcpServers are set", () => {
    const fakeChild = createFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    const iter = queryGemini({
      prompt: "test",
      options: {
        geminiPath: "/usr/bin/gemini",
        mcpServers: { "srv": { command: "echo" } },
      },
    });
    iter[Symbol.asyncIterator]().next();

    // mkdirSync should be called for the temp directory
    expect(mockMkdirSync).toHaveBeenCalled();
    // spawn should have a cwd set (the temp dir)
    const [, , spawnOpts] = mockSpawn.mock.calls[0];
    expect(spawnOpts.cwd).toBeDefined();
    expect(spawnOpts.cwd).toContain("gemini-");

    fakeChild.stdout.emit("end");
    fakeChild.emit("exit", 0, null);
  });
});

describe("interrupt and close", () => {
  it("interrupt sends SIGINT to process group", async () => {
    const fakeChild = createFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const query = queryGemini({
      prompt: "test",
      options: { geminiPath: "/usr/bin/gemini" },
    });
    // Start iteration to spawn
    query[Symbol.asyncIterator]().next();

    await query.interrupt();

    expect(killSpy).toHaveBeenCalledWith(-12345, "SIGINT");

    killSpy.mockRestore();
    fakeChild.stdout.emit("end");
    fakeChild.emit("exit", 0, null);
  });

  it("close sends SIGTERM to process group", () => {
    const fakeChild = createFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const query = queryGemini({
      prompt: "test",
      options: { geminiPath: "/usr/bin/gemini" },
    });
    query[Symbol.asyncIterator]().next();

    query.close();

    expect(killSpy).toHaveBeenCalledWith(-12345, "SIGTERM");

    killSpy.mockRestore();
    fakeChild.stdout.emit("end");
    fakeChild.emit("exit", 0, null);
  });
});

describe("environment and cwd", () => {
  it("passes GEMINI_API_KEY from process.env (not from options.env)", () => {
    const fakeChild = createFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    const originalKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "process-env-key";

    try {
      const iter = queryGemini({
        prompt: "test",
        options: {
          geminiPath: "/usr/bin/gemini",
          env: { GEMINI_API_KEY: "options-env-key" },
          cwd: "/my/project",
        },
      });
      iter[Symbol.asyncIterator]().next();

      const [, , spawnOpts] = mockSpawn.mock.calls[0];
      // GEMINI_API_KEY comes from process.env, not options.env (filtered by buildChildEnv)
      expect(spawnOpts.env.GEMINI_API_KEY).toBe("process-env-key");
      expect(spawnOpts.cwd).toBe("/my/project");
      expect(spawnOpts.detached).toBe(true);
      expect(spawnOpts.stdio).toEqual(["pipe", "pipe", "pipe"]);

      fakeChild.stdout.emit("end");
      fakeChild.emit("exit", 0, null);
    } finally {
      if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalKey;
    }
  });
});
