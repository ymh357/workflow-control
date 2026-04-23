// kernel-next SSE broadcaster.
//
// Purpose: collect events published by runner / PortRuntime and fan
// them out to subscribers (HTTP SSE clients). Intentionally
// in-memory and local — single-user engine, no cross-process
// replication.
//
// Design notes:
//   - Per-task subscriptions. An HTTP SSE connection subscribes to
//     one taskId and receives only that task's events. Cross-task
//     subscriptions are not supported by design (no dashboard-wide
//     firehose — too noisy for the one-engineer-one-machine use case).
//   - Ring-buffer history per task. Late subscribers (e.g. dashboard
//     reloaded mid-run) replay the last N events synchronously on
//     `subscribe` so they never "miss the start" for short runs.
//     Buffer default = 100 events per task; configurable at
//     construction for tests. When the buffer overflows, oldest
//     events are dropped; we do not persist to disk — the source of
//     truth is the SQLite lineage, not the event log.
//   - publish is synchronous and non-throwing: any listener error is
//     caught and swallowed. A broken dashboard connection must not
//     abort runner execution.
//   - No automatic cleanup tick: closed subscribers are removed
//     explicitly via the returned `unsubscribe` function. History for
//     a task is dropped only when `clearTask` is called; for a
//     long-running engine with many tasks this can grow — acceptable
//     for the local use case, and simple to retire later if needed.

import type { KernelNextSSEEvent } from "./types.js";

export type KernelNextSSEListener = (event: KernelNextSSEEvent) => void;

export interface KernelNextBroadcasterOptions {
  // Max events retained per task in the replay ring. Default 100 —
  // enough to cover short pipelines end-to-end; long runs lose older
  // events but still deliver every live one.
  historyLimit?: number;
}

interface TaskChannel {
  listeners: Set<KernelNextSSEListener>;
  history: KernelNextSSEEvent[];
  // Monotonic sequence counter, per task. The next-to-assign seq value
  // on publish. Events in the ring are stamped with the value at the
  // time of publish; assigned values are never re-used even if a
  // channel's history ring drops older entries.
  nextSeq: number;
}

const DEFAULT_HISTORY_LIMIT = 100;

export class KernelNextBroadcaster {
  private readonly channels = new Map<string, TaskChannel>();
  private readonly historyLimit: number;

  constructor(options: KernelNextBroadcasterOptions = {}) {
    this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  }

  /**
   * Subscribe to a task's event stream. The listener is invoked
   * synchronously for every retained event in the history whose `seq`
   * is greater than `opts.fromSeq` (default 0), in order, and then
   * for every subsequent `publish` call until unsubscribe.
   * Returns an `unsubscribe` function that is idempotent.
   *
   * `fromSeq` wiring:
   *   Client opens an SSE stream with `Last-Event-ID: <taskId>:<seq>`.
   *   The HTTP route parses that into a number and passes it here, so
   *   the ring replay skips events the client already acknowledged.
   *   When the server side has dropped those events out of the ring,
   *   the client still receives everything remaining — they just see
   *   a gap (documented behaviour; the DB lineage is authoritative).
   */
  subscribe(
    taskId: string,
    listener: KernelNextSSEListener,
    opts: { fromSeq?: number } = {},
  ): () => void {
    const channel = this.ensureChannel(taskId);
    const fromSeq = opts.fromSeq ?? 0;
    for (const event of channel.history) {
      // history entries are always stamped — see publish()
      if ((event.seq ?? 0) > fromSeq) {
        this.safeDispatch(listener, event);
      }
    }
    channel.listeners.add(listener);
    return () => {
      channel.listeners.delete(listener);
    };
  }

  /**
   * Publish an event. Always stamps a per-task monotonic `seq`,
   * appends to the task's history ring, then dispatches to current
   * subscribers. Listener errors are swallowed — a broken consumer
   * must not stop the runner.
   *
   * Accepts events without a `seq` field (runner callers never supply
   * one); any supplied value is ignored in favour of the broadcaster-
   * assigned sequence. This keeps callers simple and guarantees the
   * monotonic invariant.
   */
  publish(event: KernelNextSSEEvent): void {
    const channel = this.ensureChannel(event.taskId);
    const seq = channel.nextSeq;
    channel.nextSeq += 1;
    const stamped: KernelNextSSEEvent = { ...event, seq };
    channel.history.push(stamped);
    if (channel.history.length > this.historyLimit) {
      channel.history.splice(0, channel.history.length - this.historyLimit);
    }
    for (const listener of channel.listeners) {
      this.safeDispatch(listener, stamped);
    }
  }

  /**
   * Inspect the retained history for a task. Returns a defensive
   * copy so callers cannot mutate the internal ring.
   */
  historyFor(taskId: string): KernelNextSSEEvent[] {
    const channel = this.channels.get(taskId);
    return channel ? [...channel.history] : [];
  }

  /**
   * Drop all history and listeners for a task. Use when a task is
   * known to be finalized and its stream will not be re-opened.
   */
  clearTask(taskId: string): void {
    this.channels.delete(taskId);
  }

  /**
   * Subscriber count for a task — intended for tests and the HTTP
   * route's connection accounting. O(1).
   */
  subscriberCount(taskId: string): number {
    return this.channels.get(taskId)?.listeners.size ?? 0;
  }

  private ensureChannel(taskId: string): TaskChannel {
    let channel = this.channels.get(taskId);
    if (!channel) {
      channel = { listeners: new Set(), history: [], nextSeq: 1 };
      this.channels.set(taskId, channel);
    }
    return channel;
  }

  private safeDispatch(listener: KernelNextSSEListener, event: KernelNextSSEEvent): void {
    try {
      listener(event);
    } catch {
      // Swallow listener errors. A single broken listener cannot
      // poison the publish loop. We do not log here because the
      // broadcaster is on the runner hot path; loggers can be wired
      // at the listener layer instead.
    }
  }
}
