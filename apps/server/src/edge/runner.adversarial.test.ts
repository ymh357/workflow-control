import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseArgs } from "node:util";

// Replicate pure logic from runner.ts for isolated testing (same approach as runner.test.ts)

const DEFAULT_SERVER_URL = "http://localhost:3001";
type Engine = "claude" | "gemini" | "codex";

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

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// SSE parser replica
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

// Model validation replica
const KNOWN_CLAUDE_MODELS = [
  "haiku", "sonnet", "opus",
  "claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-6",
];
const KNOWN_GEMINI_MODELS = [
  "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash",
];
const KNOWN_CODEX_MODELS = [
  "gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o3", "o4-mini",
];

function resolveModelSync(configured: string | undefined, engine: Engine): string | undefined {
  if (!configured) return undefined;
  const known = engine === "gemini" ? KNOWN_GEMINI_MODELS : engine === "codex" ? KNOWN_CODEX_MODELS : KNOWN_CLAUDE_MODELS;
  if (known.includes(configured)) return configured;
  return configured;
}

// getProjectDir replica
import * as path from "node:path";

function getProjectDir(cwd: string): string {
  const normalized = path.resolve(cwd).replace(/\//g, "-");
  return path.join(process.env.HOME ?? "~", ".claude", "projects", normalized);
}

// Transcript event extraction replica
function extractTranscriptEvents(lines: string[]): Array<{ type: string; data: Record<string, unknown> }> {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "assistant" && entry.message?.content) {
        for (const block of entry.message.content) {
          if (block.type === "text") {
            events.push({ type: "text", data: { text: block.text?.slice(0, 500) } });
          } else if (block.type === "tool_use") {
            events.push({ type: "tool_use", data: { toolName: block.name, input: block.input } });
          } else if (block.type === "thinking") {
            events.push({ type: "thinking", data: { text: block.thinking?.slice(0, 300) } });
          }
        }
      }
    } catch { /* skip malformed lines */ }
  }
  return events;
}

// ---- Adversarial Tests ----

describe("parseCliArgs - adversarial edge cases", () => {
  it("returns undefined taskId when only flags are passed with no positional", () => {
    const args = parseCliArgs(["--engine", "gemini"]);
    expect(args.taskId).toBeUndefined();
    expect(args.trigger).toBeUndefined();
    // No pipeline, no trigger, no taskId — caller should error
  });

  it("ignores extra positional args beyond the first (no validation)", () => {
    const args = parseCliArgs(["task-1", "task-2", "task-3"]);
    expect(args.taskId).toBe("task-1");
    // task-2 and task-3 are silently dropped — potential user confusion
  });

  it("accepts empty string as taskId from positional", () => {
    const args = parseCliArgs([""]);
    expect(args.taskId).toBe("");
    // Empty string taskId would cause API failures downstream
  });

  it("strips ALL leading -- separators even when many are present", () => {
    const args = parseCliArgs(["--", "--", "--", "--", "task-99"]);
    expect(args.taskId).toBe("task-99");
  });

  it("does not validate engine value — accepts arbitrary strings", () => {
    const args = parseCliArgs(["task-1", "--engine", "openai"]);
    expect(args.engine).toBe("openai");
    // "openai" is not a valid Engine type but passes the cast silently
  });

});

describe("fetchJson - adversarial HTTP responses", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws when response is 200 but json() rejects (invalid JSON body)", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
      text: () => Promise.resolve("not json"),
    } as unknown as Response);

    await expect(fetchJson("http://localhost/api/test")).rejects.toThrow("Unexpected token");
  });

  it("includes full error body even for large responses", async () => {
    const longBody = "x".repeat(10000);
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve(longBody),
    } as unknown as Response);

    await expect(fetchJson("http://localhost/api/err")).rejects.toThrow(
      `HTTP 500: ${longBody}`,
    );
  });

  it("propagates network errors (fetch itself throws)", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("fetch failed"));
    await expect(fetchJson("http://localhost/api/down")).rejects.toThrow("fetch failed");
  });
});

describe("parseSseChunk - adversarial SSE inputs", () => {
  it("handles data line without preceding event line", () => {
    const chunk = 'data: {"orphan": true}\n';
    const events = parseSseChunk(chunk);
    expect(events).toHaveLength(0);
  });

  it("handles event with no data line following", () => {
    const chunk = "event: lonely_event\n\n";
    const events = parseSseChunk(chunk);
    // Empty line resets currentEvent, so no event is emitted
    expect(events).toHaveLength(0);
  });

  it("handles multiple data lines for same event — only first data line is used", () => {
    // After first data line, currentEvent is reset to ""
    const chunk = [
      "event: multi_data",
      'data: {"first": true}',
      'data: {"second": true}',
      "",
    ].join("\n");
    const events = parseSseChunk(chunk);
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ first: true });
  });

  it("handles SSE comment lines (starting with :) resetting current event", () => {
    const chunk = [
      "event: should_be_dropped",
      ": this is a comment",
      'data: {"lost": true}',
      "",
    ].join("\n");
    const events = parseSseChunk(chunk);
    // Comment resets currentEvent, so data has no event context
    expect(events).toHaveLength(0);
  });

  it("handles data with nested JSON strings containing 'event:' patterns", () => {
    const chunk = [
      "event: test",
      'data: {"msg": "event: fake\\ndata: {}", "val": 1}',
      "",
    ].join("\n");
    const events = parseSseChunk(chunk);
    expect(events).toHaveLength(1);
    expect(events[0].data.val).toBe(1);
  });

  it("handles extremely long event names", () => {
    const longName = "a".repeat(10000);
    const chunk = `event: ${longName}\ndata: {"ok": true}\n\n`;
    const events = parseSseChunk(chunk);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe(longName);
  });
});

describe("resolveModel - adversarial model names", () => {
  it("returns empty string model as-is (does not treat it as falsy)", () => {
    // Empty string is truthy for the `if (!configured)` check? No, "" is falsy
    expect(resolveModelSync("", "claude")).toBeUndefined();
  });

  it("does not match partial model names", () => {
    // "son" should not match "sonnet"
    expect(resolveModelSync("son", "claude")).toBe("son");
    // It returns as-is since it's unknown, but it's NOT in the known list
  });

  it("is case-sensitive — 'Sonnet' does not match 'sonnet'", () => {
    const result = resolveModelSync("Sonnet", "claude");
    expect(result).toBe("Sonnet");
    expect(KNOWN_CLAUDE_MODELS.includes("Sonnet")).toBe(false);
  });

  it("does not cross-validate engines — claude model accepted for gemini", () => {
    // "sonnet" is a known claude model but resolveModel checks only gemini list
    const result = resolveModelSync("sonnet", "gemini");
    expect(result).toBe("sonnet");
    // No error — silently uses wrong model for wrong engine
  });
});

describe("getProjectDir - path normalization edge cases", () => {
  it("replaces all forward slashes including root", () => {
    const dir = getProjectDir("/Users/test/project");
    // The path.resolve output should have slashes replaced with dashes
    expect(dir).toContain("-Users-test-project");
    expect(dir).not.toContain("/Users/test/project");
  });

  it("handles paths with spaces", () => {
    const dir = getProjectDir("/Users/test/my project");
    expect(dir).toContain("my project");
  });

  it("handles relative paths by resolving them first", () => {
    const dir1 = getProjectDir("./relative");
    const dir2 = getProjectDir(path.resolve("./relative"));
    expect(dir1).toBe(dir2);
  });
});

describe("extractTranscriptEvents - adversarial transcript lines", () => {
  it("skips non-assistant entries entirely", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "hello" }] } }),
      JSON.stringify({ type: "system", message: { content: [{ type: "text", text: "init" }] } }),
    ];
    const events = extractTranscriptEvents(lines);
    expect(events).toHaveLength(0);
  });

  it("truncates text blocks to 500 chars", () => {
    const longText = "a".repeat(1000);
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: longText }] } }),
    ];
    const events = extractTranscriptEvents(lines);
    expect(events).toHaveLength(1);
    expect((events[0].data.text as string).length).toBe(500);
  });

  it("truncates thinking blocks to 300 chars", () => {
    const longThinking = "b".repeat(600);
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: longThinking }] } }),
    ];
    const events = extractTranscriptEvents(lines);
    expect(events).toHaveLength(1);
    expect((events[0].data.text as string).length).toBe(300);
  });

  it("handles assistant entry with null/undefined content gracefully", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: null } }),
      JSON.stringify({ type: "assistant", message: {} }),
    ];
    // Should not throw
    const events = extractTranscriptEvents(lines);
    expect(events).toHaveLength(0);
  });

  it("handles tool_use blocks with missing name/input", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use" }], // no name or input
        },
      }),
    ];
    const events = extractTranscriptEvents(lines);
    expect(events).toHaveLength(1);
    expect(events[0].data.toolName).toBeUndefined();
    expect(events[0].data.input).toBeUndefined();
  });

  it("skips malformed JSON lines without affecting valid lines", () => {
    const lines = [
      "not json at all",
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "valid" }] } }),
      "{broken json",
    ];
    const events = extractTranscriptEvents(lines);
    expect(events).toHaveLength(1);
    expect(events[0].data.text).toBe("valid");
  });

  it("handles text block where text is undefined (slice of undefined)", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text" }] }, // text field missing
      }),
    ];
    const events = extractTranscriptEvents(lines);
    expect(events).toHaveLength(1);
    // text?.slice(0, 500) returns undefined when text is undefined
    expect(events[0].data.text).toBeUndefined();
  });
});
