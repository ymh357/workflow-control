// SSE stream route test. Connects, drives publish events, verifies
// the ReadableStream yields SSE frames carrying proposal_* types.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { ProposalsBroadcaster, type ProposalEvent } from "../kernel-next/sse/proposals-broadcaster.js";
import {
  kernelProposalsStreamRoute,
  __setProposalsBroadcasterForStreamTest,
} from "./kernel-proposals-stream.js";

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api", kernelProposalsStreamRoute);
  return app;
}

function mkEvent(id: string, type: ProposalEvent["type"] = "proposal_created"): ProposalEvent {
  return {
    type,
    timestamp: new Date().toISOString(),
    data: {
      proposalId: id,
      pipelineName: "demo",
      baseVersion: "bv",
      proposedVersion: "pv",
      actor: "u",
      status: type === "proposal_approved" ? "approved" : type === "proposal_rejected" ? "rejected" : "pending",
      createdAt: Date.now(),
    },
  };
}

describe("GET /api/kernel/proposals/stream", () => {
  let broadcaster: ProposalsBroadcaster;

  beforeEach(() => {
    broadcaster = new ProposalsBroadcaster();
    __setProposalsBroadcasterForStreamTest(broadcaster);
  });

  afterEach(() => {
    __setProposalsBroadcasterForStreamTest(undefined);
  });

  it("responds 200 with text/event-stream headers", async () => {
    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/proposals/stream"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    // Fully drain so the Node runtime teardown isn't blocked on an
    // orphan heartbeat interval; we cancel via reader below.
    const reader = res.body!.getReader();
    await reader.cancel();
  });

  it("replays history on connect + delivers live events", async () => {
    broadcaster.publish(mkEvent("p1"));
    broadcaster.publish(mkEvent("p2", "proposal_approved"));

    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/proposals/stream"));
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Collect enough bytes to see history replay.
    let seen = "";
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      const r = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((res) => setTimeout(() => res({ done: true, value: undefined }), 100)),
      ]);
      if (r.done) break;
      seen += decoder.decode(r.value);
      if (seen.includes("p1") && seen.includes("p2")) break;
    }

    expect(seen).toContain("event: proposal_created");
    expect(seen).toContain("event: proposal_approved");
    expect(seen).toContain(`"proposalId":"p1"`);
    expect(seen).toContain(`"proposalId":"p2"`);

    // Live event after connection already open.
    broadcaster.publish(mkEvent("p3", "proposal_rejected"));
    const tail = Date.now() + 300;
    while (Date.now() < tail) {
      const r = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((res) => setTimeout(() => res({ done: true, value: undefined }), 100)),
      ]);
      if (r.done) break;
      seen += decoder.decode(r.value);
      if (seen.includes("p3")) break;
    }
    expect(seen).toContain("event: proposal_rejected");
    expect(seen).toContain(`"proposalId":"p3"`);

    await reader.cancel();
  });
});
