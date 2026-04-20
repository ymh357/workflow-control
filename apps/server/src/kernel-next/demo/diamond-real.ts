// Real-SDK diamond demo + stress harness (Phase 2 P1).
//
// Drives the canonical diamond pipeline (A -> {B, C} -> D) through the
// RealStageExecutor so each stage actually invokes Claude Haiku via the
// Claude Agent SDK. Measures the agent's compliance with the Typed Port
// output schema across N runs.
//
// Usage:
//   ANTHROPIC_API_KEY=... tsx src/kernel-next/demo/diamond-real.ts \
//     --runs 10 [--model claude-haiku-4-5] [--out /tmp/report.json]
//
// Exits non-zero (without invoking the SDK) when ANTHROPIC_API_KEY is
// missing, so the code path can be smoke-tested in CI without spending
// API credits.

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelService } from "../mcp/kernel.js";
import { createKernelMcp } from "../mcp/server.js";
import { runPipeline } from "../runtime/runner.js";
import { RealStageExecutor } from "../runtime/real-executor.js";
import { generatePipeline } from "../generator-mock/mini-generator.js";

export interface RunOnceOptions {
  runIdx: number;
  model: string;
  tscPath?: string;
  claudePath?: string;
  timeoutMs?: number;
  maxBudgetUsd?: number;
  maxRetries?: number;
}

export interface StageAttemptSummary {
  stage: string;
  attempts: number;
  lastStatus?: "success" | "error";
  lastError?: string;
}

export interface RunOnceResult {
  runIdx: number;
  startMs: number;
  durationMs: number;
  finalState: "completed" | "failed";
  drainErrors: Array<{ stage: string | null; message: string }>;
  portValues: Record<string, unknown>;
  stageAttempts: StageAttemptSummary[];
  schemaCompliant: boolean;
  finalValue: string | null;
}

export interface AggregateReport {
  totalRuns: number;
  compliantCount: number;
  complianceRate: number;
  meanDurationMs: number;
  totalAttempts: number;
  model: string;
  runs: RunOnceResult[];
}

const STAGE_NAMES = ["A", "B", "C", "D"] as const;

/** Run the diamond once against a fresh in-memory DB. */
export async function runOnce(opts: RunOnceOptions): Promise<RunOnceResult> {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);

  try {
    const gen = generatePipeline({ task: "diamond" });
    const service = new KernelService(db, { tscPath: opts.tscPath });
    const submit = service.submit(gen.ir);
    if (!submit.ok) {
      const msg = submit.diagnostics
        .map((d) => `${d.code}: ${d.message}`)
        .join("; ");
      throw new Error(`submit_pipeline failed: ${msg}`);
    }

    const executor = new RealStageExecutor({
      // Fresh MCP server per stage: SDK MCP transport is single-use.
      // Pass the live dispatcher so agent-side write_port tool calls fire
      // PORT_WRITTEN and advance the runner's state machine.
      mcpServerFactory: (_dispatcher, portRuntime) =>
        createKernelMcp(db, {
          // Execution path: the agent needs `write_port` to deliver
          // stage outputs. Explicit 'combined' after the default flip
          // to 'external' (Debt #2 retire). Reuse the runner's live
          // PortRuntime (A7.2) so SSE port_written events fire on
          // MCP-initiated writes.
          surface: "combined",
          tscPath: opts.tscPath,
          portRuntime,
        }),
      model: opts.model,
      maxTurns: 10,
      maxBudgetUsd: opts.maxBudgetUsd ?? 0.2,
      claudePath: opts.claudePath,
      maxRetries: opts.maxRetries ?? 0,
    });

    const taskId = `real-${opts.runIdx}`;
    const startMs = Date.now();
    const result = await runPipeline(
      {
        db,
        ir: gen.ir,
        taskId,
        versionHash: submit.versionHash,
        // handlers is still required by the current RunnerOptions type for
        // backward-compat; real execution goes through executor.
        handlers: {},
        executor,
      },
      opts.timeoutMs ?? 120_000,
    );
    const durationMs = Date.now() - startMs;

    // Stage-level attempt counts: 1 row per attempt, so COUNT(*) is the
    // count of tries (including errored ones).
    const stageAttempts: StageAttemptSummary[] = STAGE_NAMES.map((stage) => {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM stage_attempts
           WHERE task_id = ? AND stage_name = ?`,
        )
        .get(taskId, stage) as { n: number };
      const last = db
        .prepare(
          `SELECT status FROM stage_attempts
           WHERE task_id = ? AND stage_name = ?
           ORDER BY attempt_idx DESC LIMIT 1`,
        )
        .get(taskId, stage) as { status: "success" | "error" } | undefined;
      // error_message is not persisted to stage_attempts (only dispatched as
      // STAGE_FAILED to the machine). Pull it from runner's stageErrors
      // instead (populated from executor.executeStage results).
      const errorEntry = result.stageErrors.find((e) => e.stage === stage);
      return {
        stage,
        attempts: row.n,
        lastStatus: last?.status,
        lastError: errorEntry?.message,
      };
    });

    const finalRaw = result.portValues["D.final"];
    const finalValue = typeof finalRaw === "string" && finalRaw.length > 0 ? finalRaw : null;
    const schemaCompliant = result.finalState === "completed" && finalValue !== null;

    return {
      runIdx: opts.runIdx,
      startMs,
      durationMs,
      finalState: result.finalState,
      drainErrors: result.drainErrors,
      portValues: result.portValues,
      stageAttempts,
      schemaCompliant,
      finalValue,
    };
  } finally {
    db.close();
  }
}

interface CliArgs {
  runs: number;
  model: string;
  out: string;
  retries: number;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    runs: 10,
    model: "claude-haiku-4-5",
    out: "/tmp/kernel-next-stress-report.json",
    retries: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--runs" && i + 1 < argv.length) {
      const n = Number.parseInt(argv[++i]!, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--runs must be a positive integer, got '${argv[i]}'`);
      }
      out.runs = n;
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
    if (tok === "--retries" && i + 1 < argv.length) {
      const n = Number.parseInt(argv[++i]!, 10);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`--retries must be a non-negative integer, got '${argv[i]}'`);
      }
      out.retries = n;
      continue;
    }
    if (tok === "--help" || tok === "-h") {
      // eslint-disable-next-line no-console
      console.log(
        "Usage: diamond-real.ts [--runs N] [--model NAME] [--out PATH] [--retries N]",
      );
      process.exit(0);
    }
  }
  return out;
}

/** Walk up from this file looking for node_modules/.bin/<name>. */
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

function aggregate(
  runs: RunOnceResult[],
  model: string,
): AggregateReport {
  const compliantCount = runs.filter((r) => r.schemaCompliant).length;
  const totalAttempts = runs.reduce(
    (acc, r) => acc + r.stageAttempts.reduce((a, s) => a + s.attempts, 0),
    0,
  );
  const meanDurationMs =
    runs.length > 0
      ? runs.reduce((acc, r) => acc + r.durationMs, 0) / runs.length
      : 0;
  return {
    totalRuns: runs.length,
    compliantCount,
    complianceRate: runs.length > 0 ? compliantCount / runs.length : 0,
    meanDurationMs,
    totalAttempts,
    model,
    runs,
  };
}

async function runAsCli(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.ANTHROPIC_API_KEY) {
    // eslint-disable-next-line no-console
    console.warn(
      "ANTHROPIC_API_KEY not set; falling back to local Claude CLI auth " +
        "(~/.claude). If the CLI is not logged in, the SDK will fail.",
    );
  }

  const tscPath = findBinPath("tsc");
  // claude CLI is resolved by the Agent SDK from PATH by default; only
  // override if a local node_modules/.bin/claude exists (developer install).
  const claudePath = findBinPath("claude");
  const runs: RunOnceResult[] = [];

  // eslint-disable-next-line no-console
  console.log(
    `--- kernel-next diamond-real stress (${args.runs} runs, model=${args.model}) ---`,
  );

  for (let i = 1; i <= args.runs; i++) {
    try {
      const r = await runOnce({
        runIdx: i,
        model: args.model,
        tscPath,
        claudePath,
        maxRetries: args.retries,
      });
      runs.push(r);
      // eslint-disable-next-line no-console
      console.log(
        `[${i}/${args.runs}] state=${r.finalState} ok=${r.schemaCompliant} ` +
          `dur=${r.durationMs}ms attempts=${r.stageAttempts
            .map((s) => `${s.stage}:${s.attempts}`)
            .join(",")} final=${r.finalValue ?? "<none>"}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[${i}/${args.runs}] runOnce threw: ${msg}`);
      runs.push({
        runIdx: i,
        startMs: Date.now(),
        durationMs: 0,
        finalState: "failed",
        drainErrors: [{ stage: null, message: msg }],
        portValues: {},
        stageAttempts: STAGE_NAMES.map((s) => ({ stage: s, attempts: 0 })),
        schemaCompliant: false,
        finalValue: null,
      });
    }
  }

  const report = aggregate(runs, args.model);

  writeFileSync(args.out, JSON.stringify(report, null, 2), "utf8");
  // eslint-disable-next-line no-console
  console.log("---");
  // eslint-disable-next-line no-console
  console.log(
    `compliance: ${report.compliantCount}/${report.totalRuns} ` +
      `(${(report.complianceRate * 100).toFixed(1)}%) ` +
      `mean=${report.meanDurationMs.toFixed(0)}ms ` +
      `total_attempts=${report.totalAttempts}`,
  );
  // eslint-disable-next-line no-console
  console.log(`report written to ${args.out}`);
  // Always exit 0 when the harness itself ran to completion — partial
  // compliance is a measurement, not a harness failure.
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runAsCli().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("diamond-real failed:", err);
    process.exit(1);
  });
}
