import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { mapCodexEvent } from "./codex-executor.js";

describe("mapCodexEvent", () => {
  it("maps thread.started to init message", () => {
    const result = mapCodexEvent({ type: "thread.started", thread_id: "t-123" });
    expect(result).toEqual({ type: "init", session_id: "t-123" });
  });

  it("maps item.completed agent_message to assistant text", () => {
    const result = mapCodexEvent({
      type: "item.completed",
      item: { type: "agent_message", text: "Hello world" },
    });
    expect(result).toEqual({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello world" }] },
    });
  });

  it("maps item.completed command_execution to Bash tool_use", () => {
    const result = mapCodexEvent({
      type: "item.completed",
      item: { type: "command_execution", command: "ls -la" },
    });
    expect(result).toEqual({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la" } }] },
    });
  });

  it("maps item.completed file_edit to Edit tool_use", () => {
    const result = mapCodexEvent({
      type: "item.completed",
      item: { type: "file_edit", file_path: "/src/app.ts", diff: "+line" },
    });
    expect(result).toEqual({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/src/app.ts", diff: "+line" } }] },
    });
  });

  it("maps item.completed mcp_tool_call to named tool_use", () => {
    const result = mapCodexEvent({
      type: "item.completed",
      item: { type: "mcp_tool_call", tool_name: "linear_getIssue", arguments: { id: "ENG-123" } },
    });
    expect(result).toEqual({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "linear_getIssue", input: { id: "ENG-123" } }] },
    });
  });

  it("maps item.completed reasoning to assistant text", () => {
    const result = mapCodexEvent({
      type: "item.completed",
      item: { type: "reasoning", text: "Let me think..." },
    });
    expect(result).toEqual({
      type: "assistant",
      message: { content: [{ type: "text", text: "Let me think..." }] },
    });
  });

  it("maps item.completed web_search to WebSearch tool_use", () => {
    const result = mapCodexEvent({
      type: "item.completed",
      item: { type: "web_search", query: "React hooks guide" },
    });
    expect(result).toEqual({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "WebSearch", input: { query: "React hooks guide" } }] },
    });
  });

  it("maps item.started command_execution in_progress to Bash tool_use", () => {
    const result = mapCodexEvent({
      type: "item.started",
      item: { type: "command_execution", status: "in_progress", command: "npm test" },
    });
    expect(result).toEqual({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] },
    });
  });

  it("maps turn.completed to result with cost estimate", () => {
    const result = mapCodexEvent({
      type: "turn.completed",
      thread_id: "t-456",
      usage: { input_tokens: 1000, output_tokens: 500 },
      duration_ms: 3000,
    });
    expect(result).toEqual({
      type: "result",
      subtype: "success",
      session_id: "t-456",
      total_cost_usd: expect.closeTo((1000 * 2.5 + 500 * 10) / 1_000_000, 5),
      duration_ms: 3000,
      stats: { input_tokens: 1000, output_tokens: 500 },
    });
  });

  it("maps error to result with error subtype", () => {
    const result = mapCodexEvent({ type: "error", message: "Rate limited" });
    expect(result).toEqual({
      type: "result",
      subtype: "error",
      error_message: "Rate limited",
    });
  });

  it("returns null for unhandled event types", () => {
    expect(mapCodexEvent({ type: "turn.started" })).toBeNull();
    expect(mapCodexEvent({ type: "unknown_event" })).toBeNull();
  });

  it("handles missing fields gracefully with defaults", () => {
    const agentMsg = mapCodexEvent({
      type: "item.completed",
      item: { type: "agent_message" },
    });
    expect(agentMsg?.message?.content[0].text).toBe("");

    const cmd = mapCodexEvent({
      type: "item.completed",
      item: { type: "command_execution" },
    });
    expect(cmd?.message?.content[0].input?.command).toBe("");

    const mcp = mapCodexEvent({
      type: "item.completed",
      item: { type: "mcp_tool_call" },
    });
    expect(mcp?.message?.content[0].name).toBe("mcp_tool");
  });

  it("handles turn.completed with empty usage", () => {
    const result = mapCodexEvent({ type: "turn.completed" });
    expect(result?.subtype).toBe("success");
    expect(result?.total_cost_usd).toBe(0);
    expect(result?.duration_ms).toBe(0);
  });

  it("handles error with fallback message", () => {
    const result = mapCodexEvent({ type: "error" });
    expect(result?.type).toBe("result");
    expect(result?.subtype).toBe("error");
    expect(result?.error_message).toBe("Unknown codex error");
  });
});

describe("codex message stream-processor compatibility", () => {
  it("result messages have subtype='success' required by stream-processor", () => {
    const turnResult = mapCodexEvent({
      type: "turn.completed",
      thread_id: "t-1",
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    // stream-processor checks: if (subtype === "success") → extract result
    // Without subtype, it falls to else branch and throws AgentError
    expect(turnResult?.subtype).toBe("success");
  });

  it("error messages map to result type (not 'error') for stream-processor switch", () => {
    const errResult = mapCodexEvent({ type: "error", message: "API error" });
    // stream-processor switch only handles "assistant", "result", "system"
    // "error" type would be silently ignored in default branch
    expect(errResult?.type).toBe("result");
    expect(errResult?.subtype).toBe("error");
  });

  it("assistant messages have message.content array for stream-processor iteration", () => {
    const msg = mapCodexEvent({
      type: "item.completed",
      item: { type: "agent_message", text: "output" },
    });
    // stream-processor iterates: for (const block of message.message.content)
    expect(msg?.message?.content).toBeDefined();
    expect(Array.isArray(msg?.message?.content)).toBe(true);
    expect(msg?.message?.content.length).toBeGreaterThan(0);
  });

  it("tool_use blocks have name and input for SSE emission", () => {
    const msg = mapCodexEvent({
      type: "item.completed",
      item: { type: "command_execution", command: "npm test" },
    });
    const block = msg?.message?.content[0];
    // stream-processor emits: { toolName: block.name, input: block.input }
    expect(block?.type).toBe("tool_use");
    expect(block?.name).toBeDefined();
    expect(block?.input).toBeDefined();
  });
});
