import { describe, it, expect } from "vitest";
import { humanizeToolCall } from "./utils";

// ── no input ──

describe("humanizeToolCall — no input", () => {
  it("returns 'Tool: <name>' when input is undefined", () => {
    expect(humanizeToolCall("Read", undefined)).toBe("Tool: Read");
  });

  it("returns 'Tool: <name>' for unknown tool with no input", () => {
    expect(humanizeToolCall("UnknownTool", undefined)).toBe("Tool: UnknownTool");
  });
});

// ── MCP tools (mcp__ prefix) ──

describe("humanizeToolCall — MCP tools", () => {
  it("mcp__server__tool → 'server: tool'", () => {
    expect(humanizeToolCall("mcp__github__create_issue", {})).toBe("github: create_issue");
  });

  it("mcp__server__a__b → 'server: a__b' (multi-segment tool name preserved)", () => {
    expect(humanizeToolCall("mcp__notion__page__create", {})).toBe("notion: page__create");
  });

  it("mcp__server (no tool segment) → 'server: call'", () => {
    expect(humanizeToolCall("mcp__myserver", {})).toBe("myserver: call");
  });

  it("mcp__server__ (trailing __) → tool part is empty string → falls back to 'call'", () => {
    // parts = ["mcp","slack",""], parts.slice(2).join("__") = "" (falsy) → "call"
    expect(humanizeToolCall("mcp__slack__", {})).toBe("slack: call");
  });
});

// ── Standard tools ──

describe("humanizeToolCall — Read", () => {
  it("Read with absolute path — shows basename", () => {
    expect(humanizeToolCall("Read", { file_path: "/Users/foo/bar/baz.ts" })).toBe("Read baz.ts");
  });

  it("Read with relative path — shows basename", () => {
    expect(humanizeToolCall("Read", { file_path: "src/lib/utils.ts" })).toBe("Read utils.ts");
  });

  it("Read with filename only — shows filename", () => {
    expect(humanizeToolCall("Read", { file_path: "README.md" })).toBe("Read README.md");
  });

  it("Read with non-string file_path — shows 'unknown'", () => {
    expect(humanizeToolCall("Read", { file_path: 42 })).toBe("Read unknown");
  });

  it("Read with no file_path — shows 'unknown'", () => {
    expect(humanizeToolCall("Read", {})).toBe("Read unknown");
  });
});

describe("humanizeToolCall — Write", () => {
  it("Write with path shows basename", () => {
    expect(humanizeToolCall("Write", { file_path: "/tmp/output.json" })).toBe("Write output.json");
  });
});

describe("humanizeToolCall — Edit", () => {
  it("Edit with path shows basename", () => {
    expect(humanizeToolCall("Edit", { file_path: "/src/index.ts" })).toBe("Edit index.ts");
  });
});

describe("humanizeToolCall — Bash", () => {
  it("short command shown in full", () => {
    expect(humanizeToolCall("Bash", { command: "ls -la" })).toBe("Run: ls -la");
  });

  it("command truncated at 60 chars", () => {
    const longCmd = "a".repeat(80);
    const result = humanizeToolCall("Bash", { command: longCmd });
    expect(result).toBe("Run: " + "a".repeat(60));
  });

  it("missing command — shows 'Run: '", () => {
    expect(humanizeToolCall("Bash", {})).toBe("Run: ");
  });
});

describe("humanizeToolCall — Grep", () => {
  it("shows pattern", () => {
    expect(humanizeToolCall("Grep", { pattern: "TODO.*fixme" })).toBe("Search: TODO.*fixme");
  });
});

describe("humanizeToolCall — Glob", () => {
  it("shows pattern", () => {
    expect(humanizeToolCall("Glob", { pattern: "**/*.ts" })).toBe("Find: **/*.ts");
  });
});

describe("humanizeToolCall — WebSearch", () => {
  it("short query shown in full", () => {
    expect(humanizeToolCall("WebSearch", { query: "vitest docs" })).toBe("Web search: vitest docs");
  });

  it("query truncated at 50 chars", () => {
    const longQuery = "q".repeat(70);
    const result = humanizeToolCall("WebSearch", { query: longQuery });
    expect(result).toBe("Web search: " + "q".repeat(50));
  });

  it("missing query — shows 'Web search: '", () => {
    expect(humanizeToolCall("WebSearch", {})).toBe("Web search: ");
  });
});

describe("humanizeToolCall — WebFetch", () => {
  it("shows URL truncated at 50 chars", () => {
    const url = "https://example.com/very/long/path/that/exceeds/50/characters/easily";
    const result = humanizeToolCall("WebFetch", { url });
    expect(result).toBe("Fetch: " + url.slice(0, 50));
  });

  it("short URL shown in full", () => {
    expect(humanizeToolCall("WebFetch", { url: "https://example.com" })).toBe("Fetch: https://example.com");
  });
});

describe("humanizeToolCall — Agent", () => {
  it("uses description when present", () => {
    expect(humanizeToolCall("Agent", { description: "Run tests" })).toBe("Agent: Run tests");
  });

  it("falls back to prompt when description missing", () => {
    expect(humanizeToolCall("Agent", { prompt: "Do something" })).toBe("Agent: Do something");
  });

  it("truncates at 50 chars", () => {
    const long = "x".repeat(80);
    expect(humanizeToolCall("Agent", { description: long })).toBe("Agent: " + "x".repeat(50));
  });

  it("missing description and prompt — shows 'Agent: '", () => {
    expect(humanizeToolCall("Agent", {})).toBe("Agent: ");
  });
});

describe("humanizeToolCall — NotebookEdit", () => {
  it("shows notebook basename", () => {
    expect(humanizeToolCall("NotebookEdit", { notebook_path: "/work/analysis.ipynb" }))
      .toBe("Notebook: analysis.ipynb");
  });
});

describe("humanizeToolCall — default case", () => {
  it("unknown tool with input returns 'Tool: <name>'", () => {
    expect(humanizeToolCall("MyCustomTool", { foo: "bar" })).toBe("Tool: MyCustomTool");
  });
});
