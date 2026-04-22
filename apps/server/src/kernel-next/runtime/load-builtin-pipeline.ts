// load-builtin-pipeline — reads pipeline.ir.json + prompts/ from a
// builtin-pipelines directory and returns the IR + prompts bundle.
//
// Replaces load-legacy-pipeline (which parsed YAML + ran the converter).
// pipeline.ir.json is the canonical on-disk representation; no YAML
// anywhere on this path.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import type { PipelineIR } from "../ir/schema.js";
import { PipelineIRSchema } from "../ir/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_PIPELINES_ROOT = join(__dirname, "..", "..", "builtin-pipelines");

export interface BuiltinPipelineLoadResult {
  ir: PipelineIR;
  pipelineDir: string;
  promptRoot: string;
  prompts: Record<string, string>;
  warnings: Array<{ code: string; message?: string }>;
}

export class BuiltinPipelineLoadError extends Error {
  constructor(
    message: string,
    public readonly diagnostics: Array<{ code: string; message?: string }>,
  ) {
    super(message);
    this.name = "BuiltinPipelineLoadError";
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

export function loadBuiltinPipelineIR(pipelineDir: string): BuiltinPipelineLoadResult {
  const dir = join(BUILTIN_PIPELINES_ROOT, pipelineDir);
  const irPath = join(dir, "pipeline.ir.json");
  const promptRoot = join(dir, "prompts");

  let raw: string;
  try {
    raw = readFileSync(irPath, "utf-8");
  } catch (err) {
    throw new BuiltinPipelineLoadError(
      `failed to read ${irPath}: ${(err as Error).message}`,
      [{ code: "IR_READ_FAILED", message: (err as Error).message }],
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    throw new BuiltinPipelineLoadError(
      `invalid JSON in ${irPath}: ${(err as Error).message}`,
      [{ code: "IR_JSON_PARSE_FAILED", message: (err as Error).message }],
    );
  }

  const parsed = PipelineIRSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new BuiltinPipelineLoadError(
      `IR schema violation in ${irPath}`,
      parsed.error.issues.map((i) => ({
        code: "ZOD_PARSE_ERROR",
        message: `${i.path.join(".") || "<root>"}: ${i.message}`,
      })),
    );
  }

  const prompts = scanPrompts(promptRoot);

  return {
    ir: parsed.data,
    pipelineDir: dir,
    promptRoot,
    prompts,
    warnings: [],
  };
}
