import { flattenStages, type PipelineStageConfig, type PipelineStageEntry } from "./types.js";

export function findStageConfig(
  stages: PipelineStageEntry[] | undefined,
  stageName: string,
): PipelineStageConfig | undefined {
  if (!stages) return undefined;
  return flattenStages(stages).find((s) => s.name === stageName);
}
