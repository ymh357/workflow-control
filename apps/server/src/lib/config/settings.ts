import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYAML } from "yaml";
import { z } from "zod";

export const CONFIG_DIR = resolve(import.meta.dirname, "../../../config");

// --- Types ---

export interface SandboxConfig {
  enabled?: boolean;
  auto_allow_bash?: boolean;
  allow_unsandboxed_commands?: boolean;
  network?: {
    allowed_domains?: string[];
  };
  filesystem?: {
    allow_write?: string[];
    deny_write?: string[];
    deny_read?: string[];
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface SystemSettings extends Record<string, any> {
  paths?: {
    repos_base?: string;
    worktrees_base?: string;
    data_dir?: string;
    claude_executable?: string;
  };
  agent?: {
    default_model?: string; // Legacy
    claude_model?: string;
    max_budget_usd?: number;
  };
  sandbox?: SandboxConfig;
}

// --- Schema (runtime validation) ---

const SandboxConfigSchema = z.object({
  enabled: z.boolean().optional(),
  auto_allow_bash: z.boolean().optional(),
  allow_unsandboxed_commands: z.boolean().optional(),
  network: z
    .object({
      allowed_domains: z.array(z.string()).optional(),
    })
    .optional(),
  filesystem: z
    .object({
      allow_write: z.array(z.string()).optional(),
      deny_write: z.array(z.string()).optional(),
      deny_read: z.array(z.string()).optional(),
    })
    .optional(),
});

export const SystemSettingsSchema = z
  .object({
    paths: z
      .object({
        repos_base: z.string().optional(),
        worktrees_base: z.string().optional(),
        data_dir: z.string().optional(),
        claude_executable: z.string().optional(),
      })
      .optional(),
    agent: z
      .object({
        default_model: z.string().optional(),
        claude_model: z.string().optional(),
        max_budget_usd: z.number().optional(),
      })
      .optional(),
    sandbox: SandboxConfigSchema.optional(),
  })
  .catchall(z.unknown());

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
    paths: {
      repos_base: process.env.REPOS_BASE_PATH || process.env.HOME || "",
      worktrees_base: process.env.WORKTREES_BASE_PATH || join(process.env.HOME ?? "/tmp", "wfc-worktrees"),
      data_dir: process.env.DATA_DIR || "/tmp/workflow-control-data",
      claude_executable: process.env.CLAUDE_PATH || "claude",
    },
    agent: {
      default_model: process.env.DEFAULT_MODEL || "claude-sonnet-4-6",
      claude_model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
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
  //
  // Bug 51 (c12+ review): pre-fix this stored every env value as a
  // string, regardless of the target field's declared type. Setting
  // SETTING_AGENT_MAX_BUDGET_USD=5 produced agent.max_budget_usd = "5",
  // which downstream code that checked `> threshold` did via string
  // comparison — and certain budget guards silently broke. Coerce
  // when the existing field on `merged` is a number / boolean,
  // matching the type contract expressed in SystemSettingsSchema.
  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (envKey.startsWith("SETTING_") && envVal) {
      const parts = envKey.split("_").slice(1); // ["NOTION", "TOKEN"]
      if (parts.length >= 2) {
        const section = parts[0].toLowerCase();
        const key = parts.slice(1).join("_").toLowerCase();
        if (!merged[section]) merged[section] = {};
        const existing = merged[section][key];
        let coerced: unknown = envVal;
        if (typeof existing === "number") {
          const n = Number(envVal);
          if (Number.isFinite(n)) coerced = n;
          // If the env value isn't a finite number, leave as string;
          // SystemSettingsSchema's safeParse will surface a warning.
        } else if (typeof existing === "boolean") {
          if (envVal === "true" || envVal === "1") coerced = true;
          else if (envVal === "false" || envVal === "0") coerced = false;
          // Unknown truthiness encoding — leave as string for warning.
        }
        merged[section][key] = coerced;
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
