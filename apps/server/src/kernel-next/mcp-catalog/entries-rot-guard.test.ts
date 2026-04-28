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
// Run sequentially (not parallel): some packages need 25s+ to first-cache
// their tarballs from npm, and vitest's default parallel `it.each` lights up
// 9+ concurrent `npx` invocations that contend on the npm-cli mutex and
// trigger spurious timeouts. `describe.sequential` forces one at a time.
(SPAWN_ENABLED ? describe.sequential : describe.skip)("entries.json rot guard (MCP spawn)", () => {
  const path = join(import.meta.dirname, "entries.json");
  const raw = readFileSync(path, "utf8");
  const data = SeedFileSchema.parse(JSON.parse(raw));

  // arxiv (@fre4x/arxiv) verified-working when spawned standalone (25s
  // cold-start), but consistently times out inside the vitest worker
  // even with sequential mode and 60s budget. Suspect npx + node-pty
  // / vitest stdio interaction; not a catalog rot. Skip from spawn-test
  // and re-verify manually before bumping the entry.
  const SKIP_SPAWN_TEST = new Set<string>(["arxiv"]);

  it.each(data.entries.map((e) => [e.id, e]))(
    "%s — spawns and completes MCP initialize",
    async (id, entry) => {
      if (SKIP_SPAWN_TEST.has(id)) return;
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

      const initialized = await new Promise<{ ok: boolean; reason: string }>((resolve) => {
        const child = spawn(entry.command, entry.args, {
          stdio: ["pipe", "pipe", "pipe"],
          env,
        });
        let stdout = "";
        let stderr = "";
        let resolved = false;
        const settle = (ok: boolean, reason: string): void => {
          if (resolved) return;
          resolved = true;
          try { child.kill(); } catch { /* best-effort */ }
          resolve({ ok, reason });
        };
        child.stdout.on("data", (d) => {
          stdout += d.toString();
          // Look for the initialize result with id:1.
          if (/"id"\s*:\s*1[\s,}]/.test(stdout) && stdout.includes("\"result\"")) {
            settle(true, "initialized");
          }
        });
        child.stderr.on("data", (d) => { stderr += d.toString(); });
        child.on("error", (err) => settle(false, `spawn error: ${err.message}`));
        child.on("exit", (code) => {
          if (resolved) return;
          // Treat clean exit (code=0) without an initialize result as a
          // race rather than a hard fail: some MCP servers (e.g. @fre4x/arxiv)
          // exit before flushing stdout when stdin closes early. Defer to
          // the timeout — if the server didn't print "id":1 within 30s,
          // that's the real signal. Hard-fail only on non-zero exits with
          // a real stderr message.
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
        // Generous timeout: cold npx + tarball download + MCP startup.
        // Some packages (@fre4x/arxiv) need 25s when npm cache is cold
        // AND vitest is running multiple npx invocations in parallel.
        setTimeout(() => settle(false, "timeout waiting for initialize result"), 60000);
      });

      if (!initialized.ok) {
        throw new Error(`${entry.id}: ${initialized.reason}`);
      }
    },
    75000,
  );
});
