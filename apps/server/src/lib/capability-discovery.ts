// External capability discovery — finds MCP servers (via PulseMCP) and Skills
// (via claude-skill-registry) that could enhance pipeline execution.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CONFIG_DIR } from "./config/settings.js";
import { logger } from "./logger.js";

// ── Interfaces ──

export interface DiscoveredMcp {
  name: string;
  displayName: string;
  description: string;
  packageName: string;
  githubStars?: number;
}

export interface DiscoveredSkill {
  name: string;
  description: string;
  repo: string;
  path: string;
  branch: string;
  stars?: number;
}

export interface DiscoveryResult {
  mcps: DiscoveredMcp[];
  skills: DiscoveredSkill[];
}

// ── Main entry ──

export async function discoverExternalCapabilities(
  query: string,
  installedMcpNames: Set<string>,
  installedSkillNames: Set<string>,
  opts?: { maxResults?: number; timeoutMs?: number },
): Promise<DiscoveryResult> {
  const maxResults = opts?.maxResults ?? 5;
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const perSourceMax = maxResults * 2; // over-fetch for dedup headroom

  const [pulseMcpResult, officialMcpResult, skillResult] = await Promise.allSettled([
    discoverMcps(query, installedMcpNames, { maxResults: perSourceMax, timeoutMs }),
    discoverMcpsFromRegistry(query, installedMcpNames, { maxResults: perSourceMax, timeoutMs }),
    discoverSkills(query, installedSkillNames, { maxResults, timeoutMs }),
  ]);

  const pulseMcps = pulseMcpResult.status === "fulfilled" ? pulseMcpResult.value : [];
  const officialMcps = officialMcpResult.status === "fulfilled" ? officialMcpResult.value : [];

  return {
    mcps: mergeMcpResults(pulseMcps, officialMcps, maxResults),
    skills: skillResult.status === "fulfilled" ? skillResult.value : [],
  };
}

// ── MCP Discovery (PulseMCP via MCP SDK) ──

async function callMcpTool(
  command: string,
  args: string[],
  toolName: string,
  toolArgs: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  const transport = new StdioClientTransport({ command, args });
  const client = new Client({ name: "capability-discovery", version: "1.0.0" });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      (async () => {
        await client.connect(transport);
        const response = await client.callTool({ name: toolName, arguments: toolArgs });
        const text = (response.content as Array<{ type: string; text?: string }>)?.[0]?.text;
        if (!text) return null;
        return JSON.parse(text);
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("MCP call timed out")), timeoutMs);
      }),
    ]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    try { await client.close(); } catch { /* ignore */ }
    try { await transport.close(); } catch { /* ignore */ }
  }
}

function normalizeMcpName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function discoverMcps(
  query: string,
  installedNames: Set<string>,
  opts: { maxResults: number; timeoutMs: number },
): Promise<DiscoveredMcp[]> {
  try {
    const raw = await callMcpTool(
      "npx",
      ["-y", "pulsemcp-server"],
      "list_servers",
      { query, count_per_page: 20 },
      opts.timeoutMs,
    ) as { servers?: Array<Record<string, unknown>> } | null;

    if (!raw?.servers) return [];

    const results: DiscoveredMcp[] = [];
    for (const srv of raw.servers) {
      if (srv.package_registry !== "npm" || !srv.package_name) continue;
      if (typeof srv.name !== "string" || !srv.name) continue;

      const normalized = normalizeMcpName(srv.name);
      if (!normalized || installedNames.has(normalized)) continue;

      const desc = typeof srv.description === "string" ? srv.description : "";
      results.push({
        name: normalized,
        displayName: srv.name,
        description: desc.slice(0, 200),
        packageName: srv.package_name as string,
        githubStars: typeof srv.github_stars === "number" ? srv.github_stars : undefined,
      });
    }

    results.sort((a, b) => (b.githubStars ?? 0) - (a.githubStars ?? 0));
    return results.slice(0, opts.maxResults);
  } catch (err) {
    logger.warn({ err }, "capability-discovery: MCP discovery failed");
    return [];
  }
}

// ── Official MCP Registry Discovery ──

const OFFICIAL_REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0.1/servers";

async function discoverMcpsFromRegistry(
  query: string,
  installedNames: Set<string>,
  opts: { maxResults: number; timeoutMs: number },
): Promise<DiscoveredMcp[]> {
  try {
    const url = `${OFFICIAL_REGISTRY_URL}?search=${encodeURIComponent(query)}&version=latest&limit=20`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs) });
    if (!resp.ok) return [];
    const data = await resp.json();

    const results: DiscoveredMcp[] = [];
    for (const entry of data.servers ?? []) {
      const srv = entry.server ?? entry;
      if (!srv.name || typeof srv.name !== "string") continue;

      // Only npm stdio packages
      const npmPkg = (srv.packages ?? []).find(
        (p: any) => p.registryType === "npm",
      );
      if (!npmPkg?.identifier) continue;

      // Skip packages with required env vars (need API keys)
      const envs = npmPkg.environmentVariables ?? [];
      if (envs.some((e: any) => e.isRequired)) continue;

      // Extract short display name: "io.github.owner/repo-name" -> "repo-name"
      const displayName = srv.name.includes("/")
        ? srv.name.slice(srv.name.lastIndexOf("/") + 1)
        : srv.name;

      const normalized = normalizeMcpName(displayName);
      if (!normalized || installedNames.has(normalized)) continue;

      const desc = typeof srv.description === "string" ? srv.description : "";
      results.push({
        name: normalized,
        displayName,
        description: desc.slice(0, 200),
        packageName: npmPkg.identifier,
        githubStars: undefined,
      });
    }

    return results.slice(0, opts.maxResults);
  } catch (err) {
    logger.warn({ err }, "capability-discovery: official registry discovery failed");
    return [];
  }
}

// ── Merge MCP results from multiple sources ──

function mergeMcpResults(
  pulseMcps: DiscoveredMcp[],
  officialMcps: DiscoveredMcp[],
  maxResults: number,
): DiscoveredMcp[] {
  const seen = new Set<string>();
  const merged: DiscoveredMcp[] = [];

  // PulseMCP first — has githubStars, richer metadata
  for (const mcp of pulseMcps) {
    if (!seen.has(mcp.packageName)) {
      seen.add(mcp.packageName);
      merged.push(mcp);
    }
  }

  // Official Registry second — fills gaps
  for (const mcp of officialMcps) {
    if (!seen.has(mcp.packageName)) {
      seen.add(mcp.packageName);
      merged.push(mcp);
    }
  }

  merged.sort((a, b) => (b.githubStars ?? 0) - (a.githubStars ?? 0));
  return merged.slice(0, maxResults);
}

// ── Skills Discovery (claude-skill-registry via GitHub raw) ──

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  development: ["develop", "code", "programming", "implement", "refactor", "software", "coding"],
  testing: ["test", "testing", "quality", "spec", "jest", "vitest", "lint"],
  security: ["security", "audit", "vulnerability", "owasp", "pentest"],
  devops: ["deploy", "cicd", "docker", "kubernetes", "infrastructure", "devops", "cloud"],
  design: ["design", "frontend", "component", "figma", "styling"],
  data: ["data", "database", "sql", "analytics", "machine learning", "dataset"],
  documents: ["document", "markdown", "readme", "documentation", "writing"],
  productivity: ["workflow", "automation", "productivity", "optimize"],
};

const SKILL_REGISTRY_BASE =
  "https://raw.githubusercontent.com/majiayu000/claude-skill-registry/main/categories";

function matchCategories(query: string, maxCategories = 2): string[] {
  const lower = query.toLowerCase();
  const scores: Array<{ category: string; score: number }> = [];

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      // Use word boundary matching to avoid "test" matching "latest" etc.
      const pattern = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
      if (pattern.test(lower)) score++;
    }
    if (score > 0) scores.push({ category, score });
  }

  scores.sort((a, b) => b.score - a.score);
  if (scores.length === 0) return ["development"];
  return scores.slice(0, maxCategories).map((s) => s.category);
}

async function discoverSkills(
  query: string,
  installedNames: Set<string>,
  opts: { maxResults: number; timeoutMs: number },
): Promise<DiscoveredSkill[]> {
  try {
    const categories = matchCategories(query);
    const fetches = categories.map(async (cat) => {
      const resp = await fetch(`${SKILL_REGISTRY_BASE}/${cat}.json`, {
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      if (!resp.ok) return [];
      const data = (await resp.json()) as {
        skills?: Array<{
          name: string;
          description: string;
          repo: string;
          path: string;
          branch: string;
          stars?: number;
        }>;
      };
      return data.skills ?? [];
    });

    const results = await Promise.allSettled(fetches);
    const allSkills = results.flatMap((r) =>
      r.status === "fulfilled" ? r.value : [],
    );

    // Deduplicate by name
    const seen = new Set<string>();
    const unique: DiscoveredSkill[] = [];
    for (const skill of allSkills) {
      if (!skill.name || seen.has(skill.name) || installedNames.has(skill.name)) continue;
      if (!skill.repo || !skill.path || !skill.branch) continue;
      seen.add(skill.name);
      const desc = typeof skill.description === "string" ? skill.description : "";
      unique.push({
        name: skill.name,
        description: desc.slice(0, 200),
        repo: skill.repo,
        path: skill.path,
        branch: skill.branch,
        stars: skill.stars,
      });
    }

    unique.sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));
    return unique.slice(0, opts.maxResults);
  } catch (err) {
    logger.warn({ err }, "capability-discovery: skills discovery failed");
    return [];
  }
}

// ── Auto-install helpers ──

export async function autoInstallSkill(skill: DiscoveredSkill): Promise<boolean> {
  try {
    const url = `https://raw.githubusercontent.com/${skill.repo}/${skill.branch}/${skill.path}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) return false;
    const content = await resp.text();
    const destDir = join(CONFIG_DIR, "skills");
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, `${skill.name}.md`), content, "utf-8");
    return true;
  } catch (err) {
    logger.warn({ err, skill: skill.name }, "capability-discovery: skill install failed");
    return false;
  }
}
