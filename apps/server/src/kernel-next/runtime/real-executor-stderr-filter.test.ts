// Bug 11 (2026-04-28) — verify the SDK stderr filter only forwards
// operationally-useful lines and survives a closed writer.
//
// The whole point of having a filter is to keep agent_stream_json from
// drowning in cli.js debug noise: only MCP-handshake-failed and
// adjacent failures should land in the attempt log.

import { describe, it, expect } from "vitest";
import { filterAndAppendSdkStderr } from "./real-executor.js";
import type { ExecutionRecordWriter } from "./execution-record-writer.js";
import type { AgentStreamEvent } from "./execution-record-types.js";

function makeMockWriter(): { writer: ExecutionRecordWriter; events: AgentStreamEvent[] } {
  const events: AgentStreamEvent[] = [];
  const writer: ExecutionRecordWriter = {
    attemptId: "test",
    appendToolCall: () => {},
    completeToolCall: () => {},
    appendAgentStream: (e) => events.push(e),
    appendCompactEvent: () => {},
    completeCompactEvent: () => {},
    updateCost: () => {},
    updateSessionId: () => {},
    heartbeat: () => {},
    close: () => {},
    __flushForTests: () => {},
  };
  return { writer, events };
}

describe("filterAndAppendSdkStderr", () => {
  it("captures MCP 'Connection failed after Xms' lines", () => {
    const { writer, events } = makeMockWriter();
    filterAndAppendSdkStderr(
      "Connection failed after 4321ms: invalid handshake\n",
      writer,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("sdk_stderr");
    expect(events[0]!.text).toContain("Connection failed after 4321ms");
  });

  it("captures multiple matching lines from a single chunk", () => {
    const { writer, events } = makeMockWriter();
    filterAndAppendSdkStderr(
      [
        "Connection failed after 1000ms: timeout",
        "Some unrelated debug noise",
        "MCP server playwright failed to initialize",
      ].join("\n"),
      writer,
    );
    expect(events.map((e) => e.text)).toEqual([
      "Connection failed after 1000ms: timeout",
      "MCP server playwright failed to initialize",
    ]);
  });

  it("drops everything that does not match the include patterns", () => {
    const { writer, events } = makeMockWriter();
    filterAndAppendSdkStderr(
      [
        "GET /v1/messages 200 OK",
        "react-reconciler debug: scheduling",
        "ink renderer paint",
      ].join("\n"),
      writer,
    );
    expect(events).toHaveLength(0);
  });

  it("recognises 'Failed to connect SDK MCP server' (createSdkMcpServer error path)", () => {
    const { writer, events } = makeMockWriter();
    filterAndAppendSdkStderr(
      "Failed to connect SDK MCP server: TypeError: x is undefined\n",
      writer,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.text).toMatch(/Failed to connect SDK MCP server/);
  });

  it("recognises 'Authentication failed' lines (OAuth MCP)", () => {
    const { writer, events } = makeMockWriter();
    filterAndAppendSdkStderr(
      "Authentication failed for slack: invalid token\n",
      writer,
    );
    expect(events).toHaveLength(1);
  });

  it("trims whitespace and skips empty lines", () => {
    const { writer, events } = makeMockWriter();
    filterAndAppendSdkStderr(
      "\n   \nConnection failed after 5ms: x\n\n",
      writer,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.text).toBe("Connection failed after 5ms: x");
  });

  it("survives a writer that throws (closed mid-attempt)", () => {
    const writer: ExecutionRecordWriter = {
      attemptId: "t",
      appendToolCall: () => {},
      completeToolCall: () => {},
      appendAgentStream: () => {
        throw new Error("writer closed");
      },
      appendCompactEvent: () => {},
      completeCompactEvent: () => {},
      updateCost: () => {},
      updateSessionId: () => {},
      heartbeat: () => {},
      close: () => {},
      __flushForTests: () => {},
    };
    expect(() =>
      filterAndAppendSdkStderr(
        "Connection failed after 1ms: x\n",
        writer,
      ),
    ).not.toThrow();
  });
});
