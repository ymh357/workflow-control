// kernel-next SSE HTTP handler.
//
// Produces a text/event-stream ReadableStream bound to a single
// task's broadcaster channel. History is replayed synchronously on
// subscribe (broadcaster's own behaviour), then live events flow
// until the client disconnects. Deliberately lightweight compared
// to legacy src/sse/manager.ts:
//   - No DB persistence (broadcaster's ring buffer is the source of
//     retained events; SQLite lineage is the source of truth for
//     port values and stage_attempts — use those APIs for history
//     beyond the ring).
//   - No per-connection cap (single-user local engine).
//   - Heartbeat every 30s to survive proxies / laptop sleep.
//   - cancel() unsubscribes and drops the heartbeat interval — no
//     leaked timers when dashboard tabs close.

import type { KernelNextBroadcaster } from "./broadcaster.js";
import type { KernelNextSSEEvent } from "./types.js";

const encoder = new TextEncoder();

function formatEvent(event: KernelNextSSEEvent): Uint8Array {
  // Standard SSE data frame. `event:` field matches type so
  // EventSource clients can `addEventListener(type, ...)` instead
  // of always parsing `message`.
  const lines = [
    `event: ${event.type}`,
    `data: ${JSON.stringify(event)}`,
    "",
    "",
  ];
  return encoder.encode(lines.join("\n"));
}

export interface CreateKernelNextStreamOptions {
  heartbeatMs?: number;
}

/**
 * Create a ReadableStream that delivers every broadcaster event for
 * the given taskId. Returned stream is ready to pass to Hono's
 * c.body() with the appropriate headers.
 */
export function createKernelNextStream(
  broadcaster: KernelNextBroadcaster,
  taskId: string,
  options: CreateKernelNextStreamOptions = {},
): ReadableStream<Uint8Array> {
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Broadcaster will synchronously replay existing history before
      // returning from subscribe(); subsequent live publishes arrive
      // asynchronously via the same listener.
      unsubscribe = broadcaster.subscribe(taskId, (event) => {
        if (closed) return;
        try {
          controller.enqueue(formatEvent(event));
        } catch {
          // Controller already closed (client dropped). Next
          // heartbeat / cancel will clean up.
          closed = true;
        }
      });

      heartbeat = setInterval(() => {
        if (closed) {
          if (heartbeat) clearInterval(heartbeat);
          return;
        }
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
        }
      }, heartbeatMs);
    },
    cancel() {
      closed = true;
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    },
  });
}
