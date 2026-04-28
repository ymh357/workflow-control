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
      type StageResult = {
        ok: boolean;
        reason: string;
        initMs?: number;
        toolsListMs?: number;
        toolCount?: number;
      };
      const result_ = await new Promise<StageResult>((resolve) => {
        const child = spawn(entry.command, entry.args, {
          stdio: ["pipe", "pipe", "pipe"],
          env,
        });
        let stdout = "";
        let stderr = "";
        let resolved = false;
        let firstStdoutAt: number | null = null;
        let initializedAt: number | null = null;
        let initializeSent = false;
        let toolsListSent = false;
        const settle = (r: StageResult): void => {
          if (resolved) return;
          resolved = true;
          try { child.kill(); } catch { /* best-effort */ }
          resolve(r);
        };
        const sendOnce = (id: number, method: string, params: Record<string, unknown>): void => {
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        };
        const tryParseAllJsonLines = (): { id: number; result?: unknown; error?: unknown }[] => {
          const lines = stdout.split("\n").filter((l) => l.trim().startsWith("{"));
          const out: { id: number; result?: unknown; error?: unknown }[] = [];
          for (const line of lines) {
            try {
              const obj = JSON.parse(line);
              if (typeof obj.id === "number") out.push(obj);
            } catch { /* mid-line, ignore */ }
          }
          return out;
        };
        child.stdout.on("data", (d) => {
          if (firstStdoutAt === null) firstStdoutAt = Date.now();
          stdout += d.toString();
          const responses = tryParseAllJsonLines();
          // Step 1: wait for initialize (id=1) result.
          if (initializedAt === null) {
            const initResp = responses.find((r) => r.id === 1 && r.result !== undefined);
            if (initResp) {
              initializedAt = Date.now();
              // Per MCP protocol, send `notifications/initialized` then
              // tools/list to mirror what the SDK does.
              child.stdin.write(JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/initialized",
                params: {},
              }) + "\n");
              sendOnce(2, "tools/list", {});
              toolsListSent = true;
            }
          }
          // Step 2: wait for tools/list (id=2) result.
          if (initializedAt !== null && toolsListSent) {
            const toolsResp = responses.find((r) => r.id === 2);
            if (toolsResp && toolsResp.result !== undefined) {
              const tools = (toolsResp.result as { tools?: unknown[] }).tools ?? [];
              const initMs = initializedAt - (firstStdoutAt ?? start);
              const toolsListMs = Date.now() - initializedAt;
              settle({ ok: true, reason: "initialized + tools advertised", initMs, toolsListMs, toolCount: tools.length });
            }
          }
        });
        child.stderr.on("data", (d) => { stderr += d.toString(); });
        child.on("error", (err) => settle({ ok: false, reason: `spawn error: ${err.message}` }));
        child.on("exit", (code) => {
          if (resolved) return;
          if (code === 0 && stderr.length === 0) {
            return; // wait for timeout
          }
          settle({ ok: false, reason: `process exited code=${code}; stderr first 300=${stderr.slice(0, 300).replace(/\n/g, " ")}` });
        });
        // Send initialize request.
        if (!initializeSent) {
          initializeSent = true;
          sendOnce(1, "initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "rot-guard", version: "1" },
          });
        }
        // Total budget covers cold-start npm download + server init + tools/list.
        setTimeout(
          () => settle({ ok: false, reason: `timeout (>${SPAWN_TOTAL_BUDGET_MS}ms total): initializedAt=${initializedAt !== null} toolsListSent=${toolsListSent}` }),
          SPAWN_TOTAL_BUDGET_MS,
        );
      });

      if (!result_.ok) {
        throw new Error(`${entry.id}: ${result_.reason}`);
      }
      if (result_.initMs !== undefined && result_.initMs > SDK_MCP_INIT_BUDGET_MS) {
        throw new Error(
          `${entry.id}: initialize took ${result_.initMs}ms (>${SDK_MCP_INIT_BUDGET_MS}ms SDK budget) — would orphan inside SDK runtime`,
        );
      }
      if (result_.toolsListMs !== undefined && result_.toolsListMs > SDK_MCP_INIT_BUDGET_MS) {
        throw new Error(
          `${entry.id}: tools/list took ${result_.toolsListMs}ms (>${SDK_MCP_INIT_BUDGET_MS}ms SDK budget) — would orphan inside SDK runtime`,
        );
      }
      if (result_.toolCount !== undefined && result_.toolCount === 0) {
        throw new Error(
          `${entry.id}: server advertised 0 tools at tools/list — SDK would emit MCP_STARTUP_FAILED`,
        );
      }
    },
    SPAWN_TOTAL_BUDGET_MS + 5000,
  );
});
