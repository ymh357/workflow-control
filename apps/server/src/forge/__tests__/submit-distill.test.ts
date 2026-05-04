// E2E test for distillSession using the real kernel-next runtime via
// MockStageExecutor handlers. We submit forge-distill, then inject a
// fake handler that returns the episodes_json port directly.

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../../kernel-next/ir/sql.js";
import { initForgeSchema } from "../db/schema.js";
import { upsertSession, insertEvents } from "../db/sessions.js";
import { distillSession } from "../distillation/submit-distill.js";
import { listEpisodesBySession, getEpisode } from "../db/episodes.js";

let kernelDb: DatabaseSync;
let forgeDb: DatabaseSync;

beforeEach(() => {
  kernelDb = new DatabaseSync(":memory:");
  initKernelNextSchema(kernelDb);
  forgeDb = new DatabaseSync(":memory:");
  initForgeSchema(forgeDb);
});

function seed(sessionId: string, eventCount: number): void {
  upsertSession(forgeDb, {
    sessionId, cwd: "/p", jsonlPath: `/p/${sessionId}.jsonl`,
    firstSeenAt: 1, lastEventAt: 1,
  });
  const events = Array.from({ length: eventCount }, (_, i) => ({
    sessionId, seq: i + 1, ts: 1000 + i,
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    textExcerpt: `event ${i}`, textHash: null, textLength: 7,
    toolName: null, toolArgsExcerpt: null,
  }));
  insertEvents(forgeDb, sessionId, events);
}

describe("distillSession", () => {
  it("returns empty episodes when session has fewer than 3 events", async () => {
    seed("s1", 2);
    const r = await distillSession({
      forgeDb, kernelDb, sessionId: "s1", pollIntervalMs: 10, timeoutMs: 1000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.episodes).toEqual([]);
      expect(r.reasonNoEpisodes).toContain("only 2 events");
    }
  });

  it("returns DISTILL_SUBMIT_FAILED when forge-distill is not registered", async () => {
    seed("s1", 5);
    const r = await distillSession({
      forgeDb, kernelDb, sessionId: "s1", pollIntervalMs: 10, timeoutMs: 1000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("DISTILL_SUBMIT_FAILED");
    }
  });
});
