// A2.1 — pure AgentMachine tests. No SDK, no DB. Drive events directly,
// assert state transitions and final output per design doc §4.2.

import { describe, it, expect } from "vitest";
import { createActor, waitFor } from "xstate";
import { createAgentMachine, type AgentMachineOutput } from "./agent-machine.js";

// A2.3.1 — machine now declares `input: AgentMachineInput | undefined` so
// every createActor call must pass an `input` option (undefined is valid).
// Legacy tests use undefined; the dedicated correlation-id suite below
// exercises the non-undefined path.
function start() {
  const actor = createActor(createAgentMachine(), { input: undefined });
  actor.start();
  return actor;
}

async function runToFinal(actor: ReturnType<typeof start>): Promise<AgentMachineOutput> {
  const snap = await waitFor(actor, (s) => s.status === "done", { timeout: 1000 });
  return snap.output as AgentMachineOutput;
}

describe("AgentMachine — happy path", () => {
  it("starts in 'starting'; SDK_INIT → waiting_for_claude", () => {
    const a = start();
    expect(a.getSnapshot().value).toBe("starting");
    a.send({ type: "SDK_INIT" });
    expect(a.getSnapshot().value).toBe("waiting_for_claude");
    expect(a.getSnapshot().context.turns).toBe(1);
  });

  it("single tool round trip returns to waiting_for_claude", () => {
    const a = start();
    a.send({ type: "SDK_INIT" });
    a.send({ type: "TOOL_USE_REQUESTED", id: "t1", name: "write_port", input: {} });
    expect(a.getSnapshot().value).toBe("dispatching_tool");
    a.send({ type: "TOOL_RESULT_RECEIVED", id: "t1" });
    expect(a.getSnapshot().value).toBe("waiting_for_claude");
    expect(a.getSnapshot().context.pendingToolUseIds).toEqual([]);
  });

  it("observed-template flow: init → (tool→result)×3 → text → success → done", async () => {
    const a = start();
    a.send({ type: "SDK_INIT" });
    for (const id of ["w1", "w2", "w3"]) {
      a.send({ type: "TOOL_USE_REQUESTED", id, name: "write_port", input: {} });
      a.send({ type: "TOOL_RESULT_RECEIVED", id });
    }
    a.send({ type: "ASSISTANT_TEXT" });
    a.send({ type: "RESULT_SUCCESS", cost_usd: 0.012, num_turns: 5 });
    const out = await runToFinal(a);
    expect(out.status).toBe("done");
    expect(out.turns).toBeGreaterThanOrEqual(1);
  });

  it("RATE_LIMIT_SIGNAL is a no-op in every state", () => {
    const a = start();
    a.send({ type: "RATE_LIMIT_SIGNAL", utilization: 0.5 });
    expect(a.getSnapshot().value).toBe("starting");
    a.send({ type: "SDK_INIT" });
    a.send({ type: "RATE_LIMIT_SIGNAL", utilization: 0.7 });
    expect(a.getSnapshot().value).toBe("waiting_for_claude");
    a.send({ type: "TOOL_USE_REQUESTED", id: "t1", name: "x", input: {} });
    a.send({ type: "RATE_LIMIT_SIGNAL" });
    expect(a.getSnapshot().value).toBe("dispatching_tool");
  });
});

describe("AgentMachine — compact", () => {
  it("compact_boundary → compacting; COMPACT_ENDED → waiting_for_claude", () => {
    const a = start();
    a.send({ type: "SDK_INIT" });
    a.send({ type: "COMPACT_STARTED", trigger: "auto", pre_tokens: 12345 });
    expect(a.getSnapshot().value).toBe("compacting");
    expect(a.getSnapshot().context.compactMetadata).toEqual({ trigger: "auto", pre_tokens: 12345 });
    a.send({ type: "COMPACT_ENDED" });
    expect(a.getSnapshot().value).toBe("waiting_for_claude");
    expect(a.getSnapshot().context.compactMetadata).toBeNull();
  });

  it("RESULT during compacting finalises; compactMetadata cleared", async () => {
    const a = start();
    a.send({ type: "SDK_INIT" });
    a.send({ type: "COMPACT_STARTED", trigger: "manual", pre_tokens: 1 });
    a.send({ type: "RESULT_SUCCESS" });
    const out = await runToFinal(a);
    expect(out.status).toBe("done");
    expect(a.getSnapshot().context.compactMetadata).toBeNull();
  });
});

describe("AgentMachine — errors", () => {
  it("RESULT_ERROR transitions to error with diagnostic in output", async () => {
    const a = start();
    a.send({ type: "SDK_INIT" });
    a.send({
      type: "RESULT_ERROR",
      subtype: "error_max_turns",
      message: "ran out of turns",
    });
    const snap = await waitFor(a, (s) => s.status === "done", { timeout: 1000 });
    expect(snap.value).toBe("error");
    const out = snap.output as AgentMachineOutput;
    expect(out.status).toBe("error");
    expect(out.diagnostic).toEqual({ subtype: "error_max_turns", message: "ran out of turns" });
  });

  it("RESULT_ERROR during dispatching_tool is honored (error during execution)", async () => {
    const a = start();
    a.send({ type: "SDK_INIT" });
    a.send({ type: "TOOL_USE_REQUESTED", id: "t1", name: "x", input: {} });
    a.send({ type: "RESULT_ERROR", subtype: "error_during_execution", message: "boom" });
    const snap = await waitFor(a, (s) => s.status === "done", { timeout: 1000 });
    expect(snap.value).toBe("error");
  });
});

describe("AgentMachine — INTERRUPT (§4.2)", () => {
  it("from starting: immediate done with interrupted", async () => {
    const a = start();
    a.send({ type: "INTERRUPT" });
    const out = await runToFinal(a);
    expect(out.status).toBe("interrupted");
    expect(out.interruptedFrom).toBe("starting");
  });

  it("from waiting_for_claude: armed; next re-entry to waiting finalises", async () => {
    const a = start();
    a.send({ type: "SDK_INIT" });
    a.send({ type: "INTERRUPT" });
    // Still in waiting_for_claude (summary-turn slot); INTERRUPT armed.
    expect(a.getSnapshot().value).toBe("waiting_for_claude");
    expect(a.getSnapshot().context.interruptArmed).toBe(true);
    // The "summary turn" — one more tool round trip then the next time we
    // bounce through waiting, the armed flag fires.
    a.send({ type: "TOOL_USE_REQUESTED", id: "t1", name: "x", input: {} });
    a.send({ type: "TOOL_RESULT_RECEIVED", id: "t1" });
    const out = await runToFinal(a);
    expect(out.status).toBe("interrupted");
    expect(out.interruptedFrom).toBe("waiting_for_claude");
  });

  it("from dispatching_tool: deferred; tool completes then interrupt fires", async () => {
    const a = start();
    a.send({ type: "SDK_INIT" });
    a.send({ type: "TOOL_USE_REQUESTED", id: "t1", name: "x", input: {} });
    a.send({ type: "INTERRUPT" });
    // Still dispatching — do NOT abort mid-tool.
    expect(a.getSnapshot().value).toBe("dispatching_tool");
    a.send({ type: "TOOL_RESULT_RECEIVED", id: "t1" });
    // Now re-entered waiting; armed interrupt fires via `always`.
    const out = await runToFinal(a);
    expect(out.status).toBe("interrupted");
  });

  it("a RESULT_SUCCESS after an INTERRUPT still wins (the summary turn landed)", async () => {
    const a = start();
    a.send({ type: "SDK_INIT" });
    a.send({ type: "INTERRUPT" });
    // Before the `always` could fire (it only fires on re-entry), the agent
    // hands us a successful result. That's acceptance of the summary turn.
    // In our machine, arming-on-waiting means the very next `entry` to
    // waiting_for_claude flips. We haven't re-entered yet — we're still in
    // the same waiting. RESULT_SUCCESS from waiting_for_claude transitions
    // to done with status='done'.
    a.send({ type: "RESULT_SUCCESS" });
    const out = await runToFinal(a);
    expect(out.status).toBe("done");
  });
});

// A2.3.1 — XState `input` wiring. These tests lock the contract that the
// machine accepts an AgentMachineInput (stageName/taskId/attemptId/label)
// and passes it through context → output so a parent TaskMachine's
// `invoke.onDone` can correlate the final output with the attempt it
// started. Without input the machine still works (legacy test path) and
// the output carries empty-string identifiers.
describe("AgentMachine — input → context → output correlation", () => {
  it("input identifiers land in context at actor creation", () => {
    const actor = createActor(createAgentMachine(), {
      input: { stageName: "analysis", taskId: "t-1", attemptId: "a-7", label: "ad-hoc" },
    });
    actor.start();
    const ctx = actor.getSnapshot().context;
    expect(ctx.stageName).toBe("analysis");
    expect(ctx.taskId).toBe("t-1");
    expect(ctx.attemptId).toBe("a-7");
    expect(ctx.label).toBe("ad-hoc");
  });

  it("input identifiers surface on AgentMachineOutput", async () => {
    const actor = createActor(createAgentMachine(), {
      input: { stageName: "build", taskId: "task-9", attemptId: "att-3" },
    });
    actor.start();
    actor.send({ type: "SDK_INIT" });
    actor.send({ type: "RESULT_SUCCESS" });
    const out = await runToFinal(actor);
    expect(out.status).toBe("done");
    expect(out.stageName).toBe("build");
    expect(out.taskId).toBe("task-9");
    expect(out.attemptId).toBe("att-3");
  });

  it("missing input defaults to empty strings (legacy createActor path)", async () => {
    const a = start();
    a.send({ type: "SDK_INIT" });
    a.send({ type: "RESULT_SUCCESS" });
    const out = await runToFinal(a);
    expect(out.stageName).toBe("");
    expect(out.taskId).toBe("");
    expect(out.attemptId).toBe("");
  });
});

describe("AgentMachine — pending tool queue", () => {
  it("multiple tool_use in one assistant message queue up", () => {
    const a = start();
    a.send({ type: "SDK_INIT" });
    a.send({ type: "TOOL_USE_REQUESTED", id: "a", name: "f", input: {} });
    a.send({ type: "TOOL_USE_REQUESTED", id: "b", name: "f", input: {} });
    a.send({ type: "TOOL_USE_REQUESTED", id: "c", name: "f", input: {} });
    expect(a.getSnapshot().value).toBe("dispatching_tool");
    expect(a.getSnapshot().context.pendingToolUseIds).toEqual(["a", "b", "c"]);
    // Resolve in arbitrary order — machine only leaves dispatching_tool
    // when the queue is empty.
    a.send({ type: "TOOL_RESULT_RECEIVED", id: "b" });
    expect(a.getSnapshot().value).toBe("dispatching_tool");
    a.send({ type: "TOOL_RESULT_RECEIVED", id: "a" });
    expect(a.getSnapshot().value).toBe("dispatching_tool");
    a.send({ type: "TOOL_RESULT_RECEIVED", id: "c" });
    expect(a.getSnapshot().value).toBe("waiting_for_claude");
  });
});
