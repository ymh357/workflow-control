import { describe, it, expect } from "vitest";
import { ProposalsBroadcaster, type ProposalEvent } from "./proposals-broadcaster.js";

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
      status: "pending",
      createdAt: Date.now(),
    },
  };
}

describe("ProposalsBroadcaster", () => {
  it("replays existing history synchronously to a new subscriber", () => {
    const b = new ProposalsBroadcaster();
    b.publish(mkEvent("p1"));
    b.publish(mkEvent("p2"));
    const received: string[] = [];
    b.subscribe((e) => received.push(e.data.proposalId));
    expect(received).toEqual(["p1", "p2"]);
  });

  it("delivers new publishes live to every subscriber", () => {
    const b = new ProposalsBroadcaster();
    const a: string[] = [];
    const c: string[] = [];
    b.subscribe((e) => a.push(e.data.proposalId));
    b.subscribe((e) => c.push(e.data.proposalId));
    b.publish(mkEvent("x"));
    expect(a).toEqual(["x"]);
    expect(c).toEqual(["x"]);
  });

  it("honours historyLimit — oldest dropped on overflow", () => {
    const b = new ProposalsBroadcaster({ historyLimit: 2 });
    b.publish(mkEvent("a"));
    b.publish(mkEvent("b"));
    b.publish(mkEvent("c"));
    const snap = b.historySnapshot();
    expect(snap.map((e) => e.data.proposalId)).toEqual(["b", "c"]);
  });

  it("unsubscribe stops further delivery", () => {
    const b = new ProposalsBroadcaster();
    const received: string[] = [];
    const unsub = b.subscribe((e) => received.push(e.data.proposalId));
    b.publish(mkEvent("1"));
    unsub();
    b.publish(mkEvent("2"));
    expect(received).toEqual(["1"]);
  });

  it("swallows listener errors so a broken consumer cannot stop publish", () => {
    const b = new ProposalsBroadcaster();
    b.subscribe(() => { throw new Error("boom"); });
    const ok: string[] = [];
    b.subscribe((e) => ok.push(e.data.proposalId));
    b.publish(mkEvent("z"));
    expect(ok).toEqual(["z"]);
  });
});
