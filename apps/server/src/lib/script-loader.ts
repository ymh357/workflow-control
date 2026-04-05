import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYAML } from "yaml";
import { CONFIG_DIR } from "./config/settings.js";

interface DynamicScriptManifest {
  name: string;
  version: string;
  type: "script";
  description: string;
  script_id: string;
  entry: string;
}

interface DynamicScriptInput {
  cwd: string;
  store: Record<string, any>;
  args?: Record<string, any>;
  taskId: string;
}

interface DynamicScriptResult {
  success: boolean;
  [key: string]: any;
}

type DynamicScriptExecutor = (input: DynamicScriptInput) => Promise<DynamicScriptResult>;

const scriptModuleCache = new Map<string, DynamicScriptExecutor>();

/**
 * Scans config/scripts/ for directories with manifest.yaml and builds a map of script_id -> directory.
 */
function scanDynamicScripts(): Map<string, { dir: string; manifest: DynamicScriptManifest }> {
  const scriptsDir = join(CONFIG_DIR, "scripts");
  const map = new Map<string, { dir: string; manifest: DynamicScriptManifest }>();
  if (!existsSync(scriptsDir)) return map;

  const entries = readdirSync(scriptsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(scriptsDir, entry.name, "manifest.yaml");
    if (!existsSync(manifestPath)) continue;
    try {
      const raw = readFileSync(manifestPath, "utf-8");
      const manifest = parseYAML(raw) as DynamicScriptManifest;
      if (manifest.script_id && manifest.entry) {
        map.set(manifest.script_id, { dir: join(scriptsDir, entry.name), manifest });
      }
    } catch { /* skip invalid manifests */ }
  }
  return map;
}

/**
 * Load and return a dynamic script executor by script_id.
 * Returns null if no dynamic script matches.
 */
export async function loadDynamicScript(scriptId: string): Promise<DynamicScriptExecutor | null> {
  const cached = scriptModuleCache.get(scriptId);
  if (cached) return cached;

  const scripts = scanDynamicScripts();
  const entry = scripts.get(scriptId);
  if (!entry) return null;

  const entryPath = resolve(entry.dir, entry.manifest.entry);

  // Path containment: ensure entry resolves inside config/scripts/
  const scriptsBase = resolve(CONFIG_DIR, "scripts");
  const resolvedEntry = resolve(entryPath);
  if (!resolvedEntry.startsWith(scriptsBase + "/")) {
    throw new Error(`Script entry path escapes scripts directory: ${entryPath}`);
  }

  if (!existsSync(entryPath)) return null;

  try {
    const mod = await import(entryPath);
    const executor: DynamicScriptExecutor = mod.default;
    if (typeof executor !== "function") return null;
    scriptModuleCache.set(scriptId, executor);
    return executor;
  } catch {
    return null;
  }
}

export function clearDynamicScriptCache(): void {
  scriptModuleCache.clear();
}
