// Builtin script modules — deterministic I/O + transformation primitives
// available to any pipeline via `ScriptStage { config: { moduleId: "..." } }`.
// These are the only script modules AI-generated pipelines can reference in
// D'-1; D'-3 adds inline-source scripts that compose these alongside
// custom logic.
//
// Contract:
//   - module.run(inputs, ctx) returns Record<string, unknown> whose keys
//     match the ScriptStage's declared output ports. Extra keys are
//     silently ignored at port_values (lineage) level; the sidecar still
//     captures the full object for debugging.
//   - Throw on precondition violation (missing input, malformed URL,
//     etc.) — kernel catches the throw and writes stage_attempts.status
//     = 'error' with the message.
//   - Don't read process.env directly. Caller-supplied env values
//     arrive in ctx.env (populated from task_env_values).

import type { ScriptModule } from "../runtime/script-module-resolver.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve as pathResolve, join as pathJoin } from "node:path";
import { homedir } from "node:os";
import { validate_and_repair_ir } from "./validate-and-repair-ir.js";
import { assemble_investigation_ir } from "./assemble-investigation-ir.js";

// ---------- helpers ----------

function requireString(inputs: Record<string, unknown>, key: string): string {
  const v = inputs[key];
  if (typeof v !== "string") {
    throw new Error(`input '${key}' is required and must be a string (got ${typeof v})`);
  }
  return v;
}

function optionalString(inputs: Record<string, unknown>, key: string): string | undefined {
  const v = inputs[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") {
    throw new Error(`input '${key}' must be a string when set (got ${typeof v})`);
  }
  return v;
}

function optionalRecord(
  inputs: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const v = inputs[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`input '${key}' must be an object when set (got ${typeof v})`);
  }
  return v as Record<string, unknown>;
}

// Expand ${VAR} placeholders in a string using the provided env map.
// Unknown vars left literal — matches the mcpServers-expander policy and
// lets scripts pass through $FOO style literals when desired.
function expandPlaceholders(tpl: string, env: Readonly<Record<string, string>>): string {
  return tpl.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name) => {
    const v = env[name];
    return v === undefined ? `\${${name}}` : v;
  });
}

// ---------- http ----------

// HTTP guard rails (Bug 6 fix, c12+ review).
//
// Pre-fix: http_fetch / http_request had no SSRF guard, no timeout,
// no body cap. AI-generated pipelines that wired user input into a
// fetch could probe loopback / cloud-metadata IPs, hang on slow
// servers indefinitely, or download multi-GB bodies that exhausted
// the kernel's heap.
//
// SSRF allow-list: explicitly reject loopback, link-local, private,
// cloud-metadata, multicast, and unspecified addresses. The
// allow-list is intentionally narrow — only RFC1918 + RFC6890
// public-internet hosts are permitted. If a future use case needs
// to fetch from a private IP, the caller can override via the
// `allowPrivate: true` input flag (off by default).
//
// Timeout: 30s default, 5min ceiling. Implemented via AbortController.
//
// Body cap: 10MB default, 100MB ceiling. Implemented via streamed
// read with byte counter (fetch's res.text() loads the entire body
// into memory; we use res.body iterator to bound memory).

const HTTP_DEFAULT_TIMEOUT_MS = 30_000;
const HTTP_MAX_TIMEOUT_MS = 5 * 60 * 1000;
const HTTP_DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const HTTP_MAX_MAX_BYTES = 100 * 1024 * 1024;

// SSRF: reject any host in these reserved ranges unless allowPrivate=true.
// Patterns are checked against the parsed URL's hostname (lowercased).
function isPrivateOrReservedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  // localhost / loopback names
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  // IPv6 loopback / link-local / unique-local / unspecified
  if (h === "::1" || h === "[::1]") return true;
  if (h.startsWith("[fe80:") || h.startsWith("fe80:")) return true;
  if (h.startsWith("[fc") || h.startsWith("[fd")) return true; // fc00::/7
  if (h === "::" || h === "[::]") return true;
  // IPv4 patterns. Only literal IPs check; hostnames are subject to
  // DNS rebinding which we don't defend against here (would require
  // resolve-and-pin which is out of scope for builtin-scripts).
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [, a, b] = ipv4.map(Number) as [number, number, number, number, number];
    if (a === 10) return true;             // 10.0.0.0/8 RFC1918
    if (a === 127) return true;            // loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + cloud metadata
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true; // 100.64/10 CGN
    if (a === 0) return true;              // 0.0.0.0/8
    if (a >= 224) return true;             // multicast + reserved
  }
  // Cloud metadata aliases (some clouds resolve these to 169.254.169.254)
  if (h === "metadata.google.internal") return true;
  if (h === "metadata.aws.internal") return true;
  return false;
}

interface HttpGuardOptions {
  timeoutMs: number;
  maxBytes: number;
  allowPrivate: boolean;
}

function readHttpGuardOptions(inputs: Record<string, unknown>): HttpGuardOptions {
  let timeoutMs = HTTP_DEFAULT_TIMEOUT_MS;
  if (typeof inputs.timeoutMs === "number" && inputs.timeoutMs > 0) {
    timeoutMs = Math.min(inputs.timeoutMs, HTTP_MAX_TIMEOUT_MS);
  }
  let maxBytes = HTTP_DEFAULT_MAX_BYTES;
  if (typeof inputs.maxBytes === "number" && inputs.maxBytes > 0) {
    maxBytes = Math.min(inputs.maxBytes, HTTP_MAX_MAX_BYTES);
  }
  const allowPrivate = inputs.allowPrivate === true;
  return { timeoutMs, maxBytes, allowPrivate };
}

function validateHttpUrl(rawUrl: string, allowPrivate: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`invalid URL: ${JSON.stringify(rawUrl)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `URL protocol '${parsed.protocol}' is not allowed (only http: and https:)`,
    );
  }
  if (!allowPrivate && isPrivateOrReservedHostname(parsed.hostname)) {
    throw new Error(
      `URL hostname '${parsed.hostname}' resolves to a private / loopback / cloud-metadata range. ` +
        `Pass allowPrivate: true to override (single-user posture).`,
    );
  }
  return parsed;
}

// Streamed body read with byte cap. Aborts the underlying response
// when the cap is exceeded. Returns the partial body decoded as UTF-8
// up to the cap, plus a `truncated: true` flag callers can observe.
async function readBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<{ body: string; truncated: boolean }> {
  if (!response.body) {
    return { body: "", truncated: false };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let collected = "";
  let bytesRead = 0;
  let truncated = false;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      truncated = true;
      // Take only the prefix up to the cap so total decoded size matches.
      const allowedBytes = maxBytes - (bytesRead - value.byteLength);
      const slice = allowedBytes > 0 ? value.slice(0, allowedBytes) : new Uint8Array();
      collected += decoder.decode(slice, { stream: false });
      try { await reader.cancel(); } catch { /* swallow */ }
      break;
    }
    collected += decoder.decode(value, { stream: true });
  }
  if (!truncated) collected += decoder.decode();
  return { body: collected, truncated };
}

// http_fetch — GET a URL, optionally with headers. Body returned as string
// (UTF-8 decoded) plus numeric status and response headers. No retry loop;
// callers that need retries wrap in a gate or a regenerate-friendly agent.
const http_fetch: ScriptModule = {
  async run(inputs, ctx) {
    const rawUrl = requireString(inputs, "url");
    const expandedUrl = expandPlaceholders(rawUrl, ctx.env);
    const guard = readHttpGuardOptions(inputs);
    validateHttpUrl(expandedUrl, guard.allowPrivate);

    const headersIn = optionalRecord(inputs, "headers") ?? {};
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(headersIn)) {
      if (typeof v !== "string") {
        throw new Error(`headers.${k} must be a string (got ${typeof v})`);
      }
      headers[k] = expandPlaceholders(v, ctx.env);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), guard.timeoutMs);
    timer.unref?.();
    let res: Response;
    try {
      res = await fetch(expandedUrl, { method: "GET", headers, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`http_fetch timed out after ${guard.timeoutMs}ms (url=${expandedUrl})`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    const { body, truncated } = await readBodyCapped(res, guard.maxBytes);
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => { respHeaders[k] = v; });
    return {
      status: res.status,
      ok: res.ok,
      body,
      headers: respHeaders,
      truncated,
    };
  },
};

// http_request — arbitrary method + body. Body is stringified JSON when
// the input is an object; string passthrough otherwise.
const http_request: ScriptModule = {
  async run(inputs, ctx) {
    const rawUrl = requireString(inputs, "url");
    const expandedUrl = expandPlaceholders(rawUrl, ctx.env);
    const guard = readHttpGuardOptions(inputs);
    validateHttpUrl(expandedUrl, guard.allowPrivate);

    const method = (optionalString(inputs, "method") ?? "GET").toUpperCase();
    const headersIn = optionalRecord(inputs, "headers") ?? {};
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(headersIn)) {
      if (typeof v !== "string") {
        throw new Error(`headers.${k} must be a string (got ${typeof v})`);
      }
      headers[k] = expandPlaceholders(v, ctx.env);
    }
    let body: string | undefined;
    const rawBody = inputs.body;
    if (rawBody !== undefined && rawBody !== null) {
      if (typeof rawBody === "string") {
        body = rawBody;
      } else {
        body = JSON.stringify(rawBody);
        if (headers["content-type"] === undefined && headers["Content-Type"] === undefined) {
          headers["content-type"] = "application/json";
        }
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), guard.timeoutMs);
    timer.unref?.();
    let res: Response;
    try {
      res = await fetch(expandedUrl, { method, headers, body, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`http_request timed out after ${guard.timeoutMs}ms (url=${expandedUrl})`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    const { body: respText, truncated } = await readBodyCapped(res, guard.maxBytes);
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => { respHeaders[k] = v; });
    return {
      status: res.status,
      ok: res.ok,
      body: respText,
      headers: respHeaders,
      truncated,
    };
  },
};

// ---------- fs ----------

// read_file — UTF-8 text read. Returns the full contents. Throws ENOENT
// when the path doesn't exist.
const read_file: ScriptModule = {
  async run(inputs) {
    const path = requireString(inputs, "path");
    const content = await readFile(path, "utf8");
    return { content };
  },
};

// write_file — UTF-8 text write, with mkdir -p on the parent. Returns the
// absolute resolved path so downstream stages can wire it to other steps
// without duplicating path logic.
const write_file: ScriptModule = {
  async run(inputs) {
    const path = requireString(inputs, "path");
    const content = requireString(inputs, "content");
    const absPath = pathResolve(path);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, content, "utf8");
    return { absolutePath: absPath };
  },
};

// ---------- path ----------

// path_expand — expand a leading `~` to the user's home directory and
// resolve to an absolute path. `~user` form is NOT supported (matches
// node's path module scope; expand a known $HOME only).
const path_expand: ScriptModule = {
  async run(inputs) {
    const path = requireString(inputs, "path");
    let expanded = path;
    if (path === "~") {
      expanded = homedir();
    } else if (path.startsWith("~/")) {
      expanded = pathJoin(homedir(), path.slice(2));
    }
    return { path: pathResolve(expanded) };
  },
};

// path_join — delegate to node:path.join. Accepts a `segments: string[]`
// input because script inputs map 1:1 to declared ports; a variadic API
// doesn't fit the port model cleanly.
const path_join: ScriptModule = {
  async run(inputs) {
    const segments = inputs.segments;
    if (!Array.isArray(segments) || segments.some((s) => typeof s !== "string")) {
      throw new Error("input 'segments' must be a string[]");
    }
    return { path: pathJoin(...(segments as string[])) };
  },
};

// ---------- json ----------

// json_parse — JSON.parse on a string input. Distinct port from http_fetch
// so pipelines that fetch-then-parse have two named stages (lineage trail).
const json_parse: ScriptModule = {
  async run(inputs) {
    const raw = requireString(inputs, "raw");
    return { value: JSON.parse(raw) };
  },
};

// json_stringify — JSON.stringify with optional indent. Returns the
// serialized string for downstream write_file / http_request.body wiring.
const json_stringify: ScriptModule = {
  async run(inputs) {
    const value = inputs.value;
    if (value === undefined) {
      throw new Error("input 'value' is required");
    }
    const indent = inputs.indent;
    let raw: string;
    if (indent === undefined || indent === null) {
      raw = JSON.stringify(value);
    } else if (typeof indent === "number") {
      raw = JSON.stringify(value, null, indent);
    } else {
      throw new Error(`input 'indent' must be a number when set (got ${typeof indent})`);
    }
    return { raw };
  },
};

// ---------- env ----------

// env_resolve — looks up a key in ctx.env (per-task env values) with an
// optional default. Explicit over inlining `ctx.env["FOO"]` inside a
// script because it produces a lineage-tracked port, which is auditable
// in the dashboard; directly reading ctx is invisible to lineage.
const env_resolve: ScriptModule = {
  async run(inputs, ctx) {
    const key = requireString(inputs, "key");
    const v = ctx.env[key];
    if (v !== undefined) {
      return { value: v, present: true };
    }
    const fallback = optionalString(inputs, "default");
    if (fallback !== undefined) {
      return { value: fallback, present: false };
    }
    throw new Error(`env key '${key}' not set and no default provided`);
  },
};

// ---------- pipeline-modifier guard ----------

// validate_patch_vs_intent — kernel-side guard for pipeline-modifier
// (dogfood-2026-04-28 Bug 8b). The agent stage `genPatch` is allowed to
// emit `{ ops: [] }` only when the upstream `gapAnalysis.intendedChanges`
// is itself empty (legitimate no-op intent, e.g. description-only edits)
// or when the dry-run came back non-safe (the agent must surface the
// real failure, not paper over it). This script enforces that contract
// in code so a future prompt regression cannot reintroduce the silent
// "empty patch + safe verdict" failure mode.
//
// Inputs:
//   gapAnalysis    — analyzeGap output; expected shape includes
//                    `intendedChanges: Array<unknown>` per gen-patch.md.
//   patch          — genPatch output; expected `{ ops: Array<unknown> }`.
//   dryRunVerdict  — genPatch output; one of "safe" | "unsafe" | "structural".
//
// Outputs (passthroughs to applying — kept here so this stage owns the
// authoritative wire and applying does not have to read from genPatch
// directly when the guard is engaged):
//   patch, dryRunVerdict
//
// Failure mode: throws on the contradiction. Script-stage runner
// catches the throw and marks the stage as `error`, which surfaces to
// the user as a stage_failed event with this exact message — no silent
// success on contradictory intent + empty patch.
const validate_patch_vs_intent: ScriptModule = {
  async run(inputs) {
    const gapAnalysis = inputs.gapAnalysis;
    const patch = inputs.patch;
    const verdict = inputs.dryRunVerdict;

    const intendedChanges =
      gapAnalysis && typeof gapAnalysis === "object" && !Array.isArray(gapAnalysis)
        ? (gapAnalysis as { intendedChanges?: unknown }).intendedChanges
        : undefined;
    const intendedNonEmpty = Array.isArray(intendedChanges) && intendedChanges.length > 0;

    const ops =
      patch && typeof patch === "object" && !Array.isArray(patch)
        ? (patch as { ops?: unknown }).ops
        : undefined;
    if (!Array.isArray(ops)) {
      throw new Error(
        `validate_patch_vs_intent: patch.ops must be an array (got ${typeof ops})`,
      );
    }
    const opsEmpty = ops.length === 0;

    if (typeof verdict !== "string") {
      throw new Error(
        `validate_patch_vs_intent: dryRunVerdict must be a string (got ${typeof verdict})`,
      );
    }

    if (intendedNonEmpty && opsEmpty && verdict === "safe") {
      throw new Error(
        `Bug 8b guard: gapAnalysis.intendedChanges has ${(intendedChanges as unknown[]).length} entries ` +
          `but patch.ops is empty and dryRunVerdict='safe'. This is the silent-no-op failure mode: the ` +
          `agent observed a non-empty intent, failed to author a working patch, and submitted an empty ` +
          `patch with a safe verdict to mask the failure. Re-run genPatch and either author a real ` +
          `patch (any non-empty ops[]) or emit dryRunVerdict='unsafe' with the last non-empty draft.`,
      );
    }

    return { patch, dryRunVerdict: verdict };
  },
};

// ---------- source classification ----------

// classify_source_url — domain-agnostic URL → source-type classifier.
// Continuation 9 (2026-04-29). The web3-tech-research dogfood revealed
// that LLM-driven evidenceGather routinely cites blogs/articles when
// primary sources (source code, on-chain explorers, RFCs, papers,
// official spec) exist for the claim. A purely prompt-based fix is
// brittle; this script enforces source quality at the type level so
// downstream stages (filter / verify / judge) can react deterministically.
//
// Type taxonomy — chosen so it generalises across domains without baking
// in any specific subject (no "blockchain", no "ML", no "Linux" hints):
//   - "primary"            — independently verifiable artifact: source
//                            code, on-chain transaction/address, RFC,
//                            published paper, official spec/standard.
//   - "official_secondary" — produced by the subject itself (their own
//                            blog, docs site, announcement). Authoritative
//                            but a curated narrative, not raw evidence.
//                            Recognized via the optional subjectDomain
//                            input: when present, hosts containing it
//                            are treated as official.
//   - "third_party"        — articles/blogs/tutorials about the subject
//                            written by someone else.
//   - "aggregator"         — Q&A and discussion sites (reddit, HN, SO,
//                            zhihu). Evidence is the consensus, not the
//                            individual posts.
//
// The signal field returns the matching pattern key for diagnostics so
// downstream filters can explain *why* a URL was classified a given way.
//
// Inputs:
//   url:           string (required) — single URL to classify
//   subjectDomain: string (optional)  — registrable domain of the subject
//                                       under investigation (e.g. "0g.ai",
//                                       "ethereum.org"). When set, hosts
//                                       whose registrable suffix matches
//                                       are upgraded from third_party →
//                                       official_secondary if not already
//                                       primary.
//
// Output:
//   type:       "primary" | "official_secondary" | "third_party"
//                 | "aggregator" | "unknown"
//   signal:     short pattern key explaining the match
//   confidence: 0-1 numeric; 1.0 for hard structural matches (github
//                 path depth ≥ 2, etherscan tx/address), 0.7-0.9 for
//                 host-based, 0.5 for fallback.

interface ClassifyResult {
  type: "primary" | "official_secondary" | "third_party" | "aggregator" | "unknown";
  signal: string;
  confidence: number;
}

const PRIMARY_HOST_PATTERNS: Array<{
  hostMatch: (host: string) => boolean;
  pathMatch: (path: string) => boolean;
  signal: string;
  confidence: number;
}> = [
  // Source code repositories — require ≥1 path segment after the host so
  // bare github.com homepage doesn't qualify.
  {
    hostMatch: (h) => h === "github.com" || h.endsWith(".github.com"),
    pathMatch: (p) => /^\/[^/]+\/[^/]+/.test(p),
    signal: "source_repo:github",
    confidence: 1.0,
  },
  {
    hostMatch: (h) => h === "gitlab.com" || h.endsWith(".gitlab.com"),
    pathMatch: (p) => /^\/[^/]+\/[^/]+/.test(p),
    signal: "source_repo:gitlab",
    confidence: 1.0,
  },
  {
    hostMatch: (h) => h === "bitbucket.org",
    pathMatch: (p) => /^\/[^/]+\/[^/]+/.test(p),
    signal: "source_repo:bitbucket",
    confidence: 1.0,
  },
  {
    hostMatch: (h) => h === "codeberg.org" || h === "git.sr.ht",
    pathMatch: (p) => /^\/[^/]+\/[^/]+/.test(p),
    signal: "source_repo:other",
    confidence: 1.0,
  },
  // On-chain explorers — only address/tx/contract paths, not the homepage.
  {
    hostMatch: (h) => /(^|\.)etherscan\.io$/.test(h)
      || /(^|\.)bscscan\.com$/.test(h)
      || /(^|\.)polygonscan\.com$/.test(h)
      || /(^|\.)arbiscan\.io$/.test(h)
      || /(^|\.)basescan\.org$/.test(h)
      || /(^|\.)optimistic\.etherscan\.io$/.test(h)
      || /(^|\.)snowtrace\.io$/.test(h)
      || /(^|\.)ftmscan\.com$/.test(h),
    pathMatch: (p) => /^\/(address|tx|token|block|api)\b/.test(p),
    signal: "onchain_explorer:evm",
    confidence: 1.0,
  },
  {
    hostMatch: (h) => h === "explorer.solana.com" || h === "solscan.io" || h === "solana.fm",
    pathMatch: (p) => /^\/(address|tx|account|block)\b/.test(p),
    signal: "onchain_explorer:solana",
    confidence: 1.0,
  },
  {
    hostMatch: (h) => h === "blockstream.info" || h === "mempool.space",
    pathMatch: (p) => /^\/(tx|address|block)\b/.test(p),
    signal: "onchain_explorer:bitcoin",
    confidence: 1.0,
  },
  // Specs & RFCs.
  {
    hostMatch: (h) => h === "datatracker.ietf.org",
    pathMatch: (p) => /^\/doc\//.test(p),
    signal: "spec:ietf_rfc",
    confidence: 1.0,
  },
  {
    hostMatch: (h) => h === "www.rfc-editor.org" || h === "rfc-editor.org",
    pathMatch: (p) => /^\/(rfc|info)\//.test(p),
    signal: "spec:rfc_editor",
    confidence: 1.0,
  },
  {
    hostMatch: (h) => h === "eips.ethereum.org",
    pathMatch: () => true,
    signal: "spec:eip",
    confidence: 1.0,
  },
  {
    hostMatch: (h) => h === "ercs.ethereum.org",
    pathMatch: () => true,
    signal: "spec:erc",
    confidence: 1.0,
  },
  {
    hostMatch: (h) => h === "bips.dev" || h === "github.com" /* already caught above */,
    pathMatch: (p) => /^\/bip-/.test(p),
    signal: "spec:bip",
    confidence: 1.0,
  },
  {
    hostMatch: (h) => h === "www.w3.org" || h === "w3.org",
    pathMatch: (p) => /^\/TR\//.test(p),
    signal: "spec:w3c_tr",
    confidence: 1.0,
  },
  {
    hostMatch: (h) => h === "www.iso.org" || h === "iso.org",
    pathMatch: (p) => /^\/standard\//.test(p),
    signal: "spec:iso",
    confidence: 1.0,
  },
  // Peer-reviewed papers / preprints.
  {
    hostMatch: (h) => h === "arxiv.org",
    pathMatch: (p) => /^\/(abs|pdf)\//.test(p),
    signal: "paper:arxiv",
    confidence: 1.0,
  },
  {
    hostMatch: (h) => h === "doi.org" || h === "dx.doi.org",
    pathMatch: () => true,
    signal: "paper:doi",
    confidence: 1.0,
  },
  {
    hostMatch: (h) => h === "dl.acm.org",
    pathMatch: (p) => /^\/doi\//.test(p),
    signal: "paper:acm",
    confidence: 1.0,
  },
  {
    hostMatch: (h) => /(^|\.)ieee\.org$/.test(h),
    pathMatch: (p) => /^\/document\//.test(p),
    signal: "paper:ieee",
    confidence: 1.0,
  },
  {
    hostMatch: (h) => /(^|\.)springer\.com$/.test(h) || /(^|\.)nature\.com$/.test(h)
      || /(^|\.)sciencedirect\.com$/.test(h),
    pathMatch: () => true,
    signal: "paper:journal",
    confidence: 0.9,
  },
  {
    hostMatch: (h) => h === "www.usenix.org" || h === "usenix.org",
    pathMatch: (p) => /^\/conference\//.test(p),
    signal: "paper:usenix",
    confidence: 1.0,
  },
  {
    hostMatch: (h) => h === "eprint.iacr.org",
    pathMatch: () => true,
    signal: "paper:iacr_eprint",
    confidence: 1.0,
  },
  // Package registries — versioned source of truth for libraries.
  {
    hostMatch: (h) => h === "www.npmjs.com" || h === "npmjs.com",
    pathMatch: (p) => /^\/package\//.test(p),
    signal: "package_registry:npm",
    confidence: 1.0,
  },
  {
    hostMatch: (h) => h === "pypi.org",
    pathMatch: (p) => /^\/project\//.test(p),
    signal: "package_registry:pypi",
    confidence: 1.0,
  },
  {
    hostMatch: (h) => h === "crates.io",
    pathMatch: (p) => /^\/crates\//.test(p),
    signal: "package_registry:cratesio",
    confidence: 1.0,
  },
];

const AGGREGATOR_HOSTS = new Set([
  "reddit.com",
  "www.reddit.com",
  "old.reddit.com",
  "news.ycombinator.com",
  "stackoverflow.com",
  "stackexchange.com",
  "superuser.com",
  "serverfault.com",
  "askubuntu.com",
  "math.stackexchange.com",
  "ethereum.stackexchange.com",
  "zhihu.com",
  "www.zhihu.com",
  "quora.com",
  "www.quora.com",
]);

// Hosts whose primary content shape is "third-party article". Even when
// the URL contains the subjectDomain in path/query, the publisher is a
// neutral aggregator of writers.
const THIRD_PARTY_PUBLISHER_HOSTS = new Set([
  "medium.com",
  "dev.to",
  "substack.com",
  "hackernoon.com",
  "infoq.com",
  "thenewstack.io",
  "freecodecamp.org",
  "www.freecodecamp.org",
  "towardsdatascience.com",
  "blog.csdn.net",
  "csdn.net",
  "juejin.cn",
  "jianshu.com",
  "cnblogs.com",
  "techcrunch.com",
  "wired.com",
  "arstechnica.com",
  "theverge.com",
  "coindesk.com",
  "cointelegraph.com",
  "decrypt.co",
  "theblock.co",
]);

function parseUrlSafe(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

// Strip a leading "www." from a host and return both forms for matching
// against a registrable-domain hint without a public-suffix list.
function hostMatchesSubject(host: string, subjectDomain: string): boolean {
  const h = host.toLowerCase();
  const sd = subjectDomain.toLowerCase().replace(/^www\./, "");
  if (!sd) return false;
  // Exact host or any sub-host of the subject domain.
  if (h === sd) return true;
  if (h.endsWith("." + sd)) return true;
  return false;
}

function classifyOne(rawUrl: string, subjectDomain?: string): ClassifyResult {
  const u = parseUrlSafe(rawUrl);
  if (!u) {
    return { type: "unknown", signal: "url_parse_error", confidence: 0 };
  }
  const host = u.host.toLowerCase();
  const path = u.pathname || "/";

  // Primary check first — structural matches beat host-based matches.
  for (const rule of PRIMARY_HOST_PATTERNS) {
    if (rule.hostMatch(host) && rule.pathMatch(path)) {
      return { type: "primary", signal: rule.signal, confidence: rule.confidence };
    }
  }

  // Strip a leading "www." for set lookups so the SET stays canonical
  // and we don't have to enumerate both forms.
  const hostNoWww = host.replace(/^www\./, "");

  // Aggregators take precedence over subject-domain reasoning — even if
  // someone embeds reddit.com/r/ethereum, the content shape is still a
  // discussion thread, not the project's own narrative.
  if (AGGREGATOR_HOSTS.has(host) || AGGREGATOR_HOSTS.has(hostNoWww)) {
    return { type: "aggregator", signal: "aggregator_host", confidence: 0.9 };
  }

  // Third-party publishers — neutral platforms regardless of who wrote.
  if (THIRD_PARTY_PUBLISHER_HOSTS.has(host) || THIRD_PARTY_PUBLISHER_HOSTS.has(hostNoWww)) {
    return { type: "third_party", signal: "third_party_publisher", confidence: 0.9 };
  }

  // Subject-domain bump: when the caller knows the subject's registrable
  // domain (e.g. hypothesize stage extracted "0g.ai" from the input
  // topic), a host that matches it is the subject's own narrative
  // surface — official_secondary.
  if (subjectDomain && hostMatchesSubject(host, subjectDomain)) {
    return {
      type: "official_secondary",
      signal: "subject_domain_match",
      confidence: 0.85,
    };
  }

  // Generic blog/docs heuristics — when no subject hint is present we
  // can't tell whether a "blog.foo.com" is the subject's own blog or a
  // third party's site about the subject. Treat as third_party (the
  // higher-rigor default) so the filter doesn't over-credit unverified
  // sources.
  if (/^blog\./.test(host) || /^news\./.test(host)) {
    return { type: "third_party", signal: "blog_subdomain", confidence: 0.6 };
  }
  if (/^docs?\./.test(host) || /\.readthedocs\.io$/.test(host)) {
    // Docs subdomains lean official, but without a subject hint we cannot
    // confirm. Mark as official_secondary at lower confidence — downstream
    // filter can choose whether to credit at this confidence level.
    return { type: "official_secondary", signal: "docs_subdomain", confidence: 0.6 };
  }

  return { type: "unknown", signal: "no_match", confidence: 0.5 };
}

// classify_source_url — single URL or array form.
// Inputs (one of):
//   url: string                     — single classification
//   urls: string[]                  — batch by raw URL
//   citations: Array<{ url: string }> — batch by Citation objects (passthrough preserved)
// Optional:
//   subjectDomain: string
// Output:
//   For single: { type, signal, confidence }
//   For batch:  { results: Array<ClassifyResult & { url, ...passthrough }> }
const classify_source_url: ScriptModule = {
  async run(inputs) {
    const subjectDomainRaw = optionalString(inputs, "subjectDomain");
    const subjectDomain = subjectDomainRaw?.toLowerCase().replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");

    const singleUrl = optionalString(inputs, "url");
    if (singleUrl !== undefined) {
      const r = classifyOne(singleUrl, subjectDomain);
      return { type: r.type, signal: r.signal, confidence: r.confidence };
    }

    const urlsRaw = inputs.urls;
    if (Array.isArray(urlsRaw)) {
      const out = urlsRaw.map((u, i) => {
        if (typeof u !== "string") {
          throw new Error(
            `input 'urls[${i}]' must be a string (got ${typeof u})`,
          );
        }
        return { url: u, ...classifyOne(u, subjectDomain) };
      });
      return { results: out };
    }

    const citationsRaw = inputs.citations;
    if (Array.isArray(citationsRaw)) {
      const out = citationsRaw.map((c, i) => {
        if (c === null || typeof c !== "object" || Array.isArray(c)) {
          throw new Error(
            `input 'citations[${i}]' must be an object (got ${typeof c})`,
          );
        }
        const obj = c as Record<string, unknown>;
        const u = obj.url;
        if (typeof u !== "string") {
          throw new Error(
            `input 'citations[${i}].url' must be a string (got ${typeof u})`,
          );
        }
        return { ...obj, ...classifyOne(u, subjectDomain) };
      });
      return { results: out };
    }

    throw new Error(
      "classify_source_url: provide one of 'url' (string), 'urls' (string[]), or 'citations' (Array<{url}>)",
    );
  },
};

// classify_evidence_bundle — investigation-pipeline shaped wrapper around
// classify_source_url. Continuation 9 (2026-04-29). The 14-stage
// investigation skeleton's `sourceClassify` stage consumes the aggregate
// output of the upstream `evidenceGather` fanout — an array shaped one
// entry per hypothesis, each containing positive/negative evidence
// arrays of citations. Rather than ship that shape transformation as
// inline TypeScript in every generator-emitted IR (and depend on the LLM
// to write it correctly), this builtin owns the canonical reshape.
//
// Inputs:
//   evidence: Array<{
//     hypothesisId: string,
//     verdict: "supported" | "refuted" | "inconclusive",
//     positiveEvidence: Array<{ kind: string; url: string; quote: string }>,
//     negativeEvidence: Array<{ kind: string; url: string; quote: string }>,
//     rawArtifacts?: string[]
//   }>
//   subjectDomain?: string  — forwarded to classify_source_url
//
// Output:
//   classifiedEvidence: Array<{
//     hypothesisId, verdict, rawArtifacts (passthrough),
//     positiveEvidence: Array<original + { type, signal, confidence }>,
//     negativeEvidence: Array<original + { type, signal, confidence }>,
//     primaryCount, officialCount, thirdPartyCount,
//     aggregatorCount, unknownCount
//   }>
//
// Citations whose `url` is empty (non-URL-addressable evidence — local
// files, transcripts, etc.) are tagged type:"unknown", signal:"no_url",
// confidence:0. Downstream gates can choose to treat them as unverifiable
// or trust them under their own logic.
const classify_evidence_bundle: ScriptModule = {
  async run(inputs) {
    const subjectDomainRaw = optionalString(inputs, "subjectDomain");
    const subjectDomain = subjectDomainRaw?.toLowerCase().replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");

    const evidenceRaw = inputs.evidence;
    if (!Array.isArray(evidenceRaw)) {
      throw new Error(
        `classify_evidence_bundle: input 'evidence' is required and must be an array (got ${typeof evidenceRaw})`,
      );
    }

    const classified = evidenceRaw.map((entry, idx) => {
      // C10 (2026-04-30): tolerate stringified-JSON input. Some agent
      // outputs come through as `JSON.stringify(obj)` instead of the
      // raw object — parse it once before validating shape. If parse
      // fails or produces a non-object, fall through to the strict
      // throw below so callers still see a clear error.
      let parsedEntry: unknown = entry;
      if (typeof entry === "string") {
        try {
          parsedEntry = JSON.parse(entry);
        } catch {
          // not JSON — leave as string so the type check below throws
        }
      }
      if (parsedEntry === null || typeof parsedEntry !== "object" || Array.isArray(parsedEntry)) {
        throw new Error(
          `classify_evidence_bundle: evidence[${idx}] must be an object (got ${typeof entry})`,
        );
      }
      const e = parsedEntry as Record<string, unknown>;

      const classifyCitationList = (
        list: unknown,
        listName: string,
      ): Array<Record<string, unknown> & ClassifyResult> => {
        if (list === undefined || list === null) return [];
        if (!Array.isArray(list)) {
          throw new Error(
            `classify_evidence_bundle: evidence[${idx}].${listName} must be an array when present (got ${typeof list})`,
          );
        }
        return list.map((c, ci) => {
          // C10 (2026-04-30): same stringified-JSON tolerance as above.
          let parsed: unknown = c;
          if (typeof c === "string") {
            try { parsed = JSON.parse(c); } catch { /* leave as string */ }
          }
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error(
              `classify_evidence_bundle: evidence[${idx}].${listName}[${ci}] must be an object (got ${typeof c})`,
            );
          }
          const cit = parsed as Record<string, unknown>;
          const u = cit.url;
          if (u === undefined || u === null || u === "") {
            return {
              ...cit,
              type: "unknown" as const,
              signal: "no_url",
              confidence: 0,
            };
          }
          if (typeof u !== "string") {
            throw new Error(
              `classify_evidence_bundle: evidence[${idx}].${listName}[${ci}].url must be a string when present (got ${typeof u})`,
            );
          }
          const cls = classifyOne(u, subjectDomain);
          return { ...cit, ...cls };
        });
      };

      const pos = classifyCitationList(e.positiveEvidence, "positiveEvidence");
      const neg = classifyCitationList(e.negativeEvidence, "negativeEvidence");

      // Counts use positive evidence only — those are the citations that
      // back a "supported" verdict. Negative evidence is the agent's
      // record of what was tried and didn't pan out; counting it as
      // "primary support" would defeat the gate's purpose.
      let primaryCount = 0,
        officialCount = 0,
        thirdPartyCount = 0,
        aggregatorCount = 0,
        unknownCount = 0;
      for (const c of pos) {
        switch (c.type) {
          case "primary": primaryCount++; break;
          case "official_secondary": officialCount++; break;
          case "third_party": thirdPartyCount++; break;
          case "aggregator": aggregatorCount++; break;
          default: unknownCount++;
        }
      }

      return {
        ...e,
        positiveEvidence: pos,
        negativeEvidence: neg,
        primaryCount,
        officialCount,
        thirdPartyCount,
        aggregatorCount,
        unknownCount,
      };
    });

    return { classifiedEvidence: classified };
  },
};

// noop_terminal — single-purpose script whose only job is to be a real
// stage at the end of a pipeline so a gate can route `approve` to it.
// Continuation 9 (2026-04-29). The 16-stage investigation skeleton's
// `reportJudgeGate` needs an approve route that is the pipeline's
// terminal — but kernel-next's gate-routing schema requires every route
// to name a real stage (no `"terminal"` sentinel). Pointing approve
// back to an upstream stage like `reportAssembly` would re-execute it,
// wasting work. `noop_terminal` is the canonical solution: a one-line
// script that returns `{ done: true }`. Multiple pipelines may use the
// same builtin id without conflict.
//
// Inputs: any (ignored).
// Output: { done: true }.
const noop_terminal: ScriptModule = {
  // The literal `done: true` is the only output port a pipeline using
  // this stage needs to declare; other input wires (the report markdown,
  // the judge audit JSON) flow into the stage but don't need to be
  // re-emitted — the stage exists for routing, not for transformation.
  // eslint-disable-next-line @typescript-eslint/require-await
  async run() {
    return { done: true };
  },
};

// merge_tutorials — D1 (c12, 2026-04-30). Concatenate cached and freshly
// authored tutorial parallel-arrays into one merged set. Pure transform
// (no DB), so it lives here rather than in tutorial-cache.ts.
//
// Inputs:
//   cachedSlugs, cachedContents (parallel arrays from lookup_tutorial_cache)
//   freshSlugs,  freshContents  (parallel arrays — fanout aggregate of
//                                tutorialAuthoring.slug + .markdown)
// Outputs:
//   slugs, contents (cached then fresh, parallel-array concat)
const merge_tutorials: ScriptModule = {
  // eslint-disable-next-line @typescript-eslint/require-await
  async run(inputs) {
    const cachedSlugs = (inputs.cachedSlugs ?? []) as unknown[];
    const cachedContents = (inputs.cachedContents ?? []) as unknown[];
    const freshSlugs = (inputs.freshSlugs ?? []) as unknown[];
    const freshContents = (inputs.freshContents ?? []) as unknown[];

    if (!Array.isArray(cachedSlugs) || !Array.isArray(cachedContents)
        || !Array.isArray(freshSlugs) || !Array.isArray(freshContents)) {
      throw new Error("merge_tutorials: all inputs must be arrays");
    }
    if (cachedSlugs.length !== cachedContents.length) {
      throw new Error(
        `merge_tutorials: cached parallel-array length mismatch ` +
        `(${cachedSlugs.length}/${cachedContents.length})`,
      );
    }
    if (freshSlugs.length !== freshContents.length) {
      throw new Error(
        `merge_tutorials: fresh parallel-array length mismatch ` +
        `(${freshSlugs.length}/${freshContents.length})`,
      );
    }

    return {
      slugs: [...cachedSlugs, ...freshSlugs],
      contents: [...cachedContents, ...freshContents],
    };
  },
};

// ---------- registry ----------

export const BUILTIN_SCRIPT_MODULES: Readonly<Record<string, ScriptModule>> = Object.freeze({
  http_fetch,
  http_request,
  read_file,
  write_file,
  path_expand,
  path_join,
  json_parse,
  json_stringify,
  env_resolve,
  validate_patch_vs_intent,
  classify_source_url,
  classify_evidence_bundle,
  noop_terminal,
  validate_and_repair_ir,
  assemble_investigation_ir,
  merge_tutorials,
});

// Continuation 8 (2026-04-29) — `submit_pipeline_passthrough` is a
// builtin module ID but its implementation lives in
// `./submit-pipeline.ts` (factory function bound to db at run time, not
// a stateless module). It's listed here so submit-time validation
// (validator/structural.ts SCRIPT_MODULE_NOT_REGISTERED) accepts it,
// and the actual binding is wired into the resolver in
// runtime/start-pipeline-run.ts.
const FACTORY_SCRIPT_IDS = [
  "submit_pipeline_passthrough",
  // D1 (c12, 2026-04-30) — tutorial cache scripts that need a live db
  // handle. Bound in start-pipeline-run.ts via buildLookupTutorialCache /
  // buildWriteTutorialCache.
  "lookup_tutorial_cache",
  "write_tutorial_cache",
] as const;

export const BUILTIN_SCRIPT_IDS: ReadonlySet<string> = new Set([
  ...Object.keys(BUILTIN_SCRIPT_MODULES),
  ...FACTORY_SCRIPT_IDS,
]);
