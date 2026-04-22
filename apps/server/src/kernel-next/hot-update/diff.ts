// Pure function — no DB, no I/O. Compares two PipelineIR values and
// returns a structured diff. Terminal-design §10 / Stage 5A spec §3.

import type {
  PipelineIR, StageIR, WireIR, PortIR,
} from "../ir/schema.js";
import type {
  PipelineDiff, StageDiff, StageDiffChanges, PortTypeChange,
} from "./types.js";

export function computePipelineDiff(
  base: PipelineIR,
  proposed: PipelineIR,
): PipelineDiff {
  const baseStageByName = new Map(base.stages.map((s) => [s.name, s]));
  const propStageByName = new Map(proposed.stages.map((s) => [s.name, s]));

  const added:    StageIR[] = [];
  const removed:  { name: string; stage: StageIR }[] = [];
  const modified: StageDiff[] = [];
  const categoryUnion = new Set<
    "promptOnly" | "portsOnly" | "budgetOnly" | "structural"
  >();

  for (const [name, stage] of propStageByName) {
    if (!baseStageByName.has(name)) {
      added.push(stage);
      categoryUnion.add("structural");
    }
  }
  for (const [name, stage] of baseStageByName) {
    if (!propStageByName.has(name)) {
      removed.push({ name, stage });
      categoryUnion.add("structural");
    }
  }

  const routingChanged: PipelineDiff["routing"]["gateRoutingChanged"] = [];

  for (const [name, baseStage] of baseStageByName) {
    const propStage = propStageByName.get(name);
    if (!propStage) continue;
    if (baseStage.type !== propStage.type) {
      modified.push({
        stageName: name,
        type: propStage.type,
        changes: {},
        category: "structural",
      });
      categoryUnion.add("structural");
      continue;
    }

    const changes: StageDiffChanges = {};

    const inputsDiff = diffPorts(baseStage.inputs ?? [], propStage.inputs ?? []);
    if (inputsDiff) changes.inputs = inputsDiff;
    const outputsDiff = diffPorts(baseStage.outputs ?? [], propStage.outputs ?? []);
    if (outputsDiff) changes.outputs = outputsDiff;

    if (baseStage.type === "agent" && propStage.type === "agent") {
      if (baseStage.config.promptRef !== propStage.config.promptRef) {
        changes.promptRef = {
          before: baseStage.config.promptRef,
          after: propStage.config.promptRef,
        };
      }
    } else if (baseStage.type === "script" && propStage.type === "script") {
      if (baseStage.config.moduleId !== propStage.config.moduleId) {
        changes.moduleId = {
          before: baseStage.config.moduleId,
          after: propStage.config.moduleId,
        };
      }
    } else if (baseStage.type === "gate" && propStage.type === "gate") {
      const bq = baseStage.config.question;
      const pq = propStage.config.question;
      if (JSON.stringify(bq) !== JSON.stringify(pq)) {
        changes.question = { before: bq, after: pq };
      }
      const br = baseStage.config.routing;
      const pr = propStage.config.routing;
      if (JSON.stringify(br) !== JSON.stringify(pr)) {
        routingChanged.push({ stageName: name, before: br, after: pr });
      }
    }

    const hasRoutingChangeForThis = routingChanged.some((r) => r.stageName === name);
    if (Object.keys(changes).length === 0 && !hasRoutingChangeForThis) {
      continue;
    }

    const category = classifyStageCategory(changes, hasRoutingChangeForThis);
    modified.push({ stageName: name, type: propStage.type, changes, category });
    categoryUnion.add(category);
  }

  const wiresDiff = diffWires(base.wires, proposed.wires);
  if (wiresDiff.added.length > 0 || wiresDiff.removed.length > 0) {
    categoryUnion.add("structural");
  }

  return {
    stages: { added, removed, modified },
    wires: wiresDiff,
    routing: { gateRoutingChanged: routingChanged },
    categoryUnion: Array.from(categoryUnion),
  };
}

function diffPorts(
  base: PortIR[],
  proposed: PortIR[],
): StageDiffChanges["inputs"] | undefined {
  const baseByName = new Map(base.map((p) => [p.name, p]));
  const propByName = new Map(proposed.map((p) => [p.name, p]));
  const added:   PortIR[] = [];
  const removed: PortIR[] = [];
  const typeChanged: PortTypeChange[] = [];
  for (const [n, p] of propByName) {
    const b = baseByName.get(n);
    if (!b) { added.push(p); continue; }
    if (b.type !== p.type) {
      typeChanged.push({ port: n, beforeType: b.type, afterType: p.type });
    }
  }
  for (const [n, p] of baseByName) {
    if (!propByName.has(n)) removed.push(p);
  }
  if (added.length === 0 && removed.length === 0 && typeChanged.length === 0) {
    return undefined;
  }
  return { added, removed, typeChanged };
}

function diffWires(
  base: WireIR[], proposed: WireIR[],
): { added: WireIR[]; removed: WireIR[] } {
  const wireKey = (w: WireIR): string => {
    const from = w.from.source === "external"
      ? `ext:${w.from.port}`
      : `${(w.from as { stage: string }).stage}.${w.from.port}`;
    return `${from}->${w.to.stage}.${w.to.port}${w.guard ? `|${w.guard}` : ""}`;
  };
  const baseKeys = new Set(base.map(wireKey));
  const propKeys = new Set(proposed.map(wireKey));
  const added   = proposed.filter((w) => !baseKeys.has(wireKey(w)));
  const removed = base.filter((w) => !propKeys.has(wireKey(w)));
  return { added, removed };
}

function classifyStageCategory(
  changes: StageDiffChanges,
  hasRoutingChange: boolean,
): "promptOnly" | "portsOnly" | "budgetOnly" | "structural" {
  if (hasRoutingChange) return "structural";
  const keys = Object.keys(changes) as (keyof StageDiffChanges)[];
  if (keys.length === 0) return "structural";
  if (keys.length === 1 && keys[0] === "promptRef") return "promptOnly";
  return "structural";
}
