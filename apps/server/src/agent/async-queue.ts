/**
 * Simple async queue that implements AsyncIterable.
 * Items can be enqueued from producers and consumed via for-await or .next().
 * Equivalent to SDK's internal q4 class.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | null = null;
  private isDone = false;
  private started = false;

  enqueue(item: T): void {
    if (this.isDone) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  finish(): void {
    this.isDone = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.started) throw new Error("AsyncQueue has already been iterated");
    this.started = true;

    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.isDone) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}
