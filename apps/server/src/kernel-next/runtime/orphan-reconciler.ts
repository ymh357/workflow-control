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
import { deleteTaskEnvValues } from "./task-env-values.js";

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
  | { kind: "unresolvable"; reason: "no_attempts" | "ir_not_found" }
  | { kind: "secret_pending"; versionHash: string };

export function classifyOrphan(
  db: DatabaseSync,
  taskId: string,
): OrphanClassification {
  // F17: unresolved secret_gate_queue rows mark this task as paused
  // waiting for secrets. Reconciler must NOT auto-resume; the task
  // resumes only when provide_task_secrets is called.
  const hasPendingSecret = db.prepare(
    `SELECT 1 FROM secret_gate_queue WHERE task_id = ? AND resolved_at IS NULL LIMIT 1`,
  ).get(taskId) !== undefined;
  if (hasPendingSecret) {
    const latest = db.prepare(
      `SELECT version_hash FROM stage_attempts WHERE task_id = ? ORDER BY started_at DESC LIMIT 1`,
    ).get(taskId) as { version_hash: string } | undefined;
    return { kind: "secret_pending", versionHash: latest?.version_hash ?? "-" };
  }

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

  // Bug 58 (c12+ review Wave 2 T3): pre-fix, any stage_attempt with
  // status='success' marked the stage as completed — but for fanout
  // stages, only the `fanout_aggregate` row represents the whole
  // stage. A `fanout_element` success marks a single element; if
  // some elements succeeded but the aggregate never landed (runner
  // crashed mid-fanout), the pre-fix logic mistakenly considered the
  // stage "succeeded" and advanced resumeFrom past it. The next
  // stage's wires would then never see the aggregated array and the
  // run would hit NO_ACTIVE_WIRE forever.
  //
  // Correct rule: a fanout stage is successful when its
  // fanout_aggregate row is success. A non-fanout stage is
  // successful when any of its attempts is success (fanout_element
  // is irrelevant for non-fanout stages, and regular is the
  // canonical kind there).
  //
  // We compute it as "stages whose latest authoritative success row
  // exists with the right kind" by joining against the IR-known
  // fanout map. Stages we don't recognise from the IR (legacy IR
  // GC'd) fall back to the permissive pre-fix rule so we don't
  // regress recoverability for those — but the IR-not-found case is
  // already classified as `unresolvable` upstream.
  const fanoutStageNames = new Set<string>();
  for (const s of ir.stages) {
    if ((s.type === "agent" || s.type === "script") && s.fanout) {
      fanoutStageNames.add(s.name);
    }
  }
  const successStages = new Set<string>();
  {
    const rows = db.prepare(
      `SELECT stage_name, kind, status FROM stage_attempts
        WHERE task_id = ? AND status = 'success'`,
    ).all(taskId) as Array<{ stage_name: string; kind: string; status: string }>;
    for (const r of rows) {
      if (fanoutStageNames.has(r.stage_name)) {
        // Fanout stage: only fanout_aggregate counts as the stage
        // having succeeded. Element successes alone are a partial
        // state we must NOT treat as terminal.
        if (r.kind === "fanout_aggregate") successStages.add(r.stage_name);
      } else {
        successStages.add(r.stage_name);
      }
    }
  }
  // BUG-1 fix: a gate stage is only skippable once it has been answered.
  // Previously every gate was skippable unconditionally — an orphan task
  // that died while blocked on an unanswered gate would have its resume
  // pointer advance past the gate to a downstream stage, whose
  // gateAuthorizedTargets were never populated, leaving the downstream
  // stage permanently in `waiting`. If every remaining stage happened to
  // be a skippable gate, classification would wrongly return `terminal`
  // and the task would be force-completed without ever running the gated
  // work. Answered gates must stay skippable so we don't re-open a
  // gate the user already resolved.
  const answeredGates = new Set(
    (db.prepare(
      `SELECT stage_name FROM gate_queue
        WHERE task_id = ? AND answer IS NOT NULL`,
    ).all(taskId) as Array<{ stage_name: string }>).map((r) => r.stage_name),
  );
  const order = topologicalStageOrder(ir);
  const firstPending = order.find(
    (name) => !successStages.has(name) && !isSkippable(ir, name, answeredGates),
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
  /**
   * Bug 56 (c12+ review Wave 2 T3): cap on concurrent resume
   * dispatches. Pre-fix the reconciler used Promise.allSettled with N
   * resumes spawned in one tick — a multi-task crash boot synthesised
   * an instant rate-limit storm against the Anthropic API. Default
   * keeps boot fast while bounding the fan-out; callers running on a
   * heavily-throttled key can dial it lower. 0 / negative falls back
   * to default.
   */
  resumeConcurrency?: number;
  /**
   * Inter-resume stagger in ms. The first batch fires immediately,
   * each subsequent slot waits this long before kicking the next
   * resume. Smooths the per-task SDK warm-up cost across the boot
   * window rather than hammering the connection pool. 0 disables
   * the stagger entirely (back to "as fast as possible").
   */
  resumeStaggerMs?: number;
}

const DEFAULT_RESUME_CONCURRENCY = 4;
const DEFAULT_RESUME_STAGGER_MS = 250;

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

  // Bug 43 (c12+ review Wave 2 T3): a migration that ended in
  // RESUME_FAILED (or whose runner died after supersede but before
  // the new attempts opened) can leave fanout_element rows still
  // tagged status='running'. They aren't covered by
  // reconcileRunningAttempts above (which only handles task-level
  // running) — sweep them per-orphan task here so the resumed runner
  // sees a clean world.
  reconcileFanoutElementOrphans(db, orphans);

  let resumed = 0;
  let terminalRecovered = 0;
  let unresolvable = 0;
  const now = Date.now();
  // Tasks queued for actual resume after classification — held in a
  // separate list so we can throttle concurrency rather than spawning
  // every single resume in one tick (Bug 56).
  const resumeQueue: Array<{
    taskId: string;
    versionHash: string;
    resumeFrom: string;
    resumeSessionId: string | undefined;
  }> = [];

  for (const taskId of orphans) {
    const cls = classifyOrphan(db, taskId);
    if (cls.kind === "terminal") {
      db.prepare(
        `INSERT OR IGNORE INTO task_finals (task_id, version_hash, final_state, reason, detail, ended_at)
         VALUES (?, ?, 'completed', 'natural', 'recovered_no_finals_row', ?)`,
      ).run(taskId, cls.versionHash, now);
      // P3.6: plaintext env tokens must not outlive the task lifetime.
      deleteTaskEnvValues(db, taskId);
      terminalRecovered += 1;
      continue;
    }
    if (cls.kind === "secret_pending") {
      // F17: don't auto-resume; don't write task_finals (the task is paused).
      // The task remains in this state until provide_task_secrets resolves
      // its secret_gate_queue row, which itself triggers retryTaskFromStage.
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
      // P3.6: plaintext env tokens must not outlive the task lifetime.
      deleteTaskEnvValues(db, taskId);
      unresolvable += 1;
      continue;
    }
    const resumeSessionId = lookupResumeSessionId(db, taskId, cls.resumeFrom);
    resumeQueue.push({
      taskId,
      versionHash: cls.versionHash,
      resumeFrom: cls.resumeFrom,
      resumeSessionId,
    });
    resumed += 1;
  }

  // Bug 56: throttled fan-out. Cap concurrent in-flight resumes at
  // resumeConcurrency and stagger each new dispatch by
  // resumeStaggerMs to smooth API connection-pool pressure during
  // multi-task crash recovery. The original Promise.allSettled
  // approach kicked N resumes simultaneously and hit Anthropic rate
  // limits within the first second on any non-trivial run.
  const maxConcurrent =
    input.resumeConcurrency && input.resumeConcurrency > 0
      ? input.resumeConcurrency
      : DEFAULT_RESUME_CONCURRENCY;
  const staggerMs =
    input.resumeStaggerMs !== undefined && input.resumeStaggerMs >= 0
      ? input.resumeStaggerMs
      : DEFAULT_RESUME_STAGGER_MS;

  const dispatch = async (job: typeof resumeQueue[number]): Promise<unknown> => {
    try {
      return await input.startPipelineRun({
        taskId: job.taskId,
        versionHash: job.versionHash,
        resumeFrom: job.resumeFrom,
        resumeSessionId: job.resumeSessionId,
        tscPath: input.tscPath,
      });
    } catch (err) {
      return err;
    }
  };

  const inFlight = new Set<Promise<unknown>>();
  for (const job of resumeQueue) {
    if (inFlight.size >= maxConcurrent) {
      await Promise.race(inFlight);
    }
    if (staggerMs > 0 && inFlight.size > 0) {
      await new Promise<void>((res) => setTimeout(res, staggerMs));
    }
    const p = dispatch(job).finally(() => { inFlight.delete(p); });
    inFlight.add(p);
  }
  await Promise.allSettled(inFlight);

  return { resumed, terminalRecovered, unresolvable };
}

/**
 * Bug 43 (c12+ review Wave 2 T3): RESUME_FAILED migrations can leave
 * fanout_element attempts tagged status='running' even though the
 * orchestrator that owned them is gone. The reconciler-style sweep
 * handles them the same way as task-level running attempts:
 * supersede-with-AED-update so the resumed runner doesn't
 * mis-attribute their port_values to live execution.
 *
 * Limited to orphan task ids so we don't touch live runners' fanout
 * mid-flight on a fresh boot (live runners would not be in the
 * orphan set yet — task_finals doesn't exist for them, but the
 * runner is also not live; the boot sequence is the only caller).
 */
function reconcileFanoutElementOrphans(db: DatabaseSync, taskIds: string[]): void {
  if (taskIds.length === 0) return;
  const placeholders = taskIds.map(() => "?").join(",");
  const now = Date.now();
  const rows = db.prepare(
    `SELECT attempt_id FROM stage_attempts
      WHERE task_id IN (${placeholders})
        AND status = 'running'
        AND kind = 'fanout_element'`,
  ).all(...taskIds) as Array<{ attempt_id: string }>;
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.attempt_id);
  const idPh = ids.map(() => "?").join(",");
  db.prepare(
    `UPDATE stage_attempts SET status = 'superseded'
      WHERE attempt_id IN (${idPh})`,
  ).run(...ids);
  db.prepare(
    `UPDATE agent_execution_details
        SET termination_reason = 'interrupted', ended_at = ?
      WHERE attempt_id IN (${idPh}) AND ended_at IS NULL`,
  ).run(now, ...ids);
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
  return row?.session_id;
}

function isSkippable(ir: PipelineIR, name: string, answeredGates: Set<string>): boolean {
  if (name === "__external__") return true;
  const stage = ir.stages.find((s) => s.name === name);
  // Only answered gates are skippable — see BUG-1 comment in classifyOrphan.
  return stage?.type === "gate" && answeredGates.has(name);
}

function topologicalStageOrder(ir: PipelineIR): string[] {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const s of ir.stages) {
    inDegree.set(s.name, 0);
    adj.set(s.name, []);
  }
  // Tolerate legacy IR rows missing `wires` entirely — the earliest
  // kernel-next drafts stored it omitted. Topological order reduces
  // to "any linear sequence of declared stages" in that case, which
  // is good enough for orphan classification.
  for (const w of ir.wires ?? []) {
    if (!("stage" in w.from)) continue;
    // Skip gate-feedback wires (`<gate>.__gate_feedback__ → <upstream>.rejectionFeedback`).
    // These are reject-loop edges that do NOT participate in the forward DAG;
    // including them as forward edges creates spurious cycles and zeros out
    // every stage's "is a topological root" candidacy, leaving the topo sort
    // empty — which classifyOrphan then misreads as "no pending stages =
    // terminal." Mirrors `validator/dag.ts:44` which excludes the same edge
    // class from cycle detection. Dogfood Finding 12 (2026-04-26).
    if (w.from.port === "__gate_feedback__") continue;
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
