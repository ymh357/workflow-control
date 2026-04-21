import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { convertLegacyYaml } from "../converter/legacy-yaml.js";
import type { PipelineIR } from "../ir/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Two levels up: runtime/ -> kernel-next/ -> src/
const BUILTIN_PIPELINES_ROOT = join(__dirname, "..", "..", "builtin-pipelines");

export interface LegacyPipelineLoadResult {
  ir: PipelineIR;
  promptRoot: string;
  yamlFilePath: string;
  warnings: Array<{ code: string; message?: string }>;
}

export class LegacyPipelineLoadError extends Error {
  constructor(
    message: string,
    public readonly diagnostics: Array<{ code: string; message?: string }>,
  ) {
    super(message);
    this.name = "LegacyPipelineLoadError";
  }
}

export function loadLegacyPipelineIR(pipelineDir: string): LegacyPipelineLoadResult {
  const yamlFilePath = join(BUILTIN_PIPELINES_ROOT, pipelineDir, "pipeline.yaml");
  let yamlText: string;
  try {
    yamlText = readFileSync(yamlFilePath, "utf-8");
  } catch (err) {
    throw new LegacyPipelineLoadError(
      `failed to read pipeline YAML at ${yamlFilePath}: ${(err as Error).message}`,
      [{ code: "YAML_READ_FAILED", message: (err as Error).message }],
    );
  }
  const conv = convertLegacyYaml(yamlText, { yamlFilePath });
  if (!conv.ok) {
    throw new LegacyPipelineLoadError(
      `legacy pipeline '${pipelineDir}' failed to convert`,
      conv.diagnostics,
    );
  }
  if (!conv.promptRoot) {
    throw new LegacyPipelineLoadError(
      `legacy pipeline '${pipelineDir}' produced no promptRoot`,
      [{ code: "MISSING_PROMPT_ROOT" }],
    );
  }
  return {
    ir: conv.ir,
    promptRoot: conv.promptRoot,
    yamlFilePath,
    warnings: conv.warnings,
  };
}
