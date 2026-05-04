import { describe, it, expect } from "vitest";
import { parseLine } from "../ingestion/parser.js";

const ctx = () => ({ sessionId: "s1", nextSeq: 1 });

describe("parseLine — control plane", () => {
  it("returns [] for permission-mode line", () => {
    const line = JSON.stringify({ type: "permission-mode", permissionMode: "bypass", sessionId: "s1" });
    expect(parseLine(line, ctx())).toEqual([]);
  });

  it("returns [] for attachment line (hook output)", () => {
    const line = JSON.stringify({
      sessionId: "s1",
      attachment: { type: "hook_success", hookName: "SessionStart", content: "..." },
    });
    expect(parseLine(line, ctx())).toEqual([]);
  });

  it("returns [] for malformed JSON", () => {
    expect(parseLine("{not-json", ctx())).toEqual([]);
  });

  it("returns [] when sessionId missing and no ctx fallback message", () => {
    const c = { sessionId: "", nextSeq: 1 };
    const line = JSON.stringify({ message: { role: "user", content: "hi" } });
    expect(parseLine(line, c)).toEqual([]);
  });
});

describe("parseLine — user / assistant text", () => {
  it("extracts a user text turn", () => {
    const line = JSON.stringify({
      sessionId: "s1",
      timestamp: 1700000000000,
      message: { role: "user", content: "hello there" },
    });
    const ev = parseLine(line, ctx());
    expect(ev).toHaveLength(1);
    expect(ev[0]!.role).toBe("user");
    expect(ev[0]!.textExcerpt).toBe("hello there");
    expect(ev[0]!.textLength).toBe(11);
    expect(ev[0]!.textHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("extracts an assistant text turn (string content)", () => {
    const line = JSON.stringify({
      sessionId: "s1",
      message: { role: "assistant", content: "ok" },
    });
    const ev = parseLine(line, ctx());
    expect(ev).toHaveLength(1);
    expect(ev[0]!.role).toBe("assistant");
  });

  it("extracts an assistant turn with text + tool_use blocks", () => {
    const line = JSON.stringify({
      sessionId: "s1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "tool_use", name: "Read", input: { path: "/etc/foo" } },
        ],
      },
    });
    const ev = parseLine(line, ctx());
    expect(ev).toHaveLength(2);
    expect(ev[0]!.role).toBe("assistant");
    expect(ev[0]!.textExcerpt).toBe("let me check");
    expect(ev[1]!.role).toBe("tool_use");
    expect(ev[1]!.toolName).toBe("Read");
    expect(ev[1]!.toolArgsExcerpt).toContain("/etc/foo");
  });

  it("extracts a tool_result block", () => {
    const line = JSON.stringify({
      sessionId: "s1",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: "file contents here" }],
      },
    });
    const ev = parseLine(line, ctx());
    expect(ev).toHaveLength(1);
    expect(ev[0]!.role).toBe("tool_result");
    expect(ev[0]!.textExcerpt).toBe("file contents here");
  });
});

describe("parseLine — seq advances", () => {
  it("advances ctx.nextSeq across blocks", () => {
    const c = { sessionId: "s1", nextSeq: 5 };
    const line = JSON.stringify({
      sessionId: "s1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "a" },
          { type: "tool_use", name: "X", input: {} },
        ],
      },
    });
    const ev = parseLine(line, c);
    expect(ev[0]!.seq).toBe(5);
    expect(ev[1]!.seq).toBe(6);
    expect(c.nextSeq).toBe(7);
  });
});

describe("parseLine — redaction integration", () => {
  it("redacts secrets in user text excerpts", () => {
    const line = JSON.stringify({
      sessionId: "s1",
      message: { role: "user", content: "use this token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa to login" },
    });
    const ev = parseLine(line, ctx());
    expect(ev[0]!.textExcerpt).toContain("<REDACTED:github-token>");
    expect(ev[0]!.textExcerpt).not.toContain("ghp_aaaa");
  });

  it("redacts secrets in tool_use arguments", () => {
    const line = JSON.stringify({
      sessionId: "s1",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", name: "Bash", input: { command: "echo ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
        ],
      },
    });
    const ev = parseLine(line, ctx());
    expect(ev[0]!.toolArgsExcerpt).toContain("<REDACTED:github-token>");
  });
});

describe("parseLine — text excerpt limits", () => {
  it("truncates long text to 4 KB but preserves full hash + length", () => {
    const huge = "x".repeat(10_000);
    const line = JSON.stringify({
      sessionId: "s1",
      message: { role: "user", content: huge },
    });
    const ev = parseLine(line, ctx());
    expect(ev[0]!.textExcerpt!.length).toBeLessThanOrEqual(4096);
    expect(ev[0]!.textLength).toBe(10_000);
    expect(ev[0]!.textHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
