import { describe, it, expect } from "vitest";
import { AsyncQueue } from "./async-queue.js";

describe("AsyncQueue", () => {
  it("yields items in order", async () => {
    const q = new AsyncQueue<number>();
    q.enqueue(1);
    q.enqueue(2);
    q.finish();

    const items: number[] = [];
    for await (const item of q) {
      items.push(item);
    }
    expect(items).toEqual([1, 2]);
  });

  it("waits for enqueue when queue is empty", async () => {
    const q = new AsyncQueue<string>();

    const promise = q[Symbol.asyncIterator]().next();
    q.enqueue("hello");
    const result = await promise;
    expect(result).toEqual({ value: "hello", done: false });
  });

  it("finish signals done", async () => {
    const q = new AsyncQueue<string>();
    q.finish();

    const result = await q[Symbol.asyncIterator]().next();
    expect(result).toEqual({ value: undefined, done: true });
  });

  it("drains remaining items before done", async () => {
    const q = new AsyncQueue<number>();
    q.enqueue(10);
    q.enqueue(20);
    q.finish();

    const iter = q[Symbol.asyncIterator]();
    expect(await iter.next()).toEqual({ value: 10, done: false });
    expect(await iter.next()).toEqual({ value: 20, done: false });
    expect(await iter.next()).toEqual({ value: undefined, done: true });
  });

  it("can be iterated only once", async () => {
    const q = new AsyncQueue<number>();
    q.finish();

    const iter1 = q[Symbol.asyncIterator]();
    await iter1.next();

    expect(() => q[Symbol.asyncIterator]()).toThrow("already been iterated");
  });
});
