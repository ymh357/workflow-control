import { Hono } from "hono";
import { existsSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getFragmentRegistry } from "../lib/config-loader.js";
import { validateBody, getValidatedBody, yamlContentSchema } from "../middleware/validate.js";
import { errorResponse, ErrorCode } from "../lib/error-response.js";
import { safePath, ensureDir, atomicWriteSync, listFiles, promptsDir } from "./config-helpers.js";

export const configPromptsRoute = new Hono();

// --- Prompts ---

configPromptsRoute.get("/config/prompts", (c) => {
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

configPromptsRoute.get("/config/prompts/:category/:name", async (c) => {
  const filePath = resolvePromptPath(c.req.param("category"), c.req.param("name"));
  if (!filePath) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid path");
  if (!existsSync(filePath)) return errorResponse(c, 404, ErrorCode.FILE_NOT_FOUND, "File not found");
  try {
    return c.json({ content: await readFile(filePath, "utf-8") });
  } catch {
    return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, "Failed to read file");
  }
});

configPromptsRoute.put("/config/prompts/:category/:name", validateBody(yamlContentSchema), async (c) => {
  const filePath = resolvePromptPath(c.req.param("category"), c.req.param("name"));
  if (!filePath) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid path");

  const body = getValidatedBody(c) as { content: string };

  ensureDir(resolve(filePath, ".."));
  atomicWriteSync(filePath, body.content);
  return c.json({ ok: true });
});

configPromptsRoute.delete("/config/prompts/:category/:name", (c) => {
  const category = c.req.param("category");
  if (category === "global") return errorResponse(c, 400, ErrorCode.INVALID_CONFIG, "Cannot delete global constraints via this endpoint");

  const filePath = resolvePromptPath(category, c.req.param("name"));
  if (!filePath) return errorResponse(c, 400, ErrorCode.INVALID_PATH, "Invalid path");
  if (!existsSync(filePath)) return errorResponse(c, 404, ErrorCode.FILE_NOT_FOUND, "File not found");

  unlinkSync(filePath);
  return c.json({ ok: true });
});

// --- Fragment Registry ---

configPromptsRoute.get("/config/fragments/registry", (c) => {
  const registry = getFragmentRegistry();
  const entries: Record<string, { meta: { id: string; keywords: string[]; stages: string[] | "*"; always: boolean }; content: string }> = {};
  for (const [id, entry] of registry.getAllEntries()) {
    entries[id] = { meta: entry.meta, content: entry.content };
  }
  return c.json({ entries });
});
