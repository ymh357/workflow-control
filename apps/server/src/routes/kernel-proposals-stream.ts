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
  // B5 / B6.#12 (2026-04-30 review): pre-fix the listener-throw and
  // heartbeat-throw paths set closed=true but did NOT unsubscribe
  // the broadcaster listener (and the listener-throw path didn't
  // clearInterval the heartbeat either). Result: a controller that
  // errored mid-stream kept its listener slot occupied forever, the
  // listener kept being called for every subsequent broadcast (each
  // call short-circuited via `closed` but still ran a method
  // dispatch + try/catch frame), and the heartbeat kept ticking
  // until cancel() finally tore everything down — which only fires
  // on graceful disconnect, not on a thrown enqueue.
  //
  // Now: a single cleanup() function tears down both subscription
  // and interval; both throw paths invoke it.
  const cleanup = () => {
    closed = true;
    if (unsubscribe) {
      try { unsubscribe(); } catch { /* idempotent */ }
      unsubscribe = null;
    }
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      unsubscribe = broadcaster.subscribe((event) => {
        if (closed) return;
        try {
          controller.enqueue(formatEvent(event));
        } catch {
          cleanup();
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
          cleanup();
        }
      }, heartbeatMs);
    },
    cancel() {
      cleanup();
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
