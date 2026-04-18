// Phase 2 / Step 2.2 — Fragment-aware (deep) pipeline hash.
//
// The canonical hash (see ./canonical.ts) covers the pipeline YAML itself,
// which is enough for "the pipeline file hasn't changed" — but a pipeline's
// observable behavior also depends on the knowledge fragments it activates.
// Fragments are not statically referenced: they match stage + available_steps
// at runtime via keywords/always/stages rules. So "deep hash" = canonical
// hash augmented with a deterministic digest of the fragment set the
// pipeline would activate at creation time.
//
// The resolver is injected — this module has zero filesystem / registry
// dependencies so it stays trivially testable.

import { createHash } from "node:crypto";
import { parse as parseYAML } from "yaml";
import { canonicalize, canonicalJson } from "./canonical.js";

/** Shape a caller must supply for each (stage, enabled_steps) combo we probe. */
export interface ResolvedFragmentEntry {
  id: string;
  content: string;
  /**
   * T1.1 — Activation rules for this fragment (stages match list, keywords,
   * always flag). Hashed into the digest so changes to activation rules
   * flip the pipeline version hash even when the rule change does not
   * affect the current pipeline's probe results.
   *
   * Required: every resolver must supply meta so pipelineVersionHash
   * reflects the full activation rule set.
   */
  meta: {
    stages: string[] | "*";
    keywords: string[];
    always: boolean;
  };
}

export type FragmentResolver = (
  stageName: string,
  enabledSteps: string[] | undefined,
) => ResolvedFragmentEntry[];

interface PipelineShape {
  stages?: unknown[];
}

/**
 * Flatten stages and parallel groups into `{name, availableStepKeys[]}`.
 * Accepts plain objects so this helper can work without pulling the full
 * pipeline config schema.
 */
function collectStageProbes(pipeline: PipelineShape): Array<{
  name: string;
  availableStepKeys: string[] | undefined;
}> {
  const probes: Array<{ name: string; availableStepKeys: string[] | undefined }> = [];
  const stages = Array.isArray(pipeline.stages) ? pipeline.stages : [];
  for (const entry of stages) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e.parallel && typeof e.parallel === "object") {
      const group = e.parallel as { stages?: unknown[] };
      if (Array.isArray(group.stages)) {
        for (const child of group.stages) {
          pushProbe(probes, child);
        }
      }
      continue;
    }
    pushProbe(probes, entry);
  }
  return probes;
}

function pushProbe(
  probes: Array<{ name: string; availableStepKeys: string[] | undefined }>,
  stage: unknown,
): void {
  if (!stage || typeof stage !== "object") return;
  const s = stage as Record<string, unknown>;
  const name = typeof s.name === "string" ? s.name : undefined;
  if (!name) return;
  const runtime = (s.runtime ?? {}) as Record<string, unknown>;
  const available = runtime.available_steps;
  let keys: string[] | undefined;
  if (Array.isArray(available)) {
    keys = available
      .map((a) => (a && typeof a === "object" ? (a as { key?: unknown }).key : undefined))
      .filter((k): k is string => typeof k === "string");
  }
  probes.push({ name, availableStepKeys: keys });
}

/**
 * Given a pipeline and a fragment resolver, compute the deterministic
 * fragment digest used by canonicalHashDeep. Exposed so callers that want
 * to persist the same bytes the hash was computed over (e.g. the
 * pipeline_versions row writer in Step 2.5) can read what went in.
 *
 * Probing strategy:
 *   For every stage (including parallel children), probe the resolver
 *   with (stageName, undefined) — this gets `always: true` and stage-
 *   matched fragments — and then with (stageName, [singleStep]) for
 *   every available_steps.key the stage declares. Union the results by
 *   id. Sorted alphabetically by id so the digest is deterministic.
 */
export function collectPipelineFragmentDigest(
  pipeline: PipelineShape,
  resolver: FragmentResolver,
): Array<{ id: string; contentHash: string; metaHash: string }> {
  // Track both content and meta per id. First sighting wins for both —
  // same fragment ID can surface through multiple probes but must be
  // identical across them (callers are expected to use a deterministic
  // resolver; no cross-check is performed).
  const seen = new Map<string, ResolvedFragmentEntry>();
  const probes = collectStageProbes(pipeline);
  for (const probe of probes) {
    const entries = resolver(probe.name, undefined);
    for (const entry of entries) {
      if (!seen.has(entry.id)) seen.set(entry.id, entry);
    }
    if (probe.availableStepKeys) {
      for (const step of probe.availableStepKeys) {
        const entries2 = resolver(probe.name, [step]);
        for (const entry of entries2) {
          if (!seen.has(entry.id)) seen.set(entry.id, entry);
        }
      }
    }
  }
  const sorted = [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted.map(([id, entry]) => ({
    id,
    contentHash: createHash("sha256").update(entry.content, "utf8").digest("hex"),
    // T1.1 — activation rule hash. Canonicalize the meta object so key
    // order inside `meta` doesn't change the digest.
    metaHash: createHash("sha256")
      .update(canonicalJson(entry.meta), "utf8")
      .digest("hex"),
  }));
}

/**
 * Full (deep) canonical hash. Includes the canonical hash of the pipeline
 * object PLUS the deterministic fragment digest. Changing either the
 * pipeline YAML or any activated fragment's content flips the output.
 */
export function canonicalHashDeep(
  input: string | unknown,
  resolver: FragmentResolver,
): string {
  const parsed = typeof input === "string" ? parseYAML(input) : input;
  const canonPipeline = canonicalize(parsed);
  const fragments = collectPipelineFragmentDigest(
    (parsed ?? {}) as PipelineShape,
    resolver,
  );
  const payload = {
    pipeline: canonPipeline,
    fragments, // already sorted + content-hashed
  };
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}
