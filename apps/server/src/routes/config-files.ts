import { Hono } from "hono";
import { existsSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYAML } from "yaml";
import { CONFIG_DIR, loadMcpRegistry } from "../lib/config-loader.js";
import { scriptRegistry } from "../scripts/index.js";
import { validateBody, getValidatedBody, yamlContentSchema } from "../middleware/validate.js";
import { errorResponse, ErrorCode } from "../lib/error-response.js";
import { safePath, ensureDir, atomicWriteSync, listFiles, rejectDangerousKeys } from "./config-helpers.js";

export const configFilesRoute = new Hono();

// --- Scripts ---

configFilesRoute.get("/config/scripts", (c) => {
  return c.json(scriptRegistry.getAllMetadata());
});

// --- Custom scripts ---

const ALLOWED_SCRIPT_FILES = ["manifest.yaml", "index.ts"];

configFilesRoute.put("/config/scripts/:scriptId/:filename", validateBody(yamlContentSchema), async (c) => {
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

configFilesRoute.delete("/config/scripts/:scriptId/:filename", (c) => {
  const scriptId = c.req.param("scriptId");
  const filename = c.req.param("filename");
  if (!/^[a-z0-9_-]+$/.test(scriptId)) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid script ID");
  if (!ALLOWED_SCRIPT_FILES.includes(filename)) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid filename");

  const filePath = join(CONFIG_DIR, "scripts", scriptId, filename);
  if (!existsSync(filePath)) return errorResponse(c, 404, ErrorCode.FILE_NOT_FOUND, "File not found");
  unlinkSync(filePath);
  return c.json({ ok: true });
});

configFilesRoute.get("/config/scripts/:scriptId/:filename", async (c) => {
  const scriptId = c.req.param("scriptId");
  const filename = c.req.param("filename");
  if (!/^[a-z0-9_-]+$/.test(scriptId)) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid script ID");
  if (!ALLOWED_SCRIPT_FILES.includes(filename)) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid filename");

  const filePath = join(CONFIG_DIR, "scripts", scriptId, filename);
  if (!existsSync(filePath)) return errorResponse(c, 404, ErrorCode.FILE_NOT_FOUND, "File not found");
  try {
    return c.json({ content: await readFile(filePath, "utf-8") });
  } catch {
    return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, "Failed to read file");
  }
});

// --- Generic config files (gates, hooks, skills) ---

const EDITABLE_SUBDIRS = ["gates", "hooks", "skills"] as const;

function isEditableSubdir(s: string): s is (typeof EDITABLE_SUBDIRS)[number] {
  return (EDITABLE_SUBDIRS as readonly string[]).includes(s);
}

configFilesRoute.get("/config/overview", (c) => {
  return c.json({
    gates: listFiles(join(CONFIG_DIR, "gates")),
    hooks: listFiles(join(CONFIG_DIR, "hooks")),
    skills: listFiles(join(CONFIG_DIR, "skills")),
  });
});

configFilesRoute.get("/config/files/:subdir/:name", async (c) => {
  const subdir = c.req.param("subdir");
  if (!isEditableSubdir(subdir)) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid subdir");

  const filePath = safePath(join(CONFIG_DIR, subdir), c.req.param("name"));
  if (!filePath) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid path");
  if (!existsSync(filePath)) return errorResponse(c, 404, ErrorCode.FILE_NOT_FOUND, "File not found");

  try {
    return c.json({ content: await readFile(filePath, "utf-8") });
  } catch {
    return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, "Failed to read file");
  }
});

configFilesRoute.put("/config/files/:subdir/:name", validateBody(yamlContentSchema), async (c) => {
  const subdir = c.req.param("subdir");
  if (!isEditableSubdir(subdir)) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid subdir");

  const filePath = safePath(join(CONFIG_DIR, subdir), c.req.param("name"));
  if (!filePath) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid path");

  const body = getValidatedBody(c) as { content: string };

  ensureDir(resolve(filePath, ".."));
  atomicWriteSync(filePath, body.content);
  return c.json({ ok: true });
});

configFilesRoute.delete("/config/files/:subdir/:name", (c) => {
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

configFilesRoute.get("/config/claude-md", (c) => {
  const globalFiles = listFiles(claudeMdDir).filter((f) => !f.startsWith("stage"));
  const stageDir = join(claudeMdDir, "stage");
  const stageFiles = listFiles(stageDir);
  return c.json({ global: globalFiles, stage: stageFiles });
});

configFilesRoute.get("/config/claude-md/:layer/:name", async (c) => {
  const layer = c.req.param("layer");
  if (layer !== "global" && layer !== "stage") return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid layer");

  const base = layer === "stage" ? join(claudeMdDir, "stage") : claudeMdDir;
  const filePath = safePath(base, c.req.param("name"));
  if (!filePath) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid path");
  if (!existsSync(filePath)) return errorResponse(c, 404, ErrorCode.FILE_NOT_FOUND, "File not found");

  try {
    return c.json({ content: await readFile(filePath, "utf-8") });
  } catch {
    return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, "Failed to read file");
  }
});

configFilesRoute.put("/config/claude-md/:layer/:name", validateBody(yamlContentSchema), async (c) => {
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

configFilesRoute.delete("/config/claude-md/:layer/:name", (c) => {
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

configFilesRoute.get("/config/gemini-md", (c) => {
  const globalFiles = listFiles(geminiMdDir).filter((f) => !f.startsWith("stage"));
  const stageDir = join(geminiMdDir, "stage");
  const stageFiles = listFiles(stageDir);
  return c.json({ global: globalFiles, stage: stageFiles });
});

configFilesRoute.get("/config/gemini-md/:layer/:name", async (c) => {
  const layer = c.req.param("layer");
  if (layer !== "global" && layer !== "stage") return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid layer");

  const base = layer === "stage" ? join(geminiMdDir, "stage") : geminiMdDir;
  const filePath = safePath(base, c.req.param("name"));
  if (!filePath) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid path");
  if (!existsSync(filePath)) return errorResponse(c, 404, ErrorCode.FILE_NOT_FOUND, "File not found");

  try {
    return c.json({ content: await readFile(filePath, "utf-8") });
  } catch {
    return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, "Failed to read file");
  }
});

configFilesRoute.put("/config/gemini-md/:layer/:name", validateBody(yamlContentSchema), async (c) => {
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

configFilesRoute.delete("/config/gemini-md/:layer/:name", (c) => {
  const layer = c.req.param("layer");
  if (layer !== "global" && layer !== "stage") return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid layer");

  const base = layer === "stage" ? join(geminiMdDir, "stage") : geminiMdDir;
  const filePath = safePath(base, c.req.param("name"));
  if (!filePath) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid path");
  if (!existsSync(filePath)) return errorResponse(c, 404, ErrorCode.FILE_NOT_FOUND, "File not found");

  unlinkSync(filePath);
  return c.json({ ok: true });
});

// --- MCP Registry ---

const mcpsDir = join(CONFIG_DIR, "mcps");

configFilesRoute.get("/config/mcps", async (c) => {
  const filePath = join(mcpsDir, "registry.yaml");
  if (!existsSync(filePath)) return c.json({ raw: "", registry: {} });
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, "Failed to read MCP registry");
  }
  try {
    return c.json({ raw, registry: parseYAML(raw) as Record<string, unknown> });
  } catch {
    return c.json({ raw, registry: {} });
  }
});

configFilesRoute.put("/config/mcps", validateBody(yamlContentSchema), async (c) => {
  const body = getValidatedBody(c) as { content: string };

  let parsed: Record<string, unknown>;
  try {
    parsed = parseYAML(body.content) as Record<string, unknown>;
  } catch (e) {
    return errorResponse(c, 400, ErrorCode.INVALID_CONFIG, `Invalid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!parsed || typeof parsed !== "object") return errorResponse(c, 400, ErrorCode.INVALID_CONFIG, "MCP registry must be a YAML object");

  const dangerousKey = rejectDangerousKeys(parsed);
  if (dangerousKey) {
    return errorResponse(c, 400, ErrorCode.VALIDATION_FAILED, dangerousKey);
  }

  ensureDir(mcpsDir);
  atomicWriteSync(join(mcpsDir, "registry.yaml"), body.content);
  return c.json({ ok: true, registry: parsed });
});
