import { existsSync, statSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { loadSystemSettings, getNestedValue } from "./config-loader.js";
import { loadMcpRegistry, buildMcpFromRegistry } from "./config/mcp.js";
import { scriptRegistry } from "../scripts/index.js";

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Helper to validate a setting path and add results, masking sensitive values.
 */
function checkSettingPath(path: string, settings: any, checkedPaths: Set<string>, results: CheckResult[], optional = false) {
  if (checkedPaths.has(path)) return;
  checkedPaths.add(path);

  const value = getNestedValue(settings, path);
  if (value) {
    // Mask sensitive looking values (token, secret, key)
    const displayValue = /token|secret|key|id/i.test(path) && typeof value === "string" 
      ? value.slice(0, 4) + "..." + value.slice(-4)
      : String(value);
      
    results.push({ name: `Setting: ${path}`, ok: true, detail: displayValue });
  } else {
    results.push({ 
      name: `Setting: ${path}`, 
      ok: optional, 
      detail: optional ? "(Optional) Missing or empty" : "Missing or empty" 
    });
  }
}

export function runPreflight(): { passed: boolean; results: CheckResult[] } {
  if (process.env.MOCK_EXECUTOR === "true") {
    return { passed: true, results: [{ name: "Mock mode", ok: true, detail: "MOCK_EXECUTOR=true, skipping preflight" }] };
  }
  const results: CheckResult[] = [];
  const settings = loadSystemSettings();
  const checkedPaths = new Set<string>();

  // 1. Core Framework Paths
  const claudePath = settings.paths?.claude_executable || "claude";
  try {
    const found = execFileSync("which", [claudePath], { encoding: "utf-8", timeout: 5_000 }).trim();
    results.push({ name: "Claude Executable", ok: true, detail: found });
  } catch {
    results.push({ name: "Claude Executable", ok: false, detail: `Not found: ${claudePath}` });
  }

  const geminiPath = settings.paths?.gemini_executable || "gemini";
  try {
    const found = execFileSync("which", [geminiPath], { encoding: "utf-8", timeout: 5_000 }).trim();
    results.push({ name: "Gemini Executable", ok: true, detail: found });
  } catch {
    results.push({ name: "Gemini Executable", ok: false, detail: `Not found: ${geminiPath}` });
  }

  const reposBase = settings.paths?.repos_base || "";
  if (reposBase && existsSync(reposBase)) {
    results.push({ name: "Repos Base", ok: true, detail: reposBase });
  } else {
    // Repos base is only needed if scripts depend on it, otherwise warn
    results.push({ name: "Repos Base", ok: true, detail: "(Optional) Use current directory or absolute paths" });
  }

  const worktreesBase = settings.paths?.worktrees_base || "";
  results.push({ 
    name: "Worktrees Base", 
    ok: true, 
    detail: worktreesBase || "Not set (will fallback to temp dir)" 
  });

  // 2. Integrations (optional — only needed when pipelines use Slack notifications)
  checkSettingPath("slack.bot_token", settings, checkedPaths, results, true);
  checkSettingPath("slack.notify_channel_id", settings, checkedPaths, results, true);

  // 3. Tool availability
  try {
    const ghVersion = execFileSync("gh", ["--version"], { encoding: "utf-8", timeout: 5_000 }).split("\n")[0];
    results.push({ name: "gh CLI", ok: true, detail: ghVersion });
  } catch {
    results.push({ name: "gh CLI", ok: false, detail: "gh CLI not installed" });
  }

  // 3. DYNAMIC REQUIREMENTS (Scripts & Pipeline MCPs)
  const scripts = scriptRegistry.getAllScripts();

  // 3a. From Scripts (optional — only needed when a pipeline actually uses the script)
  for (const script of scripts) {
    for (const path of script.metadata.requiredSettings || []) {
      checkSettingPath(path, settings, checkedPaths, results, true);
    }
  }

  // 3b. From MCP registry — check which MCPs can be built (have required env vars)
  const mcpRegistry = loadMcpRegistry();
  if (mcpRegistry) {
    for (const [name, entry] of Object.entries(mcpRegistry)) {
      const config = buildMcpFromRegistry(name, entry);
      if (config) {
        results.push({ name: `MCP: ${name}`, ok: true, detail: entry.description || "Ready" });
      } else {
        results.push({ name: `MCP: ${name}`, ok: true, detail: "(Optional) Missing credentials" });
      }
    }
  }

  // 4. Config files
  const configDir = resolve(import.meta.dirname, "../../config");
  const mcpFile = join(configDir, "mcps", "registry.yaml");

  // Check for at least one pipeline directory with pipeline.yaml
  const pipelinesBase = join(configDir, "pipelines");
  const pipelineDirs = existsSync(pipelinesBase)
    ? readdirSync(pipelinesBase, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(pipelinesBase, d.name, "pipeline.yaml")))
        .map((d) => d.name)
    : [];
  if (pipelineDirs.length > 0) {
    results.push({ name: "Pipeline configuration", ok: true, detail: `${pipelineDirs.length} pipeline(s): ${pipelineDirs.join(", ")}` });
  } else {
    results.push({ name: "Pipeline configuration", ok: false, detail: "No pipeline directories found in config/pipelines/" });
  }

  if (existsSync(mcpFile)) {
    results.push({ name: "MCP registry", ok: true, detail: mcpFile });
  } else {
    results.push({ name: "MCP registry", ok: true, detail: "config/mcps/registry.yaml missing (no MCPs available)" });
  }

  const passed = results.filter((r) => !r.ok).length === 0;
  return { passed, results };
}

export function printPreflightResults(results: CheckResult[]): void {
  const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
  const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const maxName = Math.max(...results.map((r) => r.name.length));

  console.log(`\n  Preflight Check`);
  console.log(`  ${"=".repeat(60)}`);
  for (const r of results) {
    const tag = r.ok ? green("PASS") : red("FAIL");
    const name = r.name.padEnd(maxName);
    console.log(`  ${tag}  ${name}  ${dim(r.detail)}`);
  }
  console.log(`  ${"=".repeat(60)}\n`);
}