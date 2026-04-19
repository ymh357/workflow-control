#!/usr/bin/env tsx
/**
 * Phase 4 / A4 — debug CLI. External-access front-end to the same
 * debug-queries core that powers the __debug__ MCP.
 *
 * Usage:
 *   pnpm --filter server exec tsx src/cli/debug.ts analyze <taskId>
 *   pnpm --filter server exec tsx src/cli/debug.ts record <taskId> <stageName> [--attempt=N]
 *   pnpm --filter server exec tsx src/cli/debug.ts diff <attemptIdA> <attemptIdB>
 *
 * Default output: JSON (for AI consumption + scripting). Pass
 * --pretty for a human-readable summary.
 */

import { parseArgs } from "node:util";
import {
  analyzeTaskFailure,
  diffExecutions,
  getStageExecutionRecord,
  listTaskRecords,
  type TaskFailureReport,
  type GetStageRecordResult,
  type ExecutionDiffResult,
  type ListTaskRecordsResult,
} from "../lib/debug-queries.js";

const HELP = `
workflow-control debug CLI

Usage:
  debug analyze <taskId> [--pretty]
    Summarize a task's execution records and surface failure hints.

  debug record <taskId> <stageName> [--attempt=N] [--pretty]
    Fetch a full ExecutionRecord for one stage attempt.
    Omit --attempt for the latest.

  debug list <taskId> [--pretty]
    List every attempt row for a task as a lightweight index.

  debug diff <attemptIdA> <attemptIdB> [--pretty]
    Compare two ExecutionRecords by attempt_id.

Options:
  --pretty                    Print a human-readable summary instead of JSON.
                              Default is JSON (machine-readable; AI-friendly).
  --help, -h                  Show this help message.
`.trim();

interface CommonFlags {
  pretty: boolean;
}

function parseCommonFlags(rest: string[]): { positional: string[]; flags: CommonFlags; extra: Record<string, string | boolean | undefined> } {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      pretty: { type: "boolean", default: false },
      attempt: { type: "string" },
    },
  });
  return {
    positional: positionals,
    flags: { pretty: !!values.pretty },
    extra: { attempt: values.attempt as string | undefined },
  };
}

function printAnalyzePretty(r: TaskFailureReport): void {
  if (!r.found) {
    console.log(`Task ${r.taskId}: no execution_records rows found.`);
    return;
  }
  console.log(`Task ${r.taskId}`);
  console.log(`  Attempts:      ${r.totalAttempts}`);
  console.log(`  Cost (USD):    ${r.totalCostUsd.toFixed(4)}`);
  console.log(`  First start:   ${r.firstStartedAt ?? "-"}`);
  console.log(`  Last heartbeat:${r.lastHeartbeatAt ?? "-"}`);
  console.log("");
  console.log("  Stages:");
  for (const s of r.stages) {
    const flag = r.failingStages.includes(s.stageName) ? " [FAIL]" : "";
    console.log(
      `    - ${s.stageName}${flag} x${s.attempts} ` +
        `last=${s.lastTerminationReason ?? "open"} ` +
        `cost=${s.totalCostUsd.toFixed(4)} ` +
        `tokens=${s.totalTokenInput}in/${s.totalTokenOutput}out`,
    );
  }
  if (r.hints.length > 0) {
    console.log("");
    console.log("  Hints:");
    for (const h of r.hints) {
      console.log(`    - [${h.kind}] ${h.stageName}${h.attemptId ? `/${h.attemptId}` : ""}`);
      console.log(`      ${h.detail}`);
    }
  }
}

function printRecordPretty(r: GetStageRecordResult): void {
  if (!r.found || !r.record) {
    console.log(
      `No record for task=${r.taskId} stage=${r.stageName} attempt=${r.attempt ?? "latest"}. ` +
        `Available attempts: ${r.availableAttempts.join(", ") || "(none)"}`,
    );
    return;
  }
  const rec = r.record;
  console.log(`attempt_id:   ${rec.attemptId}`);
  console.log(`task:         ${rec.taskId}`);
  console.log(`stage:        ${rec.stageName} (attempt ${rec.attemptIndex})`);
  console.log(`engine/model: ${rec.engine}${rec.model ? `/${rec.model}` : ""}`);
  console.log(`started:      ${rec.startedAt}`);
  console.log(`terminated:   ${rec.terminatedAt ?? "still open"}`);
  console.log(`reason:       ${rec.terminationReason ?? "-"}`);
  console.log(`duration_ms:  ${rec.durationMs ?? "-"}`);
  console.log(`cost_usd:     ${rec.costUsd ?? "-"}`);
  console.log(`tokens:       ${rec.tokenInput ?? 0}in / ${rec.tokenOutput ?? 0}out`);
  console.log(`reads keys:   ${Object.keys(rec.readsSnapshot).join(", ") || "(none)"}`);
  console.log(
    `writes keys:  ${rec.writesCommitted ? Object.keys(rec.writesCommitted).join(", ") || "(none)" : "(null)"}`,
  );
  console.log(`decisions:    ${rec.decisions.length}`);
  console.log(`tool_calls:   ${rec.toolCalls.length}`);
  console.log(`stream lines: ${rec.agentStream.length}`);
}

function printListPretty(r: ListTaskRecordsResult): void {
  if (!r.found) {
    console.log(`Task ${r.taskId}: no execution_records rows found.`);
    return;
  }
  console.log(`Task ${r.taskId} — ${r.total} attempt(s)`);
  for (const rec of r.records) {
    const flag = rec.isOpen ? " [OPEN]" : "";
    const cost = rec.costUsd !== null ? rec.costUsd.toFixed(4) : "-";
    const tokens = `${rec.tokenInput ?? 0}in/${rec.tokenOutput ?? 0}out`;
    console.log(
      `  ${rec.startedAt}  ${rec.attemptId}  ` +
        `${rec.stageName}@${rec.attemptIndex}${flag}  ` +
        `${rec.terminationReason ?? "open"}  ` +
        `cost=${cost} tokens=${tokens}`,
    );
  }
}

function printDiffPretty(r: ExecutionDiffResult): void {
  if (!r.found) {
    console.log(`Missing attempt(s): ${r.missing.join(", ")}`);
    return;
  }
  const a = r.a!;
  const b = r.b!;
  console.log(`A: ${a.attemptId} (${a.taskId}/${a.stageName}@${a.attemptIndex})`);
  console.log(`B: ${b.attemptId} (${b.taskId}/${b.stageName}@${b.attemptIndex})`);
  if (r.identical) {
    console.log("identical: yes");
    return;
  }
  const d = r.differences!;
  if (d.promptBlob.length > 0) {
    console.log("");
    console.log("  prompt changes:");
    for (const p of d.promptBlob) console.log(`    - ${p.field}`);
  }
  if (d.readsSnapshot.changed.length || d.readsSnapshot.onlyInA.length || d.readsSnapshot.onlyInB.length) {
    console.log("");
    console.log("  reads:");
    if (d.readsSnapshot.onlyInA.length) console.log(`    only in A: ${d.readsSnapshot.onlyInA.join(", ")}`);
    if (d.readsSnapshot.onlyInB.length) console.log(`    only in B: ${d.readsSnapshot.onlyInB.join(", ")}`);
    for (const c of d.readsSnapshot.changed) console.log(`    changed: ${c.key}`);
  }
  if (d.writesCommitted.changed.length || d.writesCommitted.onlyInA.length || d.writesCommitted.onlyInB.length) {
    console.log("");
    console.log("  writes:");
    if (d.writesCommitted.onlyInA.length) console.log(`    only in A: ${d.writesCommitted.onlyInA.join(", ")}`);
    if (d.writesCommitted.onlyInB.length) console.log(`    only in B: ${d.writesCommitted.onlyInB.join(", ")}`);
    for (const c of d.writesCommitted.changed) console.log(`    changed: ${c.key}`);
  }
  if (d.decisions.onlyInA.length || d.decisions.onlyInB.length) {
    console.log("");
    console.log(`  decisions: A=${d.decisions.aCount} B=${d.decisions.bCount}`);
    for (const x of d.decisions.onlyInA) console.log(`    only A: ${x.context} => ${x.chosen}`);
    for (const x of d.decisions.onlyInB) console.log(`    only B: ${x.context} => ${x.chosen}`);
  }
  if (
    Object.keys(d.toolCalls.countByName.onlyInA).length ||
    Object.keys(d.toolCalls.countByName.onlyInB).length
  ) {
    console.log("");
    console.log(`  tool_calls: A=${d.toolCalls.aCount} B=${d.toolCalls.bCount}`);
    for (const [name, n] of Object.entries(d.toolCalls.countByName.onlyInA)) {
      console.log(`    only A: ${name} x${n}`);
    }
    for (const [name, n] of Object.entries(d.toolCalls.countByName.onlyInB)) {
      console.log(`    only B: ${name} x${n}`);
    }
  }
  if (d.termination.length) {
    console.log("");
    console.log("  termination changes:");
    for (const t of d.termination) console.log(`    ${t.field}: ${t.a} -> ${t.b}`);
  }
  if (d.cost.deltaUsd !== null) {
    console.log("");
    console.log(`  cost delta: ${d.cost.deltaUsd >= 0 ? "+" : ""}${d.cost.deltaUsd} USD`);
  }
  if (d.durationMs.deltaMs !== null) {
    console.log(`  duration delta: ${d.durationMs.deltaMs >= 0 ? "+" : ""}${d.durationMs.deltaMs} ms`);
  }
}

export async function runAnalyze(positional: string[], flags: CommonFlags): Promise<number> {
  const taskId = positional[0];
  if (!taskId) {
    console.error("Error: debug analyze <taskId>");
    return 1;
  }
  const result = analyzeTaskFailure(taskId);
  if (flags.pretty) {
    printAnalyzePretty(result);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  return 0;
}

export async function runRecord(
  positional: string[],
  flags: CommonFlags,
  extra: Record<string, string | boolean | undefined>,
): Promise<number> {
  const [taskId, stageName] = positional;
  if (!taskId || !stageName) {
    console.error("Error: debug record <taskId> <stageName> [--attempt=N]");
    return 1;
  }
  const options: { attempt?: number } = {};
  if (typeof extra.attempt === "string") {
    const n = Number(extra.attempt);
    if (!Number.isInteger(n) || n < 0) {
      console.error(`Error: --attempt must be a non-negative integer (got "${extra.attempt}")`);
      return 1;
    }
    options.attempt = n;
  }
  const result = getStageExecutionRecord(taskId, stageName, options);
  if (flags.pretty) {
    printRecordPretty(result);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  return 0;
}

export async function runList(positional: string[], flags: CommonFlags): Promise<number> {
  const taskId = positional[0];
  if (!taskId) {
    console.error("Error: debug list <taskId>");
    return 1;
  }
  const result = listTaskRecords(taskId);
  if (flags.pretty) {
    printListPretty(result);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  return 0;
}

export async function runDiff(positional: string[], flags: CommonFlags): Promise<number> {
  const [aId, bId] = positional;
  if (!aId || !bId) {
    console.error("Error: debug diff <attemptIdA> <attemptIdB>");
    return 1;
  }
  const result = diffExecutions(aId, bId);
  if (flags.pretty) {
    printDiffPretty(result);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  return 0;
}

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
    console.log(HELP);
    process.exit(0);
  }
  const command = rawArgs[0];
  const rest = rawArgs.slice(1);

  try {
    const { positional, flags, extra } = parseCommonFlags(rest);
    switch (command) {
      case "analyze": {
        process.exit(await runAnalyze(positional, flags));
        break;
      }
      case "record": {
        process.exit(await runRecord(positional, flags, extra));
        break;
      }
      case "list": {
        process.exit(await runList(positional, flags));
        break;
      }
      case "diff": {
        process.exit(await runDiff(positional, flags));
        break;
      }
      default:
        console.error(`Unknown command: ${command}`);
        console.log(HELP);
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

if (process.env.VITEST !== "true") {
  void main();
}
