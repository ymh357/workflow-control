// Phase 2 A.3 stress harness — AI-authored pipeline patch.
//
// Seeds a baseline diamond IR via the mock generator (so the baseline
// is deterministic across runs), then asks Haiku to propose a specific
// structural patch: add a second output port `extra: string` on stage
// B, and wire B.extra into a new input `bExtra: string` on stage D.
//
// This exercises IRPatch with THREE ops in one submission:
//   1. update_stage_config to keep B's prompt sane (optional)
//   2. add_stage is NOT needed; we reuse B and D
//   - add a new output port on B (via a compound patch: we can't
//     update existing stage.outputs directly, so this requires either
//     remove_stage + add_stage with new shape, OR use
//     update_port_type on a brand-new port... neither is supported
//     directly. Instead we test: add a new OUTPUT port by way of
//     remove_stage B + add_stage B'. See task description below.
//
// Correction: the IR patch op set supports add/remove stage, wires,
// update_port_type, update_stage_config — but NOT "add_port" to an
// existing stage. So the realistic request we make of Claude is:
//   (a) remove_stage B
//   (b) add_stage B with the same inputs + BOTH outputs (y, extra)
//   (c) add_wire from B.extra to a new port on D — but again D can't
//       grow a port without remove+re-add.
//
// We compress the task to: "remove B, re-add B with an extra output,
// remove D, re-add D with a new input, then add the wires". This is a
// realistic multi-op patch.

import { DatabaseSync } from "node:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initKernelNextSchema, getPipelineIR } from "../ir/sql.js";
import { KernelService } from "../mcp/kernel.js";
import { createKernelMcp } from "../mcp/server.js";
import { diamondIR } from "../generator-mock/mini-generator.js";
import { generatePatch, type GeneratePatchResult } from "./real-generator.js";
import type { PipelineIR } from "../ir/schema.js";

const PATCH_TASK = [
  "Patch the pipeline to add a new data path from B to D.",
  "",
  "Desired end state:",
  "- B keeps its existing output port `y: string` AND gains a second",
  "  output port `extra: string`.",
  "- D keeps its existing inputs `b: string` and `c: string` AND gains",
  "  a new input port `bExtra: string`.",
  "- A new wire connects B.extra -> D.bExtra.",
  "",
  "Because the IRPatch op set cannot add a port to an existing stage",
  "directly, the realistic way to do this is:",
  "  1. remove_stage B",
  "  2. remove_stage D (this will cascade-drop wires; that's fine)",
  "  3. add_stage B with inputs=[x:number], outputs=[y:string, extra:string],",
  "     same config.prompt as before.",
  "  4. add_stage D with inputs=[b:string, c:string, bExtra:string],",
  "     outputs=[final:string], same config.prompt.",
  "  5. Re-add wires dropped by step 2 (A.x->B.x is still there because",
  "     only B was removed in step 1, whose wires to it get cascade-",
  "     dropped — so you need to re-add A.x->B.x. After step 2 all wires",
  "     touching D are also gone, so re-add A.x->C.x is unaffected but",
  "     B.y->D.b and C.z->D.c need re-adding).",
  "  6. Add the new wire B.extra -> D.bExtra.",
  "",
  "Submit a single propose_pipeline_change call containing all these",
  "ops in order. Use actor='ai:real-generator'. You have been given",
  "the base IR in the system prompt.",
].join("\n");

interface PatchReport {
  runs: number;
  model: string;
  baseVersion: string;
  complianceRate: number;
  meanTurns: number;
  meanCostUsd: number;
  meanDurationMs: number;
  totalCostUsd: number;
  salvagedByDiagnosticLoop: number;
  endStateChecks: {
    bHasExtraPort: number;
    dHasBExtraInput: number;
    newWireExists: number;
    allThree: number;
  };
  runResults: Array<StressRunResult>;
}

interface StressRunResult extends GeneratePatchResult {
  runIdx: number;
  endStateNotes: string[];
  endStateOk: boolean;
}

function verifyPatchedIr(ir: PipelineIR | null): { ok: boolean; notes: string[]; b: boolean; d: boolean; w: boolean } {
  const notes: string[] = [];
  if (!ir) return { ok: false, notes: ["no proposedVersion ir"], b: false, d: false, w: false };
  const B = ir.stages.find((s) => s.name === "B");
  const D = ir.stages.find((s) => s.name === "D");
  if (!B) notes.push("stage B missing");
  if (!D) notes.push("stage D missing");
  const bHasExtra = !!B?.outputs.some((p) => p.name === "extra" && p.type.trim() === "string");
  const dHasBExtra = !!D?.inputs.some((p) => p.name === "bExtra" && p.type.trim() === "string");
  const newWire = !!ir.wires.some(
    (w) => w.from.stage === "B" && w.from.port === "extra" && w.to.stage === "D" && w.to.port === "bExtra",
  );
  if (!bHasExtra) notes.push("B.extra output missing or wrong type");
  if (!dHasBExtra) notes.push("D.bExtra input missing or wrong type");
  if (!newWire) notes.push("wire B.extra -> D.bExtra missing");
  return { ok: bHasExtra && dHasBExtra && newWire, notes, b: bHasExtra, d: dHasBExtra, w: newWire };
}

interface CliArgs { runs: number; model: string; out: string; }

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    runs: 10,
    model: "claude-haiku-4-5",
    out: "/tmp/kernel-next-generator-patch.json",
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--runs" && i + 1 < argv.length) { out.runs = Number.parseInt(argv[++i]!, 10); continue; }
    if (tok === "--model" && i + 1 < argv.length) { out.model = argv[++i]!; continue; }
    if (tok === "--out" && i + 1 < argv.length) { out.out = argv[++i]!; continue; }
    if (tok === "--help" || tok === "-h") {
      // eslint-disable-next-line no-console
      console.log("Usage: diamond-patch.ts [--runs N] [--model NAME] [--out PATH]");
      process.exit(0);
    }
  }
  return out;
}

function findBinPath(name: string): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 10; i++) {
    const cand = join(dir, "node_modules", ".bin", name);
    if (existsSync(cand)) return cand;
    dir = dirname(dir);
  }
  return undefined;
}

async function runOnce(
  runIdx: number,
  model: string,
  tscPath: string | undefined,
  claudePath: string | undefined,
): Promise<{ baseVersion: string; result: StressRunResult }> {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  try {
    // Seed baseline diamond from mock generator.
    const svc = new KernelService(db, { tscPath });
    const submit = svc.submit(diamondIR());
    if (!submit.ok) throw new Error("failed to seed baseline diamond");
    const baseVersion = submit.versionHash;

    const mcpServer = createKernelMcp(db, { tscPath });
    const result = await generatePatch({
      baseVersion,
      taskDescription: PATCH_TASK,
      mcpServer,
      db,
      model,
      claudePath,
    });

    let patchedIr: PipelineIR | null = null;
    if (result.proposedVersion) {
      patchedIr = getPipelineIR(db, result.proposedVersion);
    }
    const check = verifyPatchedIr(patchedIr);

    return {
      baseVersion,
      result: {
        runIdx,
        ...result,
        endStateNotes: check.notes,
        endStateOk: check.ok,
      },
    };
  } finally {
    db.close();
  }
}

async function runAsCli(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.ANTHROPIC_API_KEY) {
    // eslint-disable-next-line no-console
    console.warn("ANTHROPIC_API_KEY not set; falling back to local Claude CLI auth (~/.claude).");
  }

  const tscPath = findBinPath("tsc");
  const claudePath = findBinPath("claude");

  // eslint-disable-next-line no-console
  console.log(`--- kernel-next generator-real / diamond patch (${args.runs} runs, model=${args.model}) ---`);

  const runResults: StressRunResult[] = [];
  let lastBaseVersion = "";
  for (let i = 1; i <= args.runs; i++) {
    try {
      const { baseVersion, result } = await runOnce(i, args.model, tscPath, claudePath);
      lastBaseVersion = baseVersion;
      runResults.push(result);
      // eslint-disable-next-line no-console
      console.log(
        `[${i}/${args.runs}] ok=${result.ok} end_state=${result.endStateOk} ` +
          `turns=${result.numTurns} proposes=${result.proposeAttempts} ` +
          `cost=$${result.totalCostUsd.toFixed(4)} dur=${result.durationMs}ms ` +
          `hash=${result.proposedVersion ? result.proposedVersion.slice(0, 12) : "<none>"} ` +
          `${result.endStateNotes.length ? `notes=${JSON.stringify(result.endStateNotes)}` : ""}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[${i}/${args.runs}] runOnce threw: ${msg}`);
      runResults.push({
        runIdx: i, ok: false, proposalId: null, proposedVersion: null,
        numTurns: 0, totalCostUsd: 0, resultSubtype: null,
        proposeAttempts: 0, durationMs: 0, endStateOk: false, endStateNotes: [msg],
      });
    }
  }

  const landed = runResults.filter((r) => r.ok);
  const endStateOk = runResults.filter((r) => r.endStateOk);
  const salvaged = runResults.filter((r) => r.ok && r.proposeAttempts > 1);

  const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
  const mean = (xs: number[]): number => (xs.length ? sum(xs) / xs.length : 0);

  const report: PatchReport = {
    runs: runResults.length,
    model: args.model,
    baseVersion: lastBaseVersion,
    complianceRate: landed.length / Math.max(1, runResults.length),
    meanTurns: mean(runResults.map((r) => r.numTurns)),
    meanCostUsd: mean(runResults.map((r) => r.totalCostUsd)),
    meanDurationMs: mean(runResults.map((r) => r.durationMs)),
    totalCostUsd: sum(runResults.map((r) => r.totalCostUsd)),
    salvagedByDiagnosticLoop: salvaged.length,
    endStateChecks: {
      bHasExtraPort: runResults.filter((r) => r.endStateNotes.every((n) => !n.includes("B.extra"))).length - (runResults.length - landed.length),
      dHasBExtraInput: runResults.filter((r) => r.endStateNotes.every((n) => !n.includes("D.bExtra"))).length - (runResults.length - landed.length),
      newWireExists: runResults.filter((r) => r.endStateNotes.every((n) => !n.includes("wire B.extra"))).length - (runResults.length - landed.length),
      allThree: endStateOk.length,
    },
    runResults,
  };

  writeFileSync(args.out, JSON.stringify(report, null, 2), "utf8");
  // eslint-disable-next-line no-console
  console.log("---");
  // eslint-disable-next-line no-console
  console.log(
    `landed=${landed.length}/${runResults.length} ` +
      `(${(report.complianceRate * 100).toFixed(1)}%) ` +
      `end-state-ok=${endStateOk.length}/${runResults.length} ` +
      `salvaged=${salvaged.length} ` +
      `mean_turns=${report.meanTurns.toFixed(1)} ` +
      `mean_cost=$${report.meanCostUsd.toFixed(4)} ` +
      `total_cost=$${report.totalCostUsd.toFixed(4)}`,
  );
  // eslint-disable-next-line no-console
  console.log(`report written to ${args.out}`);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runAsCli().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("diamond-patch failed:", err);
    process.exit(1);
  });
}
