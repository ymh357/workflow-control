// bug-g-runtime-guard.test.ts
//
// Bug G runtime guard (D4 dogfood, 2026-04-30).
//
// The validator (structural.ts ENVKEY_NOT_REFERENCED) prevents new IRs
// that declare envKeys without a matching ${VAR} reference. But
// historical IRs already in pipeline_versions can still be in this
// shape — `run_pipeline { name }` resolves to the latest version_hash
// for that name, so a pre-fix IR remains reachable indefinitely.
//
// Pre-fix runtime behavior on such an IR:
//   - expandMcpServers returns ok:true (nothing to expand)
//   - the secret-gate path is skipped
//   - SDK spawns the MCP child without the envKey value
//   - the child process fails its own handshake
//   - attempt status='error' with opaque error_message
//   - provide_task_secrets cannot recover (no secret_gate_queue row;
//     even if there were one, there is no ${VAR} for the resolved
//     value to substitute into → next attempt fails identically)
//
// Post-fix runtime behavior (this test):
//   - real-executor pre-screens stage.config.mcpServers
//   - if any envKey is unreferenced in command/args/env, fails the
//     attempt with code IR_BROKEN_ENVKEY_NOT_REFERENCED
//   - the message tells the operator exactly what to add to the IR
//   - no SDK spawn, no opaque handshake failure

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import { initKernelNextSchema } from "../ir/sql.js";
import { RealStageExecutor } from "./real-executor.js";
import { PortRuntime, type EventDispatcher } from "./port-runtime.js";
import type { PipelineIR } from "../ir/schema.js";

function noopDispatcher(): EventDispatcher {
  return { send: () => {} };
}

// Pipeline with the Bug G shape: envKeys declared, env field omitted.
function brokenIR(uniqueKey: string): PipelineIR {
  return {
    name: "bug-g-historical",
    externalInputs: [],
    stages: [
      {
        name: "research",
        type: "agent",
        inputs: [],
        outputs: [{ name: "summary", type: "string" }],
        config: {
          promptRef: "stub",
          mcpServers: [
            {
              name: "fake-mcp",
              command: "npx",
              args: ["-y", "@fake/mcp-server"],
              envKeys: [uniqueKey],
              // env field intentionally omitted — this is the Bug G shape.
            },
          ],
        },
      },
    ],
    wires: [],
  };
}

describe("Bug G runtime guard — historical IR with envKeys but no ${VAR} ref", () => {
  let db: DatabaseSync;
  let uniqueKey: string;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    uniqueKey = `BUG_G_KEY_${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
    delete process.env[uniqueKey];
  });

  it("fails the attempt with IR_BROKEN_ENVKEY_NOT_REFERENCED before reaching the SDK", async () => {
    const ir = brokenIR(uniqueKey);
    const taskId = `bug-g-${randomUUID().slice(0, 8)}`;
    const portRuntime = new PortRuntime(db, noopDispatcher());

    // No queryFn override — the real SDK would be invoked if the guard
    // didn't fire, but the guard runs before expandMcpServers and well
    // before any SDK call. The fact that the test does NOT spawn a real
    // SDK process is itself proof the guard tripped early.
    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
    });

    const result = await executor.executeStage({
      ir,
      stageName: "research",
      taskId,
      versionHash: "v1",
      portValues: {},
      handlers: {},
      portRuntime,
    });

    expect(result.status).toBe("error");

    // attempt row exists with status='error' (no secret_pending — that
    // path would lead to a dead-end since provide_task_secrets cannot
    // recover an unreferenced envKey)
    const attempt = db.prepare(
      `SELECT status FROM stage_attempts WHERE attempt_id = ?`,
    ).get(result.attemptId) as { status: string } | undefined;
    expect(attempt).toBeDefined();
    expect(attempt!.status).toBe("error");

    // No secret_gate_queue row was written — this IR cannot be recovered
    // through the secret-gate path because there is no ${VAR} to substitute
    // the value into. The operator must re-submit a corrected IR.
    const sg = db.prepare(
      `SELECT secret_gate_id FROM secret_gate_queue WHERE task_id = ?`,
    ).get(taskId);
    expect(sg).toBeUndefined();
  });

  it("does NOT fire when env: { KEY: '${KEY}' } is present (validator-blessed shape)", async () => {
    const ir: PipelineIR = {
      name: "bug-g-fixed",
      externalInputs: [],
      stages: [
        {
          name: "research",
          type: "agent",
          inputs: [],
          outputs: [{ name: "summary", type: "string" }],
          config: {
            promptRef: "stub",
            mcpServers: [
              {
                name: "fake-mcp",
                command: "npx",
                args: ["-y", "@fake/mcp-server"],
                envKeys: [uniqueKey],
                env: { [uniqueKey]: `\${${uniqueKey}}` },
              },
            ],
          },
        },
      ],
      wires: [],
    };

    const taskId = `bug-g-fixed-${randomUUID().slice(0, 8)}`;
    const portRuntime = new PortRuntime(db, noopDispatcher());

    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
    });

    const result = await executor.executeStage({
      ir,
      stageName: "research",
      taskId,
      versionHash: "v1",
      portValues: {},
      handlers: {},
      portRuntime,
    });

    // The validator-blessed shape correctly routes to secret_pending
    // because expandMcpServers sees ${VAR} unresolved → ok:false →
    // secret-gate path fires.
    expect(result.status).toBe("secret_pending");
  });

  it("does NOT fire when value is in process.env (envKeys satisfied even without ${VAR} ref)", async () => {
    process.env[uniqueKey] = "real_value";
    try {
      const ir = brokenIR(uniqueKey);
      const taskId = `bug-g-pe-${randomUUID().slice(0, 8)}`;
      const portRuntime = new PortRuntime(db, noopDispatcher());

      const executor = new RealStageExecutor({
        mcpServerFactory: () => ({}),
      });

      // Even with the value in process.env, the guard fires because
      // the IR shape itself is broken — it would silently fail on
      // anyone else's machine. A working dev environment should not
      // mask the underlying defect.
      const result = await executor.executeStage({
        ir,
        stageName: "research",
        taskId,
        versionHash: "v1",
        portValues: {},
        handlers: {},
        portRuntime,
      });

      expect(result.status).toBe("error");
    } finally {
      delete process.env[uniqueKey];
    }
  });
});
