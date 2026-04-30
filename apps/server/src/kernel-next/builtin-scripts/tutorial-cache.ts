// tutorial-cache.ts — D1, c12 (2026-04-30).
//
// Cross-task tutorial cache for the 17-stage investigation skeleton.
// Two factory-bound builtin scripts that read/write the tutorial_cache
// table in kernel-next.db. A third pure-transform module
// (merge_tutorials) lives in builtin-scripts/index.ts because it has no
// DB dependency.
//
// Spec: docs/superpowers/specs/2026-04-30-tutorial-cache-design.md.
//
// Why factory-bound (not in BUILTIN_SCRIPT_MODULES directly): same
// reasoning as submit_pipeline_passthrough — ScriptModuleContext
// deliberately doesn't expose `db` (security boundary; AI-authored
// inline scripts must not get raw DB). Cache scripts need DB access,
// so the kernel binds the live handle via closure when assembling the
// per-task resolver.
//
// Caching shape (simplification, 2026-04-30): the cache stores only
// `slug` + `subject_domain` + `content_md`. Sources are already
// embedded in the markdown as inline links (the existing
// tutorialAuthoring agent emits "...source [url]..." style citations);
// caching them as a separate port would be redundant and complicate
// the wires. The `sources_json` column stays in the schema for future
// use (e.g. analytics) but is currently always written as `[]`.

import type { DatabaseSync } from "node:sqlite";
import type { ScriptModule } from "../runtime/script-module-resolver.js";

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function asStringArray(v: unknown, fieldName: string): string[] {
  if (!Array.isArray(v)) {
    throw new Error(`input '${fieldName}' must be string[] (got ${typeof v})`);
  }
  for (let i = 0; i < v.length; i++) {
    if (typeof v[i] !== "string") {
      throw new Error(`input '${fieldName}[${i}]' must be a string (got ${typeof v[i]})`);
    }
  }
  return v as string[];
}

function asStringRequired(v: unknown, fieldName: string): string {
  if (typeof v !== "string") {
    throw new Error(`input '${fieldName}' must be a string (got ${typeof v})`);
  }
  return v;
}

/**
 * Build the lookup_tutorial_cache script module bound to a specific
 * kernel-next DB handle.
 *
 * Inputs:
 *   slugs: string[]                   — full set of slugs the run wants to author
 *   subjectDomain: string             — from topicFraming.subjectDomain
 *   tutorialRejectionFeedback: string — empty on fresh runs, non-empty on
 *                                       reject re-runs from tutorialReviewGate
 *
 * Outputs:
 *   cachedSlugs: string[]
 *   cachedContents: string[]   — parallel to cachedSlugs
 *   missingSlugs: string[]     — the slugs the fanout still needs to author
 *
 * Reject-rerun semantics (Bug 7 fix, c12+ review): when the reviewer
 * rejects, every cached tutorial is suspect — the reviewer's feedback
 * may name only a subset of slugs but we cannot reliably parse
 * which ones from a free-form string. Bypass the cache entirely on
 * reject (every slug becomes missing), so the fanout re-authors all
 * tutorials and write_tutorial_cache UPSERTs replace the stale rows.
 * Pre-fix, reject rerouted to tutorialAuthoring whose fanout source
 * was lookupTutorialCache.missingSlugs = [] from the prior approve
 * pass, producing a 0-element fanout and no actual re-authoring.
 */
export function buildLookupTutorialCache(db: DatabaseSync): ScriptModule {
  return {
    async run(inputs) {
      const slugs = asStringArray(inputs.slugs ?? [], "slugs");
      const subjectDomain = asStringRequired(inputs.subjectDomain, "subjectDomain");
      const rejectionFeedback = typeof inputs.tutorialRejectionFeedback === "string"
        ? inputs.tutorialRejectionFeedback
        : "";

      if (slugs.length === 0) {
        return { cachedSlugs: [], cachedContents: [], missingSlugs: [] };
      }

      // Reject re-run: bypass the cache so every slug routes to the
      // fanout for fresh authoring. The fanout's writeTutorialCache
      // upsert then replaces the stale cache entries with the new
      // versions. See Bug 7 in
      // docs/superpowers/specs/2026-04-30-full-codebase-review.md.
      if (rejectionFeedback.trim().length > 0) {
        return {
          cachedSlugs: [],
          cachedContents: [],
          missingSlugs: [...slugs],
        };
      }

      const freshAfter = Date.now() - TTL_MS;
      // Build parameterized IN clause. SQLite parameter limit is 999;
      // typical investigation has 8–15 slugs so we never approach it,
      // but cap defensively.
      if (slugs.length > 500) {
        throw new Error(
          `lookup_tutorial_cache: refusing to look up ${slugs.length} slugs in one call (cap is 500).`,
        );
      }
      const placeholders = slugs.map(() => "?").join(",");
      const rows = db.prepare(
        `SELECT slug, content_md
           FROM tutorial_cache
          WHERE subject_domain = ?
            AND slug IN (${placeholders})
            AND created_at >= ?`,
      ).all(subjectDomain, ...slugs, freshAfter) as Array<{
        slug: string;
        content_md: string;
      }>;

      const hitMap = new Map<string, string>();
      for (const r of rows) hitMap.set(r.slug, r.content_md);

      // Preserve input slug order so cached arrays stay deterministic
      // across invocations with the same slug set.
      const cachedSlugs: string[] = [];
      const cachedContents: string[] = [];
      const missingSlugs: string[] = [];
      for (const slug of slugs) {
        const md = hitMap.get(slug);
        if (md !== undefined) {
          cachedSlugs.push(slug);
          cachedContents.push(md);
        } else {
          missingSlugs.push(slug);
        }
      }

      return { cachedSlugs, cachedContents, missingSlugs };
    },
  };
}

/**
 * Build the write_tutorial_cache script module bound to a specific
 * kernel-next DB handle.
 *
 * Inputs:
 *   slugs: string[]            — slugs the fanout actually authored this run
 *   contents: string[]         — parallel array of authored markdown
 *   subjectDomain: string
 *
 * Output:
 *   written: number            — count of upserted rows
 *
 * Upserts via INSERT … ON CONFLICT(slug, subject_domain) DO UPDATE so
 * re-running over the same slug refreshes content and bumps
 * created_at. Empty input is a no-op (returns 0).
 */
export function buildWriteTutorialCache(db: DatabaseSync): ScriptModule {
  return {
    async run(inputs) {
      const slugs = asStringArray(inputs.slugs ?? [], "slugs");
      const contents = asStringArray(inputs.contents ?? [], "contents");
      const subjectDomain = asStringRequired(inputs.subjectDomain, "subjectDomain");

      if (slugs.length !== contents.length) {
        throw new Error(
          `write_tutorial_cache: slugs/contents length mismatch ` +
          `(${slugs.length}/${contents.length})`,
        );
      }
      if (slugs.length === 0) {
        return { written: 0 };
      }

      const now = Date.now();
      const stmt = db.prepare(
        `INSERT INTO tutorial_cache (slug, subject_domain, content_md, sources_json, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(slug, subject_domain) DO UPDATE SET
           content_md   = excluded.content_md,
           sources_json = excluded.sources_json,
           created_at   = excluded.created_at`,
      );
      let written = 0;
      for (let i = 0; i < slugs.length; i++) {
        // sources_json kept as "[]" placeholder — see file header
        // comment for why we don't expose sources as a port.
        stmt.run(slugs[i]!, subjectDomain, contents[i]!, "[]", now);
        written++;
      }
      return { written };
    },
  };
}
