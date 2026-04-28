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

// http_fetch — GET a URL, optionally with headers. Body returned as string
// (UTF-8 decoded) plus numeric status and response headers. No retry loop;
// callers that need retries wrap in a gate or a regenerate-friendly agent.
const http_fetch: ScriptModule = {
  async run(inputs, ctx) {
    const rawUrl = requireString(inputs, "url");
    const url = expandPlaceholders(rawUrl, ctx.env);
    const headersIn = optionalRecord(inputs, "headers") ?? {};
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(headersIn)) {
      if (typeof v !== "string") {
        throw new Error(`headers.${k} must be a string (got ${typeof v})`);
      }
      headers[k] = expandPlaceholders(v, ctx.env);
    }
    const res = await fetch(url, { method: "GET", headers });
    const body = await res.text();
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => { respHeaders[k] = v; });
    return {
      status: res.status,
      ok: res.ok,
      body,
      headers: respHeaders,
    };
  },
};

// http_request — arbitrary method + body. Body is stringified JSON when
// the input is an object; string passthrough otherwise.
const http_request: ScriptModule = {
  async run(inputs, ctx) {
    const rawUrl = requireString(inputs, "url");
    const url = expandPlaceholders(rawUrl, ctx.env);
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
    const res = await fetch(url, { method, headers, body });
    const respText = await res.text();
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => { respHeaders[k] = v; });
    return {
      status: res.status,
      ok: res.ok,
      body: respText,
      headers: respHeaders,
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
});

export const BUILTIN_SCRIPT_IDS: ReadonlySet<string> = new Set(
  Object.keys(BUILTIN_SCRIPT_MODULES),
);
