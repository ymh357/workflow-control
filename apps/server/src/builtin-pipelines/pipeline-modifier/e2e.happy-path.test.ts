// Pipeline-modifier e2e happy path.
//
// End-to-end exercise of the pipeline-modifier flow with mocked agent
// handlers:
//   1. submit() smoke-test (acts as the modification target)
//   2. submit() pipeline-modifier (the engine being exercised)
//   3. runPipeline(modifier) with seedValues pointing at smoke-test
//   4. mocked stages produce a non-structural patch (rename promptRef on
//      one agent stage of smoke-test) -> dry-run classifies as "safe"
//   5. autoApprover poller approves the awaitingConfirm gate
//   6. applying handler invokes svc.propose(...) directly with
//      autoApprove: true (this mirrors what the real applying-stage
//      agent does via the propose_pipeline_change MCP tool)
//   7. assert: a NEW pipeline_versions row exists for smoke-test with
//      parent_hash = base hash, the proposal is recorded with status
//      'approved', and applying.outcome === "auto-applied".
//
// Mocked: stage handlers (no real Claude). Real: KernelService.submit,
// KernelService.propose, KernelService.answerGate, dry-run, gate
// resume, port_values lineage. This is the test that covers the wire
// fix in 5cb975e (analyzeGap.proposedChangeOutline -> awaitingConfirm
// __gate_signal) end-to-end.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../../kernel-next/ir/sql.js";
import { KernelService } from "../../kernel-next/mcp/kernel.js";
import { loadBuiltinPipelineIR } from "../../kernel-next/runtime/load-builtin-pipeline.js";
import { runPipeline } from "../../kernel-next/runtime/runner.js";
import { taskRegistry } from "../../kernel-next/runtime/task-registry.js";
import type { StageHandlerMap } from "../../kernel-next/runtime/mock-executor.js";
import type { IRPatch } from "../../kernel-next/ir/schema.js";

describe("pipeline-modifier e2e happy path", () => {
  it(
    "non-structural patch -> autoApprove -> outcome=auto-applied",
    { timeout: 20_000 },
    async () => {
      const db = new DatabaseSync(":memory:");
      initKernelNextSchema(db);
      try {
        const svc = new KernelService(db, { skipTypeCheck: true });

        // Submit the modification target (smoke-test) and the engine
        // (pipeline-modifier) so both versions resolve in pipeline_versions.
        const smoke = loadBuiltinPipelineIR("smoke-test");
        const smokeRes = await svc.submit(smoke.ir, { prompts: smoke.prompts });
        if (!smokeRes.ok) {
          throw new Error(
            `smoke-test submit failed: ${JSON.stringify(smokeRes.diagnostics)}`,
          );
        }

        const modifier = loadBuiltinPipelineIR("pipeline-modifier");
        const modRes = await svc.submit(modifier.ir, { prompts: modifier.prompts });
        if (!modRes.ok) {
          throw new Error(
            `pipeline-modifier submit failed: ${JSON.stringify(modRes.diagnostics)}`,
          );
        }

        const taskId = "t-modifier-happy-1";

        // Pick the first agent stage of smoke-test (echoBack) for the
        // promptOnly rename. update_stage_config { promptRef: "<old>-v2" }
        // is classified as "promptOnly" by classifyStageCategory and
        // thus "safe" by classifySafeRange (no schemaDriftIssues, no
        // active tasks). The rename-carry rule in propose() will copy
        // the old prompt body forward to the new ref so the proposed
        // version still resolves.
        const targetAgentStage = smoke.ir.stages.find((s) => s.type === "agent");
        if (!targetAgentStage || targetAgentStage.type !== "agent") {
          throw new Error("smoke-test has no agent stage to rename");
        }
        const oldRef = targetAgentStage.config.promptRef;
        const newRef = `${oldRef}-v2`;

        const patch: IRPatch = {
          ops: [
            {
              op: "update_stage_config",
              stage: targetAgentStage.name,
              configPatch: { promptRef: newRef },
            },
          ],
        };

        // Mocked stage handlers. The gate (awaitingConfirm) has no
        // handler — gates are dispatcher-driven, not handler-driven.
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
              intendedChanges: [`rename ${targetAgentStage.name}.promptRef`],
              affectedStages: [targetAgentStage.name],
              risks: [],
            },
            proposedChangeOutline: `Rename ${targetAgentStage.name}.promptRef to ${newRef}`,
            expectedSafeRange: "safe",
          }),
          genPatch: () => ({
            patch,
            rerunFrom: "",
            migrateRunningTasks: "none",
            prompts: {},
            dryRunVerdict: "safe",
          }),
          applying: (inputs) => {
            // Mirrors the real applying-stage agent which calls the
            // propose_pipeline_change MCP tool. Since the kernel-next
            // MCP layer routes that tool to KernelService.propose,
            // calling svc.propose directly here is faithful.
            const inPatch = inputs.patch as IRPatch;
            const inPromptsObj =
              (inputs.prompts as Record<string, string> | null | undefined) ?? {};
            const promptsArg =
              Object.keys(inPromptsObj).length > 0 ? inPromptsObj : undefined;
            const proposeRes = svc.propose({
              currentVersion: inputs.currentVersionHash as string,
              patch: inPatch,
              prompts: promptsArg,
              actor: `pipeline-modifier-task-${taskId}`,
              autoApprove: true,
            });
            if (!proposeRes.ok) {
              return {
                proposalId: "",
                proposedVersion: "",
                outcome: "failed",
                migrationResult: null,
              };
            }
            return {
              proposalId: proposeRes.proposalId,
              proposedVersion: proposeRes.proposedVersion,
              outcome: proposeRes.autoApplied ? "auto-applied" : "pending-approval",
              migrationResult: null,
            };
          },
        };

        // AutoApprover poller — mirrors gate-resume-downstream.test.ts.
        // Watches gate_queue for the awaitingConfirm gate row, persists
        // an "approve" answer via svc.answerGate, then dispatches
        // GATE_ANSWERED through taskRegistry so the running machine
        // transitions past the gate.
        const autoApprover = (async () => {
          const deadline = Date.now() + 15_000;
          while (Date.now() < deadline) {
            const row = db
              .prepare(
                `SELECT gate_id FROM gate_queue
                 WHERE task_id = ? AND answered_at IS NULL
                 ORDER BY created_at ASC LIMIT 1`,
              )
              .get(taskId) as { gate_id: string } | undefined;
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
            seedValues: {
              targetPipelineName: "smoke-test",
              modificationGoal: `Rename ${targetAgentStage.name} promptRef`,
              failureContext: null,
            },
          },
          18_000,
        );
        await autoApprover;

        expect(result.finalState).toBe("completed");
        expect(result.stageErrors).toEqual([]);

        // Assertion 1: a NEW pipeline_versions row whose parent_hash is
        // the smoke-test base hash. We don't filter by name in SQL
        // because pipeline_versions.name on the new row should still
        // be "smoke-test" — the patch only changed promptRef.
        const newVersionRow = db
          .prepare(
            `SELECT version_hash, pipeline_name, parent_hash FROM pipeline_versions
             WHERE parent_hash = ?`,
          )
          .get(smokeRes.versionHash) as
          | { version_hash: string; pipeline_name: string; parent_hash: string }
          | undefined;
        expect(newVersionRow).toBeDefined();
        expect(newVersionRow!.pipeline_name).toBe("smoke-test");
        expect(newVersionRow!.parent_hash).toBe(smokeRes.versionHash);
        expect(newVersionRow!.version_hash).not.toBe(smokeRes.versionHash);

        // Assertion 2: a proposal row written by the applying stage,
        // with status flipped to 'approved' by the autoApprove path.
        const proposalRow = db
          .prepare(
            `SELECT proposal_id, base_version, proposed_version, actor, status
             FROM pipeline_proposals
             WHERE actor LIKE 'pipeline-modifier-task-%'`,
          )
          .get() as
          | {
              proposal_id: string;
              base_version: string;
              proposed_version: string;
              actor: string;
              status: string;
            }
          | undefined;
        expect(proposalRow).toBeDefined();
        expect(proposalRow!.base_version).toBe(smokeRes.versionHash);
        expect(proposalRow!.proposed_version).toBe(newVersionRow!.version_hash);
        expect(proposalRow!.status).toBe("approved");

        // Assertion 3: applying.outcome === "auto-applied" written to
        // port_values, confirming the applying handler interpreted
        // svc.propose's autoApplied=true as the auto-applied outcome.
        const outcomeRow = db
          .prepare(
            `SELECT pv.value_json FROM port_values pv
             JOIN stage_attempts sa ON sa.attempt_id = pv.attempt_id
             WHERE sa.task_id = ?
               AND pv.stage_name = 'applying'
               AND pv.port_name = 'outcome'
               AND pv.direction = 'out'
             ORDER BY pv.written_at DESC LIMIT 1`,
          )
          .get(taskId) as { value_json: string } | undefined;
        expect(outcomeRow).toBeDefined();
        expect(JSON.parse(outcomeRow!.value_json)).toBe("auto-applied");
      } finally {
        taskRegistry.__clearForTest();
        db.close();
      }
    },
  );
});
