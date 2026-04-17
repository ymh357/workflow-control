import type { WriteDeclaration, PipelineStageConfig, PipelineStageEntry } from "../lib/config/types.js";
import { isParallelGroup } from "../lib/config/types.js";

/**
 * Apply deterministic fixes to a pipeline object BEFORE validation.
 *
 * Rationale: autofix used to paper over common LLM mistakes (missing outputs
 * for writes, missing reads) but the fixes were unsafe:
 *   - Generating `{ type: "object", fields: [] }` made agents output `{}`
 *     silently — worse than a validator error that triggers an LLM retry.
 *   - Auto-populating reads with "all upstream keys" blew up token budgets by
 *     injecting entire upstream objects into every stage's Tier1 context.
 *
 * The current generator prompt already teaches the LLM to use `store_schema`
 * and declare `reads` explicitly; validator errors drive the retry loop,
 * which has cumulative feedback. So autofix is now a no-op placeholder —
 * kept as an extension point for genuinely mechanical, narrow fixes (e.g.
 * normalizing stage name casing) that we're confident can never make a
 * valid pipeline invalid. It intentionally returns `[]` today.
 */
export function autofixPipeline(_pipeline: {
  stages?: PipelineStageEntry[];
  store_schema?: Record<string, { produced_by: string; [k: string]: unknown }>;
}): string[] {
  return [];
}

// Re-export utility types/helpers so future fixes have them at hand.
// (Unused here today — intentionally imported to anchor the shared type
// contract with lib/config/types.ts.)
export type { WriteDeclaration, PipelineStageConfig };
export { isParallelGroup };
