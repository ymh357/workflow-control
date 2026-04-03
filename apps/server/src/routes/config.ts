import { Hono } from "hono";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync, renameSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { parse as parseYAML, stringify as stringifyYAML } from "yaml";
import { CONFIG_DIR, clearConfigCache, type PipelineConfig, type SystemSettings, type SandboxConfig, loadSystemSettings, loadMcpRegistry, getFragmentRegistry, listAvailablePipelines, loadPipelineConfig, flattenStages, isParallelGroup } from "../lib/config-loader.js";
import { validatePipelineLogic, getValidationErrors } from "@workflow-control/shared";
import { buildMcpFromRegistry } from "../lib/config/mcp.js";
import { runPreflight } from "../lib/preflight.js";
import { scriptRegistry } from "../scripts/index.js";
import { validateBody, getValidatedBody, yamlContentSchema, sandboxSchema } from "../middleware/validate.js";
import { errorResponse, ErrorCode } from "../lib/error-response.js";

export const configRoute = new Hono();

// --- Scripts ---

configRoute.get("/config/scripts", (c) => {
  return c.json(scriptRegistry.getAllMetadata());
});

// --- Available Pipelines (for pipeline-call / foreach selectors) ---

configRoute.get("/config/pipelines-list", (c) => {
  const manifests = listAvailablePipelines();
  return c.json(manifests);
});

// --- Helpers ---

function safePath(base: string, ...segments: string[]): string | null {
  for (const s of segments) {
    if (s.includes("..") || s.includes("/") || s.includes("\\")) return null;
  }
  const filePath = join(base, ...segments);
  const resolved = resolve(filePath);
  if (!resolved.startsWith(resolve(base))) return null;
  // Resolve symlinks to prevent escaping the base directory
  try {
    if (existsSync(filePath)) {
      const real = realpathSync(filePath);
      if (!real.startsWith(realpathSync(base))) return null;
    }
  } catch { /* file doesn't exist yet — ok for writes */ }
  return filePath;
}

function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
}

function atomicWriteSync(filePath: string, content: string): void {
  const tmp = filePath + "." + randomBytes(6).toString("hex") + ".tmp";
  writeFileSync(tmp, content, "utf-8");
  try {
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

function listFiles(dir: string, ext?: string): string[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => !f.startsWith("."));
  return ext ? files.filter((f) => f.endsWith(ext)) : files;
}

// --- System Settings ---

const settingsPath = join(CONFIG_DIR, "system-settings.yaml");

function validateSettingsContent(content: string): { ok: true } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = parseYAML(content);
  } catch (e) {
    return { ok: false, error: `Invalid YAML: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (parsed && typeof parsed === "object") {
    const dangerous = ["__proto__", "constructor", "prototype"];
    for (const key of dangerous) {
      if (Object.prototype.hasOwnProperty.call(parsed, key)) {
        return { ok: false, error: `Forbidden YAML key: ${key}` };
      }
    }
  }
  return { ok: true };
}

configRoute.get("/config/system", (c) => {
  const preflight = runPreflight();
  const settings = loadSystemSettings();
  const mcpRegistry = loadMcpRegistry();
  
  // Load global standards content
  const globalClaudePath = join(CONFIG_DIR, "claude-md", "global.md");
  const globalClaudeContent = existsSync(globalClaudePath) ? readFileSync(globalClaudePath, "utf-8") : "";
  const globalGeminiPath = join(CONFIG_DIR, "gemini-md", "global.md");
  const globalGeminiContent = existsSync(globalGeminiPath) ? readFileSync(globalGeminiPath, "utf-8") : "";

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
    },
    agent: settings.agent,
  });
});

configRoute.get("/config/settings", (c) => {
  if (!existsSync(settingsPath)) {
    return c.json({ raw: "", settings: {} });
  }
  const raw = readFileSync(settingsPath, "utf-8");
  try {
    const settings = loadSystemSettings();
    return c.json({ raw, settings });
  } catch {
    return c.json({ raw, settings: {} });
  }
});

configRoute.put("/config/settings", validateBody(yamlContentSchema), async (c) => {
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

configRoute.get("/config/sandbox", (c) => {
  const settings = loadSystemSettings();
  return c.json(settings.sandbox ?? { enabled: false });
});

configRoute.put("/config/sandbox", validateBody(sandboxSchema), async (c) => {
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

// --- Pipelines ---

const pipelinesDir = join(CONFIG_DIR, "pipelines");

// List all available pipelines
configRoute.get("/config/pipelines", (c) => {
  return c.json({ pipelines: listAvailablePipelines() });
});

// Get a specific pipeline by name
configRoute.get("/config/pipelines/:name", (c) => {
  const name = c.req.param("name");
  const pipelineDir = safePath(pipelinesDir, name);
  if (!pipelineDir) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid pipeline name");
  const filePath = join(pipelineDir, "pipeline.yaml");
  if (!existsSync(filePath)) {
    return c.json({ raw: "", parsed: null }, 404);
  }
  const raw = readFileSync(filePath, "utf-8");
  try {
    const parsed = parseYAML(raw) as PipelineConfig;
    return c.json({ raw, parsed });
  } catch {
    return c.json({ raw, parsed: null });
  }
});

// Update a specific pipeline
configRoute.put("/config/pipelines/:name", validateBody(yamlContentSchema), async (c) => {
  const name = c.req.param("name");
  const pipelineDir = safePath(pipelinesDir, name);
  if (!pipelineDir) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid pipeline name");

  const body = getValidatedBody(c) as { content: string };

  let parsed: PipelineConfig;
  try {
    parsed = parseYAML(body.content) as PipelineConfig;
  } catch (e) {
    return errorResponse(c, 400, ErrorCode.INVALID_CONFIG, `Invalid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!parsed || !Array.isArray(parsed.stages)) {
    return errorResponse(c, 400, ErrorCode.INVALID_CONFIG, "Pipeline must have a stages array");
  }
  for (const entry of parsed.stages) {
    if (isParallelGroup(entry)) {
      if (!entry.parallel?.name || !Array.isArray(entry.parallel?.stages)) {
        return errorResponse(c, 400, ErrorCode.INVALID_CONFIG, `Parallel group must have name and stages array`);
      }
      for (const s of entry.parallel.stages) {
        if (!s.name || !s.type) {
          return errorResponse(c, 400, ErrorCode.INVALID_CONFIG, `Each stage in parallel group must have name and type. Invalid: ${JSON.stringify(s)}`);
        }
      }
    } else {
      const stage = entry as any;
      if (!stage.name || !stage.type) {
        return errorResponse(c, 400, ErrorCode.INVALID_CONFIG, `Each stage must have name and type. Invalid: ${JSON.stringify(stage)}`);
      }
    }
  }

  // Run business logic validation (reads/writes flow, condition branches, required fields, etc.)
  let promptKeys: Set<string> | undefined;
  try {
    promptKeys = new Set<string>();
    const promptDir = join(pipelineDir, "prompts", "system");
    if (existsSync(promptDir)) {
      for (const f of readdirSync(promptDir)) {
        if (f.endsWith(".md")) promptKeys.add(f.replace(/\.md$/, ""));
      }
    }
    const globalPromptDir = join(CONFIG_DIR, "prompts", "system");
    if (existsSync(globalPromptDir)) {
      for (const f of readdirSync(globalPromptDir)) {
        if (f.endsWith(".md")) promptKeys.add(f.replace(/\.md$/, ""));
      }
    }
  } catch {
    // Prompt directory scan failed — skip prompt validation, still run other checks
    promptKeys = undefined;
  }

  const issues = validatePipelineLogic(parsed.stages as any[], promptKeys);
  const errors = getValidationErrors(issues);
  if (errors.length > 0) {
    return c.json({ ok: false, errors: errors.map((e) => e.message), warnings: issues.filter((i) => i.severity === "warning").map((i) => i.message) }, 400);
  }

  ensureDir(pipelineDir);
  atomicWriteSync(join(pipelineDir, "pipeline.yaml"), body.content);
  clearConfigCache();

  const warnings = issues.filter((i) => i.severity === "warning").map((i) => i.message);
  return c.json({ ok: true, parsed, warnings });
});

// AI Pipeline Generation
configRoute.post("/config/pipelines/generate", async (c) => {
  const body = await c.req.json<{ description: string; engine?: "claude" | "gemini" }>();

  if (!body.description || body.description.length < 10) {
    return errorResponse(c, 400, ErrorCode.VALIDATION_FAILED, "Description must be at least 10 characters");
  }

  const settings = loadSystemSettings();
  const engine = body.engine ?? settings.agent?.default_engine ?? "claude";

  // Check CLI exists
  const { execSync } = await import("node:child_process");
  try {
    const executable = engine === "claude"
      ? (settings.paths?.claude_executable ?? "claude")
      : (settings.paths?.gemini_executable ?? "gemini");
    execSync("which " + (/^[a-zA-Z0-9_.\-/]+$/.test(executable) ? executable : ""), { stdio: "ignore" });
  } catch {
    return errorResponse(c, 503, ErrorCode.INTERNAL_ERROR, `${engine} CLI not found. Please install it first.`);
  }

  try {
    const { generatePipeline } = await import("../services/pipeline-generator.js");
    const result = await generatePipeline({ description: body.description, engine: body.engine });
    return c.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, `Generation failed: ${msg}`);
  }
});

// Create a new pipeline (copies from an existing one or creates minimal)
configRoute.post("/config/pipelines", async (c) => {
  const body = await c.req.json<{ id: string; copyFrom?: string; content?: string }>();
  if (!body.id || typeof body.id !== "string") return errorResponse(c, 400, ErrorCode.VALIDATION_FAILED, "id is required");
  if (/[^a-z0-9-]/.test(body.id)) return errorResponse(c, 400, ErrorCode.VALIDATION_FAILED, "id must be lowercase alphanumeric with hyphens");
  const RESERVED_IDS = ["generate"];
  if (RESERVED_IDS.includes(body.id)) return errorResponse(c, 400, ErrorCode.VALIDATION_FAILED, `Pipeline id "${body.id}" is reserved`);

  const targetDir = safePath(pipelinesDir, body.id);
  if (!targetDir) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid pipeline id");
  if (existsSync(join(targetDir, "pipeline.yaml"))) {
    return errorResponse(c, 409, ErrorCode.INVALID_STATE, `Pipeline "${body.id}" already exists`);
  }

  ensureDir(targetDir);
  ensureDir(join(targetDir, "prompts", "system"));

  if (body.copyFrom) {
    const sourceDir = safePath(pipelinesDir, body.copyFrom);
    if (!sourceDir || !existsSync(join(sourceDir, "pipeline.yaml"))) {
      return errorResponse(c, 404, ErrorCode.FILE_NOT_FOUND, `Source pipeline "${body.copyFrom}" not found`);
    }
    // Copy pipeline.yaml and all prompts
    const { cpSync } = await import("node:fs");
    cpSync(sourceDir, targetDir, { recursive: true });
  } else if (body.content) {
    atomicWriteSync(join(targetDir, "pipeline.yaml"), body.content);
  } else {
    const minimal = `name: "${body.id}"\ndescription: ""\nengine: claude\nstages: []\n`;
    atomicWriteSync(join(targetDir, "pipeline.yaml"), minimal);
  }

  clearConfigCache();
  return c.json({ ok: true, id: body.id }, 201);
});

// Delete a pipeline
configRoute.delete("/config/pipelines/:name", async (c) => {
  const name = c.req.param("name");
  const pipelineDir = safePath(pipelinesDir, name);
  if (!pipelineDir) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid pipeline name");
  if (!existsSync(join(pipelineDir, "pipeline.yaml"))) {
    return errorResponse(c, 404, ErrorCode.FILE_NOT_FOUND, "Pipeline not found");
  }

  // Protect official pipelines from deletion
  try {
    const raw = readFileSync(join(pipelineDir, "pipeline.yaml"), "utf-8");
    const parsed = parseYAML(raw) as PipelineConfig;
    if (parsed.official) {
      return errorResponse(c, 403, ErrorCode.INVALID_CONFIG, "Cannot delete official pipeline");
    }
  } catch { /* proceed with deletion if parse fails */ }

  const trashDir = join(pipelinesDir, ".trash");
  ensureDir(trashDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  renameSync(pipelineDir, join(trashDir, `${name}-${timestamp}`));
  clearConfigCache();
  return c.json({ ok: true });
});

// Get/Put pipeline constraints
configRoute.get("/config/pipelines/:name/prompts/constraints", (c) => {
  const name = c.req.param("name");
  const pipelineDir = safePath(pipelinesDir, name);
  if (!pipelineDir) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid pipeline name");
  const filePath = join(pipelineDir, "prompts", "global-constraints.md");
  if (!existsSync(filePath)) return c.json({ content: "" });
  return c.json({ content: readFileSync(filePath, "utf-8") });
});

configRoute.put("/config/pipelines/:name/prompts/constraints", validateBody(yamlContentSchema), async (c) => {
  const name = c.req.param("name");
  const pipelineDir = safePath(pipelinesDir, name);
  if (!pipelineDir) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid pipeline name");

  const body = getValidatedBody(c) as { content: string };

  ensureDir(join(pipelineDir, "prompts"));
  atomicWriteSync(join(pipelineDir, "prompts", "global-constraints.md"), body.content);
  clearConfigCache();
  return c.json({ ok: true });
});

// List system prompts for a pipeline
configRoute.get("/config/pipelines/:name/prompts/system", (c) => {
  const name = c.req.param("name");
  const promptDir = safePath(pipelinesDir, name);
  if (!promptDir) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid pipeline name");
  const systemDir = join(promptDir, "prompts", "system");
  return c.json({ prompts: listFiles(systemDir, ".md") });
});

// Get/Put individual system prompt for a pipeline
configRoute.get("/config/pipelines/:name/prompts/system/:promptName", (c) => {
  const name = c.req.param("name");
  const promptName = c.req.param("promptName");
  const pipelineDir = safePath(pipelinesDir, name);
  if (!pipelineDir) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid pipeline name");
  const fileName = promptName.endsWith(".md") ? promptName : `${promptName}.md`;
  const filePath = safePath(join(pipelineDir, "prompts", "system"), fileName);
  if (!filePath) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid prompt name");
  if (!existsSync(filePath)) return errorResponse(c, 404, ErrorCode.FILE_NOT_FOUND, "Prompt not found");
  return c.json({ content: readFileSync(filePath, "utf-8") });
});

configRoute.put("/config/pipelines/:name/prompts/system/:promptName", validateBody(yamlContentSchema), async (c) => {
  const name = c.req.param("name");
  const promptName = c.req.param("promptName");
  const pipelineDir = safePath(pipelinesDir, name);
  if (!pipelineDir) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid pipeline name");
  const fileName = promptName.endsWith(".md") ? promptName : `${promptName}.md`;
  const filePath = safePath(join(pipelineDir, "prompts", "system"), fileName);
  if (!filePath) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid prompt name");

  const body = getValidatedBody(c) as { content: string };

  ensureDir(resolve(filePath, ".."));
  atomicWriteSync(filePath, body.content);
  clearConfigCache();
  return c.json({ ok: true });
});

configRoute.delete("/config/pipelines/:name/prompts/system/:promptName", (c) => {
  const name = c.req.param("name");
  const promptName = c.req.param("promptName");
  const pipelineDir = safePath(pipelinesDir, name);
  if (!pipelineDir) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid pipeline name");
  const fileName = promptName.endsWith(".md") ? promptName : `${promptName}.md`;
  const filePath = safePath(join(pipelineDir, "prompts", "system"), fileName);
  if (!filePath) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid prompt name");
  if (!existsSync(filePath)) return errorResponse(c, 404, ErrorCode.FILE_NOT_FOUND, "File not found");

  unlinkSync(filePath);
  clearConfigCache();
  return c.json({ ok: true });
});

// Legacy alias: GET/PUT /config/pipeline → redirect to pipeline-generator
configRoute.get("/config/pipeline", (c) => {
  const filePath = join(pipelinesDir, "pipeline-generator", "pipeline.yaml");
  if (!existsSync(filePath)) {
    return c.json({ raw: "", parsed: null });
  }
  const raw = readFileSync(filePath, "utf-8");
  try {
    const parsed = parseYAML(raw) as PipelineConfig;
    return c.json({ raw, parsed });
  } catch {
    return c.json({ raw, parsed: null });
  }
});

configRoute.put("/config/pipeline", validateBody(yamlContentSchema), async (c) => {
  const body = getValidatedBody(c) as { content: string };

  let parsed: PipelineConfig;
  try {
    parsed = parseYAML(body.content) as PipelineConfig;
  } catch (e) {
    return errorResponse(c, 400, ErrorCode.INVALID_CONFIG, `Invalid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!parsed || !Array.isArray(parsed.stages)) {
    return errorResponse(c, 400, ErrorCode.INVALID_CONFIG, "Pipeline must have a stages array");
  }

  const targetDir = join(pipelinesDir, "pipeline-generator");
  ensureDir(targetDir);
  atomicWriteSync(join(targetDir, "pipeline.yaml"), body.content);
  clearConfigCache();

  return c.json({ ok: true, parsed });
});

// --- Prompts ---

const promptsDir = join(CONFIG_DIR, "prompts");

configRoute.get("/config/prompts", (c) => {
  return c.json({
    system: listFiles(join(promptsDir, "system"), ".md"),
    fragments: listFiles(join(promptsDir, "fragments"), ".md"),
    globalConstraints: existsSync(join(promptsDir, "global-constraints.md")),
  });
});

function resolvePromptPath(category: string, name: string): string | null {
  if (category === "global" && name === "constraints") {
    return join(promptsDir, "global-constraints.md");
  }
  if (category === "system" || category === "fragments") {
    const fileName = name.endsWith(".md") ? name : `${name}.md`;
    return safePath(join(promptsDir, category), fileName);
  }
  return null;
}

configRoute.get("/config/prompts/:category/:name", (c) => {
  const filePath = resolvePromptPath(c.req.param("category"), c.req.param("name"));
  if (!filePath) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid path");
  if (!existsSync(filePath)) return errorResponse(c, 404, ErrorCode.FILE_NOT_FOUND, "File not found");
  return c.json({ content: readFileSync(filePath, "utf-8") });
});

configRoute.put("/config/prompts/:category/:name", validateBody(yamlContentSchema), async (c) => {
  const filePath = resolvePromptPath(c.req.param("category"), c.req.param("name"));
  if (!filePath) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid path");

  const body = getValidatedBody(c) as { content: string };

  ensureDir(resolve(filePath, ".."));
  atomicWriteSync(filePath, body.content);
  clearConfigCache();
  return c.json({ ok: true });
});

configRoute.delete("/config/prompts/:category/:name", (c) => {
  const category = c.req.param("category");
  if (category === "global") return errorResponse(c, 400, ErrorCode.INVALID_CONFIG, "Cannot delete global constraints via this endpoint");

  const filePath = resolvePromptPath(category, c.req.param("name"));
  if (!filePath) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid path");
  if (!existsSync(filePath)) return errorResponse(c, 404, ErrorCode.FILE_NOT_FOUND, "File not found");

  unlinkSync(filePath);
  return c.json({ ok: true });
});

// --- Fragment Registry ---

configRoute.get("/config/fragments/registry", (c) => {
  const registry = getFragmentRegistry();
  const entries: Record<string, { meta: { id: string; keywords: string[]; stages: string[] | "*"; always: boolean }; content: string }> = {};
  for (const [id, entry] of registry.getAllEntries()) {
    entries[id] = { meta: entry.meta, content: entry.content };
  }
  return c.json({ entries });
});

// --- MCP Registry ---

const mcpsDir = join(CONFIG_DIR, "mcps");

configRoute.get("/config/mcps", (c) => {
  const filePath = join(mcpsDir, "registry.yaml");
  if (!existsSync(filePath)) return c.json({ raw: "", registry: {} });
  const raw = readFileSync(filePath, "utf-8");
  try {
    return c.json({ raw, registry: parseYAML(raw) as Record<string, unknown> });
  } catch {
    return c.json({ raw, registry: {} });
  }
});

configRoute.put("/config/mcps", validateBody(yamlContentSchema), async (c) => {
  const body = getValidatedBody(c) as { content: string };

  let parsed: Record<string, unknown>;
  try {
    parsed = parseYAML(body.content) as Record<string, unknown>;
  } catch (e) {
    return errorResponse(c, 400, ErrorCode.INVALID_CONFIG, `Invalid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!parsed || typeof parsed !== "object") return errorResponse(c, 400, ErrorCode.INVALID_CONFIG, "MCP registry must be a YAML object");

  ensureDir(mcpsDir);
  atomicWriteSync(join(mcpsDir, "registry.yaml"), body.content);
  return c.json({ ok: true, registry: parsed });
});

// --- Custom scripts ---

const ALLOWED_SCRIPT_FILES = ["manifest.yaml", "index.ts"];

configRoute.put("/config/scripts/:scriptId/:filename", validateBody(yamlContentSchema), async (c) => {
  const scriptId = c.req.param("scriptId");
  const filename = c.req.param("filename");
  if (!/^[a-z0-9_-]+$/.test(scriptId)) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid script ID");
  if (!ALLOWED_SCRIPT_FILES.includes(filename)) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid filename");

  const filePath = join(CONFIG_DIR, "scripts", scriptId, filename);
  const body = getValidatedBody(c) as { content: string };
  ensureDir(join(CONFIG_DIR, "scripts", scriptId));
  atomicWriteSync(filePath, body.content);
  return c.json({ ok: true });
});

configRoute.delete("/config/scripts/:scriptId/:filename", (c) => {
  const scriptId = c.req.param("scriptId");
  const filename = c.req.param("filename");
  if (!/^[a-z0-9_-]+$/.test(scriptId)) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid script ID");
  if (!ALLOWED_SCRIPT_FILES.includes(filename)) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid filename");

  const filePath = join(CONFIG_DIR, "scripts", scriptId, filename);
  if (!existsSync(filePath)) return errorResponse(c, 404, ErrorCode.FILE_NOT_FOUND, "File not found");
  unlinkSync(filePath);
  return c.json({ ok: true });
});

configRoute.get("/config/scripts/:scriptId/:filename", (c) => {
  const scriptId = c.req.param("scriptId");
  const filename = c.req.param("filename");
  if (!/^[a-z0-9_-]+$/.test(scriptId)) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid script ID");
  if (!ALLOWED_SCRIPT_FILES.includes(filename)) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid filename");

  const filePath = join(CONFIG_DIR, "scripts", scriptId, filename);
  if (!existsSync(filePath)) return errorResponse(c, 404, ErrorCode.FILE_NOT_FOUND, "File not found");
  return c.json({ content: readFileSync(filePath, "utf-8") });
});

// --- Generic config files (gates, hooks, skills) ---

const EDITABLE_SUBDIRS = ["gates", "hooks", "skills"] as const;

function isEditableSubdir(s: string): s is (typeof EDITABLE_SUBDIRS)[number] {
  return (EDITABLE_SUBDIRS as readonly string[]).includes(s);
}

configRoute.get("/config/overview", (c) => {
  return c.json({
    gates: listFiles(join(CONFIG_DIR, "gates")),
    hooks: listFiles(join(CONFIG_DIR, "hooks")),
    skills: listFiles(join(CONFIG_DIR, "skills")),
  });
});

configRoute.get("/config/files/:subdir/:name", (c) => {
  const subdir = c.req.param("subdir");
  if (!isEditableSubdir(subdir)) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid subdir");

  const filePath = safePath(join(CONFIG_DIR, subdir), c.req.param("name"));
  if (!filePath) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid path");
  if (!existsSync(filePath)) return errorResponse(c, 404, ErrorCode.FILE_NOT_FOUND, "File not found");

  return c.json({ content: readFileSync(filePath, "utf-8") });
});

configRoute.put("/config/files/:subdir/:name", validateBody(yamlContentSchema), async (c) => {
  const subdir = c.req.param("subdir");
  if (!isEditableSubdir(subdir)) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid subdir");

  const filePath = safePath(join(CONFIG_DIR, subdir), c.req.param("name"));
  if (!filePath) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid path");

  const body = getValidatedBody(c) as { content: string };

  ensureDir(resolve(filePath, ".."));
  atomicWriteSync(filePath, body.content);
  return c.json({ ok: true });
});

configRoute.delete("/config/files/:subdir/:name", (c) => {
  const subdir = c.req.param("subdir");
  if (!isEditableSubdir(subdir)) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid subdir");

  const filePath = safePath(join(CONFIG_DIR, subdir), c.req.param("name"));
  if (!filePath) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid path");
  if (!existsSync(filePath)) return errorResponse(c, 404, ErrorCode.FILE_NOT_FOUND, "File not found");

  unlinkSync(filePath);
  return c.json({ ok: true });
});

// --- CLAUDE.md layers ---

const claudeMdDir = join(CONFIG_DIR, "claude-md");

configRoute.get("/config/claude-md", (c) => {
  const globalFiles = listFiles(claudeMdDir).filter((f) => !f.startsWith("stage"));
  const stageDir = join(claudeMdDir, "stage");
  const stageFiles = listFiles(stageDir);
  return c.json({ global: globalFiles, stage: stageFiles });
});

configRoute.get("/config/claude-md/:layer/:name", (c) => {
  const layer = c.req.param("layer");
  if (layer !== "global" && layer !== "stage") return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid layer");

  const base = layer === "stage" ? join(claudeMdDir, "stage") : claudeMdDir;
  const filePath = safePath(base, c.req.param("name"));
  if (!filePath) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid path");
  if (!existsSync(filePath)) return errorResponse(c, 404, ErrorCode.FILE_NOT_FOUND, "File not found");

  return c.json({ content: readFileSync(filePath, "utf-8") });
});

configRoute.put("/config/claude-md/:layer/:name", validateBody(yamlContentSchema), async (c) => {
  const layer = c.req.param("layer");
  if (layer !== "global" && layer !== "stage") return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid layer");

  const base = layer === "stage" ? join(claudeMdDir, "stage") : claudeMdDir;
  const filePath = safePath(base, c.req.param("name"));
  if (!filePath) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid path");

  const body = getValidatedBody(c) as { content: string };

  ensureDir(resolve(filePath, ".."));
  atomicWriteSync(filePath, body.content);
  return c.json({ ok: true });
});

configRoute.delete("/config/claude-md/:layer/:name", (c) => {
  const layer = c.req.param("layer");
  if (layer !== "global" && layer !== "stage") return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid layer");

  const base = layer === "stage" ? join(claudeMdDir, "stage") : claudeMdDir;
  const filePath = safePath(base, c.req.param("name"));
  if (!filePath) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid path");
  if (!existsSync(filePath)) return errorResponse(c, 404, ErrorCode.FILE_NOT_FOUND, "File not found");

  unlinkSync(filePath);
  return c.json({ ok: true });
});

// --- GEMINI.md layers ---

const geminiMdDir = join(CONFIG_DIR, "gemini-md");

configRoute.get("/config/gemini-md", (c) => {
  const globalFiles = listFiles(geminiMdDir).filter((f) => !f.startsWith("stage"));
  const stageDir = join(geminiMdDir, "stage");
  const stageFiles = listFiles(stageDir);
  return c.json({ global: globalFiles, stage: stageFiles });
});

configRoute.get("/config/gemini-md/:layer/:name", (c) => {
  const layer = c.req.param("layer");
  if (layer !== "global" && layer !== "stage") return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid layer");

  const base = layer === "stage" ? join(geminiMdDir, "stage") : geminiMdDir;
  const filePath = safePath(base, c.req.param("name"));
  if (!filePath) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid path");
  if (!existsSync(filePath)) return errorResponse(c, 404, ErrorCode.FILE_NOT_FOUND, "File not found");

  return c.json({ content: readFileSync(filePath, "utf-8") });
});

configRoute.put("/config/gemini-md/:layer/:name", validateBody(yamlContentSchema), async (c) => {
  const layer = c.req.param("layer");
  if (layer !== "global" && layer !== "stage") return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid layer");

  const base = layer === "stage" ? join(geminiMdDir, "stage") : geminiMdDir;
  const filePath = safePath(base, c.req.param("name"));
  if (!filePath) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid path");

  const body = getValidatedBody(c) as { content: string };

  ensureDir(resolve(filePath, ".."));
  atomicWriteSync(filePath, body.content);
  return c.json({ ok: true });
});

configRoute.delete("/config/gemini-md/:layer/:name", (c) => {
  const layer = c.req.param("layer");
  if (layer !== "global" && layer !== "stage") return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid layer");

  const base = layer === "stage" ? join(geminiMdDir, "stage") : geminiMdDir;
  const filePath = safePath(base, c.req.param("name"));
  if (!filePath) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid path");
  if (!existsSync(filePath)) return errorResponse(c, 404, ErrorCode.FILE_NOT_FOUND, "File not found");

  unlinkSync(filePath);
  return c.json({ ok: true });
});
