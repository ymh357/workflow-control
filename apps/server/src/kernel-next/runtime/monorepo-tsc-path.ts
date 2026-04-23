// Single source of truth for the monorepo's tsc binary path.
//
// Every production path that ends up invoking validator/types.ts must
// supply a tscPath that points at a real TypeScript install; otherwise
// the validator falls back to `npx tsc` from the temporary codegen dir
// and npx cannot resolve a non-existent node_modules. That failure
// manifests as a bogus WIRE_TYPE_MISMATCH (see run #19 post-mortem).
//
// Historically each caller wired this up by hand, and two independent
// call sites silently dropped it (debts L and M). Centralising the
// resolve in one module means "I forgot to pass tscPath" is impossible
// to express at the type level — callers now import this and pass it,
// or they rely on createKernelMcp's defaulting (see mcp/server.ts).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

let cached: { resolved: boolean; path: string | undefined } = {
  resolved: false,
  path: undefined,
};

/**
 * Resolve the monorepo's tsc binary. Returns undefined only when the
 * binary literally isn't installed (e.g. someone deleted node_modules);
 * in that case callers should let validator/types.ts fall back to
 * npx — the error will at least be honest.
 *
 * Result is cached after the first call. Process-wide singleton.
 */
export function resolveMonorepoTscPath(): string | undefined {
  if (cached.resolved) return cached.path;
  const here = dirname(fileURLToPath(import.meta.url));
  // runtime/ -> kernel-next/ -> src/ -> server/
  const candidate = join(here, "..", "..", "..", "node_modules", ".bin", "tsc");
  const path = existsSync(candidate) ? candidate : undefined;
  cached = { resolved: true, path };
  return path;
}

/** Test-only helper: clears the cache so later calls re-resolve. */
export function __resetMonorepoTscPathCacheForTests(): void {
  cached = { resolved: false, path: undefined };
}
