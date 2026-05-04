import type { DatabaseSync } from "node:sqlite";
import type { SessionEpisode } from "../types.js";

export function insertEpisode(db: DatabaseSync, ep: SessionEpisode): void {
  db.prepare(
    `INSERT INTO session_episodes
       (episode_id, session_id, start_seq, end_seq, intent, outcome, steps_json, rationale, pipeline_able, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ep.episodeId, ep.sessionId, ep.startSeq, ep.endSeq,
    ep.intent, ep.outcome,
    JSON.stringify(ep.steps),
    ep.rationale,
    ep.pipelineAble ? 1 : 0,
    ep.createdAt,
  );
}

function rowToEpisode(r: Record<string, unknown>): SessionEpisode {
  return {
    episodeId: r.episode_id as string,
    sessionId: r.session_id as string,
    startSeq: r.start_seq as number,
    endSeq: r.end_seq as number,
    intent: r.intent as string,
    outcome: r.outcome as SessionEpisode["outcome"],
    steps: JSON.parse(r.steps_json as string) as SessionEpisode["steps"],
    rationale: r.rationale as string,
    pipelineAble: (r.pipeline_able as number) === 1,
    createdAt: r.created_at as number,
  };
}

export function getEpisode(db: DatabaseSync, episodeId: string): SessionEpisode | null {
  const r = db.prepare(`SELECT * FROM session_episodes WHERE episode_id = ?`).get(episodeId) as
    Record<string, unknown> | undefined;
  return r ? rowToEpisode(r) : null;
}

export function listEpisodesBySession(db: DatabaseSync, sessionId: string): SessionEpisode[] {
  const rows = db.prepare(
    `SELECT * FROM session_episodes WHERE session_id = ? ORDER BY start_seq ASC`,
  ).all(sessionId) as Array<Record<string, unknown>>;
  return rows.map(rowToEpisode);
}

export function listPipelineableEpisodes(db: DatabaseSync, limit = 100): SessionEpisode[] {
  const rows = db.prepare(
    `SELECT * FROM session_episodes WHERE pipeline_able = 1 ORDER BY created_at DESC LIMIT ?`,
  ).all(limit) as Array<Record<string, unknown>>;
  return rows.map(rowToEpisode);
}
