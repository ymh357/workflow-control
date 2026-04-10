import {
  validatePipelineLogic,
  type ValidationIssue,
} from "@workflow-control/shared";

export type { ValidationIssue };

interface PipelineEditorState {
  pipeline: { stages: unknown[]; [key: string]: unknown };
  prompts: Record<string, string>;
}

function normalizePromptKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().replace(/\.md$/, "");
}

export function validatePipeline(
  state: PipelineEditorState,
  knownMcps?: Set<string>,
): ValidationIssue[] {
  const promptKeys = new Set(Object.keys(state.prompts).map(normalizePromptKey));
  const injected = Array.isArray((state.pipeline as any).injected_context) ? new Set((state.pipeline as any).injected_context as string[]) : undefined;
  return validatePipelineLogic(state.pipeline.stages as any, promptKeys, knownMcps, injected);
}

export function getStageIssues(
  issues: ValidationIssue[],
  stageIndex: number
): ValidationIssue[] {
  return issues.filter((i) => i.stageIndex === stageIndex);
}

export function getIssueSummary(issues: ValidationIssue[]): {
  errors: number;
  warnings: number;
  infos: number;
} {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const i of issues) {
    if (i.severity === "error") errors++;
    else if (i.severity === "warning") warnings++;
    else infos++;
  }
  return { errors, warnings, infos };
}
