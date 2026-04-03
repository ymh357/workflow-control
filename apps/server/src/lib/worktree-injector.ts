// Injects skills, hooks, and CLAUDE.md into a worktree after creation.
// All operations are best-effort: failures are logged but do not block worktree setup.

import { readFileSync, readdirSync, writeFileSync, mkdirSync, chmodSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadPipelineConfig,
  loadHookConfig,
  getSkillPath,
  getClaudeMdPath,
  getGeminiMdPath,
  getCodexMdPath,
  CONFIG_DIR,
  type PipelineConfig,
} from "./config-loader.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "worktree-injector" });

// --- Skills injection (2a) ---

function injectSkills(worktreePath: string, skillNames: string[]): void {
  if (skillNames.length === 0) return;

  const claudeCmdsDir = join(worktreePath, ".claude", "commands");
  const geminiCmdsDir = join(worktreePath, ".gemini", "commands");
  mkdirSync(claudeCmdsDir, { recursive: true });
  mkdirSync(geminiCmdsDir, { recursive: true });

  for (const name of skillNames) {
    const srcPath = getSkillPath(name);
    if (!srcPath) {
      log.warn({ skill: name }, "Skill file not found, skipping");
      continue;
    }
    const destPathClaude = join(claudeCmdsDir, `${name}.md`);
    const destPathGemini = join(geminiCmdsDir, `${name}.md`);
    copyFileSync(srcPath, destPathClaude);
    copyFileSync(srcPath, destPathGemini);
    log.info({ skill: name }, "Skill injected");
  }
}

// --- Hooks injection (2b) ---

interface SettingsHookEntry {
  matcher?: string;
  hooks: Array<{
    type: string;
    command: string;
    timeout?: number;
    statusMessage?: string;
  }>;
}

function injectHooks(worktreePath: string, hookNames: string[]): void {
  if (hookNames.length === 0) return;

  const claudeHooksDir = join(worktreePath, ".claude", "hooks");
  mkdirSync(claudeHooksDir, { recursive: true });

  const groupedByEvent: Record<string, SettingsHookEntry[]> = {};

  for (const name of hookNames) {
    const config = loadHookConfig(name);
    if (!config) {
      log.warn({ hook: name }, "Hook config not found, skipping");
      continue;
    }

    let command: string;
    if (config.script) {
      const scriptPathClaude = join(claudeHooksDir, `${name}.sh`);
      writeFileSync(scriptPathClaude, config.script, "utf-8");
      chmodSync(scriptPathClaude, 0o755);
      command = `__HOOK_DIR__/${name}.sh`;
    } else if (config.command) {
      command = config.command;
    } else {
      log.warn({ hook: name }, "Hook has no script or command, skipping");
      continue;
    }

    const event = config.event ?? "PostToolUse";
    if (!groupedByEvent[event]) groupedByEvent[event] = [];

    groupedByEvent[event].push({
      ...(config.matcher ? { matcher: config.matcher } : {}),
      hooks: [{
        type: config.type ?? "command",
        command,
        ...(config.timeout ? { timeout: config.timeout } : {}),
        ...(config.statusMessage ? { statusMessage: config.statusMessage } : {}),
      }],
    });

    log.info({ hook: name, event }, "Hook injected");
  }

  if (Object.keys(groupedByEvent).length === 0) return;

  writeSettings(worktreePath, groupedByEvent);
}

function writeSettings(worktreePath: string, groupedByEvent: Record<string, SettingsHookEntry[]>): void {
  // Only write hooks to .claude/settings.json — Gemini CLI has a different hook system
  const dirs = [".claude"];
  for (const dir of dirs) {
    const settingsPath = join(worktreePath, dir, "settings.json");
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      } catch { /* start fresh */ }
    }

    const hookDir = `${dir}/hooks`;
    const existingHooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
    for (const [event, entries] of Object.entries(groupedByEvent)) {
      const patchedEntries = entries.map(e => ({
        ...e,
        hooks: e.hooks.map(h => ({
          ...h,
          command: h.command.replace("__HOOK_DIR__", hookDir),
        })),
      }));
      existingHooks[event] = [...(existingHooks[event] ?? []), ...patchedEntries];
    }
    settings.hooks = existingHooks;

    mkdirSync(join(worktreePath, dir), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  }
}

// --- CLAUDE.md merge (2c) ---

function injectGeminiMd(worktreePath: string, globalFileName?: string): void {
  if (!globalFileName) return;

  const globalPath = getGeminiMdPath(globalFileName);
  if (!globalPath) {
    log.warn({ file: globalFileName }, "Global GEMINI.md not found, skipping");
    return;
  }

  const globalContent = readFileSync(globalPath, "utf-8").trim();
  const geminiMdPath = join(worktreePath, "GEMINI.md");
  const separator = "\n\n---\n\n";

  let existing = "";
  if (existsSync(geminiMdPath)) {
    existing = readFileSync(geminiMdPath, "utf-8").trim();
  }

  // Avoid duplicate injection
  if (existing.includes(globalContent)) {
    log.info("Global GEMINI.md content already present, skipping");
    return;
  }

  const merged = existing
    ? `${existing}${separator}${globalContent}`
    : globalContent;

  writeFileSync(geminiMdPath, merged + "\n", "utf-8");
  log.info("GEMINI.md merged with global standards");
}

function injectClaudeMd(worktreePath: string, globalFileName?: string): void {
  if (!globalFileName) return;

  const globalPath = getClaudeMdPath(globalFileName);
  if (!globalPath) {
    log.warn({ file: globalFileName }, "Global CLAUDE.md not found, skipping");
    return;
  }

  const globalContent = readFileSync(globalPath, "utf-8").trim();
  const claudeMdPath = join(worktreePath, "CLAUDE.md");
  const separator = "\n\n---\n\n";

  let existing = "";
  if (existsSync(claudeMdPath)) {
    existing = readFileSync(claudeMdPath, "utf-8").trim();
  }

  // Avoid duplicate injection
  if (existing.includes(globalContent)) {
    log.info("Global CLAUDE.md content already present, skipping");
    return;
  }

  const merged = existing
    ? `${existing}${separator}${globalContent}`
    : globalContent;

  writeFileSync(claudeMdPath, merged + "\n", "utf-8");
  log.info("CLAUDE.md merged with global standards");
}

function injectStopHook(worktreePath: string): void {
  const hookScript = join(CONFIG_DIR, "stop-hook-workflow.sh");
  if (!existsSync(hookScript)) {
    log.info("stop-hook-workflow.sh not found, skipping stop hook injection");
    return;
  }

  const settingsPath = join(worktreePath, ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch { /* start fresh */ }
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  const existingStop = (hooks.Stop ?? []) as Array<{ hooks?: Array<{ command?: string }> }>;
  if (existingStop.some(rule => rule.hooks?.some(h => h.command?.includes("stop-hook-workflow")))) {
    log.info("Stop hook already present, skipping");
    return;
  }

  if (!hooks.Stop) hooks.Stop = [];
  (hooks.Stop as unknown[]).push({
    hooks: [{
      type: "command",
      command: `bash ${hookScript}`,
      timeout: 5,
    }],
  });
  settings.hooks = hooks;

  mkdirSync(join(worktreePath, ".claude"), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  log.info("Stop hook injected into worktree .claude/settings.json");
}

function injectCodexMd(worktreePath: string, globalFileName?: string): void {
  if (!globalFileName) return;

  const globalPath = getCodexMdPath(globalFileName);
  if (!globalPath) {
    log.warn({ file: globalFileName }, "Global CODEX.md not found, skipping");
    return;
  }

  const globalContent = readFileSync(globalPath, "utf-8").trim();
  const codexMdPath = join(worktreePath, "CODEX.md");
  const separator = "\n\n---\n\n";

  let existing = "";
  if (existsSync(codexMdPath)) {
    existing = readFileSync(codexMdPath, "utf-8").trim();
  }

  if (existing.includes(globalContent)) {
    log.info("Global CODEX.md content already present, skipping");
    return;
  }

  const merged = existing
    ? `${existing}${separator}${globalContent}`
    : globalContent;

  writeFileSync(codexMdPath, merged + "\n", "utf-8");
  log.info("CODEX.md merged with global standards");
}

// --- Knowledge files injection (Layer 1) ---

function injectKnowledge(worktreePath: string): void {
  const fragmentsDir = join(CONFIG_DIR, "prompts", "fragments");
  if (!existsSync(fragmentsDir)) return;

  const knowledgeDir = join(worktreePath, ".workflow", "knowledge");
  mkdirSync(knowledgeDir, { recursive: true });

  const files = readdirSync(fragmentsDir).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    copyFileSync(join(fragmentsDir, file), join(knowledgeDir, file));
  }
  log.info({ count: files.length }, "Knowledge files injected");
}

// --- Public API ---

export function injectWorktreeConfig(worktreePath: string, pipeline?: PipelineConfig | null): string[] {
  const config = pipeline ?? loadPipelineConfig();
  if (!config) {
    log.info("No pipeline config found, skipping worktree injection");
    return [];
  }

  const warnings: string[] = [];

  try {
    injectSkills(worktreePath, config.skills ?? []);
  } catch (err) {
    warnings.push(`skills: ${err}`);
    log.error({ err }, "Skills injection failed");
  }

  try {
    injectHooks(worktreePath, config.hooks ?? []);
  } catch (err) {
    warnings.push(`hooks: ${err}`);
    log.error({ err }, "Hooks injection failed");
  }

  try {
    injectClaudeMd(worktreePath, config.claude_md?.global);
  } catch (err) {
    warnings.push(`claude-md: ${err}`);
    log.error({ err }, "CLAUDE.md injection failed");
  }

  try {
    injectGeminiMd(worktreePath, config.gemini_md?.global);
  } catch (err) {
    log.error({ err }, "GEMINI.md injection failed");
  }

  try {
    injectCodexMd(worktreePath, config.codex_md?.global);
  } catch (err) {
    log.error({ err }, "CODEX.md injection failed");
  }

  try {
    injectStopHook(worktreePath);
  } catch (err) {
    log.error({ err }, "Stop hook injection failed");
  }

  try {
    injectKnowledge(worktreePath);
  } catch (err) {
    warnings.push(`knowledge: ${err}`);
    log.error({ err }, "Knowledge injection failed");
  }

  if (warnings.length) {
    log.warn({ warnings }, "Worktree injection completed with errors");
  }

  return warnings;
}
