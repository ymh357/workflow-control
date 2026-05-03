/**
 * Interactive setup for workflow-control (kernel-next era).
 *
 * Usage: pnpm setup (from repo root)
 *
 * What this does:
 *   - Verify Node.js >= 22.5 (required by node:sqlite)
 *   - Verify Claude CLI is installed (kernel-next runtime spawns it
 *     for every agent stage)
 *   - Verify gh CLI is installed (optional but used by some pipelines)
 *   - Run preflight checks against the live config
 *   - Print actionable next steps
 *
 * What this does NOT do (legacy artefacts removed 2026-05-03):
 *   - Configure Notion / Figma / Vercel / Linear MCP servers — those
 *     belong in the per-task MCP catalog (managed via the dashboard
 *     /kernel-next/mcp-catalog page or the add_mcp_catalog_entry MCP
 *     tool). Putting them in ~/.claude/settings.json was the legacy
 *     engine's mechanism; kernel-next stages declare their own
 *     mcpServers in the IR + read encrypted secrets from the catalog.
 *   - Write SETTING_NOTION_TOKEN / etc. to .env.local — no kernel-next
 *     code consumed those.
 *   - Install builtin pipelines from pipeline.yaml — those are now
 *     pipeline.ir.json files seeded automatically by the runtime via
 *     seedBuiltinPipelineByName at module load.
 *   - Install a Claude Code stop hook pointing at /api/edge/* — the
 *     edge router was retired with the legacy engine.
 */

import { existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// --- Node.js version check (node:sqlite requires >= 22.5) ---
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`\n  ERROR: Node.js >= 22.5 required (current: ${process.version})`);
  console.error("  Install via https://nodejs.org or `nvm install 22`\n");
  process.exit(1);
}

interface ToolCheck {
  name: string;
  bin: string;
  required: boolean;
  rationale: string;
  installHint: string;
}

const TOOL_CHECKS: ToolCheck[] = [
  {
    name: "Claude CLI",
    bin: "claude",
    required: true,
    rationale:
      "kernel-next spawns the Claude SDK subprocess for every agent stage.",
    installHint: "https://docs.anthropic.com/en/docs/claude-code",
  },
  {
    name: "gh CLI",
    bin: "gh",
    required: false,
    rationale:
      "Optional — used by pipelines that operate on GitHub PRs/issues.",
    installHint: "https://cli.github.com",
  },
];

async function main() {
  console.log("\n  workflow-control setup");
  console.log("  " + "=".repeat(50));
  console.log(`  Node.js: ${process.version} (>= 22.5 required ✓)`);

  // ---- External tool checks --------------------------------------
  let allRequiredFound = true;
  for (const t of TOOL_CHECKS) {
    let found: string | null = null;
    try {
      found = execFileSync("which", [t.bin], { encoding: "utf-8", timeout: 5_000 }).trim();
    } catch {
      found = null;
    }
    if (found) {
      console.log(`  [${t.name}] ${found}`);
      if (t.bin === "gh") {
        try {
          execFileSync("gh", ["auth", "status"], { encoding: "utf-8", stdio: "pipe", timeout: 5_000 });
          console.log("  [gh auth] Authenticated.");
        } catch {
          console.log("  [gh auth] Not authenticated. Run: gh auth login");
        }
      }
    } else {
      console.log(`  [${t.name}] Not found.`);
      console.log(`    rationale: ${t.rationale}`);
      console.log(`    install:   ${t.installHint}`);
      if (t.required) allRequiredFound = false;
    }
  }
  if (!allRequiredFound) {
    console.log("\n  ERROR: required tools missing — see install hints above.");
    process.exit(1);
  }

  // ---- .env.local stub ------------------------------------------
  const envLocalPath = join(process.cwd(), "apps", "server", ".env.local");
  if (!existsSync(envLocalPath)) {
    console.log("\n  [.env.local] Not found. Creating empty stub at " + envLocalPath);
    console.log("    Add per-task MCP secrets via the dashboard");
    console.log("    (/kernel-next/mcp-catalog) — they are encrypted on disk.");
    try {
      writeFileSync(
        envLocalPath,
        "# workflow-control runtime env. Add server-process variables here.\n" +
          "# Per-task MCP secrets belong in the dashboard MCP catalog, not here.\n",
        "utf-8",
      );
    } catch (err) {
      console.log(`    Could not write: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    console.log("\n  [.env.local] Already exists.");
  }

  // ---- Live preflight (config-loader checks against system-settings.yaml) ----
  console.log("\n  Running preflight checks...");
  const { loadEnv } = await import("./lib/env.js");
  loadEnv();
  const { runPreflight, printPreflightResults } = await import("./lib/preflight.js");
  const { passed, results } = runPreflight();
  printPreflightResults(results);

  console.log("  " + "=".repeat(50));
  if (passed) {
    console.log("  Setup complete.");
  } else {
    console.log("  Setup complete (some checks failed). Fix the issues above.");
  }
  console.log("  Next: pnpm dev   # Server (:3001) + Dashboard (:3000)\n");
}

main().catch((err) => {
  console.error("\n  Setup failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
