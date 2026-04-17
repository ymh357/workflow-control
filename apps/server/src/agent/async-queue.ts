/**
 * Simple async queue that implements AsyncIterable.
 * Items can be enqueued from producers and consumed via for-await or .next().
 * Equivalent to SDK's internal q4 class.
 */

export class QueueClosedError extends Error {
  constructor(message = "AsyncQueue is closed") {
    super(message);
    this.name = "QueueClosedError";
  }
}

export class QueueAbortedError extends Error {
  constructor(message = "AsyncQueue aborted") {
    super(message);
    this.name = "QueueAbortedError";
  }
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | null = null;
  private waitingReject: ((err: Error) => void) | null = null;
  private isDone = false;
  private aborted = false;
  private started = false;
  private static readonly MAX_BUFFERED = 100;

  /**
   * Enqueue an item. Throws QueueClosedError if the queue has been finished or aborted.
   * Callers must handle the throw or use `tryEnqueue` to get a boolean result.
   */
  enqueue(item: T): void {
    if (this.aborted) throw new QueueAbortedError();
    if (this.isDone) throw new QueueClosedError();
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      this.waitingReject = null;
      resolve({ value: item, done: false });
    } else {
      if (this.queue.length >= AsyncQueue.MAX_BUFFERED) {
        // Drop oldest to prevent unbounded growth
        this.queue.shift();
      }
      this.queue.push(item);
    }
  }

  /**
   * Attempt to enqueue. Returns false if the queue is closed or aborted
   * (no throw). Use when the caller wants to silently skip post-close messages.
   */
  tryEnqueue(item: T): boolean {
    if (this.aborted || this.isDone) return false;
    this.enqueue(item);
    return true;
  }

  /**
   * Mark the queue as done. Remaining buffered items are still drained by the
   * iterator before it yields `done: true`.
   */
  finish(): void {
    if (this.aborted) return;
    this.isDone = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      this.waitingReject = null;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  /**
   * Abort the queue immediately. Any pending iterator `next()` call is rejected
   * with `QueueAbortedError` and the internal buffer is dropped. Subsequent
   * `next()` calls also reject. This is the hard-stop primitive — use when the
   * upstream source (SDK query, session) is being forcibly terminated and we
   * want any consume loop to unwind rather than hang.
   */
  abort(reason?: string): void {
    if (this.aborted) return;
    this.aborted = true;
    this.isDone = true;
    this.queue = [];
    // Prefer checking `waiting` (the resolve fn) — `waiting` and `waitingReject`
    // are always set/cleared together, so this is equivalent today. But the
    // intent of abort is "if someone is awaiting, unblock them", so the resolve
    // handle is the primary signal; if the two ever drift, this fails safe.
    if (this.waiting) {
      const reject = this.waitingReject;
      this.waiting = null;
      this.waitingReject = null;
      reject?.(new QueueAbortedError(reason ?? "AsyncQueue aborted"));
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.started) throw new Error("AsyncQueue has already been iterated");
    this.started = true;

    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.aborted) {
          return Promise.reject(new QueueAbortedError());
        }
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.isDone) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiting = resolve;
          this.waitingReject = reject;
        });
      },
    };
  }
}
