// T1.2 — Workflow Control software version signature.
//
// pipelineVersionHash covers "the config (YAML + fragments) that the task
// was created with." It does NOT cover the TypeScript code that interprets
// that config — prompt-builder layer order, capability discovery rules,
// streaming logic, etc. Two tasks with the same pipelineVersionHash can
// still behave differently if the workflow-control server itself was
// updated between them.
//
// To make ExecutionRecord self-describing, we record the software version
// alongside every attempt. Format: `{packageVersion}+{gitShortSha}` when
// the repo is reachable, otherwise just `{packageVersion}`, otherwise
// `unknown`.
//
// Read once per process and cached — this is intentionally not reactive
// to git state changes during a server run (a task started on one commit
// should reflect that commit even if you rebase underneath the process).

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

function readPackageVersion(): string | null {
  try {
    // The file lives at apps/server/src/lib/execution-record/workflow-version.ts.
    // package.json is two directories up at apps/server/package.json after
    // tsx/build — walk up from this module's location.
    const here = dirname(fileURLToPath(import.meta.url));
    // here = .../apps/server/src/lib/execution-record (or .../apps/server/dist/... in built form)
    // Try two candidates: .../apps/server/package.json for source, .../apps/server/package.json for dist.
    const candidates = [
      join(here, "..", "..", "..", "package.json"),   // from src/lib/execution-record
      join(here, "..", "..", "package.json"),          // from dist/lib/execution-record
    ];
    for (const p of candidates) {
      try {
        const raw = readFileSync(p, "utf8");
        const pkg = JSON.parse(raw) as { name?: string; version?: string };
        if (pkg.name === "server" && typeof pkg.version === "string") {
          return pkg.version;
        }
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function readGitShortSha(): string | null {
  try {
    const sha = execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // Anchor to this module's repo — prevents picking up a nested worktree
      // if the server is invoked from a different CWD.
      cwd: dirname(fileURLToPath(import.meta.url)),
    }).trim();
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return null;
    return sha;
  } catch {
    return null;
  }
}

/**
 * Return a string like "0.0.1+abc1234" or "0.0.1" or "unknown".
 * Result is cached on first call and never re-read during the process life.
 */
export function getWorkflowControlVersion(): string {
  if (cached !== null) return cached;
  const pkgVersion = readPackageVersion();
  const sha = readGitShortSha();
  if (pkgVersion && sha) {
    cached = `${pkgVersion}+${sha}`;
  } else if (pkgVersion) {
    cached = pkgVersion;
  } else {
    cached = "unknown";
  }
  return cached;
}

/** Test-only. Reset the cache so tests can observe a fresh read. */
export function __resetWorkflowControlVersionCache(): void {
  cached = null;
}
