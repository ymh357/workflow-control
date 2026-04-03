/**
 * Interactive setup: configures MCP servers, .env.local, and runs preflight checks.
 *
 * Usage: pnpm setup (from repo root)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline";

// --- Node.js version check (node:sqlite requires >= 22.5) ---
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`\n  ERROR: Node.js >= 22.5 required (current: ${process.version})`);
  console.error("  Install via https://nodejs.org or nvm install 22\n");
  process.exit(1);
}

const SETTINGS_PATH = join(process.env.HOME ?? "", ".claude", "settings.json");

function loadSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveSettings(settings: Record<string, unknown>): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, res));

async function main() {
  console.log("\n  workflow-control Setup");
  console.log("  " + "=".repeat(50));

  // ============================================================
  // MCP Server Configuration
  // ============================================================

  const settings = loadSettings();
  const mcpServers = (settings.mcpServers ?? {}) as Record<string, unknown>;
  let mcpChanged = false;
  let notionToken = "";

  // --- Notion MCP (required) ---
  if (!mcpServers.notion) {
    console.log("\n  [Notion MCP] Required for ticket reading and Sprint Board.");
    console.log("  Steps:");
    console.log("    1. Go to https://www.notion.so/my-integrations");
    console.log("    2. Create integration with Read+Update+Insert permissions");
    console.log("    3. Copy the Internal Integration Secret (ntn_...)");
    console.log("    4. In Notion, share your Sprint Board + test pages with the integration");
    const token = await ask("\n  Paste Notion token (or press Enter to skip): ");
    if (token.trim()) {
      notionToken = token.trim();
      mcpServers.notion = {
        command: "npx",
        args: ["-y", "@notionhq/notion-mcp-server"],
        env: {
          OPENAPI_MCP_HEADERS: JSON.stringify({
            Authorization: `Bearer ${notionToken}`,
            "Notion-Version": "2022-06-28",
          }),
        },
      };
      mcpChanged = true;
      console.log("  -> Notion MCP configured.");
    } else {
      console.log("  -> Skipped. S1/S2/S3/S7 will fail without Notion.");
    }
  } else {
    console.log("\n  [Notion MCP] Already configured.");
  }

  // --- Context7 MCP (required) ---
  if (!mcpServers.context7) {
    console.log("\n  [Context7 MCP] Required for library documentation lookup.");
    console.log("  No API key needed.");
    const confirm = await ask("  Install Context7 MCP? (Y/n): ");
    if (confirm.trim().toLowerCase() !== "n") {
      mcpServers.context7 = {
        command: "npx",
        args: ["-y", "@upstash/context7-mcp@latest"],
      };
      mcpChanged = true;
      console.log("  -> Context7 MCP configured.");
    }
  } else {
    console.log("\n  [Context7 MCP] Already configured.");
  }

  // --- Figma MCP (optional) ---
  if (!mcpServers.figma) {
    console.log("\n  [Figma MCP] Optional. For extracting design specs from Figma.");
    const token = await ask("  Paste Figma access token (or press Enter to skip): ");
    if (token.trim()) {
      mcpServers.figma = {
        command: "npx",
        args: ["-y", "figma-developer-mcp", "--stdio"],
        env: {
          FIGMA_API_KEY: token.trim(),
        },
      };
      mcpChanged = true;
      console.log("  -> Figma MCP configured.");
    } else {
      console.log("  -> Skipped. Figma design extraction will be unavailable.");
    }
  } else {
    console.log("\n  [Figma MCP] Already configured.");
  }

  // --- Vercel MCP (optional) ---
  if (!mcpServers.vercel) {
    console.log("\n  [Vercel MCP] Optional. For deployment monitoring.");
    const token = await ask("  Paste Vercel token (or press Enter to skip): ");
    if (token.trim()) {
      mcpServers.vercel = {
        command: "npx",
        args: ["-y", "vercel-mcp-server"],
        env: {
          VERCEL_TOKEN: token.trim(),
        },
      };
      mcpChanged = true;
      console.log("  -> Vercel MCP configured.");
    } else {
      console.log("  -> Skipped. Vercel deployment monitoring will be unavailable.");
    }
  } else {
    console.log("\n  [Vercel MCP] Already configured.");
  }

  // --- Save MCP settings ---
  if (mcpChanged) {
    settings.mcpServers = mcpServers;
    saveSettings(settings);
    console.log("\n  Settings saved to " + SETTINGS_PATH);
    console.log("  Restart Claude Code for changes to take effect.");
  } else {
    console.log("\n  No MCP changes made.");
  }

  // ============================================================
  // Agent engine check (at least one of Claude / Gemini / Codex)
  // ============================================================

  console.log("");
  const engines: { name: string; bin: string; found: string | null }[] = [];
  for (const [name, bin] of [["Claude", "claude"], ["Gemini", "gemini"], ["Codex", "codex"]] as const) {
    try {
      const found = execFileSync("which", [bin], { encoding: "utf-8", timeout: 5_000 }).trim();
      engines.push({ name, bin, found });
      console.log(`  [${name} CLI] ${found}`);
    } catch {
      engines.push({ name, bin, found: null });
      console.log(`  [${name} CLI] Not found.`);
    }
  }
  if (!engines.some(e => e.found)) {
    console.log("\n  WARNING: No agent engine found. At least one of Claude, Gemini, or Codex CLI is required.");
    console.log("    Claude: https://docs.anthropic.com/en/docs/claude-code");
    console.log("    Gemini: https://github.com/google-gemini/gemini-cli");
    console.log("    Codex:  https://github.com/openai/codex");
  }

  // ============================================================
  // gh CLI check
  // ============================================================

  console.log("");
  try {
    const ghVersion = execFileSync("gh", ["--version"], { encoding: "utf-8", timeout: 5_000 }).split("\n")[0];
    console.log(`  [gh CLI] ${ghVersion}`);
    try {
      execFileSync("gh", ["auth", "status"], { encoding: "utf-8", stdio: "pipe", timeout: 5_000 });
      console.log("  [gh auth] Authenticated.");
    } catch {
      console.log("  [gh auth] Not authenticated. Run: gh auth login");
    }
  } catch {
    console.log("  [gh CLI] Not found. Install: https://cli.github.com");
  }

  // ============================================================
  // .env.local generation
  // ============================================================

  const envLocalPath = join(process.cwd(), "apps", "server", ".env.local");
  if (!existsSync(envLocalPath)) {
    console.log("\n  [.env.local] Not found. Creating from template...");
    try {
      const home = process.env.HOME ?? "";
      const lines = [
        `REPOS_BASE_PATH=${home}/`,
        `WORKTREES_BASE_PATH=${home}/wfc-worktrees/`,
      ];

      // Add detected engine paths
      for (const e of engines) {
        if (e.found) lines.push(`${e.bin.toUpperCase()}_PATH=${e.found}`);
      }

      if (notionToken) {
        lines.push(`SETTING_NOTION_TOKEN=${notionToken}`);
      }

      const slackToken = await ask("\n  Slack bot token (optional, press Enter to skip): ");
      if (slackToken.trim()) {
        lines.push(`SETTING_SLACK_BOT_TOKEN=${slackToken.trim()}`);
        const channelId = await ask("  Slack notify channel ID: ");
        if (channelId.trim()) {
          lines.push(`SETTING_SLACK_NOTIFY_CHANNEL_ID=${channelId.trim()}`);
        }
      }

      writeFileSync(envLocalPath, lines.join("\n") + "\n", "utf-8");
      console.log("  -> Created " + envLocalPath);
    } catch {
      console.log("  -> Could not auto-detect paths. Copy .env.local.example manually.");
    }
  } else {
    console.log("\n  [.env.local] Already exists.");
  }

  rl.close();

  // ============================================================
  // Install Claude Code slash commands (~/.claude/commands/)
  // ============================================================

  const commandsSrc = join(dirname(import.meta.dirname ?? process.cwd()), "config", "claude-commands");
  const commandsDest = join(process.env.HOME ?? "", ".claude", "commands");
  try {
    mkdirSync(commandsDest, { recursive: true });
    const files = readdirSync(commandsSrc).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      copyFileSync(join(commandsSrc, file), join(commandsDest, file));
    }
    if (files.length > 0) {
      console.log(`\n  [Claude Commands] Installed ${files.length} command(s) to ${commandsDest}`);
      console.log(`  -> Available: ${files.map((f) => "/" + f.replace(".md", "")).join(", ")}`);
    }
  } catch {
    console.log("\n  [Claude Commands] Could not install slash commands. Copy manually from config/claude-commands/");
  }

  // ============================================================
  // Run preflight checks
  // ============================================================

  console.log("\n  Running preflight checks...");
  const { loadEnv } = await import("./lib/env.js");
  loadEnv();
  const { runPreflight, printPreflightResults } = await import("./lib/preflight.js");
  const { passed, results } = runPreflight();
  printPreflightResults(results);

  console.log("  " + "=".repeat(50));
  if (passed) {
    console.log("  Setup complete. Run: pnpm dev\n");
  } else {
    console.log("  Setup complete (some checks failed). Fix the issues above, then run: pnpm dev\n");
  }
}

main().catch(console.error);
