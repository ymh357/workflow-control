import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYAML } from "yaml";

import type { SystemSettings } from "./types.js";
import { SystemSettingsSchema } from "./schema.js";

export const CONFIG_DIR = resolve(import.meta.dirname, "../../../config");

const CACHE_TTL_MS = 60_000;
let settingsCache: { value: SystemSettings; ts: number } | null = null;

/**
 * Gets a nested value from an object using a dot-separated path (e.g., "notion.token").
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getNestedValue(obj: Record<string, any> | undefined | null, path: string): any {
  if (!obj || !path) return undefined;
  return path.split(".").reduce((acc, part) => {
    if (acc == null || !Object.hasOwn(acc, part)) return undefined;
    return acc[part];
  }, obj as any);
}

/**
 * Recursively interpolates ${VAR} placeholders in an object tree using environment variables.
 */
export function interpolateObject<T>(obj: T): T {
  if (typeof obj === "string") {
    const interpolated = interpolateEnvVar(obj);
    return (interpolated === "\0MISSING\0" ? undefined : interpolated) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(interpolateObject) as unknown as T;
  }
  if (obj !== null && typeof obj === "object") {
    const newObj: any = {};
    for (const [key, value] of Object.entries(obj)) {
      newObj[key] = interpolateObject(value);
    }
    return newObj as T;
  }
  return obj;
}

export function interpolateEnvVar(template: string): string {
  if (!template) return template;
  return template.replace(/\$\{(\w+)(?::-([^}]+))?}/g, (_, varName, defaultValue) => {
    const val = process.env[varName];
    if (val !== undefined) return val;
    if (defaultValue !== undefined) return defaultValue;
    return "\0MISSING\0";
  });
}

export function loadSystemSettings(): SystemSettings {
  if (settingsCache && Date.now() - settingsCache.ts < CACHE_TTL_MS) return settingsCache.value;
  const filePath = join(CONFIG_DIR, "system-settings.yaml");
  let yamlConfig: any = {};

  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, "utf-8");
      yamlConfig = parseYAML(raw) || {};
    } catch (err) {
      console.warn("[config] Failed to parse system-settings.yaml:", err instanceof Error ? err.message : String(err));
    }
  }

  // Core defaults / ENV fallbacks for internal framework use
  const coreDefaults: SystemSettings = {
    slack: {
      bot_token: process.env.SLACK_BOT_TOKEN,
      notify_channel_id: process.env.SLACK_NOTIFY_CHANNEL_ID,
      signing_secret: process.env.SLACK_SIGNING_SECRET,
    },
    paths: {
      repos_base: process.env.REPOS_BASE_PATH || process.env.HOME || "",
      worktrees_base: process.env.WORKTREES_BASE_PATH || join(process.env.HOME ?? "/tmp", "wfc-worktrees"),
      data_dir: process.env.DATA_DIR || "/tmp/workflow-control-data",
      claude_executable: process.env.CLAUDE_PATH || "claude",
      gemini_executable: process.env.GEMINI_PATH || "gemini",
      codex_executable: process.env.CODEX_PATH || "codex",
    },
    agent: {
      default_model: process.env.DEFAULT_MODEL || "claude-sonnet-4-6",
      claude_model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      gemini_model: process.env.GEMINI_MODEL || "auto",
      codex_model: process.env.CODEX_MODEL || "",
      default_engine: (process.env.DEFAULT_ENGINE as "claude" | "gemini" | "codex") || "claude",
      max_budget_usd: (() => {
        const budgetEnv = process.env.MAX_BUDGET_USD;
        const parsed = budgetEnv !== undefined ? Number(budgetEnv) : 10.0;
        return Number.isFinite(parsed) ? parsed : 10.0;
      })(),
    },
  };

  // 1. Start with core defaults
  const merged: SystemSettings = { ...coreDefaults };

  // 2. Merge YAML config (overwrites core if present)
  for (const [key, value] of Object.entries(yamlConfig)) {
    if (typeof value === "object" && value !== null && merged[key]) {
      merged[key] = { ...merged[key], ...value };
    } else {
      merged[key] = value;
    }
  }

  // 3. AUTO-MAP: Merge environment variables following SETTING_SECTION_KEY convention
  // e.g., SETTING_NOTION_TOKEN -> merged.notion.token
  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (envKey.startsWith("SETTING_") && envVal) {
      const parts = envKey.split("_").slice(1); // ["NOTION", "TOKEN"]
      if (parts.length >= 2) {
        const section = parts[0].toLowerCase();
        const key = parts.slice(1).join("_").toLowerCase();
        if (!merged[section]) merged[section] = {};
        merged[section][key] = envVal;
      }
    }
  }

  const result = interpolateObject(merged);

  // Validate merged settings against schema (warn but don't crash)
  const validated = SystemSettingsSchema.safeParse(result);
  if (!validated.success) {
    console.warn(
      "[config] System settings validation warnings:",
      validated.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }

  settingsCache = { value: result, ts: Date.now() };
  return result;
}

export function clearSettingsCache(): void {
  settingsCache = null;
}
