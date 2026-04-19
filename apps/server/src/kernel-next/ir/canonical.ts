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
import type { PipelineIR, StageIR, WireIR } from "./schema.js";

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

function sortKeys(value: unknown): CanonicalValue {
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((v) => sortKeys(v));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
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

function canonicalizeStage(s: StageIR): CanonicalValue {
  return sortKeys({
    name: s.name,
    type: s.type,
    inputs: [...s.inputs].sort((a, b) => a.name.localeCompare(b.name)),
    outputs: [...s.outputs].sort((a, b) => a.name.localeCompare(b.name)),
    config: s.config,
  });
}

function canonicalizeWire(w: WireIR): CanonicalValue {
  return sortKeys({
    from: { stage: w.from.stage, port: w.from.port },
    to: { stage: w.to.stage, port: w.to.port },
  });
}

export function canonicalizeIR(ir: PipelineIR): CanonicalValue {
  const stages = [...ir.stages]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(canonicalizeStage);
  const wires = [...ir.wires]
    .sort((a, b) => {
      const ak = `${a.to.stage}.${a.to.port}`;
      const bk = `${b.to.stage}.${b.to.port}`;
      return ak.localeCompare(bk);
    })
    .map(canonicalizeWire);

  return sortKeys({
    name: ir.name,
    entry: ir.entry,
    stages,
    wires,
  });
}

export function canonicalJSON(ir: PipelineIR): string {
  return JSON.stringify(canonicalizeIR(ir));
}

export function versionHash(ir: PipelineIR): string {
  const canon = canonicalJSON(ir);
  return createHash("sha256").update(canon).digest("hex");
}
