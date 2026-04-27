// Pipeline-modifier e2e — self-modification rejection (T13).
//
// Per prompts/system/load-current.md §"Step 1 — Self-modification check":
// when targetPipelineName === "pipeline-modifier" the loadCurrent stage
// MUST emit failureBundle = { diagnostic: { code: "MODIFIER_SELF_MODIFY_REJECTED",
// message: "pipeline-modifier cannot modify itself" } } and zero values
// on the three other ports, then stop. Downstream stages (analyzeGap)
// detect this sentinel and emit a "Cannot proceed" outline. The user-side
// gate rejects this outline.
//
// Termination strategy:
//   - The IR's gate routes "reject" → analyzeGap, so a single reject
//     rolls back to analyzeGap rather than ending the run. analyzeGap is
//     deterministic (always emits the same sentinel), so the loop is
//     unbounded in production. To keep the test bounded, we Promise.race
//     runPipeline against a "saw N rejects" signal: once two reject
//     cycles have completed (loadCurrent → analyzeGap → gate → reject →
//     analyzeGap → gate → reject), we resolve the race, cancel the task,
//     and run assertions against the DB. The pipeline never reaches
//     genPatch / applying — the gate's "reject" route never points there
//     and the user never approves.
//
// Asserts:
//   - At least 2 rejects answered (proves the rejection contract is
//     wired through more than once — not just a one-off).
//   - finalState !== "completed" / never reached completion.
//   - No pipeline_proposals row created.
//   - No new pipeline_versions row beyond pipeline-modifier itself.
//   - No hot_update_events row.
//   - loadCurrent emitted failureBundle with the expected diagnostic
//     code, surfaced via port_values lineage.
//   - genPatch and applying handlers were never called (they throw if
//     invoked, which would surface as stageErrors in the run).
//
// Mocked: stage handlers (no real Claude). Real: KernelService.submit,
// KernelService.answerGate, KernelService.cancelTask, gate rollback,
// port_values lineage.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../../kernel-next/ir/sql.js";
import { KernelService } from "../../kernel-next/mcp/kernel.js";
import { loadBuiltinPipelineIR } from "../../kernel-next/runtime/load-builtin-pipeline.js";
import { runPipeline } from "../../kernel-next/runtime/runner.js";
import { taskRegistry } from "../../kernel-next/runtime/task-registry.js";
import type { StageHandlerMap } from "../../kernel-next/runtime/mock-executor.js";

describe("pipeline-modifier e2e self-modify rejected", () => {
  it(
    "targetPipelineName=pipeline-modifier -> diagnostic + reject; never reaches genPatch/applying",
    { timeout: 20_000 },
    async () => {
      taskRegistry.__clearForTest();

      const db = new DatabaseSync(":memory:");
      initKernelNextSchema(db);
      try {
        const svc = new KernelService(db, { skipTypeCheck: true });

        // Only the modifier itself is needed — the rejection happens
        // before any target lookup, so no other pipeline must be seeded.
        const modifier = loadBuiltinPipelineIR("pipeline-modifier");
        const modRes = await svc.submit(modifier.ir, { prompts: modifier.prompts });
        if (!modRes.ok) {
          throw new Error(
            `pipeline-modifier submit failed: ${JSON.stringify(modRes.diagnostics)}`,
          );
        }

        const taskId = "t-self-modify-1";

        // Snapshot pipeline_versions BEFORE the run so we can assert no
        // additional rows are added. After modifier submit the table has
        // exactly one row (pipeline-modifier).
        const versionsBefore = db
          .prepare(`SELECT version_hash FROM pipeline_versions`)
          .all() as Array<{ version_hash: string }>;
        expect(versionsBefore).toHaveLength(1);
        expect(versionsBefore[0]!.version_hash).toBe(modRes.versionHash);

        const handlers: StageHandlerMap = {
          // Mirrors load-current.md §Step 1: self-modification check.
          // Diagnostic on failureBundle, zero values on the three pipeline
          // ports.
          loadCurrent: () => ({
            currentVersionHash: "",
            currentIr: null,
            currentPromptsMap: {},
            failureBundle: {
              diagnostic: {
                code: "MODIFIER_SELF_MODIFY_REJECTED",
                message: "pipeline-modifier cannot modify itself",
              },
            },
          }),
          // analyzeGap detects the diagnostic and emits the sentinel
          // outline. In production the prompt instructs analyzeGap to
          // surface "Cannot proceed" so the user rejects at the gate.
          // Deterministic: emits the same outline on every invocation
          // (including post-rollback re-runs).
          analyzeGap: () => ({
            gapAnalysis: {
              currentShapeSummary: "",
              intendedChanges: [],
              affectedStages: [],
              risks: ["self-modification rejected upstream"],
            },
            proposedChangeOutline:
              "Cannot proceed: pipeline-modifier cannot modify itself.",
            expectedSafeRange: "unknown",
          }),
          // genPatch and applying must never run. propose() must never
          // be invoked. If the rejection contract works, neither handler
          // is called and these throws stay dormant.
          genPatch: () => {
            throw new Error("genPatch should not be reached for self-modify");
          },
          applying: () => {
            throw new Error("applying should not be reached for self-modify");
          },
        };

        // Reject poller. Each cycle: see new gate row, answer reject,
        // dispatch GATE_REJECTED so the runner rolls back to analyzeGap.
        // After REQUIRED_REJECTS rejections have been answered, we
        // resolve the gate done signal so the test can proceed past
        // runPipeline (which would otherwise hang on the next gate
        // because gate budget is paused per BUG-2 in runner.ts §494).
        const REQUIRED_REJECTS = 2;
        let rejectsAnswered = 0;
        let resolveRejectsDone: (() => void) = () => undefined;
        const rejectsDone = new Promise<void>((resolve) => {
          resolveRejectsDone = resolve;
        });

        const rejectPoller = (async () => {
          const seen = new Set<string>();
          const deadline = Date.now() + 18_000;
          while (Date.now() < deadline) {
            const row = db
              .prepare(
                `SELECT gate_id FROM gate_queue
                 WHERE task_id = ? AND answered_at IS NULL
                 ORDER BY created_at ASC LIMIT 1`,
              )
              .get(taskId) as { gate_id: string } | undefined;
            if (row && !seen.has(row.gate_id)) {
              seen.add(row.gate_id);
              const r = svc.answerGate(
                row.gate_id,
                "reject",
                "self-modify rejected; aborting",
              );
              if (r.ok) {
                rejectsAnswered++;
                const dispatcher = taskRegistry.get(r.taskId);
                if (r.kind === "rejected") {
                  // Reject targets an upstream stage → the runner expects
                  // GATE_REJECTED so its rejectHandler can fire and
                  // resolve the attempt with verdict='rollback' for the
                  // rebuild path. GATE_ANSWERED would be silently
                  // swallowed.
                  dispatcher?.send({
                    type: "GATE_REJECTED",
                    gateId: r.gateId,
                    stageName: r.stageName,
                    answer: r.answer,
                    targetStage: r.targetStage,
                    affectedStages: r.affectedStages,
                  });
                } else {
                  dispatcher?.send({
                    type: "GATE_ANSWERED",
                    gateId: r.gateId,
                    stageName: r.stageName,
                    answer: r.answer,
                    targetStage: r.targetStage,
                  });
                }
                if (rejectsAnswered >= REQUIRED_REJECTS) {
                  resolveRejectsDone();
                  return;
                }
              }
            }
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
        })();

        // Race runPipeline against the rejects-done signal. The rejection
        // loop is unbounded by design (loops back to analyzeGap forever),
        // so we cap it at REQUIRED_REJECTS, then call cancelTask to
        // terminate the run cleanly. cancelTask writes task_finals
        // ('cancelled') first via INSERT OR IGNORE, then sends INTERRUPT
        // to the dispatcher. The runPipeline promise may still hang on
        // the gate-paused budget, so we Promise.race to reach assertions.
        const runPromise = runPipeline(
          {
            db,
            ir: modifier.ir,
            taskId,
            versionHash: modRes.versionHash,
            handlers,
            seedValues: {
              targetPipelineName: "pipeline-modifier",
              modificationGoal: "Add a stage",
              failureContext: null,
            },
          },
          18_000,
        ).catch((err) => {
          // Surface the runner error if it threw, but never let it
          // propagate before assertions run — the test's source of
          // truth is DB state, not the runner return value.
          return { _runError: err as Error };
        });

        await rejectsDone;
        // Best-effort cancel: writes task_finals='cancelled' before
        // dispatching INTERRUPT. Even if INTERRUPT can't unblock the
        // gate (the gate stage has no executing-invoke to abort), the
        // sticky 'cancelled' row is the authoritative termination marker
        // for assertions.
        svc.cancelTask({
          taskId,
          reason: "self-modify test termination",
          actor: "test",
        });
        await rejectPoller;

        // Assertion 1: at least REQUIRED_REJECTS rejects answered (proves
        // the rejection contract is wired through more than one rollback
        // cycle, not just a one-off).
        expect(rejectsAnswered).toBeGreaterThanOrEqual(REQUIRED_REJECTS);

        // Assertion 2: task_finals reflects the cancellation. cancelTask
        // wrote 'cancelled' via INSERT OR IGNORE; runner's later upsert
        // (when/if it fires) is gated by `WHERE final_state != 'cancelled'`.
        const finalRow = db
          .prepare(
            `SELECT final_state FROM task_finals WHERE task_id = ?`,
          )
          .get(taskId) as { final_state: string } | undefined;
        expect(finalRow).toBeDefined();
        expect(finalRow!.final_state).toBe("cancelled");

        // Assertion 3: NO proposal row created. propose_pipeline_change
        // is only called by the applying stage; if the rejection
        // contract works, applying never runs.
        const proposalRow = db
          .prepare(
            `SELECT COUNT(*) AS n FROM pipeline_proposals
             WHERE actor LIKE 'pipeline-modifier-task-%'`,
          )
          .get() as { n: number };
        expect(proposalRow.n).toBe(0);

        // Assertion 4: NO new pipeline_versions row beyond the modifier
        // itself. propose() is the only writer of new versions; if it
        // never runs, no new row.
        const versionsAfter = db
          .prepare(`SELECT version_hash FROM pipeline_versions`)
          .all() as Array<{ version_hash: string }>;
        expect(versionsAfter).toHaveLength(1);
        expect(versionsAfter[0]!.version_hash).toBe(modRes.versionHash);

        // Assertion 5: NO hot_update_events row. executeMigration is the
        // only writer; never reached.
        const hotUpdateRow = db
          .prepare(`SELECT COUNT(*) AS n FROM hot_update_events`)
          .get() as { n: number };
        expect(hotUpdateRow.n).toBe(0);

        // Assertion 6: loadCurrent emitted the diagnostic on
        // failureBundle. Read the latest port_values row for that port.
        const failureBundleRow = db
          .prepare(
            `SELECT pv.value_json FROM port_values pv
             JOIN stage_attempts sa ON sa.attempt_id = pv.attempt_id
             WHERE sa.task_id = ?
               AND pv.stage_name = 'loadCurrent'
               AND pv.port_name = 'failureBundle'
               AND pv.direction = 'out'
             ORDER BY pv.written_at DESC LIMIT 1`,
          )
          .get(taskId) as { value_json: string } | undefined;
        expect(failureBundleRow).toBeDefined();
        const failureBundle = JSON.parse(failureBundleRow!.value_json) as {
          diagnostic?: { code?: string; message?: string };
        };
        expect(failureBundle.diagnostic).toBeDefined();
        expect(failureBundle.diagnostic!.code).toBe(
          "MODIFIER_SELF_MODIFY_REJECTED",
        );
        expect(failureBundle.diagnostic!.message).toBe(
          "pipeline-modifier cannot modify itself",
        );

        // Assertion 7: no stage_attempts row exists for genPatch/applying.
        // (If their handlers had been invoked, the throw would have
        // produced an error attempt row.)
        const reachedDownstream = db
          .prepare(
            `SELECT COUNT(*) AS n FROM stage_attempts
             WHERE task_id = ?
               AND stage_name IN ('genPatch', 'applying')`,
          )
          .get(taskId) as { n: number };
        expect(reachedDownstream.n).toBe(0);

        // Drain the run promise so it doesn't outlive the test (it may
        // still throw a timeout error from the runner — that's expected
        // behavior given the gate-paused budget never expires under the
        // unbounded reject loop). We don't assert on its result; the
        // DB-state assertions above are the source of truth. The race
        // bounds the wait so a hung gate doesn't leak into the next test.
        await Promise.race([
          runPromise.catch(() => undefined),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 500)),
        ]);
      } finally {
        taskRegistry.__clearForTest();
        db.close();
      }
    },
  );
});
