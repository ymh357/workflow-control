// Bug 11 (dogfood-2026-04-28) — verify the kernel reads
// system/init.mcp_servers[].status DIRECTLY instead of reverse-
// engineering it from the tools[] prefix list.
//
// Three behaviours to lock down:
//   1. mcp_servers entry with status "failed" → MCP_STARTUP_FAILED
//      (the existing F22 retry budget triggers off this string, so
//      the literal token must remain).
//   2. mcp_servers entry with status "needs-auth" → MCP_NEEDS_AUTH
//      (a NEW, distinct error code; not retryable; operator must
//      complete OAuth instead).
//   3. mcp_servers entry with status "connected" → no error, even
//      if the SDK happens to enumerate zero matching tool prefixes
//      (defensive: the old detector misfired in this case).
//
// All three drive RealStageExecutor end-to-end via a fake queryFn so
// we exercise the real onSdkMessage path. Results come back through
// PortRuntime → executeStage().

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { RealStageExecutor } from "./real-executor.js";
import { PortRuntime } from "./port-runtime.js";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { versionHash } from "../ir/canonical.js";
import type { PipelineIR } from "../ir/schema.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

function oneStageIRWithMcp(serverName: string): PipelineIR {
  return {
    name: "mcp-status-test",
    stages: [
      {
        name: "S",
        type: "agent",
        inputs: [],
        outputs: [],
        config: {
          promptRef: "x",
          mcpServers: [
            { name: serverName, command: "echo", args: ["hi"], envKeys: [] },
          ],
        },
      },
    ],
    wires: [],
  };
}

// Fake SDK stream factory: yields a system/init message with the given
// mcp_servers list, then ends the turn so executeStage resolves.
function fakeStreamWithMcpServers(
  mcp: Array<{ name: string; status: string }>,
): () => AsyncGenerator<unknown> {
  return async function* () {
    yield {
      type: "system",
      subtype: "init",
      uuid: "u0",
      session_id: "s",
      tools: ["mcp____kernel_next____write_port"],
      mcp_servers: mcp,
    };
    // Don't emit a result message — the MCP_STARTUP/NEEDS_AUTH throw
    // will short-circuit the iteration. For the "connected" case we
    // still need a terminator so the executor's stream-pump exits
    // cleanly without hitting an MCP error path. Yield a final result.
    yield {
      type: "result",
      uuid: "u1",
      session_id: "s",
      subtype: "success",
      is_error: false,
      result: "ok",
    };
  };
}

async function runOnce(
  ir: PipelineIR,
  stream: () => AsyncGenerator<unknown>,
): Promise<{ status: string; error?: string }> {
  const db = makeDb();
  try {
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const portRuntime = new PortRuntime(db, { send: () => {} });
    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryFn: ((_: { prompt: string; options: unknown }) =>
        stream() as unknown as ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").query>) as any,
    });
    // F22 grants up to 3 free retries on MCP_STARTUP_FAILED with
    // 2s/5s/10s backoffs. To keep this unit test fast (and to assert
    // on the FINAL error message after the budget exhausts), pre-abort
    // the signal so the retry loop short-circuits between attempts —
    // the very same mechanism cancel-during-backoff.test.ts uses. This
    // keeps the test below the default 5s vitest timeout while still
    // exercising the real onSdkMessage status-detector path.
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const result = await executor.executeStage({
      ir,
      stageName: "S",
      taskId: "t-status",
      versionHash: hash,
      portValues: {},
      handlers: {},
      portRuntime,
      signal: ac.signal,
    });
    return { status: result.status, error: (result as { error?: string }).error };
  } finally {
    db.close();
  }
}

describe("RealStageExecutor — MCP status detector (Bug 11)", () => {
  it("throws MCP_STARTUP_FAILED when SDK reports status='failed'", async () => {
    const result = await runOnce(
      oneStageIRWithMcp("playwright"),
      fakeStreamWithMcpServers([{ name: "playwright", status: "failed" }]),
    );
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/MCP_STARTUP_FAILED/);
    expect(result.error).toMatch(/'playwright'/);
    expect(result.error).toMatch(/1 failed, 0 not enumerated/);
  });

  it("throws MCP_NEEDS_AUTH when SDK reports status='needs-auth'", async () => {
    const result = await runOnce(
      oneStageIRWithMcp("slack"),
      fakeStreamWithMcpServers([{ name: "slack", status: "needs-auth" }]),
    );
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/MCP_NEEDS_AUTH/);
    expect(result.error).toMatch(/'slack'/);
    // Critical: a needs-auth error must NOT include the
    // MCP_STARTUP_FAILED token, otherwise the F22 retry budget would
    // burn 3 free retries on something that won't ever come up
    // without operator intervention.
    expect(result.error).not.toMatch(/MCP_STARTUP_FAILED/);
  });

  it("throws MCP_STARTUP_FAILED when declared server is missing from mcp_servers entirely", async () => {
    // Operator declared 'github' but SDK didn't surface it at all in
    // the init message — typically a config error or a server that
    // crashed before the SDK could even register the entry.
    const result = await runOnce(
      oneStageIRWithMcp("github"),
      fakeStreamWithMcpServers([{ name: "playwright", status: "connected" }]),
    );
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/MCP_STARTUP_FAILED/);
    expect(result.error).toMatch(/'github'/);
    expect(result.error).toMatch(/0 failed, 1 not enumerated/);
  });

  it("does NOT throw when SDK reports status='connected' (even with an empty tools list)", async () => {
    // Defence against the old detector's misfire path: even if no
    // mcp__playwright__* tool happens to be enumerated yet (e.g. the
    // SDK ships tools in a later message), 'connected' is the SDK's
    // word that the handshake succeeded. Trust it.
    const result = await runOnce(
      oneStageIRWithMcp("playwright"),
      fakeStreamWithMcpServers([{ name: "playwright", status: "connected" }]),
    );
    expect(result.status).toBe("success");
  });

  it("tolerates status='pending' at init (transient state, not a failure)", async () => {
    // 'pending' = SDK is still mid-handshake. Failing here would be
    // racy; later messages or the eventual handshake outcome will
    // surface the real result.
    const result = await runOnce(
      oneStageIRWithMcp("playwright"),
      fakeStreamWithMcpServers([{ name: "playwright", status: "pending" }]),
    );
    expect(result.status).toBe("success");
  });
});
