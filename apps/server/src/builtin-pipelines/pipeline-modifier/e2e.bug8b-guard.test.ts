// Pipeline-modifier full e2e regression for the Bug 8b kernel guard.
//
// Promotion of validate-patch-stage.test.ts (stage-layer integration)
// to runner-layer e2e: drives runPipeline through the failure path so
// the cross-region cancellation propagation is exercised at the same
// time as the guard itself. Both have to work together for this test
// to resolve cleanly within the wall-clock budget.
//
// Scenario: genPatch emits the silent-no-op contradiction
//   - gapAnalysis.intendedChanges: 1 entry (non-empty intent)
//   - patch.ops: [] (empty)
//   - dryRunVerdict: "safe"
//
// Expected:
//   1. validatePatch raises Bug 8b error (stageErrors carries it)
//   2. applying never starts (cross-region cancel)
//   3. runPipeline resolves (not times out) with finalState='failed'
//   4. no proposal row written

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../../kernel-next/ir/sql.js";
import { KernelService } from "../../kernel-next/mcp/kernel.js";
import { loadBuiltinPipelineIR } from "../../kernel-next/runtime/load-builtin-pipeline.js";
import { runPipeline } from "../../kernel-next/runtime/runner.js";
import { taskRegistry } from "../../kernel-next/runtime/task-registry.js";
import type { StageHandlerMap } from "../../kernel-next/runtime/mock-executor.js";
import { buildModifierTestExecutor } from "./test-utils.js";

describe("pipeline-modifier e2e Bug 8b guard", () => {
  it(
    "validatePatch fails the run when genPatch emits empty ops + safe verdict + non-empty intent",
    { timeout: 20_000 },
    async () => {
      const db = new DatabaseSync(":memory:");
      initKernelNextSchema(db);
      try {
        const svc = new KernelService(db, { skipTypeCheck: true });

        const smoke = loadBuiltinPipelineIR("smoke-test");
        const smokeRes = await svc.submit(smoke.ir, { prompts: smoke.prompts });
        if (!smokeRes.ok) {
          throw new Error(`smoke-test submit failed: ${JSON.stringify(smokeRes.diagnostics)}`);
        }

        const modifier = loadBuiltinPipelineIR("pipeline-modifier");
        const modRes = await svc.submit(modifier.ir, { prompts: modifier.prompts });
        if (!modRes.ok) {
          throw new Error(`pipeline-modifier submit failed: ${JSON.stringify(modRes.diagnostics)}`);
        }

        const taskId = "t-modifier-bug8b-1";
        const targetAgentStage = smoke.ir.stages.find((s) => s.type === "agent");
        if (!targetAgentStage || targetAgentStage.type !== "agent") {
          throw new Error("smoke-test has no agent stage");
        }

        const handlers: StageHandlerMap = {
          loadCurrent: () => ({
            currentVersionHash: smokeRes.versionHash,
            currentIr: smoke.ir,
            currentPromptsMap: smoke.prompts,
            failureBundle: null,
          }),
          analyzeGap: () => ({
            gapAnalysis: {
              currentShapeSummary: "smoke-test 2-stage agent pipeline",
              intendedChanges: [
                { stage: targetAgentStage.name, kind: "modify", description: "rename promptRef" },
              ],
              affectedStages: [targetAgentStage.name],
              risks: [],
            },
            proposedChangeOutline: `Rename ${targetAgentStage.name}.promptRef`,
            expectedSafeRange: "safe",
          }),
          // Bug-8b shaped output: non-empty intent (set above), empty
          // ops, safe verdict. validatePatch must reject this.
          genPatch: () => ({
            patch: { ops: [] },
            rerunFrom: "",
            migrateRunningTasks: "none",
            prompts: {},
            dryRunVerdict: "safe",
          }),
          // applying handler — should never run. If it does, the run
          // would write a proposal row, which we assert below is absent.
          // The handler returns a sentinel so a guard regression surfaces
          // as proposalRow being defined rather than as a thrown error.
          applying: () => ({
            proposalId: "GUARD_BYPASS_BUG",
            proposedVersion: "GUARD_BYPASS_BUG",
            outcome: "guard-bypass",
            migrationResult: null,
          }),
        };

        const autoApprover = (async () => {
          const deadline = Date.now() + 15_000;
          while (Date.now() < deadline) {
            const row = db.prepare(
              `SELECT gate_id FROM gate_queue
               WHERE task_id = ? AND answered_at IS NULL
               ORDER BY created_at ASC LIMIT 1`,
            ).get(taskId) as { gate_id: string } | undefined;
            if (row) {
              const r = svc.answerGate(row.gate_id, "approve");
              if (r.ok) {
                const dispatcher = taskRegistry.get(r.taskId);
                dispatcher?.send({
                  type: "GATE_ANSWERED",
                  gateId: r.gateId,
                  stageName: r.stageName,
                  answer: r.answer,
                  targetStage: r.targetStage,
                });
              }
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        })();

        const result = await runPipeline(
          {
            db,
            ir: modifier.ir,
            taskId,
            versionHash: modRes.versionHash,
            handlers,
            executor: buildModifierTestExecutor(handlers),
            seedValues: {
              targetPipelineName: "smoke-test",
              modificationGoal: "Bug 8b regression",
              failureContext: null,
            },
          },
          15_000,
        );
        await autoApprover;

        // Invariant 1: run resolved (not timed out) with failed state.
        expect(result.finalState).toBe("failed");

        // Invariant 2: validatePatch is in stageErrors with the guard
        // message. (`stage` field — runner.RunResult shape.)
        const guardError = result.stageErrors.find((e) => e.stage === "validatePatch");
        expect(guardError).toBeDefined();
        expect(guardError!.message).toMatch(/Bug 8b guard:/);

        // Invariant 3: applying never started — no stage_attempts row,
        // no port_values output. Cross-region cancel propagation
        // ensured the applying region transitioned to error final via
        // STAGE_CANCELLED before its invoke could fire.
        const applyingAttempt = db.prepare(
          `SELECT attempt_id FROM stage_attempts
           WHERE task_id = ? AND stage_name = 'applying'`,
        ).get(taskId) as { attempt_id: string } | undefined;
        expect(applyingAttempt).toBeUndefined();

        // Invariant 4: no proposal written.
        const proposalRow = db.prepare(
          `SELECT proposal_id FROM pipeline_proposals
           WHERE actor LIKE 'pipeline-modifier-task-%'`,
        ).get() as { proposal_id: string } | undefined;
        expect(proposalRow).toBeUndefined();
      } finally {
        taskRegistry.__clearForTest();
        db.close();
      }
    },
  );
});
