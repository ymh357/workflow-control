import { describe, it, expect } from "vitest";
import { AsyncQueue, QueueClosedError, QueueAbortedError } from "./async-queue.js";

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

  it("enqueue after finish throws QueueClosedError", () => {
    const q = new AsyncQueue<number>();
    q.finish();
    expect(() => q.enqueue(1)).toThrow(QueueClosedError);
  });

  it("enqueue after abort throws QueueAbortedError", () => {
    const q = new AsyncQueue<number>();
    q.abort();
    expect(() => q.enqueue(1)).toThrow(QueueAbortedError);
  });

  it("tryEnqueue returns false after finish (no throw)", () => {
    const q = new AsyncQueue<number>();
    q.finish();
    expect(q.tryEnqueue(1)).toBe(false);
  });

  it("tryEnqueue returns true on open queue", () => {
    const q = new AsyncQueue<number>();
    expect(q.tryEnqueue(1)).toBe(true);
  });

  it("abort rejects pending waiter with QueueAbortedError", async () => {
    const q = new AsyncQueue<string>();
    const promise = q[Symbol.asyncIterator]().next();
    q.abort("test reason");
    await expect(promise).rejects.toThrow(QueueAbortedError);
  });

  it("abort drops buffered items — next rejects", async () => {
    const q = new AsyncQueue<number>();
    q.enqueue(1);
    q.enqueue(2);
    q.abort();
    const iter = q[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow(QueueAbortedError);
  });

  it("finish after buffered items preserves drain order", async () => {
    const q = new AsyncQueue<number>();
    q.enqueue(1);
    q.enqueue(2);
    q.finish();
    // Post-finish enqueue must throw — no silent drops
    expect(() => q.enqueue(3)).toThrow(QueueClosedError);

    const iter = q[Symbol.asyncIterator]();
    expect(await iter.next()).toEqual({ value: 1, done: false });
    expect(await iter.next()).toEqual({ value: 2, done: false });
    expect(await iter.next()).toEqual({ value: undefined, done: true });
  });
});
