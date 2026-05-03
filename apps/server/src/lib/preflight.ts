import { execFileSync } from "node:child_process";
import { loadSystemSettings } from "./config-loader.js";

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export function runPreflight(): { passed: boolean; results: CheckResult[] } {
  if (process.env.MOCK_EXECUTOR === "true") {
    return { passed: true, results: [{ name: "Mock mode", ok: true, detail: "MOCK_EXECUTOR=true, skipping preflight" }] };
  }
  const results: CheckResult[] = [];
  const settings = loadSystemSettings();

  // Claude CLI: kernel-next runtime spawns it for every agent stage.
  const claudePath = settings.paths?.claude_executable || "claude";
  try {
    const found = execFileSync("which", [claudePath], { encoding: "utf-8", timeout: 5_000 }).trim();
    results.push({ name: "Claude Executable", ok: true, detail: found });
  } catch {
    results.push({ name: "Claude Executable", ok: false, detail: `Not found: ${claudePath}` });
  }

  // gh CLI: optional, only required by pipelines that operate on GitHub.
  try {
    const ghVersion = execFileSync("gh", ["--version"], { encoding: "utf-8", timeout: 5_000 }).split("\n")[0];
    results.push({ name: "gh CLI", ok: true, detail: ghVersion });
  } catch {
    results.push({ name: "gh CLI", ok: false, detail: "gh CLI not installed (optional — only needed for GitHub-touching pipelines)" });
  }

  // gh CLI is optional; treat its absence as a warning, not a failure.
  const passed = results.filter((r) => !r.ok && r.name !== "gh CLI").length === 0;
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