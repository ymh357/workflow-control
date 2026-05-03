// Read-only inventory for the propose UI. Two endpoints:
//   GET /api/kernel/pipelines             — one row per pipeline name,
//                                           with its latest version
//   GET /api/kernel/pipelines/:versionHash — the IR + prompts map for
//                                            a specific version, for
//                                            the editor page
//
// Both are local, single-user, unauthenticated — same posture as the
// rest of kernel-next HTTP.

import { Hono } from "hono";
import { getKernelNextDb } from "../lib/kernel-next-db.js";
import { getPipelineIR, getPromptsByVersion } from "../kernel-next/ir/sql.js";
import { buildEnvelope } from "../kernel-next/ir/export-envelope.js";

export const kernelPipelinesRoute = new Hono();

function sanitizeFilenameSegment(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "pipeline";
}

interface PipelineSummary {
  name: string;
  latestVersion: string;
  latestCreatedAt: number;
  // 2026-04-27 B5: enriched fields for the web quick-launcher.
  // externalInputs lets the UI render a typed form without a second
  // round-trip. envKeys aggregates every distinct envKey declared
  // across all stages, so the launcher can show which secrets the
  // pipeline will need (without leaking any values).
  externalInputs: Array<{ name: string; type: string }>;
  envKeys: string[];
}

kernelPipelinesRoute.get("/kernel/pipelines", (c) => {
  const db = getKernelNextDb();
  // One row per pipeline_name with its newest version. We pull the
  // latest via correlated subquery rather than GROUP BY+MAX so we get
  // the version_hash that corresponds to MAX(created_at), not the
  // "any" version_hash a plain GROUP BY would return alongside the
  // aggregate.
  const rows = db.prepare(
    `SELECT pv.pipeline_name, pv.version_hash, pv.created_at
     FROM pipeline_versions pv
     WHERE pv.created_at = (
       SELECT MAX(created_at) FROM pipeline_versions
       WHERE pipeline_name = pv.pipeline_name
     )
     ORDER BY pv.pipeline_name ASC`,
  ).all() as Array<{ pipeline_name: string; version_hash: string; created_at: number }>;
  const pipelines: PipelineSummary[] = rows.map((r) => {
    const ir = getPipelineIR(db, r.version_hash);
    const externalInputs = ir?.externalInputs?.map((p) => ({ name: p.name, type: p.type })) ?? [];
    const envKeys = new Set<string>();
    for (const stage of ir?.stages ?? []) {
      if (stage.type === "agent" && stage.config.mcpServers) {
        for (const m of stage.config.mcpServers) {
          for (const k of m.envKeys ?? []) envKeys.add(k);
        }
      }
    }
    return {
      name: r.pipeline_name,
      latestVersion: r.version_hash,
      latestCreatedAt: r.created_at,
      externalInputs,
      envKeys: Array.from(envKeys).sort(),
    };
  });
  return c.json({ ok: true, pipelines });
});

kernelPipelinesRoute.get("/kernel/pipelines/:versionHash", (c) => {
  const hash = c.req.param("versionHash");
  const db = getKernelNextDb();
  const ir = getPipelineIR(db, hash);
  if (ir === null) {
    return c.json({
      ok: false,
      diagnostics: [{
        code: "VERSION_NOT_FOUND",
        message: `pipeline version '${hash}' not found`,
        context: { versionHash: hash },
      }],
    }, 404);
  }
  const prompts = getPromptsByVersion(db, hash);
  // parent_hash + created_at come from the same row we already know
  // exists via getPipelineIR. Fetch them here so the UI can show
  // provenance without a second round-trip.
  const meta = db.prepare(
    `SELECT parent_hash, created_at FROM pipeline_versions WHERE version_hash = ?`,
  ).get(hash) as { parent_hash: string | null; created_at: number } | undefined;
  return c.json({
    ok: true,
    ir,
    prompts,
    parentHash: meta?.parent_hash ?? null,
    createdAt: meta?.created_at ?? 0,
  });
});

// 2026-04-27 — env probe for the launcher: tells the UI which of the
// supplied envKeys are already visible to the server's process.env so
// the user can leave those password fields blank with confidence. Only
// returns key NAMES + a boolean `present`; values never leave the
// server. POST so the keys travel in the body (not a query string).
//
// Request:  POST /api/kernel/pipelines/env-probe   { envKeys: string[] }
// Response: { ok: true, status: { GITHUB_TOKEN: true, FOO: false, ... } }
kernelPipelinesRoute.post("/kernel/pipelines/env-probe", async (c) => {
  const raw = await c.req.text();
  let body: unknown = {};
  if (raw.trim().length > 0) {
    try { body = JSON.parse(raw); }
    catch {
      return c.json({
        ok: false,
        diagnostics: [{ code: "INVALID_JSON_BODY", message: "invalid JSON body" }],
      }, 400);
    }
  }
  const keys = (body as { envKeys?: unknown }).envKeys;
  if (!Array.isArray(keys) || !keys.every((k): k is string => typeof k === "string" && k.length > 0)) {
    return c.json({
      ok: false,
      diagnostics: [{
        code: "INVALID_REQUEST_BODY",
        message: "envKeys must be a non-empty array of strings",
      }],
    }, 400);
  }
  const status: Record<string, boolean> = {};
  for (const k of keys) {
    const v = process.env[k];
    status[k] = typeof v === "string" && v.length > 0;
  }
  return c.json({ ok: true, status });
});

// Cross-user sharing v1: returns a self-contained JSON envelope wrapping
// the version's IR + prompts + provenance. The receiving machine pipes
// it through POST /import, which routes to KernelService.submit.
kernelPipelinesRoute.get("/kernel/pipelines/:versionHash/export", (c) => {
  const hash = c.req.param("versionHash");
  const db = getKernelNextDb();
  const ir = getPipelineIR(db, hash);
  if (ir === null) {
    return c.json({
      ok: false,
      diagnostics: [{
        code: "VERSION_NOT_FOUND",
        message: `pipeline version '${hash}' not found`,
        context: { versionHash: hash },
      }],
    }, 404);
  }
  const prompts = getPromptsByVersion(db, hash);
  const meta = db.prepare(
    `SELECT pipeline_name, parent_hash, created_at
     FROM pipeline_versions WHERE version_hash = ?`,
  ).get(hash) as
    | { pipeline_name: string; parent_hash: string | null; created_at: number }
    | undefined;
  if (!meta) {
    return c.json({
      ok: false,
      diagnostics: [{
        code: "VERSION_NOT_FOUND",
        message: `pipeline version '${hash}' not found`,
        context: { versionHash: hash },
      }],
    }, 404);
  }
  const envelope = buildEnvelope({
    pipelineName: meta.pipeline_name,
    versionHash: hash,
    parentHash: meta.parent_hash,
    createdAt: meta.created_at,
    ir,
    prompts,
  });
  const safeName = sanitizeFilenameSegment(meta.pipeline_name);
  const shortHash = hash.slice(0, 8);
  const filename = `${safeName}-${shortHash}.wfctl.json`;
  return new Response(JSON.stringify(envelope, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
});
