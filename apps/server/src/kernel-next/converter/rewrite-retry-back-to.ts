// Resolves script.retry.backToStage against the post-unwrap stage
// universe. If the legacy back_to pointed at a parallel block name
// (no longer present in the flat IR), rewrite it to the block's
// first inner stage and emit RETRY_BACK_TO_REDIRECTED. If it points
// at neither a stage nor a known block name, fail.

import type { StageIR } from "../ir/schema.js";
import type { ConverterDiagnostic, ConverterWarning } from "./types.js";

export type RewriteRetryBackToResult =
  | { ok: true; stages: StageIR[]; warnings: ConverterWarning[] }
  | { ok: false; diagnostics: ConverterDiagnostic[] };

export function rewriteRetryBackTo(
  stages: StageIR[],
  blockMap: Map<string, string>,
  stageNames: Set<string>,
): RewriteRetryBackToResult {
  const warnings: ConverterWarning[] = [];
  const diagnostics: ConverterDiagnostic[] = [];
  const out: StageIR[] = [];

  for (const s of stages) {
    if (s.type !== "script" || !s.config.retry) {
      out.push(s);
      continue;
    }
    const original = s.config.retry.backToStage;
    if (stageNames.has(original)) {
      out.push(s);
      continue;
    }
    const redirected = blockMap.get(original);
    if (redirected !== undefined) {
      warnings.push({
        code: "RETRY_BACK_TO_REDIRECTED",
        message: `stage '${s.name}' retry.back_to redirected from parallel block '${original}' to first inner stage '${redirected}'`,
        context: { stage: s.name, original, rewritten: redirected },
      });
      out.push({
        ...s,
        config: { ...s.config, retry: { ...s.config.retry, backToStage: redirected } },
      });
      continue;
    }
    diagnostics.push({
      code: "RETRY_BACK_TO_UNKNOWN",
      message: `stage '${s.name}' retry.back_to='${original}' names no stage and no parallel block`,
      context: { stage: s.name, backTo: original },
    });
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, stages: out, warnings };
}
