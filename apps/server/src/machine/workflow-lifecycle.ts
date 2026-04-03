// Configuration snapshotting for workflow creation.
// Extracted from actor-registry.ts to reduce file size.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowContext } from "./types.js";
import {
  loadPipelineConfig, CONFIG_DIR, loadSystemSettings,
  loadPipelineSystemPrompt, loadPipelineConstraints,
  flattenStages,
  type FragmentMeta,
} from "../lib/config-loader.js";

export function snapshotGlobalConfig(pipelineName = "pipeline-generator"): NonNullable<WorkflowContext["config"]> {
  const pipeline = loadPipelineConfig(pipelineName);
  if (!pipeline) {
    throw new Error(`Pipeline config not found for "${pipelineName}". Ensure config/pipelines/${pipelineName}/pipeline.yaml exists.`);
  }
  const globalConstraints = loadPipelineConstraints(pipelineName) ?? "";

  // Collect only MCPs referenced by pipeline stages (not the full global registry)
  const pipelineMcps = new Set<string>();
  for (const stage of flattenStages(pipeline.stages)) {
    if (stage.mcps) for (const m of stage.mcps) pipelineMcps.add(m);
  }

  const toCamelCase = (s: string) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const systemPrompts: Record<string, string> = {};
  const pipelineSystemDir = join(CONFIG_DIR, "pipelines", pipelineName, "prompts", "system");
  if (existsSync(pipelineSystemDir)) {
    const files = readdirSync(pipelineSystemDir).filter((f) => f.endsWith(".md"));
    for (const f of files) {
      const fileName = f.replace(".md", "");
      const key = toCamelCase(fileName);
      systemPrompts[key] = loadPipelineSystemPrompt(pipelineName, fileName) ?? "";
    }
  }

  // Fragments: pipeline-scoped only — do not load from global registry
  // Pipelines define their own knowledge via system prompts and claude_md/gemini_md
  const fragments: Record<string, string> = {};
  const fragmentMeta: Record<string, FragmentMeta> = {};

  // Pipeline-controlled project instructions only — no fallback to global config files
  const globalClaudeMd = pipeline.claude_md?.global ?? "";
  const globalGeminiMd = pipeline.gemini_md?.global ?? "";

  const settings = loadSystemSettings();

  return {
    pipelineName,
    pipeline,
    prompts: {
      system: systemPrompts,
      fragments,
      fragmentMeta,
      globalConstraints,
      globalClaudeMd,
      globalGeminiMd,
    },
    skills: pipeline.skills ?? [],
    mcps: [...pipelineMcps],
    sandbox: settings.sandbox,
    agent: settings.agent,
  };
}
