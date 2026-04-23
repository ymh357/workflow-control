// SSE stream of proposal lifecycle events (B5 wf.hotUpdatePending).
//
// GET /api/kernel/proposals/stream returns a text/event-stream of
// ProposalEvent values (proposal_created / proposal_approved /
// proposal_rejected). One global channel: any UI surface that cares
// about "there's a new proposal" subscribes here. Late subscribers
// replay the broadcaster's history ring so a browser tab reload does
// not miss recent events.

import { Hono } from "hono";
import { proposalsBroadcaster } from "../kernel-next/sse/singleton.js";
import type { ProposalsBroadcaster, ProposalEvent } from "../kernel-next/sse/proposals-broadcaster.js";

export const kernelProposalsStreamRoute = new Hono();

// Test hook: mirror of the pattern in kernel-proposals.ts so tests
// can inject a fresh broadcaster and assert on history + live
// delivery without touching global state.
let activeBroadcaster: ProposalsBroadcaster = proposalsBroadcaster;
export function __setProposalsBroadcasterForStreamTest(next: ProposalsBroadcaster | undefined): void {
  activeBroadcaster = next ?? proposalsBroadcaster;
}

const encoder = new TextEncoder();

function formatEvent(event: ProposalEvent): Uint8Array {
  return encoder.encode([
    `event: ${event.type}`,
    `data: ${JSON.stringify(event)}`,
    "",
    "",
  ].join("\n"));
}

function createProposalsStream(
  broadcaster: ProposalsBroadcaster,
  heartbeatMs = 30_000,
): ReadableStream<Uint8Array> {
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      unsubscribe = broadcaster.subscribe((event) => {
        if (closed) return;
        try {
          controller.enqueue(formatEvent(event));
        } catch {
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

kernelProposalsStreamRoute.get("/kernel/proposals/stream", (c) => {
  const stream = createProposalsStream(activeBroadcaster);
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");
  return c.body(stream);
});
