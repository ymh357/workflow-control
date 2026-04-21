import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { convertLegacyYaml } from "../converter/legacy-yaml.js";
import type { PipelineIR } from "../ir/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_PIPELINES_ROOT = join(__dirname, "..", "..", "builtin-pipelines");

export interface LegacyPipelineLoadResult {
  ir: PipelineIR;
  promptRoot: string;
  yamlFilePath: string;
  warnings: Array<{ code: string; message?: string }>;
  prompts: Record<string, string>;
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

function scanPrompts(promptRoot: string): Record<string, string> {
  if (!existsSync(promptRoot)) return {};
  const out: Record<string, string> = {};
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile() && entry.endsWith(".md")) {
        const rel = relative(promptRoot, full).split(sep).join("/");
        const key = rel.slice(0, -".md".length);
        out[key] = readFileSync(full, "utf-8");
      }
    }
  }
  walk(promptRoot);
  return out;
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
  const prompts = scanPrompts(conv.promptRoot);
  return {
    ir: conv.ir,
    promptRoot: conv.promptRoot,
    yamlFilePath,
    warnings: conv.warnings,
    prompts,
  };
}
