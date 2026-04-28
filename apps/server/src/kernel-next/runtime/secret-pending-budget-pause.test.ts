// Bug 12 (dogfood-2026-04-28): when a stage returns secret_pending the
// runner pauses its wall-clock timeout budget — symmetric with gate
// pause (BUG-2). Without this, the watchdog continues counting through
// human input think-time on fanout pipelines where one stage waits for
// secrets while another stage is still running.
//
// Architecture note: in the non-fanout path, secret_pending causes
// runPipeline to exit within milliseconds, so a pauseBudget call there
// is mostly defensive — by the time the timer would fire the run is
// already done. The pause matters in the fanout path, where the
// runOneAttempt actor remains alive while sibling stages continue.
//
// This test verifies the SIMPLER non-fanout path: secret_pending stage
// + a tight timeoutMs. With the pause in place, runPipeline still
// resolves cleanly (no spurious timeout reject) even on a 100ms budget.
//
// We use the same shape as secret-gate-e2e's Path A: real runner +
// RealStageExecutor against a pipeline whose mcpServers requires an
// envKey absent from process.env.

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { RealStageExecutor } from "./real-executor.js";
import { runPipeline } from "./runner.js";
import { KernelNextBroadcaster } from "../sse/broadcaster.js";
import type { PipelineIR } from "../ir/schema.js";

describe("Bug 12: secret_pending pauses the wall-clock budget", () => {
  let db: DatabaseSync;
  let uniqueKey: string;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    // Unique envKey so no real machine token can satisfy expansion.
    uniqueKey = `BUG12_E2E_${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
    delete process.env[uniqueKey];
  });

  it("runPipeline resolves cleanly even with timeoutMs short enough that a non-paused budget would fire", async () => {
    const ir: PipelineIR = {
      name: "bug12-pause",
      externalInputs: [],
      stages: [
        {
          name: "gated",
          type: "agent",
          inputs: [],
          outputs: [{ name: "result", type: "string" }],
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
    const vh = randomUUID().replace(/-/g, "").slice(0, 40);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });

    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
    });

    // Tight 100ms timeout. Without the pauseBudget call on secret_pending,
    // a buggy implementation that lets the timer keep running through the
    // last few finalize ticks could surface as a timeout reject. With the
    // fix, pauseBudget clears the timer on secret_pending entry; the
    // run-scoped finally clears any residual timer regardless.
    const result = await runPipeline({
      db, ir, taskId: "t-bug12", versionHash: vh,
      handlers: {}, executor,
    }, 100);

    // Critical: no thrown timeout. Path A E2E already proves
    // runPipeline resolves on secret_pending; this assertion locks in
    // the additional invariant that a tight wall-clock budget cannot
    // cause a spurious timeout race during the secret_pending exit
    // path. finalState may be 'failed' (interrupted verdict — task
    // is paused, not completed).
    expect(result.finalState).toMatch(/^(failed|completed)$/);

    // task_finals must NOT be written — the task is paused, not terminal.
    const finalsRow = db.prepare(
      `SELECT final_state, reason, detail FROM task_finals WHERE task_id = 't-bug12'`,
    ).get() as { final_state: string; reason: string; detail: string | null } | undefined;
    expect(finalsRow).toBeUndefined();

    // secret_gate_queue must record the pause.
    const sgRow = db.prepare(
      `SELECT required_keys FROM secret_gate_queue
       WHERE task_id = 't-bug12' AND resolved_at IS NULL`,
    ).get() as { required_keys: string } | undefined;
    expect(sgRow).toBeDefined();
    expect(JSON.parse(sgRow!.required_keys)).toContain(uniqueKey);
  }, 5_000);

  // Bug 12 root-cause fix: secret_pending exit path must NOT publish a
  // run_final SSE event. The broadcaster's per-task ring buffer
  // otherwise captures a "failed" run_final that the dashboard later
  // replays on reload, even after a successful resume has written its
  // own run_final + completed task_finals row. DB ground-truth would
  // be right but UI shows the stale event.
  it("does NOT publish run_final on secret_pending exit (broadcaster ring buffer stays clean)", async () => {
    const ir: PipelineIR = {
      name: "bug12-no-stale-run-final",
      externalInputs: [],
      stages: [
        {
          name: "gated",
          type: "agent",
          inputs: [],
          outputs: [{ name: "result", type: "string" }],
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
    const vh = randomUUID().replace(/-/g, "").slice(0, 40);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    const taskId = "t-bug12-broadcaster";

    const broadcaster = new KernelNextBroadcaster();

    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
    });

    await runPipeline({
      db, ir, taskId, versionHash: vh,
      handlers: {}, executor, broadcaster,
    }, 5_000);

    // Inspect the captured history. With the fix, no run_final should
    // be present — the task is paused, not terminal. Without the fix,
    // a single run_final with finalState='failed' would land here and
    // surface in the dashboard's Run-Final panel.
    const history = broadcaster.historyFor(taskId);
    const runFinals = history.filter((e) => e.type === "run_final");
    expect(runFinals).toHaveLength(0);

    // Sanity: other events still flow through (port_written for the
    // optional extern wire path is absent here, but stage_executing /
    // stage_error fire on the gated stage's secret_pending path).
    expect(history.length).toBeGreaterThan(0);
  }, 10_000);
});
