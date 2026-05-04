import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../../kernel-next/ir/sql.js";
import { initForgeSchema } from "../db/schema.js";
import { upsertSession, insertEvents } from "../db/sessions.js";
import { insertEpisode } from "../db/episodes.js";
import { buildForgeRoute } from "../api/routes.js";

let kernelDb: DatabaseSync;
let forgeDb: DatabaseSync;

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api", buildForgeRoute({ forgeDb, kernelDb, projectsRoot: "/nonexistent" }));
  return app;
}

beforeEach(() => {
  kernelDb = new DatabaseSync(":memory:");
  initKernelNextSchema(kernelDb);
  forgeDb = new DatabaseSync(":memory:");
  initForgeSchema(forgeDb);
});

describe("GET /api/forge/health", () => {
  it("returns mode=manual", async () => {
    const res = await buildApp().fetch(new Request("http://t/api/forge/health"));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; mode: string };
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("manual");
  });
});

describe("GET /api/forge/sessions", () => {
  it("returns empty list initially", async () => {
    const res = await buildApp().fetch(new Request("http://t/api/forge/sessions"));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; sessions: unknown[] };
    expect(body.sessions).toEqual([]);
  });

  it("returns existing sessions ordered by lastEventAt desc", async () => {
    upsertSession(forgeDb, { sessionId: "s1", cwd: "/a", jsonlPath: "/a/s1.jsonl", firstSeenAt: 100, lastEventAt: 200 });
    upsertSession(forgeDb, { sessionId: "s2", cwd: "/b", jsonlPath: "/b/s2.jsonl", firstSeenAt: 100, lastEventAt: 300 });
    const res = await buildApp().fetch(new Request("http://t/api/forge/sessions"));
    const body = await res.json() as { ok: boolean; sessions: Array<{ sessionId: string }> };
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions[0]!.sessionId).toBe("s2");
  });

  it("respects limit query param", async () => {
    for (let i = 0; i < 5; i++) {
      upsertSession(forgeDb, { sessionId: `s${i}`, cwd: "/a", jsonlPath: `/a/s${i}.jsonl`, firstSeenAt: i, lastEventAt: i });
    }
    const res = await buildApp().fetch(new Request("http://t/api/forge/sessions?limit=2"));
    const body = await res.json() as { sessions: unknown[] };
    expect(body.sessions).toHaveLength(2);
  });
});

describe("GET /api/forge/sessions/:sessionId", () => {
  it("404 on unknown session", async () => {
    const res = await buildApp().fetch(new Request("http://t/api/forge/sessions/ghost"));
    expect(res.status).toBe(404);
  });

  it("returns session + episodes", async () => {
    upsertSession(forgeDb, { sessionId: "s1", cwd: "/a", jsonlPath: "/a/s1.jsonl", firstSeenAt: 100, lastEventAt: 200 });
    insertEpisode(forgeDb, {
      episodeId: "e1", sessionId: "s1", startSeq: 1, endSeq: 5,
      intent: "test", outcome: "completed", steps: [], rationale: "r", pipelineAble: true, createdAt: 1,
    });
    const res = await buildApp().fetch(new Request("http://t/api/forge/sessions/s1"));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; session: { sessionId: string }; episodes: Array<{ episodeId: string }> };
    expect(body.session.sessionId).toBe("s1");
    expect(body.episodes).toHaveLength(1);
    expect(body.episodes[0]!.episodeId).toBe("e1");
  });
});

describe("GET /api/forge/episodes/:episodeId", () => {
  it("404 on unknown episode", async () => {
    const res = await buildApp().fetch(new Request("http://t/api/forge/episodes/ghost"));
    expect(res.status).toBe(404);
  });

  it("returns episode by id", async () => {
    upsertSession(forgeDb, { sessionId: "s1", cwd: "/a", jsonlPath: "/a/s1.jsonl", firstSeenAt: 100, lastEventAt: 200 });
    insertEpisode(forgeDb, {
      episodeId: "e1", sessionId: "s1", startSeq: 1, endSeq: 5,
      intent: "the intent", outcome: "completed", steps: [], rationale: "r", pipelineAble: true, createdAt: 1,
    });
    const res = await buildApp().fetch(new Request("http://t/api/forge/episodes/e1"));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; episode: { intent: string } };
    expect(body.episode.intent).toBe("the intent");
  });
});

describe("POST /api/forge/analyze", () => {
  it("rejects malformed JSON body with INVALID_JSON_BODY", async () => {
    const res = await buildApp().fetch(new Request("http://t/api/forge/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("INVALID_JSON_BODY");
  });

  it("returns NO_SESSION_FOUND when projects-root has no sessions and body empty", async () => {
    const res = await buildApp().fetch(new Request("http://t/api/forge/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { kind: string; code: string };
    expect(body.kind).toBe("error");
    expect(body.code).toBe("NO_SESSION_FOUND");
  });
});
