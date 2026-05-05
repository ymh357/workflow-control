// HTTP API for Forge.
//
//   POST /api/forge/analyze            — sync entry (web UI; blocks 60-180s)
//   POST /api/forge/analyze/start      — async start; returns analysisId in <1s
//   GET  /api/forge/analyze/result?id=  — poll for completion (returns running OR final)
//   GET  /api/forge/sessions           — debug list
//   GET  /api/forge/episodes/:id       — single episode detail
//   GET  /api/forge/health             — health (returns "manual" mode)

import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { analyze, analyzeStart, analyzeHarvest } from "./analyze-handler.js";
import { listAllSessions, getSession } from "../db/sessions.js";
import { getEpisode, listEpisodesBySession } from "../db/episodes.js";
import type { AnalyzeRequest } from "./types.js";

export interface ForgeRouteDeps {
  forgeDb: DatabaseSync;
  kernelDb: DatabaseSync;
  projectsRoot?: string;
}

export function buildForgeRoute(deps: ForgeRouteDeps): Hono {
  const route = new Hono();

  route.post("/forge/analyze", async (c) => {
    let body: AnalyzeRequest = {};
    try {
      const raw = await c.req.text();
      if (raw.trim().length > 0) body = JSON.parse(raw) as AnalyzeRequest;
    } catch {
      return c.json({ kind: "error", code: "INVALID_JSON_BODY", message: "request body is not valid JSON" }, 400);
    }
    const result = await analyze({
      forgeDb: deps.forgeDb, kernelDb: deps.kernelDb, projectsRoot: deps.projectsRoot,
    }, body);
    if (result.kind === "error") return c.json(result, 400);
    return c.json(result, 200);
  });

  route.post("/forge/analyze/start", async (c) => {
    let body: AnalyzeRequest = {};
    try {
      const raw = await c.req.text();
      if (raw.trim().length > 0) body = JSON.parse(raw) as AnalyzeRequest;
    } catch {
      return c.json({ kind: "error", code: "INVALID_JSON_BODY", message: "request body is not valid JSON" }, 400);
    }
    const result = await analyzeStart({
      forgeDb: deps.forgeDb, kernelDb: deps.kernelDb, projectsRoot: deps.projectsRoot,
    }, body);
    if (result.kind === "error") return c.json(result, 400);
    return c.json(result, 200);
  });

  route.get("/forge/analyze/result", async (c) => {
    const analysisId = c.req.query("id");
    if (!analysisId) {
      return c.json({ kind: "error", code: "MISSING_ANALYSIS_ID", message: "query param 'id' is required" }, 400);
    }
    const result = await analyzeHarvest({
      forgeDb: deps.forgeDb, kernelDb: deps.kernelDb, projectsRoot: deps.projectsRoot,
    }, analysisId);
    if (result.kind === "error") return c.json(result, 400);
    return c.json(result, 200);
  });

  route.get("/forge/sessions", (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
    const sessions = listAllSessions(deps.forgeDb, limit);
    return c.json({ ok: true, sessions });
  });

  route.get("/forge/sessions/:sessionId", (c) => {
    const sid = c.req.param("sessionId");
    const session = getSession(deps.forgeDb, sid);
    if (!session) return c.json({ ok: false, code: "SESSION_NOT_FOUND" }, 404);
    const episodes = listEpisodesBySession(deps.forgeDb, sid);
    return c.json({ ok: true, session, episodes });
  });

  route.get("/forge/episodes/:episodeId", (c) => {
    const eid = c.req.param("episodeId");
    const ep = getEpisode(deps.forgeDb, eid);
    if (!ep) return c.json({ ok: false, code: "EPISODE_NOT_FOUND" }, 404);
    return c.json({ ok: true, episode: ep });
  });

  route.get("/forge/health", (c) => {
    return c.json({
      ok: true,
      mode: "manual",
      info: "Forge runs request-scoped on POST /api/forge/analyze. No background daemon.",
    });
  });

  return route;
}
