import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYAML } from "yaml";

import type { FragmentMeta } from "./types.js";
import { CONFIG_DIR } from "./settings.js";

const CACHE_TTL_MS = 60_000;
let fragmentRegistry: FragmentRegistry | null = null;
let fragmentRegistryTs = 0;

export function clearFragmentCache(): void {
  fragmentRegistry = null;
  fragmentRegistryTs = 0;
}

// --- Frontmatter parser ---

export function parseFrontmatter(raw: string): { meta: FragmentMeta | null; content: string } {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("---")) return { meta: null, content: trimmed };

  const endIdx = trimmed.indexOf("---", 3);
  if (endIdx === -1) return { meta: null, content: trimmed };

  const yamlBlock = trimmed.slice(3, endIdx).trim();
  const content = trimmed.slice(endIdx + 3).trim();

  try {
    const parsed = parseYAML(yamlBlock) as Record<string, unknown>;
    const meta: FragmentMeta = {
      id: (parsed.id as string) || "",
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.map(String) : [],
      stages: parsed.stages === "*" ? "*" : (Array.isArray(parsed.stages) ? parsed.stages.map(String) : []),
      always: parsed.always === true,
    };
    return { meta, content };
  } catch {
    return { meta: null, content: trimmed };
  }
}

// --- Fragment Registry ---

export class FragmentRegistry {
  private entries = new Map<string, { meta: FragmentMeta; content: string }>();

  build(): void {
    this.entries.clear();
    const dir = join(CONFIG_DIR, "prompts", "fragments");
    if (!existsSync(dir)) return;

    // First pass: load base fragments (exclude .local.md files)
    const files = readdirSync(dir).filter((f) => f.endsWith(".md") && !f.endsWith(".local.md"));
    for (const f of files) {
      const id = f.replace(".md", "");
      try {
        const raw = readFileSync(join(dir, f), "utf-8");
        const { meta, content } = parseFrontmatter(raw);
        if (meta) {
          meta.id = id;
          this.entries.set(id, { meta, content });
        } else {
          // Legacy fragment without frontmatter — treat as always for backward compat
          this.entries.set(id, {
            meta: { id, keywords: [], stages: "*", always: true },
            content: raw.trim(),
          });
        }
      } catch { /* skip unreadable files */ }
    }

    // Second pass: apply .local.md overrides (content replacement)
    const localFiles = readdirSync(dir).filter((f) => f.endsWith(".local.md"));
    for (const f of localFiles) {
      const id = f.replace(".local.md", "");
      try {
        const raw = readFileSync(join(dir, f), "utf-8");
        const { meta, content } = parseFrontmatter(raw);
        const existing = this.entries.get(id);
        if (existing) {
          // Replace content, keep meta from local if provided, otherwise keep base meta
          this.entries.set(id, {
            meta: meta ? { ...meta, id } : existing.meta,
            content,
          });
        } else {
          // Local-only fragment with no base
          this.entries.set(id, {
            meta: meta ? { ...meta, id } : { id, keywords: [], stages: "*", always: true },
            content: meta ? content : raw.trim(),
          });
        }
      } catch { /* skip unreadable files */ }
    }
  }

  resolve(stageName: string, enabledSteps?: string[]): { id: string; content: string }[] {
    if (this.entries.size === 0) this.build();

    const results: { id: string; content: string }[] = [];
    const stepsSet = new Set(enabledSteps ?? []);

    for (const [id, { meta, content }] of this.entries) {
      const stageMatch = meta.stages === "*" || (meta.stages as string[]).includes(stageName);
      if (!stageMatch) continue;

      if (meta.always) {
        results.push({ id, content });
      } else if (stepsSet.size > 0 && meta.keywords.some((k) => stepsSet.has(k))) {
        results.push({ id, content });
      }
    }
    return results;
  }

  getAllKeywordsWithDescriptions(): { keyword: string; fragmentId: string }[] {
    if (this.entries.size === 0) this.build();
    const result: { keyword: string; fragmentId: string }[] = [];
    for (const [id, { meta }] of this.entries) {
      for (const kw of meta.keywords) {
        result.push({ keyword: kw, fragmentId: id });
      }
    }
    return result;
  }

  getAllEntries(): Map<string, { meta: FragmentMeta; content: string }> {
    if (this.entries.size === 0) this.build();
    return this.entries;
  }

  validate(pipelineStageNames: string[]): string[] {
    if (this.entries.size === 0) this.build();
    const warnings: string[] = [];
    const keywordMap = new Map<string, string[]>();

    for (const [id, { meta }] of this.entries) {
      if (!meta.always && meta.keywords.length === 0) {
        warnings.push(`Fragment "${id}" has no keywords and always=false — it will never be loaded`);
      }
      if (meta.stages !== "*") {
        for (const s of meta.stages as string[]) {
          if (!pipelineStageNames.includes(s)) {
            warnings.push(`Fragment "${id}" references unknown stage "${s}"`);
          }
        }
      }
      for (const kw of meta.keywords) {
        const existing = keywordMap.get(kw) ?? [];
        existing.push(id);
        keywordMap.set(kw, existing);
      }
    }

    for (const [kw, ids] of keywordMap) {
      if (ids.length > 1) {
        warnings.push(`Keyword "${kw}" appears in multiple fragments: ${ids.join(", ")}`);
      }
    }
    return warnings;
  }
}

export function getFragmentRegistry(): FragmentRegistry {
  const now = Date.now();
  if (!fragmentRegistry || now - fragmentRegistryTs >= CACHE_TTL_MS) {
    fragmentRegistry = new FragmentRegistry();
    fragmentRegistry.build();
    fragmentRegistryTs = now;
  }
  return fragmentRegistry;
}

// --- Resolve fragments from snapshot data (no filesystem access) ---

export function resolveFragmentsFromSnapshot(
  stageName: string,
  enabledSteps: string[] | undefined,
  fragmentContents: Record<string, string>,
  fragmentMeta: Record<string, FragmentMeta>,
): { id: string; content: string }[] {
  const results: { id: string; content: string }[] = [];
  const stepsSet = new Set(enabledSteps ?? []);

  for (const [id, meta] of Object.entries(fragmentMeta)) {
    const content = fragmentContents[id];
    if (!content) continue;

    const stageMatch = meta.stages === "*" || (meta.stages as string[]).includes(stageName);
    if (!stageMatch) continue;

    if (meta.always) {
      results.push({ id, content });
    } else if (stepsSet.size > 0 && meta.keywords.some((k) => stepsSet.has(k))) {
      results.push({ id, content });
    }
  }
  return results;
}
