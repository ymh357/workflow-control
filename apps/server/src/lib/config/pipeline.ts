import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYAML } from "yaml";

import type { PipelineConfig, PipelineStageConfig, PipelineStageEntry, PipelineManifest } from "./types.js";
import { isParallelGroup, flattenStages } from "./types.js";
import { CONFIG_DIR } from "./settings.js";
import { validatePipelineConfig } from "./schema.js";

// --- Deep merge for pipeline configs ---

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

/**
 * Deep-merge override into base pipeline config.
 * Special handling for `stages`: matched by `name` field, not array index.
 */
export function deepMergePipeline(base: PipelineConfig, override: Partial<PipelineConfig>): PipelineConfig {
  const result = deepMergeObjects(base, override) as PipelineConfig;

  // Stages require name-based matching
  if (override.stages) {
    const baseStages = [...(base.stages || [])] as PipelineStageEntry[];
    const merged: PipelineStageEntry[] = [];
    const usedOverrideNames = new Set<string>();

    function getEntryName(e: PipelineStageEntry): string {
      return isParallelGroup(e) ? e.parallel.name : e.name;
    }

    for (const baseEntry of baseStages) {
      const baseName = getEntryName(baseEntry);
      const overrideEntry = (override.stages as PipelineStageEntry[]).find((s) => getEntryName(s) === baseName);
      if (overrideEntry) {
        if (isParallelGroup(baseEntry) && isParallelGroup(overrideEntry)) {
          // Merge parallel group: merge inner stages by name
          const mergedInner: PipelineStageConfig[] = [];
          const usedInner = new Set<string>();
          for (const bs of baseEntry.parallel.stages) {
            const os = overrideEntry.parallel.stages.find((s) => s.name === bs.name);
            if (os) {
              mergedInner.push(deepMergeObjects(bs, os) as PipelineStageConfig);
              usedInner.add(os.name);
            } else {
              mergedInner.push(bs);
            }
          }
          for (const os of overrideEntry.parallel.stages) {
            if (!usedInner.has(os.name)) mergedInner.push(os);
          }
          merged.push({ parallel: { name: baseEntry.parallel.name, stages: mergedInner } });
        } else {
          merged.push(deepMergeObjects(baseEntry as Record<string, any>, overrideEntry as Record<string, any>) as PipelineStageEntry);
        }
        usedOverrideNames.add(baseName);
      } else {
        merged.push(baseEntry);
      }
    }

    // Append new entries from override that don't exist in base
    for (const overrideEntry of override.stages as PipelineStageEntry[]) {
      if (!usedOverrideNames.has(getEntryName(overrideEntry))) {
        merged.push(overrideEntry);
      }
    }

    result.stages = merged;
  }

  return result;
}

function deepMergeObjects(base: Record<string, any>, override: Record<string, any>): Record<string, any> {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (key === "stages") continue; // handled separately at top level
    const baseVal = base[key];
    const overVal = override[key];
    if (isPlainObject(baseVal) && isPlainObject(overVal)) {
      result[key] = deepMergeObjects(baseVal as Record<string, any>, overVal as Record<string, any>);
    } else {
      result[key] = overVal;
    }
  }
  return result;
}

function validateAndWarn(raw: unknown, label: string): PipelineConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const result = validatePipelineConfig(raw);
  if (!result.success) {
    console.error(`[config] Pipeline validation failed for "${label}":`, result.errors?.issues?.map((i) => `${i.path?.join(".")}: ${i.message}`).join("; "));
    // Return raw with type cast for backward compatibility, but log prominently
    return raw as PipelineConfig;
  }
  return raw as PipelineConfig;
}

const CACHE_TTL_MS = 60_000;
const pipelineCache = new Map<string, { value: PipelineConfig | null; ts: number }>();

export function clearPipelineCache(): void {
  pipelineCache.clear();
}

export function loadPipelineConfig(name = "pipeline-generator"): PipelineConfig | null {
  const cached = pipelineCache.get(name);
  if (cached !== undefined && Date.now() - cached.ts < CACHE_TTL_MS) return cached.value;
  const now = Date.now();
  // New format: config/pipelines/{name}/pipeline.yaml (directory-based)
  const dirPath = join(CONFIG_DIR, "pipelines", name, "pipeline.yaml");
  if (existsSync(dirPath)) {
    try {
      const raw = readFileSync(dirPath, "utf-8");
      const validated = validateAndWarn(parseYAML(raw), name);
      if (!validated) {
        pipelineCache.set(name, { value: null, ts: now });
        return null;
      }
      let result = validated;
      // Check for .local/ override
      const localPath = join(CONFIG_DIR, "pipelines", `${name}.local`, "pipeline.yaml");
      if (existsSync(localPath)) {
        try {
          const localRaw = readFileSync(localPath, "utf-8");
          const localConfig = parseYAML(localRaw) as Partial<PipelineConfig>;
          result = deepMergePipeline(result, localConfig);
        } catch { /* skip invalid local override */ }
      }
      pipelineCache.set(name, { value: result, ts: now });
      return result;
    } catch {
      pipelineCache.set(name, { value: null, ts: now });
      return null;
    }
  }
  // Legacy fallback: config/pipelines/{name}.yaml (single-file)
  const legacyPath = join(CONFIG_DIR, "pipelines", `${name}.yaml`);
  if (!existsSync(legacyPath)) { pipelineCache.set(name, { value: null, ts: now }); return null; }
  try {
    const raw = readFileSync(legacyPath, "utf-8");
    const result = validateAndWarn(parseYAML(raw), name);
    if (!result) {
      pipelineCache.set(name, { value: null, ts: now });
      return null;
    }
    pipelineCache.set(name, { value: result, ts: now });
    return result;
  } catch {
    pipelineCache.set(name, { value: null, ts: now });
    return null;
  }
}

/**
 * Lists all available pipelines by scanning config/pipelines/ for directories with pipeline.yaml.
 */
export function listAvailablePipelines(): PipelineManifest[] {
  const pipelinesDir = join(CONFIG_DIR, "pipelines");
  if (!existsSync(pipelinesDir)) return [];
  const entries = readdirSync(pipelinesDir, { withFileTypes: true });
  const manifests: PipelineManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.endsWith(".local")) continue;
    const yamlPath = join(pipelinesDir, entry.name, "pipeline.yaml");
    if (!existsSync(yamlPath)) continue;
    try {
      const raw = readFileSync(yamlPath, "utf-8");
      const parsed = validateAndWarn(parseYAML(raw), entry.name);
      if (!parsed) continue;
      const stages = parsed.stages || [];
      const flat = flattenStages(stages);
      const allMcps = new Set<string>();
      let totalBudget = 0;
      for (const s of flat) {
        if (s.max_budget_usd) totalBudget += s.max_budget_usd;
        if (s.mcps) for (const m of s.mcps) allMcps.add(m);
      }
      const keyStages = flat
        .filter((s) => s.type === "agent")
        .map((s) => s.name)
        .slice(0, 6);
      manifests.push({
        id: entry.name,
        name: parsed.name || entry.name,
        description: parsed.description,
        engine: parsed.engine || inferPipelineEngine(parsed),
        official: parsed.official,
        stageCount: stages.length,
        totalBudget: totalBudget > 0 ? totalBudget : undefined,
        mcps: allMcps.size > 0 ? [...allMcps] : undefined,
        stageSummary: keyStages.length > 0 ? keyStages.join(" → ") : undefined,
      });
    } catch { /* skip unreadable */ }
  }
  return manifests;
}

function inferPipelineEngine(pipeline: PipelineConfig): "claude" | "gemini" | "codex" | "mixed" {
  const engines = new Set<string>();
  for (const stage of flattenStages(pipeline.stages)) {
    if (stage.engine) engines.add(stage.engine);
  }
  if (engines.size === 0) return "claude";
  if (engines.size === 1) return engines.values().next().value as "claude" | "gemini" | "codex";
  return "mixed";
}
