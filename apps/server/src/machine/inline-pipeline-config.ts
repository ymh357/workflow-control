import type { PipelineConfig } from "../lib/config/types.js";
import type { WorkflowContext } from "./types.js";
import { flattenStages } from "../lib/config/types.js";

/**
 * Build a WorkflowContext config from an inline pipeline definition.
 * Inherits fragments, constraints, and project instructions from the parent task config.
 * System prompts come from the pipeline's inline_prompts field.
 */
export function buildInlinePipelineConfig(
  pipeline: PipelineConfig,
  parentConfig?: WorkflowContext["config"],
): NonNullable<WorkflowContext["config"]> {
  const systemPrompts: Record<string, string> = {};
  if (pipeline.inline_prompts) {
    const toCamel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    for (const [key, content] of Object.entries(pipeline.inline_prompts)) {
      systemPrompts[toCamel(key)] = content;
    }
  }

  const pipelineMcps = new Set<string>(parentConfig?.mcps ?? []);
  for (const stage of flattenStages(pipeline.stages)) {
    if (stage.mcps) for (const m of stage.mcps) pipelineMcps.add(m);
  }

  return {
    pipelineName: pipeline.name,
    pipeline,
    prompts: {
      system: systemPrompts,
      fragments: parentConfig?.prompts.fragments ?? {},
      fragmentMeta: parentConfig?.prompts.fragmentMeta,
      globalConstraints: parentConfig?.prompts.globalConstraints ?? "",
      globalClaudeMd: parentConfig?.prompts.globalClaudeMd ?? "",
      globalGeminiMd: parentConfig?.prompts.globalGeminiMd ?? "",
      globalCodexMd: parentConfig?.prompts.globalCodexMd ?? "",
    },
    skills: pipeline.skills ?? parentConfig?.skills ?? [],
    mcps: [...pipelineMcps],
    sandbox: parentConfig?.sandbox,
    agent: parentConfig?.agent,
  };
}
