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

export const kernelPipelinesRoute = new Hono();

interface PipelineSummary {
  name: string;
  latestVersion: string;
  latestCreatedAt: number;
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
  const pipelines: PipelineSummary[] = rows.map((r) => ({
    name: r.pipeline_name,
    latestVersion: r.version_hash,
    latestCreatedAt: r.created_at,
  }));
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
