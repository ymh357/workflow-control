#!/usr/bin/env tsx
/**
 * kernel-next execution-record pruning CLI.
 *
 * Targets kernel-next.db (NOT the legacy workflow.db.execution_records
 * table removed in Stage 4a). Deletes rows from stage_attempts and its
 * FK children (agent_execution_details, stage_checkpoints, port_values,
 * gate_queue) matching the given filter.
 *
 * Usage:
 *   pnpm --filter server exec tsx src/cli/prune-kernel-records.ts prune \
 *       [--task-id=X] [--older-than=30d] [--dry-run] [--yes]
 *   pnpm --filter server exec tsx src/cli/prune-kernel-records.ts stats
 *
 * Retention is permanent by default (docs/product-roadmap.md §6.1).
 * Use `prune` only when records need to go; no automatic cleanup runs.
 */

import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { getKernelNextDb } from "../lib/kernel-next-db.js";
import {
  attemptStats,
  countAttemptsToDelete,
  parseDuration,
  pruneAttempts,
  type PruneCounts,
  type PruneFilter,
} from "./lib/prune-kernel-records.js";

const HELP = `
workflow-control prune-kernel-records CLI

Usage:
  prune-kernel-records prune [options]
    Delete rows from stage_attempts + FK children (agent_execution_details,
    stage_checkpoints, port_values, gate_queue).
    Options:
      --task-id=<id>          Restrict to a single task.
      --older-than=<N>d|h|m|s Restrict to attempts started more than N
                              time units ago. Example: --older-than=30d
      --dry-run               Print counts only; do not delete.
      --yes                   Skip interactive confirmation.

    At least one of --task-id / --older-than is required.

  prune-kernel-records stats
    Print aggregate stats across all stage_attempts.

Options:
  --help, -h                  Show this help message.
`.trim();

interface PruneCliArgs {
  taskId?: string;
  olderThanMs?: number;
  dryRun: boolean;
  yes: boolean;
}

function parsePruneArgs(argv: string[]): PruneCliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "task-id": { type: "string" },
      "older-than": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "yes": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  const olderThan = values["older-than"];
  const olderThanMs = typeof olderThan === "string" ? parseDuration(olderThan) : undefined;

  return {
    taskId: typeof values["task-id"] === "string" ? (values["task-id"] as string) : undefined,
    olderThanMs,
    dryRun: Boolean(values["dry-run"]),
    yes: Boolean(values["yes"]),
  };
}

function formatTimestamp(ms: number | null): string {
  if (ms === null) return "(none)";
  try {
    return new Date(ms).toISOString();
  } catch {
    return String(ms);
  }
}

function formatCounts(c: PruneCounts): string {
  return [
    `  stage_attempts:             ${c.attempts}`,
    `  agent_execution_details:    ${c.agent_execution_details}`,
    `  stage_checkpoints:          ${c.stage_checkpoints}`,
    `  port_values:                ${c.port_values}`,
    `  gate_queue:                 ${c.gate_queue}`,
  ].join("\n");
}

async function runPrune(argv: string[]): Promise<number> {
  const cli = parsePruneArgs(argv);
  const filter: PruneFilter = {
    taskId: cli.taskId,
    olderThanMs: cli.olderThanMs,
  };
  if (filter.taskId === undefined && filter.olderThanMs === undefined) {
    process.stderr.write(
      "error: prune requires --task-id=<id> or --older-than=<N>d|h|m|s\n\n",
    );
    process.stderr.write(HELP + "\n");
    return 2;
  }

  const db = getKernelNextDb();
  const count = countAttemptsToDelete(db, filter);

  const filterDesc = [
    filter.taskId ? `task_id="${filter.taskId}"` : null,
    filter.olderThanMs !== undefined ? `older-than=${filter.olderThanMs}ms` : null,
  ].filter(Boolean).join(", ");

  if (count === 0) {
    process.stdout.write(`No stage_attempts match filter (${filterDesc}). Nothing to do.\n`);
    return 0;
  }

  if (cli.dryRun) {
    process.stdout.write(
      `Dry-run: ${count} stage_attempts match filter (${filterDesc}).\n` +
      `Use the same command without --dry-run to actually delete.\n`,
    );
    return 0;
  }

  if (!cli.yes) {
    const rl = createInterface({ input, output });
    try {
      const answer = await rl.question(
        `About to delete ${count} stage_attempts row(s) matching ${filterDesc} ` +
        `PLUS their FK children. Type "yes" to proceed: `,
      );
      if (answer.trim().toLowerCase() !== "yes") {
        process.stdout.write("Aborted.\n");
        return 1;
      }
    } finally {
      rl.close();
    }
  }

  const counts = pruneAttempts(db, filter);
  process.stdout.write(`Deleted:\n${formatCounts(counts)}\n`);
  return 0;
}

function runStats(): number {
  const db = getKernelNextDb();
  const s = attemptStats(db);
  process.stdout.write(
    [
      `Total stage_attempts: ${s.total}`,
      `Oldest started_at:    ${formatTimestamp(s.oldestStartedAt)}`,
      `Newest started_at:    ${formatTimestamp(s.newestStartedAt)}`,
      `Open agent_execution_details (ended_at IS NULL): ${s.openAgentExecutionDetails}`,
      "",
      "Top tasks by attempt count:",
      s.byTask.length === 0
        ? "  (none)"
        : s.byTask.map((r) => `  ${r.task_id}: ${r.attempts}`).join("\n"),
    ].join("\n") + "\n",
  );
  return 0;
}

async function main(): Promise<number> {
  const [, , subcommand, ...rest] = process.argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    process.stdout.write(HELP + "\n");
    return 0;
  }

  try {
    if (subcommand === "prune") return await runPrune(rest);
    if (subcommand === "stats") return runStats();
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  process.stderr.write(`error: unknown subcommand "${subcommand}"\n\n`);
  process.stderr.write(HELP + "\n");
  return 2;
}

main().then((code) => process.exit(code), (err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
