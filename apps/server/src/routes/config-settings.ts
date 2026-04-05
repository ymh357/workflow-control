import { Hono } from "hono";
import { readFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYAML, stringify as stringifyYAML } from "yaml";
import { CONFIG_DIR, clearConfigCache, type SandboxConfig, loadSystemSettings, loadMcpRegistry } from "../lib/config-loader.js";
import { buildMcpFromRegistry } from "../lib/config/mcp.js";
import { runPreflight } from "../lib/preflight.js";
import { validateBody, getValidatedBody, yamlContentSchema, sandboxSchema } from "../middleware/validate.js";
import { errorResponse, ErrorCode } from "../lib/error-response.js";
import { settingsPath, ensureDir, atomicWriteSync, listFiles, validateSettingsContent } from "./config-helpers.js";

export const configSettingsRoute = new Hono();

// --- System Settings ---

configSettingsRoute.get("/config/system", async (c) => {
  const preflight = runPreflight();
  const settings = loadSystemSettings();
  const mcpRegistry = loadMcpRegistry();

  // Load global standards content
  const globalClaudePath = join(CONFIG_DIR, "claude-md", "global.md");
  const globalClaudeContent = existsSync(globalClaudePath) ? await readFile(globalClaudePath, "utf-8").catch(() => "") : "";
  const globalGeminiPath = join(CONFIG_DIR, "gemini-md", "global.md");
  const globalGeminiContent = existsSync(globalGeminiPath) ? await readFile(globalGeminiPath, "utf-8").catch(() => "") : "";
  const globalCodexPath = join(CONFIG_DIR, "codex-md", "global.md");
  const globalCodexContent = existsSync(globalCodexPath) ? await readFile(globalCodexPath, "utf-8").catch(() => "") : "";

  return c.json({
    environment: {
      os: process.platform,
      nodeVersion: process.version,
      preflight: preflight.results,
      effectivePaths: settings.paths,
    },
    notifications: {
      slackConfigured: !!(settings.slack?.bot_token && settings.slack?.notify_channel_id),
      slackSocketMode: !!settings.slack?.app_token,
      channelId: settings.slack?.notify_channel_id,
    },
    capabilities: {
      skills: listFiles(join(CONFIG_DIR, "skills"), ".md").map(s => s.replace(".md", "")),
      mcps: Object.entries(mcpRegistry || {}).map(([name, entry]) => ({
        name,
        description: entry.description || "",
        available: buildMcpFromRegistry(name, entry) !== null,
      })),
    },
    sandbox: {
      enabled: settings.sandbox?.enabled ?? false,
    },
    instructions: {
      globalClaudeMd: globalClaudeContent,
      globalGeminiMd: globalGeminiContent,
      globalCodexMd: globalCodexContent,
    },
    agent: settings.agent,
  });
});

configSettingsRoute.get("/config/settings", async (c) => {
  if (!existsSync(settingsPath)) {
    return c.json({ raw: "", settings: {} });
  }
  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf-8");
  } catch {
    return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, "Failed to read settings file");
  }
  try {
    const settings = loadSystemSettings();
    return c.json({ raw, settings });
  } catch {
    return c.json({ raw, settings: {} });
  }
});

configSettingsRoute.put("/config/settings", validateBody(yamlContentSchema), async (c) => {
  const body = getValidatedBody(c) as { content: string };

  const result = validateSettingsContent(body.content);
  if (!result.ok) {
    return errorResponse(c, 400, ErrorCode.INVALID_CONFIG, result.error);
  }

  ensureDir(CONFIG_DIR);
  atomicWriteSync(settingsPath, body.content);
  clearConfigCache();

  return c.json({ ok: true });
});

// --- Sandbox ---

configSettingsRoute.get("/config/sandbox", (c) => {
  const settings = loadSystemSettings();
  return c.json(settings.sandbox ?? { enabled: false });
});

configSettingsRoute.put("/config/sandbox", validateBody(sandboxSchema), async (c) => {
  const body = getValidatedBody(c) as SandboxConfig;

  // Read current YAML, merge sandbox section, write back
  let yamlConfig: Record<string, any> = {};
  if (existsSync(settingsPath)) {
    try {
      yamlConfig = parseYAML(readFileSync(settingsPath, "utf-8")) || {};
    } catch { /* start fresh */ }
  }

  yamlConfig.sandbox = {
    enabled: body.enabled ?? false,
    auto_allow_bash: body.auto_allow_bash ?? true,
    allow_unsandboxed_commands: body.allow_unsandboxed_commands ?? true,
    network: body.network ?? { allowed_domains: [] },
    filesystem: body.filesystem ?? { allow_write: [], deny_write: [], deny_read: [] },
  };

  ensureDir(CONFIG_DIR);
  atomicWriteSync(settingsPath, stringifyYAML(yamlConfig));
  clearConfigCache();

  return c.json({ ok: true, sandbox: yamlConfig.sandbox });
});
