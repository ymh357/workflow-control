import { readFileSync, existsSync, readdirSync, mkdirSync, unlinkSync, renameSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { parse as parseYAML } from "yaml";
import { CONFIG_DIR, type PipelineConfig, isParallelGroup } from "../lib/config-loader.js";
import { validatePipelineLogic, getValidationErrors } from "@workflow-control/shared";

export const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export const settingsPath = join(CONFIG_DIR, "system-settings.yaml");
export const pipelinesDir = join(CONFIG_DIR, "pipelines");
export const promptsDir = join(CONFIG_DIR, "prompts");

export function safePath(base: string, ...segments: string[]): string | null {
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

export function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
}

export function atomicWriteSync(filePath: string, content: string): void {
  const tmp = filePath + "." + randomBytes(6).toString("hex") + ".tmp";
  writeFileSync(tmp, content, "utf-8");
  try {
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

export function listFiles(dir: string, ext?: string): string[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => !f.startsWith("."));
  return ext ? files.filter((f) => f.endsWith(ext)) : files;
}

export interface FileSnapshot {
  filePath: string;
  existed: boolean;
  content?: string;
}

export function captureSnapshots(paths: string[]): FileSnapshot[] {
  return [...new Set(paths)].map((filePath) => {
    try {
      const content = readFileSync(filePath, "utf-8");
      return { filePath, existed: true, content };
    } catch {
      return { filePath, existed: false };
    }
  });
}

export function restoreSnapshots(snapshots: FileSnapshot[]): void {
  for (const snapshot of snapshots) {
    if (snapshot.existed) {
      ensureDir(resolve(snapshot.filePath, ".."));
      atomicWriteSync(snapshot.filePath, snapshot.content ?? "");
    } else if (existsSync(snapshot.filePath)) {
      unlinkSync(snapshot.filePath);
    }
  }
}

export function toPromptFileName(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

export function rebuildFragmentFile(content: string, meta: { id: string; keywords?: string[]; stages?: string[] | "*"; always?: boolean }): string {
  const lines = ["---", `id: ${meta.id}`];
  if (meta.keywords?.length) lines.push(`keywords: [${meta.keywords.join(", ")}]`);
  if (meta.stages === "*") {
    lines.push(`stages: "*"`);
  } else if (Array.isArray(meta.stages) && meta.stages.length > 0) {
    lines.push(`stages: [${meta.stages.join(", ")}]`);
  }
  if (meta.always) lines.push("always: true");
  lines.push("---", "", content);
  return lines.join("\n");
}

export function collectPromptKeys(
  pipelineDir: string,
  options?: { systemPrompts?: Record<string, string>; deletedPrompts?: string[] },
): Set<string> | undefined {
  try {
    const promptKeys = new Set<string>();
    const promptDir = join(pipelineDir, "prompts", "system");
    if (existsSync(promptDir)) {
      for (const f of readdirSync(promptDir)) {
        if (f.endsWith(".md")) promptKeys.add(f.replace(/\.md$/, ""));
      }
    }
    for (const key of options?.deletedPrompts ?? []) {
      promptKeys.delete(toPromptFileName(key));
    }
    for (const key of Object.keys(options?.systemPrompts ?? {})) {
      promptKeys.add(toPromptFileName(key));
    }
    const globalPromptDir = join(CONFIG_DIR, "prompts", "system");
    if (existsSync(globalPromptDir)) {
      for (const f of readdirSync(globalPromptDir)) {
        if (f.endsWith(".md")) promptKeys.add(f.replace(/\.md$/, ""));
      }
    }
    return promptKeys;
  } catch {
    return undefined;
  }
}

export function validatePipelinePayload(
  parsed: PipelineConfig,
  pipelineDir: string,
  options?: { systemPrompts?: Record<string, string>; deletedPrompts?: string[] },
): { errors: string[]; warnings: string[] } {
  if (!parsed || !Array.isArray(parsed.stages)) {
    return { errors: ["Pipeline must have a stages array"], warnings: [] };
  }
  for (const entry of parsed.stages) {
    if (isParallelGroup(entry)) {
      if (!entry.parallel?.name || !Array.isArray(entry.parallel?.stages)) {
        return { errors: ["Parallel group must have name and stages array"], warnings: [] };
      }
      for (const s of entry.parallel.stages) {
        if (!s.name || !s.type) {
          return { errors: [`Each stage in parallel group must have name and type. Invalid: ${JSON.stringify(s)}`], warnings: [] };
        }
      }
    } else {
      const stage = entry as any;
      if (!stage.name || !stage.type) {
        return { errors: [`Each stage must have name and type. Invalid: ${JSON.stringify(stage)}`], warnings: [] };
      }
    }
  }

  const promptKeys = collectPromptKeys(pipelineDir, options);
  const injected = Array.isArray((parsed as any).injected_context) ? new Set((parsed as any).injected_context as string[]) : undefined;

  const issues = validatePipelineLogic(parsed.stages as any[], promptKeys, undefined, injected);
  return {
    errors: getValidationErrors(issues).map((e) => e.message),
    warnings: issues.filter((i) => i.severity === "warning").map((i) => i.message),
  };
}

export function rejectDangerousKeys(parsed: unknown): string | null {
  if (parsed && typeof parsed === "object") {
    const dangerous = ["__proto__", "constructor", "prototype"];
    for (const key of dangerous) {
      if (Object.prototype.hasOwnProperty.call(parsed, key)) {
        return `Forbidden key: ${key}`;
      }
    }
  }
  return null;
}

export function validateSettingsContent(content: string): { ok: true } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = parseYAML(content);
  } catch (e) {
    return { ok: false, error: `Invalid YAML: ${e instanceof Error ? e.message : String(e)}` };
  }
  const dangerousKey = rejectDangerousKeys(parsed);
  if (dangerousKey) {
    return { ok: false, error: `Forbidden YAML key: ${dangerousKey.replace("Forbidden key: ", "")}` };
  }
  return { ok: true };
}
