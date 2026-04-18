#!/usr/bin/env tsx
/**
 * ExecutionRecord CLI — inspect and prune the execution_records SQLite table.
 *
 * Usage:
 *   pnpm --filter server exec tsx src/cli/execution-record.ts prune [--task-id=X] [--older-than=30d] [--dry-run] [--yes]
 *   pnpm --filter server exec tsx src/cli/execution-record.ts stats
 *
 * Retention is permanent by default (docs/product-roadmap.md §6.1) — there is
 * no periodic auto-cleanup. Use `prune` when records need to go.
 */

import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pruneExecutionRecords, countExecutionRecords } from "./lib/prune-execution-records.js";

const HELP = `
workflow-control execution-record CLI

Usage:
  execution-record prune [options]
    Delete rows from execution_records.
    Options:
      --task-id=<id>          Restrict to a single task.
      --older-than=<N>d|h     Restrict to rows older than N days/hours.
                              Examples: --older-than=30d  --older-than=12h
      --dry-run               Print what would be deleted; do not delete.
      --yes                   Skip the interactive confirmation.

  execution-record stats
    Print a quick summary: total rows, open rows, rows per task (top 5).

Options:
  --help, -h                  Show this help message.
`.trim();

interface PruneCliArgs {
  taskId?: string;
  olderThanMs?: number;
  dryRun: boolean;
  yes: boolean;
}

/**
 * Parse a human-readable duration (e.g. "30d", "12h") into milliseconds.
 * Throws on any other format; the CLI catches and prints an error message.
 */
export function parseDuration(raw: string): number {
  const m = raw.trim().match(/^(\d+)\s*([dhms])$/);
  if (!m) {
    throw new Error(
      `Invalid --older-than value "${raw}" (expected e.g. "30d", "12h", "45m", "90s").`,
    );
  }
  const n = Number(m[1]);
  const unit = m[2];
  const multipliers: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 60 * 60_000,
    d: 24 * 60 * 60_000,
  };
  return n * multipliers[unit]!;
}

function parsePruneArgs(rest: string[]): PruneCliArgs {
  const { values } = parseArgs({
    args: rest,
    allowPositionals: false,
    options: {
      "task-id": { type: "string" },
      "older-than": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
    },
  });
  const parsed: PruneCliArgs = {
    taskId: values["task-id"],
    dryRun: !!values["dry-run"],
    yes: !!values.yes,
  };
  if (values["older-than"]) {
    parsed.olderThanMs = parseDuration(values["older-than"]);
  }
  return parsed;
}

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`${message} (y/N) `);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

export async function runPrune(args: PruneCliArgs): Promise<number> {
  if (!args.taskId && args.olderThanMs === undefined) {
    console.error(
      "Refusing to prune without a filter. Pass --task-id=<id> or --older-than=<N>d (or both).",
    );
    return 1;
  }

  const matched = countExecutionRecords({
    taskId: args.taskId,
    olderThanMs: args.olderThanMs,
  });
  const filterDesc = [
    args.taskId ? `task-id=${args.taskId}` : null,
    args.olderThanMs ? `older-than=${args.olderThanMs}ms` : null,
  ]
    .filter(Boolean)
    .join(", ");

  if (matched === 0) {
    console.log(`No execution_records rows match filter (${filterDesc}).`);
    return 0;
  }

  if (args.dryRun) {
    console.log(
      `[dry-run] Would delete ${matched} row(s) from execution_records (${filterDesc}).`,
    );
    return 0;
  }

  if (!args.yes) {
    const ok = await confirm(
      `About to delete ${matched} row(s) from execution_records (${filterDesc}). Continue?`,
    );
    if (!ok) {
      console.log("Aborted.");
      return 0;
    }
  }

  const deleted = pruneExecutionRecords({
    taskId: args.taskId,
    olderThanMs: args.olderThanMs,
  });
  console.log(`Deleted ${deleted} row(s) from execution_records.`);
  return 0;
}

export async function runStats(): Promise<number> {
  const { getDb } = await import("../lib/db.js");
  const db = getDb();
  const total = (db
    .prepare("SELECT COUNT(*) as n FROM execution_records")
    .get() as { n: number }).n;
  const open = (db
    .prepare(
      "SELECT COUNT(*) as n FROM execution_records WHERE terminated_at IS NULL",
    )
    .get() as { n: number }).n;
  const perTask = db
    .prepare(
      `SELECT task_id, COUNT(*) as n FROM execution_records
       GROUP BY task_id ORDER BY n DESC LIMIT 5`,
    )
    .all() as Array<{ task_id: string; n: number }>;

  console.log(`Total rows:  ${total}`);
  console.log(`Open rows:   ${open}`);
  if (perTask.length > 0) {
    console.log("Top tasks by row count:");
    for (const row of perTask) {
      console.log(`  ${row.task_id}  ${row.n}`);
    }
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
    switch (command) {
      case "prune": {
        const code = await runPrune(parsePruneArgs(rest));
        process.exit(code);
        break;
      }
      case "stats": {
        const code = await runStats();
        process.exit(code);
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
