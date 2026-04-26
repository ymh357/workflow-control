// A2 (2026-04-27) — cancel_task during MCP_STARTUP_RETRY backoff.
//
// F22 #1 grants up to 3 free retries when an attempt fails with
// MCP_STARTUP_FAILED, separated by 2s / 5s / 10s backoffs. Without this
// fix, an INTERRUPT delivered while the executor is sleeping in such a
// backoff was silently absorbed: the timer ran to completion, then a
// fresh doAttempt started, only to be aborted moments later. Net delay
// before the SDK subprocess actually died: up to 17s + one extra
// attempt's startup cost.
//
// Fix: the executor's retry loop checks args.signal.aborted between
// attempts AND the backoff itself races against the same signal via
// abortableDelay. The test below proves both legs.
//
// Strategy:
// - queryFn yields an MCP_STARTUP_FAILED error (which the executor
//   detects from the message text inside the stream-pump throw path).
// - After the first attempt resolves with status=error, the executor
//   enters its 2s backoff. We abort args.signal mid-sleep.
// - Assertion: executeStage returns within ~250ms (much less than the
//   2s backoff), and queryFn was invoked exactly once (no second
//   attempt was started after the abort).

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

function oneStageIR(): PipelineIR {
  return {
    name: "cancel-during-backoff",
    stages: [
      {
        name: "S",
        type: "agent",
        inputs: [],
        outputs: [],
        config: {
          promptRef: "do stuff",
          // Declaring an external MCP server is what gates the
          // "missing tools" detection that throws MCP_STARTUP_FAILED.
          mcpServers: [
            {
              name: "missing-server",
              command: "echo",
              args: ["hi"],
              envKeys: [],
            },
          ],
        },
      },
    ],
    wires: [],
  };
}

// Stream that triggers MCP_STARTUP_FAILED via the "no tools advertised"
// detector inside real-executor's onSdkMessage. The init message claims
// only the kernel's tool prefix, so the declared 'missing-server' is
// reported as not having advertised any tool.
async function* mcpStartupFailedStream(): AsyncGenerator<unknown> {
  yield {
    type: "system",
    subtype: "init",
    uuid: "u0",
    session_id: "s",
    tools: ["mcp____kernel_next____write_port"],
  };
}

describe("RealStageExecutor — cancel during MCP_STARTUP_RETRY backoff (A2)", () => {
  it("aborts the retry loop without waiting the full backoff", async () => {
    const db = makeDb();
    const ir = oneStageIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const portRuntime = new PortRuntime(db, { send: () => { /* inert */ } });

    let queryFnCallCount = 0;
    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      queryFn: ((_args: { prompt: string; options: { abortController?: AbortController } }) => {
        queryFnCallCount += 1;
        return mcpStartupFailedStream() as unknown as ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").query>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    });

    const ac = new AbortController();
    // Abort 200ms in — well before the 2s backoff would expire — to
    // simulate a cancel_task delivered while the runner is asleep
    // between MCP_STARTUP retry slots.
    setTimeout(() => ac.abort(), 200);

    const startedAt = Date.now();
    const result = await executor.executeStage({
      ir,
      stageName: "S",
      taskId: "t-cancel",
      versionHash: hash,
      portValues: {},
      handlers: {},
      portRuntime,
      signal: ac.signal,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.status).toBe("error");
    // The first 2s backoff would otherwise dominate; with the abort the
    // loop exits as soon as the signal fires (~200ms).
    expect(elapsedMs).toBeLessThan(1500);
    // Critical invariant: NO second attempt is started after the abort.
    // Without this fix, queryFnCallCount would be 2 (the cancelled
    // backoff still woke up and ran one more attempt before the inner
    // signal check triggered).
    expect(queryFnCallCount).toBe(1);

    db.close();
  });
});
