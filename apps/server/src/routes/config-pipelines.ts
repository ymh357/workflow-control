import { Hono } from "hono";
import { readFileSync, existsSync, readdirSync, unlinkSync, renameSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYAML, stringify as stringifyYAML } from "yaml";
import { CONFIG_DIR, clearConfigCache, type PipelineConfig, loadSystemSettings, listAvailablePipelines } from "../lib/config-loader.js";
import { validateBody, getValidatedBody, yamlContentSchema } from "../middleware/validate.js";
import { errorResponse, ErrorCode } from "../lib/error-response.js";
import {
  safePath, ensureDir, atomicWriteSync, listFiles, captureSnapshots, restoreSnapshots,
  SAFE_ID_PATTERN, toPromptFileName, rebuildFragmentFile, validatePipelinePayload,
  rejectDangerousKeys, settingsPath, pipelinesDir,
} from "./config-helpers.js";

export const configPipelinesRoute = new Hono();

// --- Available Pipelines (for pipeline-call / foreach selectors) ---

configPipelinesRoute.get("/config/pipelines-list", (c) => {
  const manifests = listAvailablePipelines();
  return c.json(manifests);
});

// --- Pipelines ---

// List all available pipelines
configPipelinesRoute.get("/config/pipelines", (c) => {
  return c.json({ pipelines: listAvailablePipelines() });
});

// Get a specific pipeline by name
configPipelinesRoute.get("/config/pipelines/:name", async (c) => {
  const name = c.req.param("name");
  const pipelineDir = safePath(pipelinesDir, name);
  if (!pipelineDir) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid pipeline name");
  const filePath = join(pipelineDir, "pipeline.yaml");
  if (!existsSync(filePath)) {
    return c.json({ raw: "", parsed: null }, 404);
  }
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, "Failed to read pipeline file");
  }
  try {
    const parsed = parseYAML(raw) as PipelineConfig;
    return c.json({ raw, parsed });
  } catch {
    return c.json({ raw, parsed: null });
  }
});

// Update a specific pipeline
configPipelinesRoute.put("/config/pipelines/:name", validateBody(yamlContentSchema), async (c) => {
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

  const dangerousKey = rejectDangerousKeys(parsed);
  if (dangerousKey) {
    return errorResponse(c, 400, ErrorCode.VALIDATION_FAILED, dangerousKey);
  }

  const validation = validatePipelinePayload(parsed, pipelineDir);
  if (validation.errors.length > 0) {
    return c.json({ ok: false, errors: validation.errors, warnings: validation.warnings }, 400);
  }
  const warnings = validation.warnings;

  ensureDir(pipelineDir);
  atomicWriteSync(join(pipelineDir, "pipeline.yaml"), body.content);
  clearConfigCache();

  return c.json({ ok: true, parsed, warnings });
});

configPipelinesRoute.put("/config/workbench/:name", async (c) => {
  const name = c.req.param("name");
  const pipelineDir = safePath(pipelinesDir, name);
  if (!pipelineDir) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid pipeline name");

  const body = await c.req.json().catch(() => null) as {
    config?: {
      pipeline?: PipelineConfig;
      prompts?: {
        system?: Record<string, string>;
        fragments?: Record<string, string>;
        fragmentMeta?: Record<string, { id: string; keywords?: string[]; stages?: string[] | "*"; always?: boolean }>;
        globalConstraints?: string;
        globalClaudeMd?: string;
        globalGeminiMd?: string;
        globalCodexMd?: string;
      };
      agent?: Record<string, unknown>;
      sandbox?: Record<string, unknown>;
      _deletedPrompts?: string[];
      _deletedFragments?: string[];
    };
  } | null;
  if (!body?.config?.pipeline || !body.config.prompts) {
    return errorResponse(c, 400, ErrorCode.VALIDATION_FAILED, "config.pipeline and config.prompts are required");
  }

  // Validate IDs to prevent path traversal
  for (const key of body.config._deletedPrompts ?? []) {
    if (!SAFE_ID_PATTERN.test(toPromptFileName(key))) {
      return errorResponse(c, 400, ErrorCode.VALIDATION_FAILED, `Invalid prompt key: ${key}`);
    }
  }
  for (const id of body.config._deletedFragments ?? []) {
    if (!SAFE_ID_PATTERN.test(id)) {
      return errorResponse(c, 400, ErrorCode.VALIDATION_FAILED, `Invalid fragment id: ${id}`);
    }
  }
  for (const key of Object.keys(body.config.prompts.system ?? {})) {
    if (!SAFE_ID_PATTERN.test(toPromptFileName(key))) {
      return errorResponse(c, 400, ErrorCode.VALIDATION_FAILED, `Invalid system prompt key: ${key}`);
    }
  }
  for (const id of Object.keys(body.config.prompts.fragments ?? {})) {
    if (!SAFE_ID_PATTERN.test(id)) {
      return errorResponse(c, 400, ErrorCode.VALIDATION_FAILED, `Invalid fragment id: ${id}`);
    }
  }

  const validation = validatePipelinePayload(body.config.pipeline, pipelineDir, {
    systemPrompts: body.config.prompts.system,
    deletedPrompts: body.config._deletedPrompts,
  });
  if (validation.errors.length > 0) {
    return c.json({ ok: false, errors: validation.errors, warnings: validation.warnings }, 400);
  }

  const writes = new Map<string, string>();
  const deletes = new Set<string>();

  writes.set(join(pipelineDir, "pipeline.yaml"), stringifyYAML(body.config.pipeline));
  writes.set(join(pipelineDir, "prompts", "global-constraints.md"), body.config.prompts.globalConstraints ?? "");
  writes.set(join(CONFIG_DIR, "claude-md", "global.md"), body.config.prompts.globalClaudeMd ?? "");
  writes.set(join(CONFIG_DIR, "gemini-md", "global.md"), body.config.prompts.globalGeminiMd ?? "");
  writes.set(join(CONFIG_DIR, "codex-md", "global.md"), body.config.prompts.globalCodexMd ?? "");

  for (const [key, content] of Object.entries(body.config.prompts.system ?? {})) {
    writes.set(join(pipelineDir, "prompts", "system", `${toPromptFileName(key)}.md`), content);
  }

  const fragmentMeta = body.config.prompts.fragmentMeta ?? {};
  for (const [id, content] of Object.entries(body.config.prompts.fragments ?? {})) {
    const meta = fragmentMeta[id] ?? { id, keywords: [], stages: "*", always: false };
    writes.set(
      join(CONFIG_DIR, "prompts", "fragments", `${id}.md`),
      rebuildFragmentFile(content, meta),
    );
  }

  for (const key of body.config._deletedPrompts ?? []) {
    deletes.add(join(pipelineDir, "prompts", "system", `${toPromptFileName(key)}.md`));
  }
  for (const id of body.config._deletedFragments ?? []) {
    deletes.add(join(CONFIG_DIR, "prompts", "fragments", `${id}.md`));
  }

  if (body.config.agent || body.config.sandbox) {
    let yamlConfig: Record<string, any> = {};
    if (existsSync(settingsPath)) {
      try {
        yamlConfig = parseYAML(readFileSync(settingsPath, "utf-8")) || {};
      } catch { /* start fresh */ }
    }
    if (body.config.agent) {
      yamlConfig.agent = { ...(yamlConfig.agent ?? {}), ...body.config.agent };
    }
    if (body.config.sandbox && "enabled" in body.config.sandbox) {
      yamlConfig.sandbox = {
        enabled: body.config.sandbox.enabled ?? false,
        auto_allow_bash: body.config.sandbox.auto_allow_bash ?? true,
        allow_unsandboxed_commands: body.config.sandbox.allow_unsandboxed_commands ?? true,
        network: body.config.sandbox.network ?? { allowed_domains: [] },
        filesystem: body.config.sandbox.filesystem ?? { allow_write: [], deny_write: [], deny_read: [] },
      };
    }
    writes.set(settingsPath, stringifyYAML(yamlConfig));
  }

  const snapshots = captureSnapshots([...writes.keys(), ...deletes]);
  try {
    for (const [filePath, content] of writes) {
      ensureDir(resolve(filePath, ".."));
      atomicWriteSync(filePath, content);
    }
    for (const filePath of deletes) {
      if (existsSync(filePath)) unlinkSync(filePath);
    }
    clearConfigCache();
    return c.json({ ok: true, warnings: validation.warnings });
  } catch (err) {
    restoreSnapshots(snapshots);
    clearConfigCache();
    return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
  }
});

// AI Pipeline Generation
configPipelinesRoute.post("/config/pipelines/generate", async (c) => {
  const body = await c.req.json<{ description: string; engine?: "claude" | "gemini" }>();

  if (!body.description || body.description.length < 10) {
    return errorResponse(c, 400, ErrorCode.VALIDATION_FAILED, "Description must be at least 10 characters");
  }

  const settings = loadSystemSettings();
  const engine = body.engine ?? settings.agent?.default_engine ?? "claude";

  // Check CLI exists
  const { execFileSync } = await import("node:child_process");
  try {
    const executable = engine === "claude"
      ? (settings.paths?.claude_executable ?? "claude")
      : (settings.paths?.gemini_executable ?? "gemini");
    execFileSync("which", [/^[a-zA-Z0-9_.\-/]+$/.test(executable) ? executable : "false"], { stdio: "ignore" });
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
configPipelinesRoute.post("/config/pipelines", async (c) => {
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
configPipelinesRoute.delete("/config/pipelines/:name", async (c) => {
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
configPipelinesRoute.get("/config/pipelines/:name/prompts/constraints", async (c) => {
  const name = c.req.param("name");
  const pipelineDir = safePath(pipelinesDir, name);
  if (!pipelineDir) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid pipeline name");
  const filePath = join(pipelineDir, "prompts", "global-constraints.md");
  if (!existsSync(filePath)) return c.json({ content: "" });
  try {
    return c.json({ content: await readFile(filePath, "utf-8") });
  } catch {
    return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, "Failed to read file");
  }
});

configPipelinesRoute.put("/config/pipelines/:name/prompts/constraints", validateBody(yamlContentSchema), async (c) => {
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
configPipelinesRoute.get("/config/pipelines/:name/prompts/system", (c) => {
  const name = c.req.param("name");
  const promptDir = safePath(pipelinesDir, name);
  if (!promptDir) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid pipeline name");
  const systemDir = join(promptDir, "prompts", "system");
  return c.json({ prompts: listFiles(systemDir, ".md") });
});

// Get/Put individual system prompt for a pipeline
configPipelinesRoute.get("/config/pipelines/:name/prompts/system/:promptName", async (c) => {
  const name = c.req.param("name");
  const promptName = c.req.param("promptName");
  const pipelineDir = safePath(pipelinesDir, name);
  if (!pipelineDir) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid pipeline name");
  const fileName = promptName.endsWith(".md") ? promptName : `${promptName}.md`;
  const filePath = safePath(join(pipelineDir, "prompts", "system"), fileName);
  if (!filePath) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid prompt name");
  if (!existsSync(filePath)) return errorResponse(c, 404, ErrorCode.FILE_NOT_FOUND, "Prompt not found");
  try {
    return c.json({ content: await readFile(filePath, "utf-8") });
  } catch {
    return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, "Failed to read file");
  }
});

configPipelinesRoute.put("/config/pipelines/:name/prompts/system/:promptName", validateBody(yamlContentSchema), async (c) => {
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

configPipelinesRoute.delete("/config/pipelines/:name/prompts/system/:promptName", (c) => {
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
configPipelinesRoute.get("/config/pipeline", async (c) => {
  const filePath = join(pipelinesDir, "pipeline-generator", "pipeline.yaml");
  if (!existsSync(filePath)) {
    return c.json({ raw: "", parsed: null });
  }
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, "Failed to read pipeline file");
  }
  try {
    const parsed = parseYAML(raw) as PipelineConfig;
    return c.json({ raw, parsed });
  } catch {
    return c.json({ raw, parsed: null });
  }
});

configPipelinesRoute.put("/config/pipeline", validateBody(yamlContentSchema), async (c) => {
  const body = getValidatedBody(c) as { content: string };

  let parsed: PipelineConfig;
  try {
    parsed = parseYAML(body.content) as PipelineConfig;
  } catch (e) {
    return errorResponse(c, 400, ErrorCode.INVALID_CONFIG, `Invalid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }

  const dangerousKey = rejectDangerousKeys(parsed);
  if (dangerousKey) {
    return errorResponse(c, 400, ErrorCode.VALIDATION_FAILED, dangerousKey);
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
