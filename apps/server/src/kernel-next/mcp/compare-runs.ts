// A4 compare_runs — execution-record-level diff between two tasks.
//
// Complements diff_runs (port-output-level only). Produces per-stage +
// aggregate deltas on cost / tokens / duration / tool usage / compact
// events / termination_reason, plus prompt-content-hash equality to
// tell whether the stage's prompt was edited between runs.
//
// Selection rule: the LAST attempt_idx per (task, stage) where
// kind IN ('regular','fanout_aggregate','replay','dry_run'). fanout_element
// attempts are excluded at this level — the aggregate attempt already
// carries the stage's effective output + cost summary; per-element
// detail is noise in a high-level diff.
//
// Script attempts (no agent_execution_details row) get null for every
// AED-derived field — the caller sees null deltas for those stages and
// can treat them as "nothing to diff at the execution-record level".

import type { DatabaseSync } from "node:sqlite";

export interface CompareRunsStageEntry {
  stage: string;
  attemptIdxA: number | null;
  attemptIdxB: number | null;
  /** null when either side has no AED row (script stage). */
  promptContentHashEqual: boolean | null;
  /** A - B. null when either side has no AED row or no cost captured. */
  costDeltaUsd: number | null;
  tokenInputDelta: number | null;
  tokenOutputDelta: number | null;
  durationDeltaMs: number | null;
  toolCallCountA: number | null;
  toolCallCountB: number | null;
  toolNamesOnlyInA: string[];
  toolNamesOnlyInB: string[];
  compactEventsCountA: number | null;
  compactEventsCountB: number | null;
  terminationReasonA: string | null;
  terminationReasonB: string | null;
}

export interface CompareRunsReport {
  taskA: string;
  taskB: string;
  versionHashA: string | null;
  versionHashB: string | null;
  stageComparison: CompareRunsStageEntry[];
  totals: {
    costDeltaUsd: number | null;
    tokenInputDelta: number | null;
    tokenOutputDelta: number | null;
    durationDeltaMs: number | null;
    stagesOnlyInA: string[];
    stagesOnlyInB: string[];
  };
}

interface AttemptAed {
  attemptIdx: number;
  promptHash: string | null;
  costUsd: number | null;
  tokenInput: number | null;
  tokenOutput: number | null;
  durationMs: number | null;
  terminationReason: string | null;
  toolNames: string[];
  toolCallCount: number;
  compactEventsCount: number;
  hasAed: boolean;
}

const SELECTED_KINDS = ["regular", "fanout_aggregate", "replay", "dry_run"] as const;

function loadStages(
  db: DatabaseSync,
  taskId: string,
): Map<string, AttemptAed> {
  const placeholders = SELECTED_KINDS.map(() => "?").join(",");
  // Pick the latest attempt_idx per stage across the selected kinds.
  const rows = db.prepare(
    `SELECT sa.stage_name, sa.attempt_idx,
            aed.prompt_content_hash, aed.cost_usd,
            aed.token_input, aed.token_output, aed.duration_ms,
            aed.termination_reason, aed.tool_calls_json, aed.compact_events_json
     FROM stage_attempts sa
     LEFT JOIN agent_execution_details aed ON aed.attempt_id = sa.attempt_id
     WHERE sa.task_id = ? AND sa.kind IN (${placeholders})
     ORDER BY sa.stage_name, sa.attempt_idx DESC`,
  ).all(taskId, ...SELECTED_KINDS) as Array<{
    stage_name: string;
    attempt_idx: number;
    prompt_content_hash: string | null;
    cost_usd: number | null;
    token_input: number | null;
    token_output: number | null;
    duration_ms: number | null;
    termination_reason: string | null;
    tool_calls_json: string | null;
    compact_events_json: string | null;
  }>;

  const out = new Map<string, AttemptAed>();
  for (const r of rows) {
    if (out.has(r.stage_name)) continue; // DESC order → first wins
    const toolCalls = safeParseArray(r.tool_calls_json);
    const compactEvents = safeParseArray(r.compact_events_json);
    const toolNames = toolCalls
      .map((t) => (typeof t === "object" && t !== null && "name" in t ? String((t as { name: unknown }).name) : null))
      .filter((n): n is string => typeof n === "string");
    out.set(r.stage_name, {
      attemptIdx: r.attempt_idx,
      promptHash: r.prompt_content_hash,
      costUsd: r.cost_usd,
      tokenInput: r.token_input,
      tokenOutput: r.token_output,
      durationMs: r.duration_ms,
      terminationReason: r.termination_reason,
      toolNames,
      toolCallCount: toolCalls.length,
      compactEventsCount: compactEvents.length,
      hasAed: r.prompt_content_hash !== null
        || r.cost_usd !== null
        || r.token_input !== null
        || r.tool_calls_json !== null,
    });
  }
  return out;
}

function safeParseArray(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function delta(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return a - b;
}

function earliestVersionHash(db: DatabaseSync, taskId: string): string | null {
  const row = db.prepare(
    `SELECT version_hash FROM stage_attempts
     WHERE task_id = ? ORDER BY started_at LIMIT 1`,
  ).get(taskId) as { version_hash: string } | undefined;
  return row?.version_hash ?? null;
}

export function compareRuns(
  db: DatabaseSync,
  taskA: string,
  taskB: string,
): CompareRunsReport {
  const a = loadStages(db, taskA);
  const b = loadStages(db, taskB);
  const stageNames = new Set([...a.keys(), ...b.keys()]);

  const stageComparison: CompareRunsStageEntry[] = [];
  const stagesOnlyInA: string[] = [];
  const stagesOnlyInB: string[] = [];
  let costTotal: number | null = 0;
  let tokenInTotal: number | null = 0;
  let tokenOutTotal: number | null = 0;
  let durationTotal: number | null = 0;

  for (const stage of [...stageNames].sort()) {
    const entA = a.get(stage);
    const entB = b.get(stage);
    if (entA && !entB) stagesOnlyInA.push(stage);
    if (!entA && entB) stagesOnlyInB.push(stage);

    const hashEqual: boolean | null =
      entA?.hasAed && entB?.hasAed && entA.promptHash !== null && entB.promptHash !== null
        ? entA.promptHash === entB.promptHash
        : null;

    const toolsA = entA?.hasAed ? new Set(entA.toolNames) : null;
    const toolsB = entB?.hasAed ? new Set(entB.toolNames) : null;
    const onlyA: string[] = [];
    const onlyB: string[] = [];
    if (toolsA && toolsB) {
      for (const t of toolsA) if (!toolsB.has(t)) onlyA.push(t);
      for (const t of toolsB) if (!toolsA.has(t)) onlyB.push(t);
    }

    const costD = delta(entA?.costUsd ?? null, entB?.costUsd ?? null);
    const tiD = delta(entA?.tokenInput ?? null, entB?.tokenInput ?? null);
    const toD = delta(entA?.tokenOutput ?? null, entB?.tokenOutput ?? null);
    const duD = delta(entA?.durationMs ?? null, entB?.durationMs ?? null);

    // Totals roll up only when BOTH sides have a value for the stage —
    // otherwise set the total to null (unknown, don't misrepresent).
    if (costD === null) costTotal = null; else if (costTotal !== null) costTotal += costD;
    if (tiD === null) tokenInTotal = null; else if (tokenInTotal !== null) tokenInTotal += tiD;
    if (toD === null) tokenOutTotal = null; else if (tokenOutTotal !== null) tokenOutTotal += toD;
    if (duD === null) durationTotal = null; else if (durationTotal !== null) durationTotal += duD;

    stageComparison.push({
      stage,
      attemptIdxA: entA?.attemptIdx ?? null,
      attemptIdxB: entB?.attemptIdx ?? null,
      promptContentHashEqual: hashEqual,
      costDeltaUsd: costD,
      tokenInputDelta: tiD,
      tokenOutputDelta: toD,
      durationDeltaMs: duD,
      toolCallCountA: entA?.hasAed ? entA.toolCallCount : null,
      toolCallCountB: entB?.hasAed ? entB.toolCallCount : null,
      toolNamesOnlyInA: onlyA.sort(),
      toolNamesOnlyInB: onlyB.sort(),
      compactEventsCountA: entA?.hasAed ? entA.compactEventsCount : null,
      compactEventsCountB: entB?.hasAed ? entB.compactEventsCount : null,
      terminationReasonA: entA?.terminationReason ?? null,
      terminationReasonB: entB?.terminationReason ?? null,
    });
  }

  return {
    taskA, taskB,
    versionHashA: earliestVersionHash(db, taskA),
    versionHashB: earliestVersionHash(db, taskB),
    stageComparison,
    totals: {
      costDeltaUsd: costTotal,
      tokenInputDelta: tokenInTotal,
      tokenOutputDelta: tokenOutTotal,
      durationDeltaMs: durationTotal,
      stagesOnlyInA: stagesOnlyInA.sort(),
      stagesOnlyInB: stagesOnlyInB.sort(),
    },
  };
}
