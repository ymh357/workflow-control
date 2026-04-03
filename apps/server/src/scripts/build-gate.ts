import { spawnWithTimeout } from "../lib/spawn-utils.js";
import type { AutomationScript } from "./types.js";

const EXTRA_PATH = process.env.EXTRA_PATH || "/opt/homebrew/bin:/usr/local/bin";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

export const buildGateScript: AutomationScript = {
  metadata: {
    id: "build_gate",
    name: "Build & Test Gate",
    description: "Runs pnpm build and pnpm test, returning structured pass/fail results.",
    helpMd: `
### Build & Test Gate
Lightweight verification gate that runs build and test commands in the worktree.
Returns structured results so the pipeline can automatically retry implementation on failure.

**Inputs (via \`reads\`):**
- \`worktreePath\` — Path to the git worktree (working directory for commands).

**Output (via \`writes\`):**
- \`buildGateResult\` — Object with fields: buildPassed (boolean), testsPassed (boolean),
  passed (boolean), blockers (string[]), buildOutput (string), testOutput (string).
  When build or tests fail, \`passed\` is false and \`blockers\` contains failure details.
  This enables \`retry.back_to\` to automatically route back to the implementation stage.

**Pipeline usage:**
Place between \`implementing\` and \`qualityAssurance\`. Declare \`retry.back_to: implementing\`
so the pipeline automatically retries implementation when build or tests fail.
The stage always returns (never throws), so \`retry.back_to\` triggers on \`passed: false\`.
`,
    requiredSettings: [],
  },
  handler: async ({ context, inputs }) => {
    const cwd = inputs?.worktreePath ?? context.worktreePath ?? process.cwd();
    const env = { ...process.env, PATH: `${process.env.PATH}:${EXTRA_PATH}` };

    const result: {
      buildPassed: boolean;
      testsPassed: boolean;
      buildOutput: string;
      testOutput: string;
      failureSummary: string;
    } = {
      buildPassed: false,
      testsPassed: false,
      buildOutput: "",
      testOutput: "",
      failureSummary: "",
    };

    // Run build
    const buildResult = await spawnWithTimeout("pnpm", ["build"], {
      cwd,
      env,
      timeoutMs: 120_000,
    });
    if (buildResult.exitCode === 0 && !buildResult.timedOut) {
      result.buildPassed = true;
      result.buildOutput = stripAnsi(buildResult.combined).slice(-2000);
    } else {
      result.buildOutput = stripAnsi(buildResult.combined).slice(-2000);
      result.failureSummary += buildResult.timedOut ? "Build timed out.\n" : "Build failed.\n";
    }

    // Run tests (even if build failed — test results are useful context for retry)
    const testResult = await spawnWithTimeout("pnpm", ["test"], {
      cwd,
      env,
      timeoutMs: 180_000,
    });
    if (testResult.exitCode === 0 && !testResult.timedOut) {
      result.testsPassed = true;
      result.testOutput = stripAnsi(testResult.combined).slice(-3000);
    } else {
      result.testOutput = stripAnsi(testResult.combined).slice(-3000);
      result.failureSummary += testResult.timedOut ? "Tests timed out.\n" : "Tests failed.\n";
    }

    const passed = result.buildPassed && result.testsPassed;
    const blockers: string[] = [];
    if (!result.buildPassed) blockers.push(result.buildOutput ? `Build failed:\n${result.buildOutput}` : "Build failed.");
    if (!result.testsPassed) blockers.push(result.testOutput ? `Tests failed:\n${result.testOutput}` : "Tests failed.");

    return { ...result, passed, blockers };
  },
};
