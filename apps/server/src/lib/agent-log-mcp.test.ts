// T1.5 — __agent_log__ MCP server tests.

import { describe, it, expect, vi } from "vitest";

// Mock the SDK factory so we can inspect the tool wiring without
// pulling the actual MCP runtime into the test process.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (opts: { name: string; version: string; tools: unknown[] }) => opts,
}));

import { createAgentLogMcp } from "./agent-log-mcp.js";
import type { ExecutionRecordWriter } from "./execution-record/writer.js";
import type { DecisionRecord } from "./execution-record/types.js";

function makeFakeWriter(overrides: Partial<ExecutionRecordWriter> = {}): {
  writer: ExecutionRecordWriter;
  recorded: DecisionRecord[];
} {
  const recorded: DecisionRecord[] = [];
  const writer: ExecutionRecordWriter = {
    attemptId: "att-test",
    isNoop: false,
    appendToolCall: vi.fn(),
    completeToolCall: vi.fn(),
    appendAgentStream: vi.fn(),
    recordPrecompact: vi.fn(),
    recordDecision: (d: DecisionRecord) => { recorded.push(d); },
    updateCost: vi.fn(),
    updateSessionId: vi.fn(),
    heartbeat: vi.fn(),
    close: vi.fn(),
    __flushForTests: vi.fn(),
    ...overrides,
  };
  return { writer, recorded };
}

function getRecordDecisionTool(mcp: { tools: unknown[] }): {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
} {
  const tool = (mcp.tools as Array<{ name: string; handler: unknown }>).find(
    (t) => t.name === "record_decision",
  );
  if (!tool) throw new Error("record_decision tool not registered");
  return tool as {
    name: string;
    handler: (args: Record<string, unknown>) => Promise<{
      content: Array<{ type: "text"; text: string }>;
      isError?: boolean;
    }>;
  };
}

describe("createAgentLogMcp", () => {
  it("exposes the __agent_log__ MCP server with record_decision tool", () => {
    const { writer } = makeFakeWriter();
    const mcp = createAgentLogMcp(writer) as unknown as {
      name: string;
      tools: Array<{ name: string }>;
    };
    expect(mcp.name).toBe("__agent_log__");
    const names = mcp.tools.map((t) => t.name);
    expect(names).toContain("record_decision");
  });

  it("writes a decision to the writer when called with valid args", async () => {
    const { writer, recorded } = makeFakeWriter();
    const mcp = createAgentLogMcp(writer) as unknown as { tools: unknown[] };
    const tool = getRecordDecisionTool(mcp);

    const res = await tool.handler({
      context: "parser choice",
      optionsConsidered: ["json", "yaml"],
      chosen: "json",
      reasoning: "input is always JSON",
    });

    expect(res.isError).toBeFalsy();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.context).toBe("parser choice");
    expect(recorded[0]!.chosen).toBe("json");
    expect(recorded[0]!.optionsConsidered).toEqual(["json", "yaml"]);
    expect(recorded[0]!.reasoning).toBe("input is always JSON");
    expect(typeof recorded[0]!.timestamp).toBe("string");
    // ISO timestamp
    expect(recorded[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns an error for missing context", async () => {
    const { writer, recorded } = makeFakeWriter();
    const mcp = createAgentLogMcp(writer) as unknown as { tools: unknown[] };
    const tool = getRecordDecisionTool(mcp);

    const res = await tool.handler({
      context: "",
      optionsConsidered: ["a", "b"],
      chosen: "a",
      reasoning: "r",
    });

    expect(res.isError).toBe(true);
    expect(recorded).toHaveLength(0);
  });

  it("returns an error when fewer than 2 options provided", async () => {
    const { writer, recorded } = makeFakeWriter();
    const mcp = createAgentLogMcp(writer) as unknown as { tools: unknown[] };
    const tool = getRecordDecisionTool(mcp);

    const res = await tool.handler({
      context: "c",
      optionsConsidered: ["only-one"],
      chosen: "only-one",
      reasoning: "r",
    });

    expect(res.isError).toBe(true);
    expect(recorded).toHaveLength(0);
  });

  it("warns but still records when chosen does not match any option verbatim", async () => {
    // Soft validation — agent may be summarizing an option, so we record
    // the decision anyway but make the mismatch visible in the response.
    const { writer, recorded } = makeFakeWriter();
    const mcp = createAgentLogMcp(writer) as unknown as { tools: unknown[] };
    const tool = getRecordDecisionTool(mcp);

    const res = await tool.handler({
      context: "c",
      optionsConsidered: ["option A: use fs.readFile", "option B: use fs/promises"],
      chosen: "option A",
      reasoning: "r",
    });

    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toMatch(/Warning/);
    // Decision IS recorded — the warning is about exactness, not rejection.
    // The signal (context + options + reasoning) is the valuable part;
    // chosen-mismatch is a nit worth surfacing but not enough to drop data.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.chosen).toBe("option A");
  });

  it("is inert when writer is null", async () => {
    const mcp = createAgentLogMcp(null) as unknown as { tools: unknown[] };
    const tool = getRecordDecisionTool(mcp);

    const res = await tool.handler({
      context: "c",
      optionsConsidered: ["a", "b"],
      chosen: "a",
      reasoning: "r",
    });

    // No writer to record into, but agent still gets a success response so
    // its flow isn't disturbed.
    expect(res.isError).toBeFalsy();
  });

  it("is inert when writer is no-op (flag off)", async () => {
    const { writer, recorded } = makeFakeWriter({ isNoop: true });
    const mcp = createAgentLogMcp(writer) as unknown as { tools: unknown[] };
    const tool = getRecordDecisionTool(mcp);

    await tool.handler({
      context: "c",
      optionsConsidered: ["a", "b"],
      chosen: "a",
      reasoning: "r",
    });

    expect(recorded).toHaveLength(0);
  });
});
