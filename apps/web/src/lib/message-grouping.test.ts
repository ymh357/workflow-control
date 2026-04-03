import { describe, it, expect } from "vitest";
import { groupMessages, type MessageGroup } from "./message-grouping";
import type { DisplayMessage } from "./types";

let idCounter = 0;
function msg(
  type: string,
  overrides: Partial<DisplayMessage> = {},
): DisplayMessage {
  return {
    id: `msg-${++idCounter}`,
    type: type as any,
    content: "content",
    timestamp: "2024-01-01T00:00:00Z",
    stage: "stage1",
    ...overrides,
  } as DisplayMessage;
}

// ── Empty / single message ──

describe("empty and trivial inputs", () => {
  it("empty array returns empty array", () => {
    expect(groupMessages([])).toEqual([]);
  });

  it("single agent_text returns one assistant_turn group", () => {
    const groups = groupMessages([msg("agent_text")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("assistant_turn");
  });

  it("single user_message returns one user group", () => {
    const groups = groupMessages([msg("user_message")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("user");
  });

  it("unknown type falls back to 'system' group", () => {
    const groups = groupMessages([msg("unknown_type")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("system");
  });
});

// ── assistant_turn merging ──

describe("assistant_turn merging", () => {
  it("two consecutive agent_text messages merge into one group", () => {
    const groups = groupMessages([msg("agent_text"), msg("agent_text")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].messages).toHaveLength(2);
  });

  it("three consecutive agent_text messages all merge", () => {
    const groups = groupMessages([
      msg("agent_text"),
      msg("agent_text"),
      msg("agent_text"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].messages).toHaveLength(3);
  });

  it("agent_text after user_message starts a new assistant_turn group", () => {
    const groups = groupMessages([
      msg("agent_text"),
      msg("user_message"),
      msg("agent_text"),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups[0].type).toBe("assistant_turn");
    expect(groups[1].type).toBe("user");
    expect(groups[2].type).toBe("assistant_turn");
    expect(groups[2].messages).toHaveLength(1);
  });

  it("group id is taken from first message in group", () => {
    const first = msg("agent_text");
    const groups = groupMessages([first, msg("agent_text")]);
    expect(groups[0].id).toBe(first.id);
  });

  it("group timestamp is taken from first message", () => {
    const first = msg("agent_text", { timestamp: "2024-01-01T10:00:00Z" });
    const groups = groupMessages([first, msg("agent_text", { timestamp: "2024-01-01T11:00:00Z" })]);
    expect(groups[0].timestamp).toBe("2024-01-01T10:00:00Z");
  });

  it("group stage is taken from first message", () => {
    const first = msg("agent_text", { stage: "analysis" });
    const groups = groupMessages([first, msg("agent_text", { stage: "reporting" })]);
    expect(groups[0].stage).toBe("analysis");
  });
});

// ── tool_call grouping ──

describe("tool_call grouping", () => {
  it("agent_tool_use creates a tool_call group", () => {
    const groups = groupMessages([msg("agent_tool_use", { detail: { toolName: "Read" } } as any)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("tool_call");
  });

  it("toolName is extracted from detail.toolName on agent_tool_use", () => {
    const groups = groupMessages([
      msg("agent_tool_use", { detail: { toolName: "Bash" } } as any),
    ]);
    expect(groups[0].toolName).toBe("Bash");
  });

  it("agent_tool_result after agent_tool_use merges into same group", () => {
    const groups = groupMessages([
      msg("agent_tool_use", { detail: { toolName: "Read" } } as any),
      msg("agent_tool_result"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].messages).toHaveLength(2);
  });

  it("agent_tool_result without preceding tool_call creates new tool_call group", () => {
    const groups = groupMessages([msg("agent_tool_result")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("tool_call");
  });

  it("agent_tool_result does NOT merge into assistant_turn group", () => {
    const groups = groupMessages([
      msg("agent_text"),
      msg("agent_tool_result"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[1].type).toBe("tool_call");
  });

  it("two sequential tool calls each get their own group", () => {
    const groups = groupMessages([
      msg("agent_tool_use", { detail: { toolName: "Read" } } as any),
      msg("agent_tool_result"),
      msg("agent_tool_use", { detail: { toolName: "Write" } } as any),
      msg("agent_tool_result"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].toolName).toBe("Read");
    expect(groups[1].toolName).toBe("Write");
  });

  it("agent_tool_use without detail — toolName is empty string", () => {
    const groups = groupMessages([msg("agent_tool_use")]);
    expect(groups[0].toolName).toBe("");
  });
});

// ── thinking grouping ──

describe("thinking grouping", () => {
  it("agent_thinking creates a thinking group", () => {
    const groups = groupMessages([msg("agent_thinking", { content: "I think..." })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("thinking");
  });

  it("thinkingText is taken from message content", () => {
    const groups = groupMessages([msg("agent_thinking", { content: "Deep thought" })]);
    expect(groups[0].thinkingText).toBe("Deep thought");
  });

  it("two consecutive agent_thinking messages each get their own group", () => {
    // thinking always flushes — no merging
    const groups = groupMessages([
      msg("agent_thinking", { content: "first" }),
      msg("agent_thinking", { content: "second" }),
    ]);
    expect(groups).toHaveLength(2);
  });
});

// ── stage_divider deduplication ──

describe("stage_divider deduplication", () => {
  it("single stage_divider creates one group", () => {
    const groups = groupMessages([msg("stage_change", { stage: "analysis" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("stage_divider");
  });

  it("two consecutive stage_dividers for the same stage — only one group", () => {
    const groups = groupMessages([
      msg("stage_change", { stage: "analysis" }),
      msg("stage_change", { stage: "analysis" }),
    ]);
    expect(groups).toHaveLength(1);
  });

  it("three consecutive same-stage dividers — only one group", () => {
    const groups = groupMessages([
      msg("stage_change", { stage: "s1" }),
      msg("stage_change", { stage: "s1" }),
      msg("stage_change", { stage: "s1" }),
    ]);
    expect(groups).toHaveLength(1);
  });

  it("two dividers for different stages — two groups", () => {
    const groups = groupMessages([
      msg("stage_change", { stage: "analysis" }),
      msg("stage_change", { stage: "reporting" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].stage).toBe("analysis");
    expect(groups[1].stage).toBe("reporting");
  });

  it("same-stage dividers separated by another message — both emitted", () => {
    const groups = groupMessages([
      msg("stage_change", { stage: "analysis" }),
      msg("agent_text"),
      msg("stage_change", { stage: "analysis" }),
    ]);
    // Not consecutive — both dividers should appear
    expect(groups).toHaveLength(3);
    expect(groups[0].type).toBe("stage_divider");
    expect(groups[2].type).toBe("stage_divider");
  });

  it("stage_divider after pending current group also deduplicates via lastGroup check", () => {
    // current is an assistant_turn in progress, then two same-stage dividers
    // but here current would be flushed before the divider check
    const groups = groupMessages([
      msg("stage_change", { stage: "x" }),
      msg("agent_text"),
      msg("stage_change", { stage: "x" }),
      msg("stage_change", { stage: "x" }),
    ]);
    // agent_text flushes the first divider, then two consecutive x-dividers → deduplicated
    expect(groups.filter(g => g.type === "stage_divider" && g.stage === "x")).toHaveLength(2);
  });
});

// ── Mixed message stream ──

describe("mixed message stream", () => {
  it("full realistic stream: user → thinking → agent_text → tool_call+result → agent_text", () => {
    const groups = groupMessages([
      msg("user_message"),
      msg("agent_thinking", { content: "thinking..." }),
      msg("agent_text"),
      msg("agent_text"),
      msg("agent_tool_use", { detail: { toolName: "Read" } } as any),
      msg("agent_tool_result"),
      msg("agent_text"),
    ]);

    expect(groups).toHaveLength(5);
    expect(groups[0].type).toBe("user");
    expect(groups[1].type).toBe("thinking");
    expect(groups[2].type).toBe("assistant_turn");
    expect(groups[2].messages).toHaveLength(2);
    expect(groups[3].type).toBe("tool_call");
    expect(groups[3].messages).toHaveLength(2);
    expect(groups[4].type).toBe("assistant_turn");
  });

  it("stage dividers interspersed with agent messages", () => {
    const groups = groupMessages([
      msg("stage_change", { stage: "s1" }),
      msg("agent_text"),
      msg("stage_change", { stage: "s2" }),
      msg("agent_text"),
    ]);

    expect(groups).toHaveLength(4);
    expect(groups[0].type).toBe("stage_divider");
    expect(groups[1].type).toBe("assistant_turn");
    expect(groups[2].type).toBe("stage_divider");
    expect(groups[3].type).toBe("assistant_turn");
  });

  it("all messages of each type are present in output", () => {
    const messages = [
      msg("user_message"),
      msg("agent_text"),
      msg("agent_thinking"),
      msg("agent_tool_use"),
      msg("agent_tool_result"),
      msg("stage_change"),
    ];
    const groups = groupMessages(messages);
    const types = groups.map(g => g.type);
    expect(types).toContain("user");
    expect(types).toContain("assistant_turn");
    expect(types).toContain("thinking");
    expect(types).toContain("tool_call");
    expect(types).toContain("stage_divider");
  });
});
