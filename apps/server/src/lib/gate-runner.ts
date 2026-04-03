// Loads and executes gate scripts from config/gates/.
// Gates are TypeScript files that export: function run(worktreePath: string): GateResult
// They run deterministic checks (tsc, lint, no console.log, etc.) between stages.

import { resolve } from "node:path";
import { getGatePath, CONFIG_DIR, type GateResult } from "./config-loader.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "gate-runner" });

export async function runGate(gateName: string, worktreePath: string): Promise<GateResult> {
  const gatePath = getGatePath(gateName);
  if (!gatePath) {
    log.warn({ gate: gateName }, "Gate file not found, passing by default");
    return { passed: true, checks: [] };
  }

  try {
    const resolvedPath = resolve(gatePath);
    const configBase = resolve(CONFIG_DIR);
    if (!resolvedPath.startsWith(configBase + "/")) {
      log.error({ gate: gateName, path: resolvedPath }, "Gate path outside config directory");
      return { passed: false, checks: [{ name: gateName, passed: false, detail: "Gate path outside allowed directory" }] };
    }

    const gateModule = await import(resolvedPath) as { run: (path: string) => GateResult | Promise<GateResult> };
    if (typeof gateModule.run !== "function") {
      log.error({ gate: gateName }, "Gate module does not export a run() function");
      return { passed: false, checks: [{ name: gateName, passed: false, detail: "Gate module does not export a run() function" }] };
    }

    const result = await gateModule.run(worktreePath);
    const failedChecks = result.checks.filter((c) => !c.passed);

    if (result.passed) {
      log.info({ gate: gateName, checks: result.checks.length }, "Gate passed");
    } else {
      log.warn({ gate: gateName, failed: failedChecks.map((c) => c.name) }, "Gate failed");
    }

    return result;
  } catch (err) {
    log.error({ gate: gateName, err }, "Gate execution error");
    return { passed: false, checks: [{ name: gateName, passed: false, detail: String(err) }] };
  }
}
