// Pure SQL queries for lineage / diff_runs. No MCP deps; called by both
// the MCP tool handlers and tests.

import type { DatabaseSync } from "node:sqlite";

export interface LineageReport {
  port: { stage: string; port: string };
  latestWrite: {
    attemptId: string;
    attemptIdx: number;
    taskId: string;
    writtenAt: number;
    valuePreview: string;  // truncated JSON, first 200 chars
    truncated: boolean;
    totalBytes: number;
  } | null;
  // Every attempt that read this port as input.
  downstream: Array<{
    attemptId: string;
    taskId: string;
    stageName: string;
    portName: string;      // the input port that consumed the value
    attemptIdx: number;
    readAt: number;
  }>;
}

const PREVIEW_BYTES = 200;

export function queryLineage(
  db: DatabaseSync,
  args: { stage: string; port: string; taskId?: string },
): LineageReport {
  const latestRow = args.taskId
    ? db.prepare(
        `SELECT pv.value_json, pv.attempt_id, pv.written_at, sa.task_id, sa.attempt_idx
         FROM port_values pv
         JOIN stage_attempts sa ON sa.attempt_id = pv.attempt_id
         WHERE pv.stage_name = ? AND pv.port_name = ? AND pv.direction = 'out'
           AND sa.task_id = ?
         ORDER BY pv.written_at DESC LIMIT 1`,
      ).get(args.stage, args.port, args.taskId)
    : db.prepare(
        `SELECT pv.value_json, pv.attempt_id, pv.written_at, sa.task_id, sa.attempt_idx
         FROM port_values pv
         JOIN stage_attempts sa ON sa.attempt_id = pv.attempt_id
         WHERE pv.stage_name = ? AND pv.port_name = ? AND pv.direction = 'out'
         ORDER BY pv.written_at DESC LIMIT 1`,
      ).get(args.stage, args.port);

  let latestWrite: LineageReport["latestWrite"] = null;
  if (latestRow) {
    const r = latestRow as {
      value_json: string; attempt_id: string; written_at: number;
      task_id: string; attempt_idx: number;
    };
    const total = Buffer.byteLength(r.value_json, "utf8");
    const preview = r.value_json.slice(0, PREVIEW_BYTES);
    latestWrite = {
      attemptId: r.attempt_id,
      attemptIdx: r.attempt_idx,
      taskId: r.task_id,
      writtenAt: r.written_at,
      valuePreview: preview,
      truncated: total > PREVIEW_BYTES,
      totalBytes: total,
    };
  }

  // Downstream: every attempt that read a port whose value was sourced from
  // (stage, port). In M3 we record direction='in' with the downstream stage's
  // input port name; the wire from (stage, port) to that input port is IR
  // metadata the query doesn't have. We return all 'in' reads whose source is
  // (stage, port) by joining to stages/wires via IR, BUT for spike simplicity
  // we report all 'in' reads that happened AFTER the latestWrite and share the
  // same taskId.
  //
  // A more precise impl needs the IR to resolve the wire target; that's
  // acceptable post-spike. For now this is a "readers that could have seen
  // this value" upper-bound — sufficient for diamond verification.
  const downstreamRows = (args.taskId
    ? db.prepare(
        `SELECT pv.attempt_id, sa.task_id, pv.stage_name, pv.port_name,
                sa.attempt_idx, pv.written_at
         FROM port_values pv
         JOIN stage_attempts sa ON sa.attempt_id = pv.attempt_id
         WHERE pv.direction = 'in' AND sa.task_id = ?
         ORDER BY pv.written_at ASC`,
      ).all(args.taskId)
    : db.prepare(
        `SELECT pv.attempt_id, sa.task_id, pv.stage_name, pv.port_name,
                sa.attempt_idx, pv.written_at
         FROM port_values pv
         JOIN stage_attempts sa ON sa.attempt_id = pv.attempt_id
         WHERE pv.direction = 'in'
         ORDER BY pv.written_at ASC`,
      ).all()
  ) as Array<{
    attempt_id: string; task_id: string; stage_name: string;
    port_name: string; attempt_idx: number; written_at: number;
  }>;

  return {
    port: { stage: args.stage, port: args.port },
    latestWrite,
    downstream: downstreamRows.map((r) => ({
      attemptId: r.attempt_id,
      taskId: r.task_id,
      stageName: r.stage_name,
      portName: r.port_name,
      attemptIdx: r.attempt_idx,
      readAt: r.written_at,
    })),
  };
}

// --- diff_runs ---

export interface DiffReport {
  taskA: string;
  taskB: string;
  versionHashA: string | null;
  versionHashB: string | null;
  stageComparison: Array<{
    stage: string;
    attemptIdxA: number | null;
    attemptIdxB: number | null;
    outputsEqual: boolean;
    outputsOnlyInA: string[];  // port names present in A's outputs but not B
    outputsOnlyInB: string[];
    outputsDiffer: string[];   // port names where both wrote but value differs
  }>;
}

export function diffRuns(db: DatabaseSync, taskA: string, taskB: string): DiffReport {
  const versionHash = (taskId: string): string | null => {
    const row = db.prepare(
      `SELECT version_hash FROM stage_attempts
       WHERE task_id = ? ORDER BY started_at LIMIT 1`,
    ).get(taskId) as { version_hash: string } | undefined;
    return row?.version_hash ?? null;
  };

  // For each (task, stage) get the latest successful attempt's outputs map.
  const latestOutputsByStage = (taskId: string): Map<string, { attemptIdx: number; outputs: Map<string, string> }> => {
    const rows = db.prepare(
      `SELECT sa.stage_name, sa.attempt_idx, pv.port_name, pv.value_json
       FROM stage_attempts sa
       LEFT JOIN port_values pv
         ON pv.attempt_id = sa.attempt_id AND pv.direction = 'out'
       WHERE sa.task_id = ? AND sa.status = 'success'
       ORDER BY sa.stage_name, sa.attempt_idx DESC`,
    ).all(taskId) as Array<{
      stage_name: string; attempt_idx: number;
      port_name: string | null; value_json: string | null;
    }>;

    // Keep only the row with the highest attempt_idx per stage.
    const out = new Map<string, { attemptIdx: number; outputs: Map<string, string> }>();
    for (const r of rows) {
      const entry = out.get(r.stage_name);
      if (!entry) {
        out.set(r.stage_name, {
          attemptIdx: r.attempt_idx,
          outputs: new Map(
            r.port_name && r.value_json ? [[r.port_name, r.value_json]] : [],
          ),
        });
      } else if (r.attempt_idx === entry.attemptIdx && r.port_name && r.value_json) {
        entry.outputs.set(r.port_name, r.value_json);
      }
    }
    return out;
  };

  const a = latestOutputsByStage(taskA);
  const b = latestOutputsByStage(taskB);
  const stageNames = new Set([...a.keys(), ...b.keys()]);

  const stageComparison: DiffReport["stageComparison"] = [];
  for (const stage of [...stageNames].sort()) {
    const entA = a.get(stage);
    const entB = b.get(stage);
    const aPorts = entA ? new Set(entA.outputs.keys()) : new Set<string>();
    const bPorts = entB ? new Set(entB.outputs.keys()) : new Set<string>();
    const onlyA: string[] = [];
    const onlyB: string[] = [];
    const differ: string[] = [];
    for (const p of aPorts) if (!bPorts.has(p)) onlyA.push(p);
    for (const p of bPorts) if (!aPorts.has(p)) onlyB.push(p);
    for (const p of aPorts) {
      if (bPorts.has(p) && entA!.outputs.get(p) !== entB!.outputs.get(p)) {
        differ.push(p);
      }
    }
    stageComparison.push({
      stage,
      attemptIdxA: entA?.attemptIdx ?? null,
      attemptIdxB: entB?.attemptIdx ?? null,
      outputsEqual: onlyA.length === 0 && onlyB.length === 0 && differ.length === 0,
      outputsOnlyInA: onlyA.sort(),
      outputsOnlyInB: onlyB.sort(),
      outputsDiffer: differ.sort(),
    });
  }

  return {
    taskA, taskB,
    versionHashA: versionHash(taskA),
    versionHashB: versionHash(taskB),
    stageComparison,
  };
}
