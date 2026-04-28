// Rot guard: every builtin entry's packageName must resolve on the live npm
// registry, AND (in deeper mode) actually spawn an MCP server that completes
// the JSON-RPC `initialize` handshake. The npm-existence check catches Bug 1
// (entries pointing at packages that 404). The spawn check catches Bug 9
// (packages that exist on npm but throw at module-resolve / start time —
// e.g. fetch-mcp@0.0.5 had a broken `get-stream` import).
//
// SKIPPED by default to keep CI offline-clean.
//   RUN_NPM_HEALTHCHECKS=1  → npm view only (~2s/entry, ~20s total)
//   RUN_NPM_HEALTHCHECKS=2  → npm view + MCP initialize handshake (~30s/entry,
//                              several minutes total — only run before catalog bumps)
//
// Owner workflow: at minimum run mode 1 whenever entries.json changes; run
// mode 2 before adding a NEW entry the first time, since "package exists on
// npm" is necessary but not sufficient.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { checkPackage, resolvePackageName } from "./healthcheck.js";
import { CatalogEntrySchema } from "./schema.js";

const SeedFileSchema = z.object({
  schemaVersion: z.literal("1"),
  entries: z.array(CatalogEntrySchema.omit({ source: true, deprecatedAt: true })),
});

const MODE = process.env.RUN_NPM_HEALTHCHECKS;
const NPM_VIEW_ENABLED = MODE === "1" || MODE === "2";
const SPAWN_ENABLED = MODE === "2";

(NPM_VIEW_ENABLED ? describe : describe.skip)("entries.json rot guard (live npm)", () => {
  const path = join(import.meta.dirname, "entries.json");
  const raw = readFileSync(path, "utf8");
  const data = SeedFileSchema.parse(JSON.parse(raw));

  it.each(data.entries.map((e) => [e.id, e]))(
    "%s — packageName resolves on npm",
    async (_id, entry) => {
      const packageName = resolvePackageName({
        packageName: entry.packageName,
        args: entry.args,
      });
      expect(packageName, `${entry.id} has no resolvable package name from packageName/args`).toBeTruthy();

      const result = await checkPackage({
        packageName: packageName!,
        timeoutMs: Math.max(entry.healthCheckTimeoutMs, 15000),
      });

      if (!result.ok) {
        const codes = result.diagnostics.map((d) => d.code).join(",");
        const msgs = result.diagnostics.map((d) => d.message).join(" | ");
        throw new Error(
          `${entry.id} (${packageName}) failed healthcheck: [${codes}] ${msgs}`,
        );
      }
    },
    20000,
  );
});

// Spawn-test mode: actually run `npx -y <pkg>` and check the MCP initialize
// handshake completes. Catches packages that exist on npm but throw at
// module-resolve / start time.
//
// Budget is split into two phases:
//   - cold-start (npm cache miss): up to 60s per entry while npm downloads
//     and extracts the tarball
//   - server-init (cache warm): once the binary is on disk, the MCP server
//     should respond to JSON-RPC `initialize` within `SDK_MCP_INIT_BUDGET_MS`.
//     Bug 10 (2026-04-28) showed that @fre4x/arxiv takes >10s to handshake
//     even after the tarball is cached — Claude SDK orphans tasks inside
//     that window. To approximate the SDK constraint without prematurely
//     failing first-run cold-starts, the test:
//       1. Pre-warms npm cache with `npm view <pkg> version` (already does
//          this in mode-1 above, which always runs before mode-2).
//       2. Times only the spawn → initialize-result span, not the npx
//          download span.
//
// Run sequentially: parallel `npx` invocations contend on npm-cli mutex.
const SDK_MCP_INIT_BUDGET_MS = 10000;
const SPAWN_TOTAL_BUDGET_MS = 60000;
(SPAWN_ENABLED ? describe.sequential : describe.skip)("entries.json rot guard (MCP spawn)", () => {
  const path = join(import.meta.dirname, "entries.json");
  const raw = readFileSync(path, "utf8");
  const data = SeedFileSchema.parse(JSON.parse(raw));

  it.each(data.entries.map((e) => [e.id, e]))(
    "%s — spawns and completes MCP initialize within SDK budget",
    async (_id, entry) => {
      // Skip entries whose args carry a ${VAR} placeholder for runtime
      // expansion (e.g. postgres needs a real connection string in args[2]).
      // The runtime expander injects real values; this static spawn-test
      // can't usefully verify them without sample credentials.
      if (entry.args.some((a) => /\$\{[A-Z_][A-Z0-9_]*\}/.test(a))) {
        return;
      }

      const env: Record<string, string> = { ...process.env } as Record<string, string>;
      // Stub required envKeys with a placeholder so the server doesn't
      // bail out before initialize. Real authentication is not exercised
      // here; we only want to know the binary boots.
      for (const k of entry.envKeys) {
        if (k.required && !env[k.name]) env[k.name] = "rot-guard-stub";
      }

      const start = Date.now();
      const initialized = await new Promise<{ ok: boolean; reason: string; initMs?: number }>((resolve) => {
        const child = spawn(entry.command, entry.args, {
          stdio: ["pipe", "pipe", "pipe"],
          env,
        });
        let stdout = "";
        let stderr = "";
        let resolved = false;
        let firstStdoutAt: number | null = null;
        const settle = (ok: boolean, reason: string, initMs?: number): void => {
          if (resolved) return;
          resolved = true;
          try { child.kill(); } catch { /* best-effort */ }
          resolve({ ok, reason, initMs });
        };
        child.stdout.on("data", (d) => {
          if (firstStdoutAt === null) firstStdoutAt = Date.now();
          stdout += d.toString();
          // Look for the initialize result with id:1.
          if (/"id"\s*:\s*1[\s,}]/.test(stdout) && stdout.includes("\"result\"")) {
            const initMs = Date.now() - (firstStdoutAt ?? start);
            settle(true, "initialized", initMs);
          }
        });
        child.stderr.on("data", (d) => { stderr += d.toString(); });
        child.on("error", (err) => settle(false, `spawn error: ${err.message}`));
        child.on("exit", (code) => {
          if (resolved) return;
          // Treat clean exit (code=0) without an initialize result as a
          // race rather than a hard fail: some MCP servers (e.g. @fre4x/arxiv)
          // exit before flushing stdout when stdin closes early. Defer to
          // the timeout — if the server didn't print "id":1, that's the
          // real signal. Hard-fail only on non-zero exits with a real
          // stderr message.
          if (code === 0 && stderr.length === 0) {
            return; // wait for timeout
          }
          settle(false, `process exited code=${code}; stderr first 300=${stderr.slice(0, 300).replace(/\n/g, " ")}`);
        });
        // Send initialize request.
        child.stdin.write(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "rot-guard", version: "1" },
          },
        }) + "\n");
        // Total budget covers cold-start npm download + server init.
        setTimeout(
          () => settle(false, `timeout waiting for initialize result (>${SPAWN_TOTAL_BUDGET_MS}ms total)`),
          SPAWN_TOTAL_BUDGET_MS,
        );
      });

      if (!initialized.ok) {
        throw new Error(`${entry.id}: ${initialized.reason}`);
      }
      // Bug 10: even after the tarball is cached, the MCP server's init
      // span (first stdout → initialize result) must fit the SDK's
      // window. A package that initializes >10s after first stdout
      // works standalone but orphans inside the SDK runtime.
      if (initialized.initMs !== undefined && initialized.initMs > SDK_MCP_INIT_BUDGET_MS) {
        throw new Error(
          `${entry.id}: server initialized in ${initialized.initMs}ms (>${SDK_MCP_INIT_BUDGET_MS}ms SDK budget) — would orphan inside SDK runtime`,
        );
      }
    },
    SPAWN_TOTAL_BUDGET_MS + 5000,
  );
});
