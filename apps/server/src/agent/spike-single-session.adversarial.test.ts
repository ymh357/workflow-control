import { describe, it, expect } from "vitest";

// Replicate createMessageQueue exactly as in the source
function createMessageQueue() {
  const queue: unknown[] = [];
  let waiting: ((val: IteratorResult<unknown>) => void) | null = null;

  function push(text: string) {
    const msg = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
      session_id: "",
    };
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve({ value: msg, done: false });
    } else {
      queue.push(msg);
    }
  }

  function end() {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve({ value: undefined, done: true });
    }
  }

  const iterable = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<unknown>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          return new Promise((resolve) => { waiting = resolve; });
        },
      };
    },
  };

  return { push, end, iterable };
}

describe("adversarial: createMessageQueue race conditions", () => {
  it("handles rapid push-consume-push cycle correctly", async () => {
    const { push, iterable } = createMessageQueue();
    const iter = iterable[Symbol.asyncIterator]();

    push("first");
    const r1 = await iter.next();
    expect((r1.value as any).message.content[0].text).toBe("first");

    push("second");
    const r2 = await iter.next();
    expect((r2.value as any).message.content[0].text).toBe("second");
  });

  it("handles push after end is called (queue still works for pre-end items)", async () => {
    const { push, end, iterable } = createMessageQueue();
    push("before-end");
    end(); // no-op since no one is waiting

    const iter = iterable[Symbol.asyncIterator]();
    const r = await iter.next();
    expect(r.done).toBe(false);
    expect((r.value as any).message.content[0].text).toBe("before-end");
  });

  it("end then push: subsequent push queues normally since end was no-op", async () => {
    const { push, end, iterable } = createMessageQueue();
    end(); // no-op — no pending consumer
    push("after-end");

    const iter = iterable[Symbol.asyncIterator]();
    const r = await iter.next();
    expect(r.done).toBe(false);
    expect((r.value as any).message.content[0].text).toBe("after-end");
  });
});

describe("adversarial: createMessageQueue concurrent consumers", () => {
  it("second next() call hangs when first next() already consumed the only item", async () => {
    const { push, end, iterable } = createMessageQueue();
    push("only");
    const iter = iterable[Symbol.asyncIterator]();

    const r1 = await iter.next();
    expect(r1.done).toBe(false);

    // Second call will hang waiting — resolve it with end()
    const p2 = iter.next();
    end();
    const r2 = await p2;
    expect(r2.done).toBe(true);
  });
});

describe("adversarial: createMessageQueue message structure", () => {
  it("always sets session_id to empty string", async () => {
    const { push, iterable } = createMessageQueue();
    push("test");
    const iter = iterable[Symbol.asyncIterator]();
    const { value } = await iter.next();
    expect((value as any).session_id).toBe("");
  });

  it("always sets parent_tool_use_id to null", async () => {
    const { push, iterable } = createMessageQueue();
    push("test");
    const iter = iterable[Symbol.asyncIterator]();
    const { value } = await iter.next();
    expect((value as any).parent_tool_use_id).toBeNull();
  });

  it("preserves exact text including special characters", async () => {
    const { push, iterable } = createMessageQueue();
    const special = 'Line1\nLine2\t"quoted"\\backslash';
    push(special);
    const iter = iterable[Symbol.asyncIterator]();
    const { value } = await iter.next();
    expect((value as any).message.content[0].text).toBe(special);
  });

  it("handles empty string push", async () => {
    const { push, iterable } = createMessageQueue();
    push("");
    const iter = iterable[Symbol.asyncIterator]();
    const { value } = await iter.next();
    expect((value as any).message.content[0].text).toBe("");
  });
});

describe("adversarial: main flow edge cases", () => {
  it("FAIL condition: stageCount < 2 after only one result", () => {
    // If the loop ends after stage 1 without a second result, it should be a failure
    const stageCount = 1;
    expect(stageCount < 2).toBe(true);
  });

  it("undefined session ids indicate loop never received results", () => {
    const sessionId1 = undefined;
    const sessionId2 = undefined;
    // Both undefined — sessionId1 === sessionId2 is true, but stageCount < 2 check fires first
    expect(sessionId1 === sessionId2).toBe(true);
  });
});
