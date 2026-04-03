// Builds a summary of all available system capabilities (MCPs, scripts, skills)
// for injection into pipeline-design prompts.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadMcpRegistry, buildMcpFromRegistry } from "./config/mcp.js";
import { scriptRegistry } from "../scripts/index.js";
import { CONFIG_DIR } from "./config/settings.js";

export interface McpCapability {
  name: string;
  description: string;
  available: boolean;
}

export interface ScriptCapability {
  id: string;
  description: string;
  helpMd: string;
}

export interface SkillCapability {
  id: string;
  description: string;
}

export interface CapabilitySummary {
  mcps: McpCapability[];
  scripts: ScriptCapability[];
  skills: SkillCapability[];
}

export function buildCapabilitySummary(): CapabilitySummary {
  const mcps: McpCapability[] = [];
  const registry = loadMcpRegistry();
  if (registry) {
    for (const [name, entry] of Object.entries(registry)) {
      const config = buildMcpFromRegistry(name, entry);
      mcps.push({
        name,
        description: entry.description || "",
        available: config !== null,
      });
    }
  }

  const scripts: ScriptCapability[] = scriptRegistry.getAllMetadata().map((m) => ({
    id: m.id,
    description: m.description,
    helpMd: m.helpMd ?? "",
  }));

  const skills: SkillCapability[] = [];
  try {
    const skillsDir = join(CONFIG_DIR, "skills");
    for (const file of readdirSync(skillsDir)) {
      if (!file.endsWith(".md")) continue;
      const id = file.replace(/\.md$/, "");
      try {
        const content = readFileSync(join(skillsDir, file), "utf-8");
        const firstLine = content.split("\n").find((l) => l.trim().length > 0) ?? "";
        const description = firstLine.replace(/^#+\s*/, "").slice(0, 100);
        skills.push({ id, description });
      } catch {
        skills.push({ id, description: "" });
      }
    }
  } catch {
    // skills directory may not exist
  }

  return { mcps, scripts, skills };
}

export function formatCapabilityPrompt(summary: CapabilitySummary): string {
  const parts: string[] = ["## Available Capabilities"];

  if (summary.mcps.length > 0) {
    parts.push("");
    parts.push("### MCP Servers");
    parts.push("| Name | Description | Status |");
    parts.push("|------|-------------|--------|");
    for (const mcp of summary.mcps) {
      const status = mcp.available ? "ready" : "missing credentials";
      parts.push(`| ${mcp.name} | ${mcp.description || "(no description)"} | ${status} |`);
    }
  }

  if (summary.scripts.length > 0) {
    parts.push("");
    parts.push("### Built-in Scripts");
    parts.push("| ID | Description |");
    parts.push("|----|-------------|");
    for (const script of summary.scripts) {
      parts.push(`| ${script.id} | ${script.description} |`);
    }
    // Append detailed interface docs for each script
    const scriptsWithHelp = summary.scripts.filter((s) => s.helpMd);
    if (scriptsWithHelp.length > 0) {
      parts.push("");
      parts.push("#### Script Interface Reference");
      parts.push("");
      parts.push("Use this reference to design correct `reads` and `writes` for script stages.");
      for (const script of scriptsWithHelp) {
        parts.push("");
        parts.push(script.helpMd.trim());
      }
    }
  }

  if (summary.skills.length > 0) {
    parts.push("");
    parts.push("### Skills (injected as CLI commands into agent worktree)");
    parts.push("| ID | Description |");
    parts.push("|----|-------------|");
    for (const skill of summary.skills) {
      parts.push(`| ${skill.id} | ${skill.description || "(no description)"} |`);
    }
  }

  if (summary.mcps.length === 0 && summary.scripts.length === 0 && summary.skills.length === 0) {
    parts.push("", "No capabilities registered.");
  }

  return parts.join("\n");
}
