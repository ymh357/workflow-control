// Pipeline-modifier e2e structural-patch counterpart to e2e.happy-path.
//
// Same harness as e2e.happy-path.test.ts, but the genPatch handler
// emits a STRUCTURAL patch (update_port_type on echoBack.note input).
// classifyStageCategory returns "structural" because changes.inputs is
// populated, classifySafeRange yields verdict="unsafe", and propose()
// ignores autoApprove for non-safe verdicts:
//
//   autoApplied = (autoApprove ?? false) && safeRange.verdict === "safe"
//
// → autoApplied=false → proposalStatus="pending" → applying.outcome
// surfaces "pending-approval".
//
// Mocked: stage handlers (no real Claude). Real: KernelService.submit,
// KernelService.propose, KernelService.answerGate, dry-run, gate
// resume, port_values lineage.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../../kernel-next/ir/sql.js";
import { KernelService } from "../../kernel-next/mcp/kernel.js";
import { loadBuiltinPipelineIR } from "../../kernel-next/runtime/load-builtin-pipeline.js";
import { runPipeline } from "../../kernel-next/runtime/runner.js";
import { buildModifierTestExecutor } from "./test-utils.js";
import { taskRegistry } from "../../kernel-next/runtime/task-registry.js";
import type { StageHandlerMap } from "../../kernel-next/runtime/mock-executor.js";
import type { IRPatch } from "../../kernel-next/ir/schema.js";

describe("pipeline-modifier e2e structural patch", () => {
  it(
    "structural patch -> autoApprove ignored -> outcome=pending-approval",
    { timeout: 20_000 },
    async () => {
      const db = new DatabaseSync(":memory:");
      initKernelNextSchema(db);
      try {
        const svc = new KernelService(db, { skipTypeCheck: true });

        // Submit modification target + engine.
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

        const taskId = "t-modifier-structural-1";

        // update_port_type on echoBack.note (input) — string -> string | null.
        // Diff classifier: changes.inputs.typeChanged populated → not
        // promptRef-only → category="structural". Input ports are NOT
        // tracked in store_schema (only outputs are), so the type bump
        // doesn't trip STORE_SCHEMA_TYPE_MISMATCH. tsc is skipped via
        // skipTypeCheck=true so the wire-source/target mismatch (greet.note
        // is still string) is tolerated.
        const targetAgentStage = smoke.ir.stages.find(
          (s) => s.name === "echoBack" && s.type === "agent",
        );
        if (!targetAgentStage || targetAgentStage.type !== "agent") {
          throw new Error("smoke-test has no echoBack agent stage");
        }

        const patch: IRPatch = {
          ops: [
            {
              op: "update_port_type",
              stage: "echoBack",
              port: "note",
              direction: "in",
              newType: "string | null",
            },
          ],
        };

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
              intendedChanges: ["widen echoBack.note input type to string | null"],
              affectedStages: ["echoBack"],
              risks: ["downstream consumers must handle null"],
            },
            proposedChangeOutline: "Widen echoBack.note input type",
            expectedSafeRange: "unsafe",
          }),
          genPatch: () => ({
            patch,
            rerunFrom: "",
            migrateRunningTasks: "none",
            prompts: {},
            dryRunVerdict: "structural",
          }),
          applying: (inputs) => {
            const inPatch = inputs.patch as IRPatch;
            const inPromptsObj =
              (inputs.prompts as Record<string, string> | null | undefined) ?? {};
            const promptsArg =
              Object.keys(inPromptsObj).length > 0 ? inPromptsObj : undefined;
            // autoApprove=true is intentional — kernel must IGNORE it for
            // structural patches. This mirrors what the real applying-stage
            // agent does via the propose_pipeline_change MCP tool.
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
            executor: buildModifierTestExecutor(handlers),
            seedValues: {
              targetPipelineName: "smoke-test",
              modificationGoal: "Widen echoBack.note input type",
              failureContext: null,
            },
          },
          18_000,
        );
        await autoApprover;

        // Assertion 1: modifier itself completes — modifier's job is to
        // propose, not to force approval.
        expect(result.finalState).toBe("completed");
        expect(result.stageErrors).toEqual([]);

        // Assertion 2: proposal row exists with status='pending' (NOT
        // 'approved' / 'auto_applied'), confirming kernel ignored
        // autoApprove=true for the structural verdict.
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
        expect(proposalRow!.status).toBe("pending");
        expect(proposalRow!.actor).toBe(`pipeline-modifier-task-${taskId}`);

        // Assertion 3: applying.outcome === "pending-approval".
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
        expect(JSON.parse(outcomeRow!.value_json)).toBe("pending-approval");

        // Assertion 4: applying.proposalId is non-empty (proposal was
        // created even though it stayed pending).
        const proposalIdRow = db
          .prepare(
            `SELECT pv.value_json FROM port_values pv
             JOIN stage_attempts sa ON sa.attempt_id = pv.attempt_id
             WHERE sa.task_id = ?
               AND pv.stage_name = 'applying'
               AND pv.port_name = 'proposalId'
               AND pv.direction = 'out'
             ORDER BY pv.written_at DESC LIMIT 1`,
          )
          .get(taskId) as { value_json: string } | undefined;
        expect(proposalIdRow).toBeDefined();
        const proposalIdValue = JSON.parse(proposalIdRow!.value_json) as string;
        expect(typeof proposalIdValue).toBe("string");
        expect(proposalIdValue.length).toBeGreaterThan(0);
        expect(proposalIdValue).toBe(proposalRow!.proposal_id);

        // Assertion 5: a NEW pipeline_versions row IS persisted by
        // propose() (the version write happens before the autoApplied
        // check — see kernel.ts §650-668). Status flips to pending but
        // the proposed IR is still durable for later approval.
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
        expect(newVersionRow!.version_hash).toBe(proposalRow!.proposed_version);

        // Assertion 6: NO hot_update_events row — proposal is still
        // pending, no migration occurred.
        const hotUpdateRow = db
          .prepare(
            `SELECT COUNT(*) AS n FROM hot_update_events
             WHERE proposal_id = ?`,
          )
          .get(proposalRow!.proposal_id) as { n: number };
        expect(hotUpdateRow.n).toBe(0);
      } finally {
        taskRegistry.__clearForTest();
        db.close();
      }
    },
  );
});
