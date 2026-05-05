// CRUD for forge_analyses — the per-analysis handle table.
//
// Why this table exists: the public API for async analyze takes
// `analysisId` and reconstructs the in-flight handle (sessionId,
// jsonlPath, taskId, truncated, optional empty-result cache). The
// previous implementation encoded all of that into a base64url blob
// and called *that* the analysisId — a 600-1200 char string that's
// hostile to copy-paste / debug logs.
//
// Now `analysis_id` IS the kernel-next taskId (~45 chars), and this
// table holds the rest server-side. The empty-session path uses a
// synthetic taskId (no kernel task spawned) and stores the pre-baked
// `empty_result_json` row instead.

import type { DatabaseSync } from "node:sqlite";
import type { SessionEpisode } from "../types.js";

export interface AnalysisHandleRow {
  analysisId: string;
  sessionId: string;
  jsonlPath: string;
  taskId: string;
  truncated: boolean;
  startedAt: number;
  emptyResult: { episodes: SessionEpisode[]; reasonNoEpisodes: string } | null;
}

export interface InsertAnalysisArgs {
  analysisId: string;
  sessionId: string;
  jsonlPath: string;
  taskId: string;
  truncated: boolean;
  startedAt: number;
  emptyResult?: { episodes: SessionEpisode[]; reasonNoEpisodes: string };
}

export function insertAnalysis(db: DatabaseSync, args: InsertAnalysisArgs): void {
  db.prepare(
    `INSERT OR REPLACE INTO forge_analyses
       (analysis_id, session_id, jsonl_path, task_id, truncated, started_at, empty_result_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.analysisId,
    args.sessionId,
    args.jsonlPath,
    args.taskId,
    args.truncated ? 1 : 0,
    args.startedAt,
    args.emptyResult ? JSON.stringify(args.emptyResult) : null,
  );
}

export function getAnalysis(db: DatabaseSync, analysisId: string): AnalysisHandleRow | null {
  const row = db.prepare(
    `SELECT * FROM forge_analyses WHERE analysis_id = ?`,
  ).get(analysisId) as Record<string, unknown> | undefined;
  if (!row) return null;
  let emptyResult: AnalysisHandleRow["emptyResult"] = null;
  const raw = row.empty_result_json;
  if (typeof raw === "string" && raw.length > 0) {
    try {
      emptyResult = JSON.parse(raw) as AnalysisHandleRow["emptyResult"];
    } catch {
      emptyResult = null;
    }
  }
  return {
    analysisId: row.analysis_id as string,
    sessionId: row.session_id as string,
    jsonlPath: row.jsonl_path as string,
    taskId: row.task_id as string,
    truncated: (row.truncated as number) === 1,
    startedAt: row.started_at as number,
    emptyResult,
  };
}
