// Canonical JSON + SHA256 hashing for IR.
//
// Version identity: two IRs with the same stages/ports/wires (regardless of
// array ordering) hash to the same version_hash. This is the foundation of
// propose_pipeline_change optimistic locking (currentVersion check) and of
// pipeline_versions dedup.
//
// Canonicalization rules:
//   1. Object keys sorted ascending.
//   2. Arrays ordered by content-derived key (stages by name, ports by
//      (name, direction), wires by (to.stage, to.port)).
//   3. Optional fields omitted when absent (never serialized as `undefined`).

import { createHash } from "node:crypto";
import type { GateStage, PipelineIR, StageIR, WireIR } from "./schema.js";

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

// Locale-independent string comparison. Node's String.prototype.localeCompare
// uses ICU with the process default locale, which varies across machines
// (e.g. en_US vs tr_TR produce different orderings for same-case-insensitive
// letters). We rely on canonical ordering for version_hash stability — use
// a pure codepoint comparison instead.
function codepointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortKeys(value: unknown): CanonicalValue {
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((v) => sortKeys(v));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => codepointCompare(a, b));
    const out: Record<string, CanonicalValue> = {};
    for (const [k, v] of entries) out[k] = sortKeys(v);
    return out;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  // Unsupported type (function, symbol, bigint, undefined): skip.
  return null;
}

// Custom canonicalizer for gate stage config. Route targets may be a string
// (single stage) or string[] (multiple stages). Single-string values are
// preserved as-is so existing baseline hashes remain byte-identical. Array
// values are sorted by codepointCompare so that logically-equivalent
// permutations hash identically.
function canonicalizeGateConfig(cfg: GateStage["config"]): CanonicalValue {
  const routeEntries = Object.entries(cfg.routing.routes)
    .sort(([a], [b]) => codepointCompare(a, b));
  const routesOut: Record<string, CanonicalValue> = {};
  for (const [ans, target] of routeEntries) {
    if (Array.isArray(target)) {
      routesOut[ans] = [...target].sort(codepointCompare);
    } else {
      routesOut[ans] = target;
    }
  }
  return sortKeys({
    question: cfg.question,
    routing: { routes: routesOut },
  });
}

function canonicalizeStage(s: StageIR): CanonicalValue {
  // `fanout` is only present on agent/script variants (see schema.ts); the
  // discriminated-union narrowing surfaces it as an extra optional key that
  // participates in the canonical form when set.
  const fanout = "fanout" in s ? s.fanout : undefined;
  const config = s.type === "gate" ? canonicalizeGateConfig(s.config) : s.config;
  return sortKeys({
    name: s.name,
    type: s.type,
    inputs: [...s.inputs].sort((a, b) => codepointCompare(a.name, b.name)),
    outputs: [...s.outputs].sort((a, b) => codepointCompare(a.name, b.name)),
    config,
    fanout,
  });
}

function canonicalizeWire(w: WireIR): CanonicalValue {
  // Discriminated union: "stage" sources omit the tag (preserves the
  // pre-extension hash for every legacy fixture); "external" sources
  // embed it. See §4.12 of legacy-yaml-converter-design.md.
  const from: CanonicalValue =
    w.from.source === "external"
      ? { source: "external", port: w.from.port }
      : { stage: w.from.stage, port: w.from.port };
  return sortKeys({
    from,
    to: { stage: w.to.stage, port: w.to.port },
    guard: w.guard,
  });
}

export function canonicalizeIR(ir: PipelineIR): CanonicalValue {
  const stages = [...ir.stages]
    .sort((a, b) => codepointCompare(a.name, b.name))
    .map(canonicalizeStage);
  const wires = [...ir.wires]
    .sort((a, b) => {
      const ak = `${a.to.stage}.${a.to.port}`;
      const bk = `${b.to.stage}.${b.to.port}`;
      return codepointCompare(ak, bk);
    })
    .map(canonicalizeWire);

  // externalInputs is serialized only when non-empty, preserving the
  // canonical form for every pre-extension IR fixture (their hash must
  // not shift — see canonical.test.ts backward-compat block).
  const externalInputs =
    ir.externalInputs && ir.externalInputs.length > 0
      ? [...ir.externalInputs]
          .sort((a, b) => codepointCompare(a.name, b.name))
          .map((p) => sortKeys({ name: p.name, type: p.type, zod: p.zod }))
      : undefined;

  return sortKeys({
    name: ir.name,
    entry: ir.entry,
    stages,
    wires,
    externalInputs,
  });
}

export function canonicalJSON(ir: PipelineIR): string {
  return JSON.stringify(canonicalizeIR(ir));
}

export function versionHash(ir: PipelineIR): string {
  const canon = canonicalJSON(ir);
  return createHash("sha256").update(canon).digest("hex");
}
