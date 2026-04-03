import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

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
  child.pid = 99999;
  child.exitCode = null;
  child.kill = vi.fn();
  return child;
}

let queryGemini: typeof import("./gemini-executor.js").queryGemini;

beforeEach(async () => {
  vi.clearAllMocks();
  const mod = await import("./gemini-executor.js");
  queryGemini = mod.queryGemini;
});

describe("adversarial: split JSON across multiple chunks", () => {
  it("handles JSON split across two stdout data events", async () => {
    const fakeChild = createFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    const iter = queryGemini({ prompt: "test", options: { geminiPath: "/bin/g" } });
    const iterator = iter[Symbol.asyncIterator]();
    const p = iterator.next();

    // Split a JSON line across two chunks — the buffer logic should reassemble
    const json = JSON.stringify({ type: "init", session_id: "split-1" });
    const mid = Math.floor(json.length / 2);
    fakeChild.stdout.emit("data", Buffer.from(json.slice(0, mid)));
    fakeChild.stdout.emit("data", Buffer.from(json.slice(mid) + "\n"));

    const { value } = await p;
    expect(value.type).toBe("init");
    expect(value.session_id).toBe("split-1");

    fakeChild.stdout.emit("end");
    fakeChild.emit("exit", 0, null);
  });
});

describe("adversarial: multiple JSON messages in single chunk", () => {
  it("parses multiple newline-delimited JSON objects from one data event", async () => {
    const fakeChild = createFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    const iter = queryGemini({ prompt: "test", options: { geminiPath: "/bin/g" } });
    const iterator = iter[Symbol.asyncIterator]();

    // Start consuming BEFORE emitting — the first next() triggers spawn
    const p1 = iterator.next();

    const line1 = JSON.stringify({ type: "init", session_id: "multi-1" });
    const line2 = JSON.stringify({ type: "message", role: "assistant", content: "Hi" });
    // Both lines in a single chunk — they get queued internally
    fakeChild.stdout.emit("data", Buffer.from(line1 + "\n" + line2 + "\n"));

    const r1 = await p1;
    expect(r1.value.type).toBe("init");

    // Second message should already be queued
    const r2 = await iterator.next();
    expect(r2.value.type).toBe("assistant");
    expect(r2.value.message.content[0].text).toBe("Hi");

    fakeChild.stdout.emit("end");
    fakeChild.emit("exit", 0, null);
  });
});

describe("adversarial: empty and whitespace-only lines", () => {
  it("skips empty lines between valid JSON", async () => {
    const fakeChild = createFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    const iter = queryGemini({ prompt: "test", options: { geminiPath: "/bin/g" } });
    const iterator = iter[Symbol.asyncIterator]();
    const p = iterator.next();

    const data = "\n\n" + JSON.stringify({ type: "init", session_id: "ws" }) + "\n   \n";
    fakeChild.stdout.emit("data", Buffer.from(data));

    const { value } = await p;
    expect(value.type).toBe("init");

    fakeChild.stdout.emit("end");
    fakeChild.emit("exit", 0, null);
  });
});

describe("adversarial: malformed JSON line", () => {
  it("skips corrupt JSON and still processes subsequent valid lines", async () => {
    const fakeChild = createFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    const iter = queryGemini({ prompt: "test", options: { geminiPath: "/bin/g" } });
    const iterator = iter[Symbol.asyncIterator]();
    const p = iterator.next();

    // First line is garbage, second is valid
    const data = "{broken json\n" + JSON.stringify({ type: "init", session_id: "ok" }) + "\n";
    fakeChild.stdout.emit("data", Buffer.from(data));

    const { value } = await p;
    expect(value.type).toBe("init");

    fakeChild.stdout.emit("end");
    fakeChild.emit("exit", 0, null);
  });
});

describe("adversarial: result with existing result field not overwritten by accumulated text", () => {
  it("preserves explicit result field even when accumulated text exists", async () => {
    const fakeChild = createFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    const iter = queryGemini({ prompt: "test", options: { geminiPath: "/bin/g" } });
    const iterator = iter[Symbol.asyncIterator]();

    // Accumulate assistant text
    const p1 = iterator.next();
    fakeChild.stdout.emit("data", Buffer.from(
      JSON.stringify({ type: "message", role: "assistant", content: "accumulated" }) + "\n"
    ));
    await p1;

    // Result WITH explicit result field — should NOT be overwritten
    const p2 = iterator.next();
    fakeChild.stdout.emit("data", Buffer.from(
      JSON.stringify({ type: "result", status: "success", result: "explicit result" }) + "\n"
    ));
    const { value } = await p2;

    expect(value.result).toBe("explicit result");

    fakeChild.stdout.emit("end");
    fakeChild.emit("exit", 0, null);
  });
});

describe("adversarial: tool_call and action type variants", () => {
  it("maps 'action' type with name/args fields", async () => {
    const fakeChild = createFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    const iter = queryGemini({ prompt: "test", options: { geminiPath: "/bin/g" } });
    const iterator = iter[Symbol.asyncIterator]();
    const p = iterator.next();

    fakeChild.stdout.emit("data", Buffer.from(
      JSON.stringify({ type: "action", name: "write_file", args: { path: "/a" } }) + "\n"
    ));

    const { value } = await p;
    expect(value.type).toBe("assistant");
    expect(value.message.content[0].type).toBe("tool_use");
    expect(value.message.content[0].name).toBe("write_file");
    expect(value.message.content[0].input).toEqual({ path: "/a" });

    fakeChild.stdout.emit("end");
    fakeChild.emit("exit", 0, null);
  });

  it("maps 'tool_call' type with input field", async () => {
    const fakeChild = createFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    const iter = queryGemini({ prompt: "test", options: { geminiPath: "/bin/g" } });
    const iterator = iter[Symbol.asyncIterator]();
    const p = iterator.next();

    fakeChild.stdout.emit("data", Buffer.from(
      JSON.stringify({ type: "tool_call", tool_name: "exec", input: { cmd: "ls" } }) + "\n"
    ));

    const { value } = await p;
    expect(value.message.content[0].name).toBe("exec");
    expect(value.message.content[0].input).toEqual({ cmd: "ls" });

    fakeChild.stdout.emit("end");
    fakeChild.emit("exit", 0, null);
  });
});

describe("adversarial: tool_result and user message echo produce empty content", () => {
  it("tool_result maps to assistant with empty content array", async () => {
    const fakeChild = createFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    const iter = queryGemini({ prompt: "test", options: { geminiPath: "/bin/g" } });
    const iterator = iter[Symbol.asyncIterator]();
    const p = iterator.next();

    fakeChild.stdout.emit("data", Buffer.from(
      JSON.stringify({ type: "tool_result", output: "some result" }) + "\n"
    ));

    const { value } = await p;
    expect(value.type).toBe("assistant");
    expect(value.message.content).toEqual([]);

    fakeChild.stdout.emit("end");
    fakeChild.emit("exit", 0, null);
  });

  it("user message echo maps to assistant with empty content", async () => {
    const fakeChild = createFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    const iter = queryGemini({ prompt: "test", options: { geminiPath: "/bin/g" } });
    const iterator = iter[Symbol.asyncIterator]();
    const p = iterator.next();

    fakeChild.stdout.emit("data", Buffer.from(
      JSON.stringify({ type: "message", role: "user", content: "echo" }) + "\n"
    ));

    const { value } = await p;
    expect(value.type).toBe("assistant");
    expect(value.message.content).toEqual([]);

    fakeChild.stdout.emit("end");
    fakeChild.emit("exit", 0, null);
  });
});

describe("adversarial: MCP settings preserve existing security", () => {
  it("preserves security settings from existing settings.json", () => {
    const fakeChild = createFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    mockExistsSync.mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes("settings.json")) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue(JSON.stringify({
      security: { allow_all: true },
      mcpServers: { old: {} },
    }));

    const iter = queryGemini({
      prompt: "test",
      options: {
        geminiPath: "/bin/g",
        cwd: "/proj",
        mcpServers: { new: { command: "node" } },
      },
    });
    iter[Symbol.asyncIterator]().next();

    const [, content] = mockWriteFileSync.mock.calls[0];
    const parsed = JSON.parse(content);
    // Security should be preserved, but old mcpServers should NOT be merged
    expect(parsed.security).toEqual({ allow_all: true });
    expect(parsed.mcpServers).toEqual({ new: { command: "node" } });
    expect(parsed.mcpServers).not.toHaveProperty("old");

    fakeChild.stdout.emit("end");
    fakeChild.emit("exit", 0, null);
  });
});

describe("adversarial: result with no stats defaults to 0", () => {
  it("defaults cost and duration to 0 when stats is missing", async () => {
    const fakeChild = createFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    const iter = queryGemini({ prompt: "test", options: { geminiPath: "/bin/g" } });
    const iterator = iter[Symbol.asyncIterator]();
    const p = iterator.next();

    fakeChild.stdout.emit("data", Buffer.from(
      JSON.stringify({ type: "result", status: "success", result: "ok" }) + "\n"
    ));

    const { value } = await p;
    expect(value.total_cost_usd).toBe(0);
    expect(value.duration_ms).toBe(0);

    fakeChild.stdout.emit("end");
    fakeChild.emit("exit", 0, null);
  });
});
