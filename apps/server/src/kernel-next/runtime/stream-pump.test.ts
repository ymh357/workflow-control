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
});
