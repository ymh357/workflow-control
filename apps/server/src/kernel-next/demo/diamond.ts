// End-to-end demo for kernel-next spike.
//
// Single script that exercises all 6 MCP tools against an in-memory SQLite
// DB with a synthesized diamond pipeline (A -> {B, C in parallel} -> D).
// Produces human-readable log output so that the spike result is visible
// without reading test reporter output.
//
// Run with: tsx src/kernel-next/demo/diamond.ts
//
// Acceptance coverage: every step below maps to a numbered item in
// docs/kernel-next-design.md §8.2.

import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelService } from "../mcp/kernel.js";
import { queryLineage, diffRuns } from "../mcp/lineage.js";
import { runPipeline } from "../runtime/runner.js";
import { PortRuntime } from "../runtime/port-runtime.js";
import { generatePipeline, diamondIR } from "../generator-mock/mini-generator.js";
import { pipelineVersionHash } from "../ir/canonical.js";
import type { StageHandlerMap } from "../runtime/mock-executor.js";
import type { IRPatch } from "../ir/schema.js";

interface StepResult {
  step: string;
  ok: boolean;
  detail: string;
}

const results: StepResult[] = [];

function log(result: StepResult): void {
  results.push(result);
  const mark = result.ok ? "✓" : "✗";
  // eslint-disable-next-line no-console
  console.log(`${mark} [${result.step}] ${result.detail}`);
}

function handlers(): StageHandlerMap {
  return {
    A: () => ({ x: 10 }),
    B: (i) => ({ y: `B-got-${i.x as number}` }),
    C: (i) => ({ z: `C-got-${i.x as number}` }),
    D: (i) => ({ final: `${i.b as string}+${i.c as string}` }),
  };
}

export async function runDemo(options: { skipTypeCheck?: boolean; tscPath?: string } = {}): Promise<{
  ok: boolean;
  steps: StepResult[];
}> {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  const kernel = new KernelService(db, {
    skipTypeCheck: options.skipTypeCheck,
    tscPath: options.tscPath,
  });

  try {
    // Step 1 (§8.2 #1): mini generator produces IR, submit_pipeline accepts.
    const gen = generatePipeline({ task: "diamond fan-out/fan-in" });
    // AgentStage prompts must accompany the IR since prompts-in-SQLite
    // landed — the demo's content is dummy since it doesn't exercise the
    // resolver path.
    const demoPrompts: Record<string, string> = {};
    for (const s of gen.ir.stages) {
      if (s.type === "agent" && s.config.promptRef) demoPrompts[s.config.promptRef] = "dummy";
    }
    const submit = kernel.submit(gen.ir, { prompts: demoPrompts });
    log({
      step: "1. submit_pipeline",
      ok:
        submit.ok &&
        submit.versionHash ===
          pipelineVersionHash({ ir: gen.ir, prompts: demoPrompts }),
      detail: submit.ok
        ? `versionHash=${submit.versionHash.slice(0, 12)}...`
        : `FAILED: ${submit.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; ")}`,
    });
    if (!submit.ok) return { ok: false, steps: results };

    // Step 2 (§8.2 #2): submitted pipeline has persisted .ts source that tsc
    //   would accept. (skipTypeCheck=false path already exercises tsc in the
    //   submit call above. Verify we got a non-empty ts_source row.)
    const tsRow = db.prepare(
      `SELECT LENGTH(ts_source) AS len FROM pipeline_versions WHERE version_hash = ?`,
    ).get(submit.versionHash) as { len: number };
    log({
      step: "2. tsc codegen",
      ok: tsRow.len > 100,
      detail: `ts_source ${tsRow.len} bytes persisted`,
    });

    // Step 3 (§8.2 #3): Execution — diamond runs, A before B/C before D.
    const run = await runPipeline({
      db, ir: gen.ir, taskId: "demo-t1", versionHash: submit.versionHash,
      handlers: handlers(),
    });
    const idx = (s: string) => run.log.indexOf(`${s}:executing`);
    const orderOk =
      idx("A") < idx("B") &&
      idx("A") < idx("C") &&
      idx("B") < idx("D") &&
      idx("C") < idx("D");
    log({
      step: "3. run diamond",
      ok: run.finalState === "completed" && orderOk,
      detail: `state=${run.finalState} order=${["A","B","C","D"].map((s)=>`${s}@${idx(s)}`).join(" ")} final=${run.portValues["D.final"]}`,
    });

    // Step 4 (§8.2 #4): query_lineage returns exactly B/C as downstream of A.x.
    // We pass wiredInputs derived from the IR so the result is precise
    // (without it, the query is an upper-bound over all reads in the task).
    // Bridge: Task 1.2 introduced WireSource; diamond demo never uses
    // external sources so the narrowed filter matches legacy behaviour.
    const wiredFromAx = gen.ir.wires
      .filter((w) => w.from.source !== "external" && w.from.stage === "A" && w.from.port === "x")
      .map((w) => ({ stage: w.to.stage, port: w.to.port }));
    const lineage = queryLineage(db, {
      stage: "A", port: "x", taskId: "demo-t1", wiredInputs: wiredFromAx,
    });
    const downstreamStages = new Set(lineage.downstream.map((d) => d.stageName));
    const onlyBC = downstreamStages.size === 2 && downstreamStages.has("B") && downstreamStages.has("C");
    log({
      step: "4. query_lineage",
      ok: onlyBC,
      detail: `latestWrite=${lineage.latestWrite?.valuePreview} downstream=${[...downstreamStages].sort().join(",")}`,
    });

    // Step 5 (§8.2 #5): propose_pipeline_change — add a new output port on B
    // plus a wire routing it to a new stage E. Proposal accepted + pending.
    const patch: IRPatch = {
      ops: [
        {
          op: "add_stage",
          stage: {
            name: "E",
            type: "agent",
            inputs: [{ name: "summary", type: "string" }],
            outputs: [],
            config: { promptRef: "consume the summary" },
          },
        },
        {
          op: "add_wire",
          wire: { from: { stage: "B", port: "y" }, to: { stage: "E", port: "summary" } },
        },
      ],
    };
    const propose = kernel.propose({
      currentVersion: submit.versionHash,
      patch,
      actor: "ai:pipeline-generator",
    });
    const proposalRow = propose.ok
      ? db.prepare(`SELECT status FROM pipeline_proposals WHERE proposal_id = ?`)
          .get(propose.proposalId) as { status: string } | undefined
      : undefined;
    log({
      step: "5. propose_pipeline_change (valid)",
      ok: propose.ok && propose.autoApplied === false && proposalRow?.status === "pending",
      detail: propose.ok
        ? `proposedVersion=${propose.proposedVersion.slice(0, 12)}... status=${proposalRow?.status}`
        : "FAILED",
    });

    // Step 6 (§8.2 #6): reject test — patch with incompatible wire type.
    const badPatch: IRPatch = {
      ops: [
        {
          op: "update_port_type",
          stage: "A",
          port: "x",
          direction: "out",
          newType: "string",   // now wire A.x(string) -> B.x(number) mismatches
        },
      ],
    };
    const rejected = kernel.propose({
      currentVersion: submit.versionHash,
      patch: badPatch,
      actor: "ai:pipeline-generator",
    });
    const wireMismatch = !rejected.ok &&
      rejected.diagnostics.some((d) => d.code === "WIRE_TYPE_MISMATCH");
    log({
      step: "6. propose_pipeline_change (reject)",
      ok: wireMismatch,
      detail: wireMismatch
        ? `tsc rejected with WIRE_TYPE_MISMATCH on A.x->B.x`
        : options.skipTypeCheck
          ? "SKIPPED tsc path"
          : `expected WIRE_TYPE_MISMATCH, got ${rejected.ok ? "ok" : rejected.diagnostics.map((d)=>d.code).join(",")}`,
    });

    // Step 7 (§8.2 #7): retry / multi-attempt — exercise attempt_idx column
    // directly via PortRuntime (mimics "stage B failed and retried").
    const portRuntime = new PortRuntime(db, { send: () => {} });
    const a1 = portRuntime.startAttempt({
      taskId: "retry-task", versionHash: submit.versionHash, stageName: "B",
    });
    portRuntime.finishAttempt(a1.attemptId, "error", "simulated failure");
    const a2 = portRuntime.startAttempt({
      taskId: "retry-task", versionHash: submit.versionHash, stageName: "B",
    });
    portRuntime.writePort({ attemptId: a2.attemptId, stageName: "B", portName: "y", value: "retried-output" });
    portRuntime.finishAttempt(a2.attemptId, "success");
    const attemptRows = db.prepare(
      `SELECT attempt_idx, status FROM stage_attempts WHERE task_id = ? ORDER BY attempt_idx`,
    ).all("retry-task") as Array<{ attempt_idx: number; status: string }>;
    const retryOk =
      attemptRows.length === 2 &&
      attemptRows[0]!.attempt_idx === 1 && attemptRows[0]!.status === "error" &&
      attemptRows[1]!.attempt_idx === 2 && attemptRows[1]!.status === "success";
    log({
      step: "7. retry / multi-attempt",
      ok: retryOk,
      detail: `attempts=[${attemptRows.map((r) => `#${r.attempt_idx}=${r.status}`).join(", ")}]`,
    });

    // Bonus: diff_runs between demo-t1 and retry-task (which ran only B).
    const diff = diffRuns(db, "demo-t1", "retry-task");
    log({
      step: "8. diff_runs (bonus)",
      ok: diff.stageComparison.length > 0,
      detail: `compared ${diff.stageComparison.length} stages`,
    });

    return { ok: results.every((r) => r.ok), steps: results };
  } finally {
    db.close();
  }
}

// Run standalone (pnpm tsx ...) if imported as a CLI.
if (import.meta.url === `file://${process.argv[1]}`) {
  void runAsCli();
}

async function runAsCli(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("--- kernel-next diamond demo ---");

  // ESM-friendly tsc lookup: walk up from this file to find node_modules/.bin/tsc.
  const { existsSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  let tscPath: string | undefined;
  let dir = here;
  for (let i = 0; i < 10; i++) {
    const cand = join(dir, "node_modules", ".bin", "tsc");
    if (existsSync(cand)) { tscPath = cand; break; }
    dir = dirname(dir);
  }

  try {
    const r = await runDemo({ tscPath });
    // eslint-disable-next-line no-console
    console.log("---");
    // eslint-disable-next-line no-console
    console.log(r.ok ? "ALL PASSED" : "FAILED");
    process.exit(r.ok ? 0 : 1);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("demo failed:", err);
    process.exit(1);
  }
}

// Keep diamondIR re-export so other callers (tests) can use it without
// reaching into generator-mock.
export { diamondIR };
