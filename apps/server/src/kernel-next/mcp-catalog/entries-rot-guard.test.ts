// Rot guard: every builtin entry's packageName must resolve on the live npm
// registry. Catches the failure mode that produced dogfood Bug 1 — entries
// added from training-data-recall that 404 against actual npm.
//
// SKIPPED by default to keep CI offline-clean and avoid hammering npm on every
// vitest run. Opt-in with `RUN_NPM_HEALTHCHECKS=1 vitest run entries-rot-guard`.
//
// Owner workflow: run this before bumping the catalog (or whenever
// entries.json changes). It's a smoke test, not a unit test.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { checkPackage, resolvePackageName } from "./healthcheck.js";
import { CatalogEntrySchema } from "./schema.js";

const SeedFileSchema = z.object({
  schemaVersion: z.literal("1"),
  entries: z.array(CatalogEntrySchema.omit({ source: true, deprecatedAt: true })),
});

const ENABLED = process.env.RUN_NPM_HEALTHCHECKS === "1";

(ENABLED ? describe : describe.skip)("entries.json rot guard (live npm)", () => {
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
