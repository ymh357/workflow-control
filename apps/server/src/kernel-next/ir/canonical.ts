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
import type { AgentStage, GateStage, PipelineIR, StageIR, WireIR } from "./schema.js";

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
  // B4.F4: Date is `typeof === "object"` but its own-properties are
  // empty (state lives on the prototype) — without an explicit check
  // it would canonicalise to `{}`, hashing identically to a real
  // empty object. Reject before the generic object branch.
  if (value instanceof Date) {
    throw new Error(
      `sortKeys: Date instances are not allowed in IR (Date(${value.toISOString()})). ` +
        `Use ISO 8601 strings if a timestamp is part of the canonical IR.`,
    );
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
  // B4.F4 (2026-04-30 review): unsupported types (function, symbol,
  // bigint, undefined, Date) used to silently coerce to null. That is
  // dangerous for a canonical-hash function — two IRs with field=BigInt(1)
  // vs field=BigInt(2) would hash identically and collide in
  // pipeline_versions. The IR schema (Zod) already rejects these at
  // submit time, so reaching this branch indicates either a programmer
  // error (passing raw runtime objects to canonical) or a corrupt
  // PipelineIR — either way the safer answer is to fail loud.
  const t = typeof value;
  const repr =
    t === "bigint" ? `bigint(${(value as bigint).toString()})`
      : t === "function" ? "function"
      : t === "symbol" ? `symbol(${(value as symbol).description ?? ""})`
      : t === "undefined" ? "undefined"
      : value instanceof Date ? `Date(${value.toISOString()})`
      : `unknown(${String(value)})`;
  throw new Error(
    `sortKeys: unsupported value type ${t} (${repr}) — IR must contain only ` +
      `JSON-serialisable primitives (string/number/boolean/null), arrays, and plain objects.`,
  );
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
  // P5.2 (D6): include timeout_minutes in canonical form only when set.
  // sortKeys filters undefined values, so a gate without timeout_minutes
  // hashes identically to any pre-P5.2 gate (baseline fixtures stable).
  // An explicit timeout_minutes is a meaningful hot-update — it changes
  // the cancellation policy, so it must participate in version_hash.
  //
  // Bug 34 (c12+ review): question.options array order leaked into the
  // hash, so reordering the answer choices (purely presentational —
  // routing keys are looked up by value, not index) bumped the version
  // for no semantic change. Sort by `value` to make the canonical form
  // permutation-stable. Pre-fix fixtures whose options were already in
  // sorted order keep their hash; fixtures that were not (e.g.
  // approve/reject vs reject/approve) will see a one-time hash bump,
  // which is the right outcome — those hashes were always incoherent.
  let canonicalQuestion: CanonicalValue;
  if (cfg.question?.options !== undefined) {
    const sortedOptions = [...cfg.question.options].sort((a, b) =>
      codepointCompare(a.value, b.value),
    );
    canonicalQuestion = sortKeys({ ...cfg.question, options: sortedOptions });
  } else {
    canonicalQuestion = cfg.question;
  }
  return sortKeys({
    question: canonicalQuestion,
    routing: { routes: routesOut },
    timeout_minutes: cfg.timeout_minutes,
  });
}

// Custom canonicalizer for agent stage config. subAgents array must
// be sorted by sub-agent name so authoring permutations hash
// identically. Absent subAgents omitted (preserves baseline hashes
// for every pre-D1 fixture).
//
// mcpServers (D1.2): sorted by name; within each server object keys
// are sorted (via sortKeys), BUT args are positional so order is
// preserved, and envKeys are sorted (they're a set of required env
// var names with no positional semantics).
function canonicalizeAgentConfig(cfg: AgentStage["config"]): CanonicalValue {
  const out: Record<string, unknown> = { promptRef: cfg.promptRef };
  if (cfg.subAgents && cfg.subAgents.length > 0) {
    out.subAgents = [...cfg.subAgents].sort((a, b) =>
      codepointCompare(a.name, b.name),
    );
  }
  if (cfg.mcpServers && cfg.mcpServers.length > 0) {
    out.mcpServers = [...cfg.mcpServers]
      .sort((a, b) => codepointCompare(a.name, b.name))
      .map((m) => {
        const server: Record<string, unknown> = {
          args: [...m.args],
          command: m.command,
          envKeys: [...m.envKeys].sort(codepointCompare),
          name: m.name,
        };
        if (m.env && Object.keys(m.env).length > 0) {
          const sortedEnv: Record<string, string> = {};
          for (const k of Object.keys(m.env).sort(codepointCompare)) {
            sortedEnv[k] = m.env[k]!;
          }
          server.env = sortedEnv;
        }
        return server;
      });
  }
  // 2026-04-26 pivot: cross_segment_resume_from is included in the
  // canonical form only when present, preserving hash stability for
  // every pre-pivot IR fixture (their canonical agent config does not
  // mention the field).
  if (cfg.cross_segment_resume_from !== undefined) {
    out.cross_segment_resume_from = cfg.cross_segment_resume_from;
  }
  return sortKeys(out);
}

function canonicalizeStage(s: StageIR): CanonicalValue {
  // `fanout` is only present on agent/script variants (see schema.ts); the
  // discriminated-union narrowing surfaces it as an extra optional key that
  // participates in the canonical form when set.
  //
  // P5.1: `fanout.concurrency` is optional. sortKeys filters undefined
  // values, so a fanout lacking `concurrency` hashes identically to a
  // pre-P5.1 fanout (backward-compatible). An explicit concurrency value
  // does alter the hash — changing concurrency is a meaningful hot-update.
  const fanout = "fanout" in s ? s.fanout : undefined;
  let config: unknown;
  if (s.type === "gate") {
    config = canonicalizeGateConfig(s.config);
  } else if (s.type === "agent") {
    config = canonicalizeAgentConfig(s.config);
  } else {
    config = s.config;
  }
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
          .map((p) => sortKeys({
            name: p.name,
            type: p.type,
            zod: p.zod,
            // Optional description participates in the hash — changing
            // port semantics is a real pipeline change, not metadata.
            // Absent description stays absent via sortKeys' undefined
            // stripping (preserves hash stability for pre-P3.6 IRs).
            description: p.description,
            // Bug 7 (2026-04-28): port.optional changes seed-validation
            // semantics (required vs nullable) — toggling it is a real
            // pipeline change, not metadata. Absent value stays absent
            // (sortKeys strips undefined), preserving hash stability for
            // every pre-Bug-7 IR.
            optional: p.optional,
          }))
      : undefined;

  // Bug 5 fix (c12+ review): store_schema must participate in the
  // canonical hash. Pre-fix it was silently omitted, so any change
  // to the data dictionary produced an identical versionHash —
  // breaking propose_pipeline_change's optimistic locking and
  // pipeline_versions dedup. Validator emits STORE_SCHEMA_*
  // diagnostics that never bumped the version pre-fix.
  //
  // Hash compatibility note: every existing pipeline_versions row
  // hashed before this fix did NOT include store_schema. After this
  // fix, the same IR re-submitted will hash differently than the
  // stored row. INSERT OR IGNORE in pipeline_versions then leaves
  // both rows coexisting (different version_hash). Operators
  // upgrading kernel-next should re-submit any pipelines they want
  // to keep canonical; the dashboard's "latest" lookup picks the
  // most recent row by created_at and continues working without
  // intervention.
  const storeSchema = ir.store_schema !== undefined
    ? sortKeys(ir.store_schema as Record<string, unknown>)
    : undefined;

  return sortKeys({
    name: ir.name,
    entry: ir.entry,
    stages,
    wires,
    externalInputs,
    // Default "multi" preserves hash stability for pre-2026-04-25 IRs
    // whose TS type marks session_mode optional even though the Zod
    // schema defaults to "multi". Drift here silently re-versions
    // every legacy pipeline.
    session_mode: ir.session_mode ?? "multi",
    store_schema: storeSchema,
  });
}

export function canonicalJSON(ir: PipelineIR): string {
  return JSON.stringify(canonicalizeIR(ir));
}

export function versionHash(ir: PipelineIR): string {
  const canon = canonicalJSON(ir);
  return createHash("sha256").update(canon).digest("hex");
}

/**
 * Normalize prompt content to prevent hash drift from editor-induced
 * whitespace differences:
 *   - Strip UTF-8 BOM
 *   - Normalize CRLF and lone CR to LF
 *   - Strip trailing spaces/tabs per line
 *   - Ensure exactly one trailing LF
 */
export function normalizePromptContent(raw: string): string {
  let s = raw.replace(/^\uFEFF/, "");
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  s = s.split("\n").map((line) => line.replace(/[ \t]+$/, "")).join("\n");
  if (!s.endsWith("\n")) s += "\n";
  return s;
}

export function promptContentHash(content: string): string {
  const normalized = normalizePromptContent(content);
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Canonical body for a pipeline = canonical IR + sorted promptRef→contentHash map.
 * Shape: { ir: <canonicalIR>, prompts: { <promptRef>: "sha256:<hex>" } }.
 * Empty prompts map is valid and produces a distinct hash from the IR-only one.
 */
export function canonicalizePipeline(input: {
  ir: PipelineIR;
  prompts: Record<string, string>;
}): CanonicalValue {
  const ir = canonicalizeIR(input.ir);
  const promptEntries = Object.entries(input.prompts)
    .sort(([a], [b]) => codepointCompare(a, b))
    .map(([ref, content]) => [ref, `sha256:${promptContentHash(content)}`] as const);
  const prompts: Record<string, CanonicalValue> = {};
  for (const [ref, hash] of promptEntries) prompts[ref] = hash;
  return sortKeys({ ir, prompts });
}

export function pipelineCanonicalJSON(input: {
  ir: PipelineIR;
  prompts: Record<string, string>;
}): string {
  return JSON.stringify(canonicalizePipeline(input));
}

export function pipelineVersionHash(input: {
  ir: PipelineIR;
  prompts: Record<string, string>;
}): string {
  return createHash("sha256")
    .update(pipelineCanonicalJSON(input))
    .digest("hex");
}
