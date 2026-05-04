import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initForgeSchema } from "../db/schema.js";
import { upsertSession } from "../db/sessions.js";
import { insertEpisode, getEpisode, listEpisodesBySession, listPipelineableEpisodes } from "../db/episodes.js";
import type { SessionEpisode } from "../types.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  initForgeSchema(db);
  upsertSession(db, { sessionId: "s1", cwd: "/p", jsonlPath: "/p.jsonl", firstSeenAt: 1, lastEventAt: 1 });
});

function makeEp(overrides: Partial<SessionEpisode> = {}): SessionEpisode {
  return {
    episodeId: overrides.episodeId ?? "e1",
    sessionId: overrides.sessionId ?? "s1",
    startSeq: overrides.startSeq ?? 1,
    endSeq: overrides.endSeq ?? 5,
    intent: overrides.intent ?? "test intent",
    outcome: overrides.outcome ?? "completed",
    steps: overrides.steps ?? [{ stageKind: "agent", description: "step 1" }],
    rationale: overrides.rationale ?? "because",
    pipelineAble: overrides.pipelineAble ?? true,
    createdAt: overrides.createdAt ?? 1000,
  };
}

describe("episodes CRUD", () => {
  it("insert + get round-trips", () => {
    const ep = makeEp();
    insertEpisode(db, ep);
    const got = getEpisode(db, "e1");
    expect(got).not.toBeNull();
    expect(got!.intent).toBe("test intent");
    expect(got!.steps).toEqual([{ stageKind: "agent", description: "step 1" }]);
    expect(got!.pipelineAble).toBe(true);
  });

  it("getEpisode returns null for unknown id", () => {
    expect(getEpisode(db, "ghost")).toBeNull();
  });

  it("listEpisodesBySession orders by start_seq", () => {
    insertEpisode(db, makeEp({ episodeId: "e2", startSeq: 10 }));
    insertEpisode(db, makeEp({ episodeId: "e1", startSeq: 1 }));
    const list = listEpisodesBySession(db, "s1");
    expect(list).toHaveLength(2);
    expect(list[0]!.episodeId).toBe("e1");
    expect(list[1]!.episodeId).toBe("e2");
  });

  it("listPipelineableEpisodes filters and orders by created_at desc", () => {
    insertEpisode(db, makeEp({ episodeId: "e1", createdAt: 1000, pipelineAble: true }));
    insertEpisode(db, makeEp({ episodeId: "e2", createdAt: 2000, pipelineAble: false }));
    insertEpisode(db, makeEp({ episodeId: "e3", createdAt: 1500, pipelineAble: true }));
    const list = listPipelineableEpisodes(db);
    expect(list).toHaveLength(2);
    expect(list[0]!.episodeId).toBe("e3");
    expect(list[1]!.episodeId).toBe("e1");
  });

  it("rejects invalid outcome via CHECK constraint", () => {
    expect(() => insertEpisode(db, makeEp({ outcome: "bogus" as SessionEpisode["outcome"] }))).toThrow();
  });
});
