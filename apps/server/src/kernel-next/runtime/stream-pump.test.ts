// A2.3.1 — stream-pump unit tests. These exercise pumpSdkStream in
// isolation using an in-memory async generator and a mocked adapter/
// actor. They do NOT spin up a real AgentMachine; the actor interface
// is reduced to a `send` callback plus a `waitForFinal` thunk so the
// pump's only responsibilities (drain + await) are tested directly.

import { describe, it, expect } from "vitest";
import { pumpSdkStream } from "./stream-pump.js";
import type { SdkAdapter, SdkMessageLike } from "./sdk-adapter.js";
import type { AgentEvent, AgentMachineOutput } from "./agent-machine.js";

function makeAdapter(mapping: Map<string, AgentEvent[]>): SdkAdapter {
  const unknown: Array<{ type: string; subtype?: string }> = [];
  return {
    unknownMessages: unknown,
    translate(msg) {
      return mapping.get(msg.type) ?? [];
    },
  };
}

async function* toStream<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

describe("pumpSdkStream", () => {
  it("forwards adapter-translated events in order then resolves final", async () => {
    const received: AgentEvent[] = [];
    const msgs: SdkMessageLike[] = [
      { type: "system", subtype: "init" },
      { type: "assistant" },
      { type: "result", subtype: "success" },
    ];
    const adapter = makeAdapter(
      new Map<string, AgentEvent[]>([
        ["system", [{ type: "SDK_INIT" }]],
        ["assistant", [{ type: "ASSISTANT_TEXT" }]],
        ["result", [{ type: "RESULT_SUCCESS" }]],
      ]),
    );
    const finalOutput: AgentMachineOutput = {
      status: "done",
      turns: 1,
      stageName: "S",
      taskId: "T",
      attemptId: "A",
    };

    const result = await pumpSdkStream({
      stream: toStream(msgs),
      adapter,
      send: (ev) => { received.push(ev); },
      waitForFinal: async () => finalOutput,
    });

    expect(received.map((e) => e.type)).toEqual([
      "SDK_INIT",
      "ASSISTANT_TEXT",
      "RESULT_SUCCESS",
    ]);
    expect(result).toBe(finalOutput);
  });

  it("propagates adapter errors without calling waitForFinal", async () => {
    let waited = false;
    const adapter: SdkAdapter = {
      unknownMessages: [],
      translate() { throw new Error("adapter boom"); },
    };

    await expect(
      pumpSdkStream({
        stream: toStream<SdkMessageLike>([{ type: "system" }]),
        adapter,
        send: () => {},
        waitForFinal: async () => {
          waited = true;
          return {
            status: "done", turns: 0, stageName: "", taskId: "", attemptId: "",
          } satisfies AgentMachineOutput;
        },
      }),
    ).rejects.toThrow("adapter boom");
    expect(waited).toBe(false);
  });

  it("empty stream still awaits final (the machine may already be in a final state)", async () => {
    const finalOutput: AgentMachineOutput = {
      status: "done", turns: 0, stageName: "", taskId: "", attemptId: "",
    };
    const out = await pumpSdkStream({
      stream: toStream<SdkMessageLike>([]),
      adapter: makeAdapter(new Map()),
      send: () => { throw new Error("send should not be called on empty stream"); },
      waitForFinal: async () => finalOutput,
    });
    expect(out).toBe(finalOutput);
  });

  it("iterator throws at stream end but actor reached done → returns actor output (A7.3 Bug 2)", async () => {
    // Simulates the Claude Agent SDK behaviour observed during A7.1
    // browser verification: result_success is delivered, then the
    // underlying claude CLI child process exits non-zero so the
    // async iterator throws on its next() after the last yield. The
    // AgentMachine already saw result_success via adapter, so the
    // stage is semantically complete — we must return the actor's
    // done output, not propagate the iterator exit error.
    async function* lateThrowStream(): AsyncIterable<SdkMessageLike> {
      yield { type: "result", subtype: "success" } as SdkMessageLike;
      throw new Error("Claude Code process exited with code 1");
    }
    const finalOutput: AgentMachineOutput = {
      status: "done", turns: 1, stageName: "S", taskId: "T", attemptId: "A",
    };
    const out = await pumpSdkStream({
      stream: lateThrowStream(),
      adapter: makeAdapter(
        new Map([["result", [{ type: "RESULT_SUCCESS" }]]]),
      ),
      send: () => { /* ignore */ },
      waitForFinal: async () => finalOutput,
    });
    expect(out).toBe(finalOutput);
  });

  it("iterator throws AND actor never reached final → re-throws iterator error", async () => {
    // If the SDK process crashes mid-stream (no result_success yet),
    // waitForFinal will time out. The original stream error is the
    // real cause and should surface, not the downstream wait error.
    async function* crashStream(): AsyncIterable<SdkMessageLike> {
      yield { type: "system" } as SdkMessageLike;
      throw new Error("SDK crashed");
    }
    await expect(
      pumpSdkStream({
        stream: crashStream(),
        adapter: makeAdapter(new Map()),
        send: () => { /* ignore */ },
        waitForFinal: async () => {
          throw new Error("waitFor timeout");
        },
      }),
    ).rejects.toThrow("SDK crashed");
  });
});
