// Orphan-reconciler: startup-time survivor logic.
//
// On boot, scan the kernel-next DB for tasks that have stage attempts
// but no task_finals row. Those are either:
//   - Mid-flight (runner crashed before finalizing) → resume them
//   - Terminal-but-lost-their-finals-write (WAL tailing edge) → synthesize
//     the task_finals row
//   - Unresolvable (IR GC'd) → write task_finals(failed)
//
// The reconciler does not block server startup on SDK calls; it kicks
// resume dispatches as fire-and-forget and returns summary counts.

import type { DatabaseSync } from "node:sqlite";
import type { PipelineIR } from "../ir/schema.js";
import { getPipelineIR } from "../ir/sql.js";
import { reconcileRunningAttempts } from "./graceful-shutdown.js";

export function scanOrphanTaskIds(db: DatabaseSync): string[] {
  const rows = db.prepare(
    `SELECT DISTINCT task_id FROM stage_attempts
      WHERE task_id NOT IN (SELECT task_id FROM task_finals)
      ORDER BY task_id`,
  ).all() as Array<{ task_id: string }>;
  return rows.map((r) => r.task_id);
}

export type OrphanClassification =
  | { kind: "resume"; versionHash: string; resumeFrom: string }
  | { kind: "terminal"; versionHash: string }
  | { kind: "unresolvable"; reason: "no_attempts" | "ir_not_found" };

export function classifyOrphan(
  db: DatabaseSync,
  taskId: string,
): OrphanClassification {
  const latest = db.prepare(
    `SELECT version_hash, started_at FROM stage_attempts
      WHERE task_id = ?
      ORDER BY started_at DESC
      LIMIT 1`,
  ).get(taskId) as { version_hash: string; started_at: number } | undefined;
  if (!latest) return { kind: "unresolvable", reason: "no_attempts" };
  const ir = getPipelineIR(db, latest.version_hash);
  if (!ir) return { kind: "unresolvable", reason: "ir_not_found" };

  // Hot-update priority override — if a successful migration is newer
  // than the latest stage attempt, it knows better than our topological
  // scan where the next work should pick up. Use its rerun_from_stage.
  const hu = db.prepare(
    `SELECT rerun_from_stage, started_at FROM hot_update_events
       WHERE task_id = ? AND status = 'success'
       ORDER BY started_at DESC
       LIMIT 1`,
  ).get(taskId) as { rerun_from_stage: string | null; started_at: number } | undefined;
  if (hu && hu.rerun_from_stage && hu.started_at >= latest.started_at) {
    return {
      kind: "resume",
      versionHash: latest.version_hash,
      resumeFrom: hu.rerun_from_stage,
    };
  }

  const successStages = new Set(
    (db.prepare(
      `SELECT DISTINCT stage_name FROM stage_attempts
        WHERE task_id = ? AND status = 'success'`,
    ).all(taskId) as Array<{ stage_name: string }>).map((r) => r.stage_name),
  );
  const order = topologicalStageOrder(ir);
  const firstPending = order.find(
    (name) => !successStages.has(name) && !isSkippable(ir, name),
  );
  if (firstPending === undefined) {
    return { kind: "terminal", versionHash: latest.version_hash };
  }
  return { kind: "resume", versionHash: latest.version_hash, resumeFrom: firstPending };
}

export interface BootResumabilityInput {
  db: DatabaseSync;
  startPipelineRun: (input: {
    taskId: string;
    versionHash: string;
    resumeFrom?: string;
    resumeSessionId?: string;
    // Monorepo tsc binary forwarded so downstream per-stage MCP servers
    // thread it into validateTypes. Without this the tmp-dir npx
    // fallback fails with "This is not the tsc command you are looking
    // for", parseTscOutput cannot map the error to any wire, and every
    // resumed pipeline's persist-ish stage sees a bogus
    // WIRE_TYPE_MISMATCH that the agent treats as non-retryable.
    tscPath?: string;
  }) => Promise<unknown>;
  /** Monorepo tsc binary path; forwarded verbatim to startPipelineRun. */
  tscPath?: string;
}

export interface BootResumabilityResult {
  resumed: number;
  terminalRecovered: number;
  unresolvable: number;
}

export async function bootResumability(
  input: BootResumabilityInput,
): Promise<BootResumabilityResult> {
  const { db } = input;
  const orphans = scanOrphanTaskIds(db);
  // Reconcile every orphan's running attempts up front so the resumed
  // runner sees a clean world. Classifier then reads the post-reconcile
  // state consistently.
  reconcileRunningAttempts(db, orphans);
  let resumed = 0;
  let terminalRecovered = 0;
  let unresolvable = 0;
  const now = Date.now();
  const promises: Array<Promise<unknown>> = [];
  for (const taskId of orphans) {
    const cls = classifyOrphan(db, taskId);
    if (cls.kind === "terminal") {
      db.prepare(
        `INSERT OR IGNORE INTO task_finals (task_id, version_hash, final_state, reason, detail, ended_at)
         VALUES (?, ?, 'completed', 'natural', 'recovered_no_finals_row', ?)`,
      ).run(taskId, cls.versionHash, now);
      terminalRecovered += 1;
      continue;
    }
    if (cls.kind === "unresolvable") {
      // Use a placeholder version hash when the task has no resolvable
      // version; task_finals.version_hash is TEXT NOT NULL but has no FK.
      const vhRow = db.prepare(
        `SELECT version_hash FROM stage_attempts WHERE task_id=? ORDER BY started_at DESC LIMIT 1`,
      ).get(taskId) as { version_hash: string } | undefined;
      db.prepare(
        `INSERT OR IGNORE INTO task_finals (task_id, version_hash, final_state, reason, detail, ended_at)
         VALUES (?, ?, 'failed', 'error', ?, ?)`,
      ).run(taskId, vhRow?.version_hash ?? "-", `unresolvable:${cls.reason}`, now);
      unresolvable += 1;
      continue;
    }
    const resumeSessionId = lookupResumeSessionId(db, taskId, cls.resumeFrom);
    promises.push(
      input.startPipelineRun({
        taskId,
        versionHash: cls.versionHash,
        resumeFrom: cls.resumeFrom,
        resumeSessionId,
        tscPath: input.tscPath,
      }).catch((err: unknown) => err),
    );
    resumed += 1;
  }
  await Promise.allSettled(promises);
  return { resumed, terminalRecovered, unresolvable };
}

export function lookupResumeSessionId(
  db: DatabaseSync,
  taskId: string,
  stageName: string,
): string | undefined {
  const row = db.prepare(
    `SELECT aed.session_id FROM agent_execution_details aed
       JOIN stage_attempts sa ON sa.attempt_id = aed.attempt_id
      WHERE sa.task_id = ? AND sa.stage_name = ? AND aed.session_id IS NOT NULL
      ORDER BY aed.started_at DESC
      LIMIT 1`,
  ).get(taskId, stageName) as { session_id: string } | undefined;
  return row?.session_id ?? undefined;
}

function isSkippable(ir: PipelineIR, name: string): boolean {
  if (name === "__external__") return true;
  const stage = ir.stages.find((s) => s.name === name);
  return stage?.type === "gate";
}

function topologicalStageOrder(ir: PipelineIR): string[] {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const s of ir.stages) {
    inDegree.set(s.name, 0);
    adj.set(s.name, []);
  }
  for (const w of ir.wires) {
    if (!("stage" in w.from)) continue;
    const from = w.from.stage;
    const to = w.to.stage;
    if (!adj.has(from) || !inDegree.has(to)) continue;
    adj.get(from)!.push(to);
    inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
  }
  const queue: string[] = [];
  for (const [n, d] of inDegree) {
    if (d === 0) queue.push(n);
  }
  const out: string[] = [];
  while (queue.length > 0) {
    const n = queue.shift()!;
    out.push(n);
    for (const next of adj.get(n) ?? []) {
      const d = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  return out;
}
