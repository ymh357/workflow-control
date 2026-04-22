// Pure function — classifies a PipelineDiff + Impact into a safe/unsafe
// verdict per Stage 5A design §5.

import type { PipelineDiff, Impact, SafeRangeVerdict } from "./types.js";

export function classifySafeRange(
  diff: PipelineDiff,
  impact: Impact,
): SafeRangeVerdict {
  const reasons: string[] = [];

  if (diff.categoryUnion.length === 0) {
    return { verdict: "safe", category: "empty", reasons: [] };
  }

  const hasStructural = diff.categoryUnion.includes("structural");
  if (hasStructural) {
    if (diff.stages.added.length > 0) {
      reasons.push(`adds ${diff.stages.added.length} stage(s) — structural change`);
    }
    if (diff.stages.removed.length > 0) {
      reasons.push(`removes ${diff.stages.removed.length} stage(s) — structural change`);
    }
    if (diff.wires.added.length > 0 || diff.wires.removed.length > 0) {
      reasons.push(
        `wire changes (added=${diff.wires.added.length}, removed=${diff.wires.removed.length}) — structural change`,
      );
    }
    if (diff.routing.gateRoutingChanged.length > 0) {
      reasons.push(
        `gate routing changed on ${diff.routing.gateRoutingChanged.length} stage(s) — structural change`,
      );
    }
    for (const m of diff.stages.modified) {
      if (m.category === "structural") {
        reasons.push(`stage '${m.stageName}' has structural changes (ports / moduleId / question)`);
      }
    }
  }

  if (impact.schemaDriftIssues.length > 0) {
    for (const issue of impact.schemaDriftIssues) {
      reasons.push(
        `schema drift on ${issue.stageName}${issue.portName ? "." + issue.portName : ""}: ${issue.details}`,
      );
    }
  }

  for (const t of impact.activeTasks) {
    if (!t.resumable) {
      reasons.push(
        `task '${t.taskId}' not resumable: ${t.blockingReasons.join("; ")}`,
      );
    }
  }

  const verdict = reasons.length === 0 ? "safe" : "unsafe";

  let category: SafeRangeVerdict["category"];
  if (
    diff.categoryUnion.length === 1 &&
    diff.categoryUnion[0] === "promptOnly"
  ) {
    category = "promptOnly";
  } else if (hasStructural) {
    category = "structural";
  } else {
    category = diff.categoryUnion[0] ?? "empty";
  }

  return { verdict, category, reasons };
}
