// Impact analysis — reads DB to determine which active tasks would be
// affected by migrating to the proposed IR. Stage 5A design §4.
//
// Read-only: this module does not write to the DB. Outputs Impact
// (activeTasks + schemaDriftIssues + newSubmissionsOk) for downstream
// consumption by propose-pipeline / safeRange / dry-run.

import type { DatabaseSync } from "node:sqlite";
import type { PipelineIR, WireIR } from "../ir/schema.js";
import type { Impact, TaskImpact, SchemaDriftIssue } from "./types.js";
import { topoDownstream } from "../runtime/topo-downstream.js";

// Narrow a WireIR.from to the "stage" branch. WireIR.from may also be
// { source: "external", port }; those have no producing stage and are
// excluded from stage-to-stage reasoning.
function wireFromStage(w: WireIR): { stage: string; port: string } | null {
  if (w.from.source === "external") return null;
  // Legacy WireIR allows source to be absent (defaulted to "stage").
  return { stage: w.from.stage, port: w.from.port };
}

export function computeImpact(
  db: DatabaseSync,
  currentVersion: string,
  proposedIR: PipelineIR,
  rerunFrom: string | null | undefined,
): Impact {
  const baseRow = db.prepare(
    `SELECT ir_json FROM pipeline_versions WHERE version_hash = ?`,
  ).get(currentVersion) as { ir_json: string } | undefined;
  if (!baseRow) {
    return {
      activeTasks: [],
      newSubmissionsOk: true,
      schemaDriftIssues: [{
        kind: "port_type_change_with_live_values",
        stageName: "__unknown__",
        details: `currentVersion '${currentVersion}' not found in pipeline_versions`,
      }],
    };
  }
  const baseIR = JSON.parse(baseRow.ir_json) as PipelineIR;

  // Active tasks: status='running' on this version. The stage_attempts
  // CHECK constraint only admits 'running','success','error','superseded',
  // so there is no 'pending' status to consider here.
  const activeTaskRows = db.prepare(
    `SELECT DISTINCT task_id FROM stage_attempts
     WHERE version_hash = ? AND status = 'running'`,
  ).all(currentVersion) as Array<{ task_id: string }>;

  const proposedStageNames = new Set(proposedIR.stages.map((s) => s.name));
  const removedStageNames = baseIR.stages
    .filter((s) => !proposedStageNames.has(s.name))
    .map((s) => s.name);

  const downstream = rerunFrom
    ? new Set(topoDownstream(proposedIR.wires, rerunFrom).concat([rerunFrom]))
    : new Set<string>();

  // affectedStages for each task = rerunFrom+downstream ∪ removed stages.
  // Design §4: a stage is "affected" if it will be re-executed post-migration
  // (rerun-from closure) or is missing from the proposed IR.
  const affectedUnion = new Set<string>([
    ...downstream,
    ...removedStageNames,
  ]);

  const activeTasks: TaskImpact[] = [];
  for (const { task_id: taskId } of activeTaskRows) {
    const currentStageRow = db.prepare(
      `SELECT stage_name FROM stage_attempts
       WHERE task_id = ? AND status = 'running'
       ORDER BY started_at DESC LIMIT 1`,
    ).get(taskId) as { stage_name: string } | undefined;
    const currentStage = currentStageRow?.stage_name ?? null;

    const blocking: string[] = [];
    let resumable = true;

    if (currentStage && removedStageNames.includes(currentStage)) {
      resumable = false;
      blocking.push(
        `current stage '${currentStage}' removed in proposed pipeline`,
      );
    }

    for (const removedStageName of removedStageNames) {
      const stage = baseIR.stages.find((s) => s.name === removedStageName);
      if (!stage) continue;
      for (const out of stage.outputs ?? []) {
        const hasDownstreamReader = baseIR.wires.some((w) => {
          const src = wireFromStage(w);
          return src !== null
            && src.stage === removedStageName
            && src.port === out.name;
        });
        if (hasDownstreamReader) {
          resumable = false;
          blocking.push(
            `removed stage '${removedStageName}' has wired consumers of output '${out.name}'`,
          );
        }
      }
    }

    activeTasks.push({
      taskId,
      currentStage,
      affectedStages: Array.from(affectedUnion).sort(),
      resumable,
      blockingReasons: blocking,
    });
  }

  // Schema drift: port type changes on ports that have live port_values,
  // plus proposed wires referencing stages removed in the proposal.
  const schemaDriftIssues: SchemaDriftIssue[] = [];
  for (const proposedStage of proposedIR.stages) {
    const baseStage = baseIR.stages.find((s) => s.name === proposedStage.name);
    if (!baseStage) continue;
    for (const dir of ["inputs", "outputs"] as const) {
      for (const p of proposedStage[dir] ?? []) {
        const b = (baseStage[dir] ?? []).find((x) => x.name === p.name);
        if (!b) continue;
        if (b.type === p.type) continue;
        const directionKey = dir === "outputs" ? "out" : "in";
        const row = db.prepare(
          `SELECT 1 AS present FROM port_values
           WHERE stage_name = ? AND port_name = ? AND direction = ? LIMIT 1`,
        ).get(proposedStage.name, p.name, directionKey) as
          | { present: number }
          | undefined;
        if (row) {
          schemaDriftIssues.push({
            kind: "port_type_change_with_live_values",
            stageName: proposedStage.name,
            portName: p.name,
            details: `${b.type} → ${p.type} (live value exists)`,
          });
        }
      }
    }
  }

  for (const removedStageName of removedStageNames) {
    const stage = baseIR.stages.find((s) => s.name === removedStageName);
    if (!stage) continue;
    for (const out of stage.outputs ?? []) {
      const consumer = proposedIR.wires.find((w) => {
        const src = wireFromStage(w);
        return src !== null
          && src.stage === removedStageName
          && src.port === out.name;
      });
      if (consumer) {
        schemaDriftIssues.push({
          kind: "removed_stage_with_downstream_readers",
          stageName: removedStageName,
          portName: out.name,
          details: `stage removed but proposed wires still reference '${removedStageName}.${out.name}'`,
        });
      }
    }
  }

  return {
    activeTasks,
    newSubmissionsOk: true,
    schemaDriftIssues,
  };
}
