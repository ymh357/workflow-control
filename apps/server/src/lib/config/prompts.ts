import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYAML } from "yaml";

import type { HookConfig } from "./types.js";
import { CONFIG_DIR } from "./settings.js";
import { getFragmentRegistry } from "./fragments.js";
import { parseFrontmatter } from "./fragments.js";

/** Reject names containing path traversal sequences or separators. */
function safeName(name: string): string | null {
  if (!name || name.includes("..") || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    return null;
  }
  return name;
}

/**
 * Loads a system prompt from a pipeline's prompts/system/ directory.
 */
export function loadPipelineSystemPrompt(pipelineName: string, promptName: string): string | null {
  const safePipeline = safeName(pipelineName);
  const safePrompt = safeName(promptName);
  if (!safePipeline || !safePrompt) return null;
  // Check .local/ override first (full replacement)
  const localPath = join(CONFIG_DIR, "pipelines", `${safePipeline}.local`, "prompts", "system", `${safePrompt}.md`);
  if (existsSync(localPath)) {
    try {
      return readFileSync(localPath, "utf-8").trim();
    } catch { /* fall through to base */ }
  }
  const filePath = join(CONFIG_DIR, "pipelines", safePipeline, "prompts", "system", `${safePrompt}.md`);
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, "utf-8").trim();
  } catch {
    return null;
  }
}

/**
 * Loads global constraints from a pipeline's prompts/ directory.
 */
export function loadPipelineConstraints(pipelineName: string): string | null {
  const safe = safeName(pipelineName);
  if (!safe) return null;
  const filePath = join(CONFIG_DIR, "pipelines", safe, "prompts", "global-constraints.md");
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, "utf-8").trim();
  } catch {
    return null;
  }
}

// Legacy loaders — kept for backward compatibility with old shared prompts directory.
// New code should use loadPipelineSystemPrompt() and loadPipelineConstraints() instead.

function loadSystemPrompt(stageName: string): string | null {
  const safe = safeName(stageName);
  if (!safe) return null;
  const filePath = join(CONFIG_DIR, "prompts", "system", `${safe}.md`);
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, "utf-8").trim();
  } catch {
    return null;
  }
}

function loadGlobalConstraints(): string | null {
  const filePath = join(CONFIG_DIR, "prompts", "global-constraints.md");
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, "utf-8").trim();
  } catch {
    return null;
  }
}

function resolvePromptFileName(stageName: string): string {
  return stageName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

// --- Read project CLAUDE.md from cwd ---

export function readProjectClaudeMd(cwd?: string): string {
  if (!cwd) return "";
  const paths = [
    join(cwd, ".claude", "CLAUDE.md"),
    join(cwd, "CLAUDE.md"),
  ];
  for (const p of paths) {
    try {
      if (existsSync(p)) return readFileSync(p, "utf-8");
    } catch { /* ignore */ }
  }
  return "";
}

export function readProjectGeminiMd(cwd?: string): string {
  if (!cwd) return "";
  const paths = [
    join(cwd, ".gemini", "GEMINI.md"),
    join(cwd, "GEMINI.md"),
  ];
  for (const p of paths) {
    try {
      if (existsSync(p)) return readFileSync(p, "utf-8");
    } catch { /* ignore */ }
  }
  return "";
}

export function readProjectCodexMd(cwd?: string): string {
  if (!cwd) return "";
  const paths = [
    join(cwd, ".codex", "CODEX.md"),
    join(cwd, "CODEX.md"),
  ];
  for (const p of paths) {
    try {
      if (existsSync(p)) return readFileSync(p, "utf-8");
    } catch { /* ignore */ }
  }
  return "";
}

// --- Backward-compatible prompt fragment loader ---

export function loadPromptFragment(fragmentName: string): string | null {
  const registry = getFragmentRegistry();
  const entry = registry.getAllEntries().get(fragmentName);
  if (entry) return entry.content;
  // Fallback: read directly from disk for unregistered fragments
  const safe = safeName(fragmentName);
  if (!safe) return null;
  const filePath = join(CONFIG_DIR, "prompts", "fragments", `${safe}.md`);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    return parseFrontmatter(raw).content;
  } catch {
    return null;
  }
}

// --- Skill / CLAUDE.md path helpers ---

export function getSkillPath(skillName: string): string | null {
  const safe = safeName(skillName);
  if (!safe) return null;
  // Check .local override first
  const localPath = join(CONFIG_DIR, "skills", `${safe}.local.md`);
  if (existsSync(localPath)) return localPath;
  const filePath = join(CONFIG_DIR, "skills", `${safe}.md`);
  return existsSync(filePath) ? filePath : null;
}

export function getClaudeMdPath(relativePath: string): string | null {
  const baseDir = resolve(CONFIG_DIR, "claude-md");
  const filePath = resolve(baseDir, relativePath);
  if (!filePath.startsWith(baseDir + "/")) return null;
  return existsSync(filePath) ? filePath : null;
}

export function getGeminiMdPath(relativePath: string): string | null {
  const baseDir = resolve(CONFIG_DIR, "gemini-md");
  const filePath = resolve(baseDir, relativePath);
  if (!filePath.startsWith(baseDir + "/")) return null;
  return existsSync(filePath) ? filePath : null;
}

export function getCodexMdPath(relativePath: string): string | null {
  const baseDir = resolve(CONFIG_DIR, "codex-md");
  const filePath = resolve(baseDir, relativePath);
  if (!filePath.startsWith(baseDir + "/")) return null;
  return existsSync(filePath) ? filePath : null;
}

// --- Hook config loader ---

export function loadHookConfig(hookName: string): HookConfig | null {
  const safe = safeName(hookName);
  if (!safe) return null;
  // Check .local override first (full replacement)
  const localPath = join(CONFIG_DIR, "hooks", `${safe}.local.yaml`);
  if (existsSync(localPath)) {
    try {
      const raw = readFileSync(localPath, "utf-8");
      return parseYAML(raw) as HookConfig;
    } catch { /* fall through to base */ }
  }
  const filePath = join(CONFIG_DIR, "hooks", `${safe}.yaml`);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    return parseYAML(raw) as HookConfig;
  } catch {
    return null;
  }
}

// --- Gate path resolver ---

export function getGatePath(gateName: string): string | null {
  const safe = safeName(gateName);
  if (!safe) return null;
  const gatesDir = resolve(CONFIG_DIR, "gates");
  const filePath = resolve(gatesDir, `${safe}.ts`);
  if (!filePath.startsWith(gatesDir + "/")) return null;
  return existsSync(filePath) ? filePath : null;
}
