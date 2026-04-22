// B10 end-to-end: migration INTERRUPT → AgentMachine graceful summary
// turn → write_port lands in port_values → migration completes with
// the agent's summary preserved as lineage.
//
// Existing coverage:
//   - AgentMachine unit tests verify the interruptArmed / summaryTurnUsed
//     state machine (runtime/agent-machine.test.ts).
//   - RealStageExecutor tests verify abort-while-waiting → summary-turn
//     → RESULT_SUCCESS keeps status='success' (runtime/real-executor.test.ts).
//   - migration-orchestrator tests verify INTERRUPT → awaitTermination
//     → supersede with startRunnerOverride stubs.
//
// Gap this test fills: the three pieces above are tested in isolation.
// No test exercises "real runPipeline + RealStageExecutor + migration-
// orchestrator-sent INTERRUPT" as one chain. This test does, and
// asserts the summary value written during the agent's summary turn
// survives to the port_values row the caller can query.

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelService } from "../mcp/kernel.js";
import {
  executeMigration,
  __resetOrchestratorLocksForTest,
} from "./migration-orchestrator.js";
import { taskRegistry } from "../runtime/task-registry.js";
import { runPipeline } from "../runtime/runner.js";
import { RealStageExecutor } from "../runtime/real-executor.js";
import { PortRuntime } from "../runtime/port-runtime.js";
import type { PipelineIR } from "../ir/schema.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

function singleStageIR(): PipelineIR {
  return {
    name: "b10-e2e",
    stages: [
      {
        name: "S",
        type: "agent",
        inputs: [],
        outputs: [{ name: "summary", type: "string" }],
        config: { promptRef: "p-s" },
      },
    ],
    wires: [],
  };
}

// Fake SDK stream that pauses in waiting_for_claude until the caller
// resolves `gate`. When gate resolves to "summary-then-success":
//   1. before yielding any more messages, calls writeSideEffect()
//      (stand-in for MCP write_port during the summary turn)
//   2. yields tool_use + tool_result + result(success)
// The AgentMachine sees RESULT_SUCCESS after INTERRUPT was armed but
// before any re-entry to waiting → §4.2 rules say summary turn wins,
// status = success.
function makeSummaryTurnStream(
  gate: Promise<"summary-then-success" | "hang">,
  writeSideEffect: () => void,
) {
  async function* gen() {
    yield { type: "system", subtype: "init", uuid: "u0", session_id: "s" };
    yield {
      type: "assistant",
      message: { content: [{ type: "text", text: "about to work" }] },
      session_id: "s",
    };
    // Pause here — the runner will send INTERRUPT via the abort signal.
    const next = await gate;
    if (next === "hang") return;
    writeSideEffect();
    yield {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "w1", name: "write_port", input: {} }] },
      session_id: "s",
    };
    yield {
      type: "user",
      message: { content: [{ type: "tool_result", id: "w1", content: "ok" }] },
      session_id: "s",
    };
    yield {
      type: "result",
      subtype: "success",
      total_cost_usd: 0,
      num_turns: 2,
      session_id: "s",
    };
  }
  return gen() as unknown as ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").query>;
}

describe("B10 e2e: graceful summary turn across migration INTERRUPT", () => {
  beforeEach(() => {
    __resetOrchestratorLocksForTest();
    taskRegistry.__clearForTest();
  });

  it("migration INTERRUPT triggers summary turn, write_port during that turn survives supersede", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submitted = svc.submit(singleStageIR(), { prompts: { "p-s": "prompt" } });
      if (!submitted.ok) throw new Error("submit: " + JSON.stringify(submitted.diagnostics));
      const v1 = submitted.versionHash;
      const taskId = "t-b10";

      // The summary-turn "pseudo-write_port" side effect: insert a
      // port_values row directly on the current attempt (stand-in for
      // what the MCP write_port handler would do).
      const writeSummary = () => {
        const row = db.prepare(
          `SELECT attempt_id FROM stage_attempts
             WHERE task_id = ? AND stage_name = 'S'
             ORDER BY attempt_idx DESC LIMIT 1`,
        ).get(taskId) as { attempt_id: string } | undefined;
        if (!row) return;
        const runtime = new PortRuntime(db, { send: () => { /* inert */ } });
        runtime.writePort({
          attemptId: row.attempt_id,
          stageName: "S",
          portName: "summary",
          value: "graceful-summary-from-agent",
        });
      };

      // Gate controls when the fake stream leaves waiting_for_claude.
      let resolveGate!: (v: "summary-then-success") => void;
      const gate = new Promise<"summary-then-success" | "hang">((r) => {
        resolveGate = r as never;
      });

      const executor = new RealStageExecutor({
        mcpServerFactory: () => ({}),
        queryFn: ((_args: unknown) => makeSummaryTurnStream(gate, writeSummary)) as never,
      });

      // Kick off the run. It will hang at the stream's `await gate` while
      // in waiting_for_claude.
      const runPromise = runPipeline({
        db, ir: singleStageIR(), taskId, versionHash: v1, handlers: {},
        executor,
      }, 30_000);

      // Wait until the task is visibly running (taskRegistry has the
      // dispatcher) — the migration orchestrator needs this.
      await new Promise((r) => setTimeout(r, 50));
      let reg = taskRegistry.get(taskId);
      for (let i = 0; i < 20 && !reg; i++) {
        await new Promise((r) => setTimeout(r, 25));
        reg = taskRegistry.get(taskId);
      }
      expect(reg).toBeDefined();

      // Now propose v2 and kick migration. This sends INTERRUPT to the
      // runner; executor translates it to signal.abort() which reaches
      // AgentMachine → interruptArmed. We then resolve the gate, which
      // causes the stream to fire write_port + RESULT_SUCCESS.
      const propose = svc.propose({
        currentVersion: v1,
        patch: {
          ops: [{
            op: "update_stage_config",
            stage: "S",
            configPatch: { promptRef: "p-s-v2" },
          }],
        },
        actor: "test",
        rerunFrom: "S",
        migrateRunningTasks: [taskId],
        autoApprove: true,
      });
      if (!propose.ok) throw new Error("propose: " + JSON.stringify(propose.diagnostics));

      // Migration will INTERRUPT the task. Release the gate ~20ms later
      // so the abort definitely arrives first — that's what "summary
      // turn after INTERRUPT" means.
      setTimeout(() => resolveGate("summary-then-success"), 50);

      const mig = await executeMigration({
        db, taskId, proposalId: propose.proposalId,
        startRunnerOverride: (async () => ({
          ok: true as const, taskId, versionHash: propose.proposedVersion,
        })) as never,
        interruptWaitMsOverride: 2000,
      });
      if (!mig.ok) throw new Error("migration: " + JSON.stringify(mig));

      // runPromise should settle now that the stream ended.
      const r = await runPromise;
      // The original run terminated as "interrupted" from the runner's
      // perspective (INTERRUPT was observed). The stage attempt itself
      // is either success (summary turn won, pre-supersede) or
      // superseded (migration flipped it).
      expect(["completed", "failed"]).toContain(r.finalState);

      // INVARIANT #1 — the summary written during the summary turn is
      // still in port_values. migration supersede touches stage_attempts
      // rows only, never port_values; the summary row survives as
      // lineage for the next version to read.
      const ports = db.prepare(
        `SELECT value_json FROM port_values
         WHERE stage_name = 'S' AND port_name = 'summary' AND direction = 'out'
         ORDER BY written_at DESC LIMIT 1`,
      ).all() as Array<{ value_json: string }>;
      expect(ports.length).toBeGreaterThanOrEqual(1);
      expect(JSON.parse(ports[0]!.value_json)).toBe("graceful-summary-from-agent");

      // INVARIANT #2 — the pre-migration attempt ended up superseded
      // (the version graph got re-rooted to v2 via rerunFrom=S).
      const attempts = db.prepare(
        `SELECT status FROM stage_attempts
         WHERE task_id = ? AND stage_name = 'S' AND version_hash = ?
         ORDER BY attempt_idx`,
      ).all(taskId, v1) as Array<{ status: string }>;
      expect(attempts.length).toBeGreaterThanOrEqual(1);
      // At least one of the v1 attempts is 'superseded'.
      expect(attempts.some((a) => a.status === "superseded")).toBe(true);
    } finally {
      db.close();
    }
  });
});
