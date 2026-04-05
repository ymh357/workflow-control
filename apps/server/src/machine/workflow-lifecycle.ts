// Configuration snapshotting for workflow creation.
// Extracted from actor-registry.ts to reduce file size.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowContext } from "./types.js";
import {
  loadPipelineConfig, CONFIG_DIR, loadSystemSettings,
  loadPipelineSystemPrompt, loadPipelineConstraints,
  flattenStages,
  type FragmentMeta,
  getFragmentRegistry,
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

  const fragments: Record<string, string> = {};
  const fragmentMeta: Record<string, FragmentMeta> = {};
  for (const [id, entry] of getFragmentRegistry().getAllEntries()) {
    fragments[id] = entry.content;
    fragmentMeta[id] = entry.meta;
  }

  const readOptionalMarkdown = (...segments: string[]): string => {
    const filePath = join(CONFIG_DIR, ...segments);
    if (!existsSync(filePath)) return "";
    try {
      return readFileSync(filePath, "utf-8");
    } catch {
      return "";
    }
  };

  const globalClaudeMd = pipeline.claude_md?.global ?? readOptionalMarkdown("claude-md", "global.md");
  const globalGeminiMd = pipeline.gemini_md?.global ?? readOptionalMarkdown("gemini-md", "global.md");
  const globalCodexMd = pipeline.codex_md?.global ?? readOptionalMarkdown("codex-md", "global.md");

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
      globalCodexMd,
    },
    skills: pipeline.skills ?? [],
    mcps: [...pipelineMcps],
    sandbox: settings.sandbox,
    agent: settings.agent,
  };
}
