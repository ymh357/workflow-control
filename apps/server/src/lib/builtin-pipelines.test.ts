// Guards that every pipeline shipped under src/builtin-pipelines/
// parses and passes validatePipelineConfig. New builtins must either
// be schema-clean or be removed from the ship list.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlLoad } from "yaml";
import { validatePipelineConfig } from "./config/schema.js";

const BUILTIN_DIR = join(
  import.meta.dirname ?? new URL(".", import.meta.url).pathname,
  "..",
  "builtin-pipelines",
);

function listBuiltins(): string[] {
  if (!existsSync(BUILTIN_DIR)) return [];
  return readdirSync(BUILTIN_DIR)
    .filter((name) => {
      const p = join(BUILTIN_DIR, name);
      try {
        return statSync(p).isDirectory() && existsSync(join(p, "pipeline.yaml"));
      } catch {
        return false;
      }
    })
    .sort();
}

describe("builtin pipelines", () => {
  const names = listBuiltins();

  it("ships at least one pipeline", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it.each(names)("pipeline %s passes validatePipelineConfig", (name) => {
    const yaml = readFileSync(join(BUILTIN_DIR, name, "pipeline.yaml"), "utf8");
    const parsed = yamlLoad(yaml);
    const result = validatePipelineConfig(parsed);
    if (!result.success) {
      const structural = (result as { structuralErrors?: unknown[] }).structuralErrors;
      const zodIssues = (result as { errors?: { issues?: unknown[] } }).errors?.issues;
      throw new Error(
        `builtin pipeline "${name}" failed validation:\n` +
          JSON.stringify({ structural, zodIssues }, null, 2),
      );
    }
    expect(result.success).toBe(true);
  });

  it.each(names)("pipeline %s has prompts/system dir if any stage uses llm engine", (name) => {
    const yaml = readFileSync(join(BUILTIN_DIR, name, "pipeline.yaml"), "utf8");
    const parsed = yamlLoad(yaml) as { stages?: unknown };
    const needsPrompts = hasLlmStage(parsed.stages);
    const promptsDir = join(BUILTIN_DIR, name, "prompts", "system");
    if (needsPrompts) {
      expect(existsSync(promptsDir), `${name} needs prompts/system/`).toBe(true);
    }
  });

  it.each(names)("pipeline %s — every system_prompt references an existing file", (name) => {
    const yaml = readFileSync(join(BUILTIN_DIR, name, "pipeline.yaml"), "utf8");
    const parsed = yamlLoad(yaml) as { stages?: unknown };
    const promptsDir = join(BUILTIN_DIR, name, "prompts", "system");
    const referenced = collectSystemPromptRefs(parsed.stages);
    for (const ref of referenced) {
      const candidate = join(promptsDir, `${ref}.md`);
      expect(existsSync(candidate), `${name}: missing prompt file prompts/system/${ref}.md`).toBe(true);
    }
  });
});

function hasLlmStage(stages: unknown): boolean {
  if (!Array.isArray(stages)) return false;
  for (const stage of stages) {
    if (!stage || typeof stage !== "object") continue;
    const s = stage as Record<string, unknown>;
    const runtime = s.runtime as Record<string, unknown> | undefined;
    if (runtime?.engine === "llm") return true;
    const parallel = s.parallel as { stages?: unknown } | undefined;
    if (parallel?.stages && hasLlmStage(parallel.stages)) return true;
  }
  return false;
}

function collectSystemPromptRefs(stages: unknown, acc: string[] = []): string[] {
  if (!Array.isArray(stages)) return acc;
  for (const stage of stages) {
    if (!stage || typeof stage !== "object") continue;
    const s = stage as Record<string, unknown>;
    const runtime = s.runtime as Record<string, unknown> | undefined;
    const promptRef = runtime?.system_prompt;
    if (typeof promptRef === "string") acc.push(promptRef);
    const parallel = s.parallel as { stages?: unknown } | undefined;
    if (parallel?.stages) collectSystemPromptRefs(parallel.stages, acc);
  }
  return acc;
}
