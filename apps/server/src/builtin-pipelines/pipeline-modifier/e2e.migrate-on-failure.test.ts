// Pipeline-modifier e2e — failure-driven dogfood loop (T12).
//
// Same harness shape as e2e.happy-path.test.ts, but exercises the
// failureContext-driven path:
//
//   1. Seed smoke-test pipeline + a FAILED task on it (a single
//      stage_attempts row with status='error').
//   2. Submit pipeline-modifier (the engine).
//   3. runPipeline(modifier) with seedValues.failureContext pointing
//      at the failed task.
//   4. Mocks:
//        loadCurrent → emits failureBundle with taskId + failedStage
//                      + lineagePreview (mirrors the fixed load-current.md
//                      shape).
//        analyzeGap → acknowledges the failure in its risks.
//        genPatch → SAFE update_stage_config rename, with
//                   migrateRunningTasks=[<failed-task-id>] AND
//                   rerunFrom=<failed-stage> so propose() and
//                   executeMigration accept the migration.
//        applying → calls svc.propose(autoApprove:true) on the safe
//                   patch, then drives executeMigration directly with a
//                   stand-in startRunnerOverride to avoid spawning a
//                   real RealStageExecutor for smoke-test (mirrors
//                   apps/server/src/kernel-next/hot-update/end-to-end.test.ts).
//                   Builds migrationResult = { migratedTaskIds, errors }.
//
// Asserts:
//   - finalState === "completed"
//   - pipeline_proposals row by actor LIKE 'pipeline-modifier-task-%' is
//     'approved' (autoApprove on safe patch)
//   - applying.outcome === "auto-applied"
//   - applying.migrationResult.migratedTaskIds === [failedTaskId]
//     and migrationResult.errors === []
//   - hot_update_events row exists for task_id=failedTaskId,
//     status='success', actor LIKE 'pipeline-modifier-task-%'.
//
// Mocked: stage handlers + startRunner. Real: KernelService.submit,
// KernelService.propose, KernelService.answerGate, dry-run, gate
// resume, port_values lineage, executeMigration (orchestrator).

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { initKernelNextSchema } from "../../kernel-next/ir/sql.js";
import { KernelService } from "../../kernel-next/mcp/kernel.js";
import { loadBuiltinPipelineIR } from "../../kernel-next/runtime/load-builtin-pipeline.js";
import { runPipeline } from "../../kernel-next/runtime/runner.js";
import { buildModifierTestExecutor } from "./test-utils.js";
import { taskRegistry } from "../../kernel-next/runtime/task-registry.js";
import {
  executeMigration,
  __resetOrchestratorLocksForTest,
} from "../../kernel-next/hot-update/migration-orchestrator.js";
import type { StageHandlerMap } from "../../kernel-next/runtime/mock-executor.js";
import type { IRPatch } from "../../kernel-next/ir/schema.js";

describe("pipeline-modifier e2e migrate-on-failure", () => {
  it(
    "failureContext drives autoApprove + migrate_task on the failed task",
    { timeout: 20_000 },
    async () => {
      __resetOrchestratorLocksForTest();
      taskRegistry.__clearForTest();

      const db = new DatabaseSync(":memory:");
      initKernelNextSchema(db);
      try {
        const svc = new KernelService(db, { skipTypeCheck: true });

        // 1. Seed smoke-test (modification target) and capture base hash.
        const smoke = loadBuiltinPipelineIR("smoke-test");
        const smokeRes = await svc.submit(smoke.ir, { prompts: smoke.prompts });
        if (!smokeRes.ok) {
          throw new Error(
            `smoke-test submit failed: ${JSON.stringify(smokeRes.diagnostics)}`,
          );
        }

        // 2. Hand-seed a FAILED task on smoke-test. Mirrors the seedAttempt
        //    helper in apps/server/src/kernel-next/hot-update/end-to-end.test.ts
        //    — single stage_attempts row, status='error', kind='regular'.
        //    The failed stage is the first agent stage (echoBack), which is
        //    also the rerunFrom target so executeMigration's supersede set
        //    covers it.
        const targetAgentStage = smoke.ir.stages.find((s) => s.type === "agent");
        if (!targetAgentStage || targetAgentStage.type !== "agent") {
          throw new Error("smoke-test has no agent stage to rename");
        }
        const failedTaskId = "t-modifier-failed-1";
        const failedStageName = targetAgentStage.name;
        const failedAttemptId = randomUUID();
        db.prepare(
          `INSERT INTO stage_attempts
           (attempt_id, task_id, version_hash, stage_name, attempt_idx, status,
            started_at, kind)
           VALUES (?, ?, ?, ?, ?, 'error', ?, 'regular')`,
        ).run(
          failedAttemptId,
          failedTaskId,
          smokeRes.versionHash,
          failedStageName,
          0,
          Date.now(),
        );

        // 3. Submit the modifier engine.
        const modifier = loadBuiltinPipelineIR("pipeline-modifier");
        const modRes = await svc.submit(modifier.ir, { prompts: modifier.prompts });
        if (!modRes.ok) {
          throw new Error(
            `pipeline-modifier submit failed: ${JSON.stringify(modRes.diagnostics)}`,
          );
        }

        const modifierTaskId = "t-modifier-on-failure-1";

        // Patch: same safe rename shape used in T10 happy path. Classified
        // as promptOnly → safeRange="safe" → autoApprove honoured.
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

        const errorMessage =
          `stage '${failedStageName}' threw during agent turn (seeded)`;

        const handlers: StageHandlerMap = {
          loadCurrent: () => ({
            currentVersionHash: smokeRes.versionHash,
            currentIr: smoke.ir,
            currentPromptsMap: smoke.prompts,
            // Bundle includes taskId per the load-current.md fix.
            failureBundle: {
              taskId: failedTaskId,
              failedStage: failedStageName,
              errorMessage,
              lineagePreview: [],
            },
          }),
          analyzeGap: () => ({
            gapAnalysis: {
              currentShapeSummary: "smoke-test 2-stage agent pipeline",
              intendedChanges: [
                `rename ${targetAgentStage.name}.promptRef to address failure`,
              ],
              affectedStages: [targetAgentStage.name],
              risks: [
                `previous run failed at ${failedStageName}: ${errorMessage}`,
              ],
            },
            proposedChangeOutline:
              `Fix the failure by renaming ${targetAgentStage.name}.promptRef to ${newRef}`,
            expectedSafeRange: "safe",
          }),
          genPatch: () => ({
            patch,
            rerunFrom: failedStageName,
            migrateRunningTasks: [failedTaskId],
            prompts: {},
            dryRunVerdict: "safe",
          }),
          applying: async (inputs) => {
            const inPatch = inputs.patch as IRPatch;
            const inPromptsObj =
              (inputs.prompts as Record<string, string> | null | undefined) ?? {};
            const promptsArg =
              Object.keys(inPromptsObj).length > 0 ? inPromptsObj : undefined;
            const inRerunFrom = (inputs.rerunFrom as string) || undefined;
            const inMigrate = inputs.migrateRunningTasks as
              | string[]
              | "all"
              | "none";

            // Step 1: propose with autoApprove. Safe verdict → status flips
            // to 'approved' + proposed version is written. This mirrors the
            // real applying-stage agent's propose_pipeline_change call.
            const proposeRes = svc.propose({
              currentVersion: inputs.currentVersionHash as string,
              patch: inPatch,
              prompts: promptsArg,
              actor: `pipeline-modifier-task-${modifierTaskId}`,
              autoApprove: true,
              rerunFrom: inRerunFrom,
              migrateRunningTasks: inMigrate,
            });
            if (!proposeRes.ok) {
              return {
                proposalId: "",
                proposedVersion: "",
                outcome: "failed",
                migrationResult: {
                  migratedTaskIds: [],
                  errors: proposeRes.diagnostics.map((d) => ({
                    taskId: failedTaskId,
                    code: d.code,
                    message: d.message,
                  })),
                },
              };
            }

            // Step 2: drive migration on the failed task. Use
            // executeMigration directly with a stand-in startRunner so
            // smoke-test's RealStageExecutor never spawns. This is the
            // in-process equivalent of svc.migrateTask — same orchestrator,
            // same audit-row writes, same supersede semantics; only the
            // resume-runner is mocked. Mirrors the pattern in
            // apps/server/src/kernel-next/hot-update/end-to-end.test.ts.
            const startRunner = vi.fn(async () => ({
              ok: true as const,
              taskId: failedTaskId,
              versionHash: proposeRes.proposedVersion,
            }));
            const migratedTaskIds: string[] = [];
            const errors: Array<{
              taskId: string;
              code: string;
              message: string;
            }> = [];
            if (proposeRes.autoApplied) {
              const mig = await executeMigration({
                db,
                taskId: failedTaskId,
                proposalId: proposeRes.proposalId,
                startRunnerOverride: startRunner as never,
              });
              if (mig.ok) {
                migratedTaskIds.push(failedTaskId);
              } else {
                errors.push({
                  taskId: failedTaskId,
                  code: mig.code,
                  message: mig.message,
                });
              }
            }

            return {
              proposalId: proposeRes.proposalId,
              proposedVersion: proposeRes.proposedVersion,
              outcome: proposeRes.autoApplied ? "auto-applied" : "pending-approval",
              migrationResult: { migratedTaskIds, errors },
            };
          },
        };

        // AutoApprover poller — same as T10. Resolves the awaitingConfirm
        // gate so the engine reaches the applying stage.
        const autoApprover = (async () => {
          const deadline = Date.now() + 15_000;
          while (Date.now() < deadline) {
            const row = db
              .prepare(
                `SELECT gate_id FROM gate_queue
                 WHERE task_id = ? AND answered_at IS NULL
                 ORDER BY created_at ASC LIMIT 1`,
              )
              .get(modifierTaskId) as { gate_id: string } | undefined;
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
            taskId: modifierTaskId,
            versionHash: modRes.versionHash,
            handlers,
            executor: buildModifierTestExecutor(handlers),
            seedValues: {
              targetPipelineName: "smoke-test",
              modificationGoal: "Fix the failure",
              failureContext: {
                taskId: failedTaskId,
                failedStageName,
                errorMessage,
              },
            },
          },
          18_000,
        );
        await autoApprover;

        // Assertion 1: modifier completed cleanly.
        expect(result.finalState).toBe("completed");
        expect(result.stageErrors).toEqual([]);

        // Assertion 2: proposal row exists with actor pinned to this
        // modifier task and status approved.
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
        expect(["approved", "auto_applied"]).toContain(proposalRow!.status);
        expect(proposalRow!.actor).toBe(`pipeline-modifier-task-${modifierTaskId}`);

        // Assertion 3: applying.outcome === "auto-applied".
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
          .get(modifierTaskId) as { value_json: string } | undefined;
        expect(outcomeRow).toBeDefined();
        expect(JSON.parse(outcomeRow!.value_json)).toBe("auto-applied");

        // Assertion 4: migrationResult populated with the failed task id
        // and no errors.
        const migrationRow = db
          .prepare(
            `SELECT pv.value_json FROM port_values pv
             JOIN stage_attempts sa ON sa.attempt_id = pv.attempt_id
             WHERE sa.task_id = ?
               AND pv.stage_name = 'applying'
               AND pv.port_name = 'migrationResult'
               AND pv.direction = 'out'
             ORDER BY pv.written_at DESC LIMIT 1`,
          )
          .get(modifierTaskId) as { value_json: string } | undefined;
        expect(migrationRow).toBeDefined();
        const migrationResult = JSON.parse(migrationRow!.value_json) as {
          migratedTaskIds: string[];
          errors: Array<{ taskId: string; code: string; message: string }>;
        };
        expect(migrationResult.migratedTaskIds).toEqual([failedTaskId]);
        expect(migrationResult.errors).toEqual([]);

        // Assertion 5: hot_update_events audit row for the failed task,
        // status=success, with actor inherited from the proposal.
        const hotUpdateRow = db
          .prepare(
            `SELECT task_id, status, actor, proposal_id
             FROM hot_update_events
             WHERE task_id = ? AND proposal_id = ?`,
          )
          .get(failedTaskId, proposalRow!.proposal_id) as
          | {
              task_id: string;
              status: string;
              actor: string;
              proposal_id: string;
            }
          | undefined;
        expect(hotUpdateRow).toBeDefined();
        expect(hotUpdateRow!.status).toBe("success");
        expect(hotUpdateRow!.actor).toBe(`pipeline-modifier-task-${modifierTaskId}`);
      } finally {
        taskRegistry.__clearForTest();
        __resetOrchestratorLocksForTest();
        db.close();
      }
    },
  );
});
