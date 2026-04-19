// Phase 2 A.2 stress harness — AI-authored diamond generation.
//
// Asks Haiku to produce a diamond-shaped pipeline (A -> {B, C} -> D)
// from a natural-language task description, via the kernel-next MCP
// surface. Measures:
//   - submit compliance (did a pipeline version land?)
//   - diagnostic loop salvage (more than 1 submit_attempt means the
//     retry via diagnostics saved the run)
//   - avg turns, avg cost, avg duration
//
// Usage:
//   tsx src/kernel-next/generator-real/diamond-generate.ts \
//     --runs 10 [--model claude-haiku-4-5] [--out /tmp/report.json]

import { DatabaseSync } from "node:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initKernelNextSchema } from "../ir/sql.js";
import { createKernelMcp } from "../mcp/server.js";
import { generateSubmit, type GenerateSubmitResult } from "./real-generator.js";
import type { PipelineIR } from "../ir/schema.js";

const DIAMOND_TASK = [
  "Produce a kernel-next pipeline with the diamond shape A -> {B, C} -> D.",
  "",
  "Requirements:",
  "- Stage A is the entry point. It produces one output port `x` of",
  "  TypeScript type `number`. Its prompt should tell an agent: \"Pick",
  "  a single integer between 1 and 100.\"",
  "- Stage B takes `x: number` as input and produces a port `y` of type",
  "  `string`. Prompt: \"Format the input number as the string",
  "  B-got-<x>.\"",
  "- Stage C takes `x: number` as input and produces a port `z` of type",
  "  `string`. Prompt: \"Format the input number as the string",
  "  C-got-<x>.\"",
  "- Stage D takes two inputs: `b: string` from B.y, and `c: string`",
  "  from C.z. It produces `final: string`. Prompt: \"Concatenate the",
  "  two inputs as <b>+<c>.\"",
  "- All four stages have type 'agent' with config { promptRef: <the prompt string above> }.",
  "- Name the pipeline 'diamond-gen'.",
  "",
  "Submit the IR via submit_pipeline when ready.",
].join("\n");

interface StressReport {
  runs: number;
  model: string;
  complianceRate: number;
  meanTurns: number;
  meanCostUsd: number;
  meanDurationMs: number;
  totalCostUsd: number;
  salvagedByDiagnosticLoop: number;
  structureChecks: {
    fourStages: number;
    diamondWires: number;
    namedDiamondGen: number;
  };
  runResults: Array<StressRunResult>;
}

interface StressRunResult extends GenerateSubmitResult {
  runIdx: number;
  structureOk: boolean;
  structureNotes: string[];
}

function isDiamondShape(ir: PipelineIR | null): { ok: boolean; notes: string[] } {
  const notes: string[] = [];
  if (!ir) {
    return { ok: false, notes: ["no ir landed"] };
  }
  const stageNames = new Set(ir.stages.map((s) => s.name));
  if (ir.stages.length !== 4) notes.push(`expected 4 stages, got ${ir.stages.length}`);

  // Loose shape: must have one stage with 0 inbound wires (entry), two
  // middle stages, and one stage with 2 inbound wires (join). Names are
  // not forced — A/B/C/D preferred but Claude may rename.
  const inDeg = new Map<string, number>();
  for (const s of ir.stages) inDeg.set(s.name, 0);
  for (const w of ir.wires) {
    if (!stageNames.has(w.from.stage)) notes.push(`wire.from unknown stage ${w.from.stage}`);
    if (!stageNames.has(w.to.stage)) notes.push(`wire.to unknown stage ${w.to.stage}`);
    inDeg.set(w.to.stage, (inDeg.get(w.to.stage) ?? 0) + 1);
  }
  const entries = [...inDeg.entries()].filter(([, d]) => d === 0);
  const joins = [...inDeg.entries()].filter(([, d]) => d === 2);
  if (entries.length !== 1) notes.push(`expected 1 entry stage, got ${entries.length}`);
  if (joins.length !== 1) notes.push(`expected 1 join stage (in-degree 2), got ${joins.length}`);

  // The entry stage should fan out to 2 middle stages.
  if (entries.length === 1) {
    const entry = entries[0]![0];
    const fanOut = ir.wires.filter((w) => w.from.stage === entry);
    if (fanOut.length !== 2) notes.push(`entry stage fan-out expected 2, got ${fanOut.length}`);
  }

  return { ok: notes.length === 0, notes };
}

interface CliArgs {
  runs: number;
  model: string;
  out: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    runs: 10,
    model: "claude-haiku-4-5",
    out: "/tmp/kernel-next-generator-diamond.json",
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--runs" && i + 1 < argv.length) {
      out.runs = Number.parseInt(argv[++i]!, 10);
      continue;
    }
    if (tok === "--model" && i + 1 < argv.length) {
      out.model = argv[++i]!;
      continue;
    }
    if (tok === "--out" && i + 1 < argv.length) {
      out.out = argv[++i]!;
      continue;
    }
    if (tok === "--help" || tok === "-h") {
      // eslint-disable-next-line no-console
      console.log("Usage: diamond-generate.ts [--runs N] [--model NAME] [--out PATH]");
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

async function runOnce(runIdx: number, model: string, tscPath: string | undefined, claudePath: string | undefined): Promise<StressRunResult> {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  try {
    const mcpServer = createKernelMcp(db, { tscPath });
    const result = await generateSubmit({
      taskDescription: DIAMOND_TASK,
      mcpServer,
      db,
      model,
      claudePath,
    });
    const structure = isDiamondShape(result.ir);
    return {
      runIdx,
      ...result,
      structureOk: structure.ok,
      structureNotes: structure.notes,
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
  console.log(`--- kernel-next generator-real / diamond generate (${args.runs} runs, model=${args.model}) ---`);

  const runResults: StressRunResult[] = [];
  for (let i = 1; i <= args.runs; i++) {
    try {
      const r = await runOnce(i, args.model, tscPath, claudePath);
      runResults.push(r);
      // eslint-disable-next-line no-console
      console.log(
        `[${i}/${args.runs}] ok=${r.ok} structure=${r.structureOk} ` +
          `turns=${r.numTurns} submits=${r.submitAttempts} ` +
          `cost=$${r.totalCostUsd.toFixed(4)} dur=${r.durationMs}ms ` +
          `hash=${r.versionHash ? r.versionHash.slice(0, 12) : "<none>"} ` +
          `${r.structureNotes.length ? `notes=${JSON.stringify(r.structureNotes)}` : ""}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[${i}/${args.runs}] runOnce threw: ${msg}`);
      runResults.push({
        runIdx: i,
        ok: false, versionHash: null, ir: null, numTurns: 0, totalCostUsd: 0,
        resultSubtype: null, submitAttempts: 0, durationMs: 0,
        structureOk: false, structureNotes: [msg],
      });
    }
  }

  const landed = runResults.filter((r) => r.ok);
  const structureValid = runResults.filter((r) => r.structureOk);
  const salvaged = runResults.filter((r) => r.ok && r.submitAttempts > 1);

  const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
  const mean = (xs: number[]): number => (xs.length ? sum(xs) / xs.length : 0);

  const report: StressReport = {
    runs: runResults.length,
    model: args.model,
    complianceRate: landed.length / Math.max(1, runResults.length),
    meanTurns: mean(runResults.map((r) => r.numTurns)),
    meanCostUsd: mean(runResults.map((r) => r.totalCostUsd)),
    meanDurationMs: mean(runResults.map((r) => r.durationMs)),
    totalCostUsd: sum(runResults.map((r) => r.totalCostUsd)),
    salvagedByDiagnosticLoop: salvaged.length,
    structureChecks: {
      fourStages: runResults.filter((r) => r.ir && r.ir.stages.length === 4).length,
      diamondWires: structureValid.length,
      namedDiamondGen: runResults.filter((r) => r.ir && r.ir.name === "diamond-gen").length,
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
      `structure-valid=${structureValid.length}/${runResults.length} ` +
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
    console.error("diamond-generate failed:", err);
    process.exit(1);
  });
}
