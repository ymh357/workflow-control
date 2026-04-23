// agent-message-delta.ts (P7.4 / D29)
//
// Throttled publisher for agent text deltas. The Claude Agent SDK stream
// may emit many tiny text chunks per second; coalesce to ≤10 events/
// second per attempt to keep the SSE stream + dashboard responsive.
//
// Usage: one DeltaThrottler per (taskId, attemptId, stage) — created
// when a stage starts driving the SDK stream, fed every text chunk via
// push(), and flushed/released via dispose() when the stage ends. The
// throttler never gates stage progression: broadcaster failures are
// swallowed so the live-output channel is observability-only.

import type { KernelNextBroadcaster } from "../sse/broadcaster.js";

const FLUSH_INTERVAL_MS = 100; // 10 Hz

export class DeltaThrottler {
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly broadcaster: KernelNextBroadcaster,
    private readonly taskId: string,
    private readonly attemptId: string,
    private readonly stage: string,
    private readonly role: "assistant" | "other" = "assistant",
  ) {}

  push(textDelta: string): void {
    if (!textDelta) return;
    this.buffer += textDelta;
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
    }
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.buffer) return;
    const textDelta = this.buffer;
    this.buffer = "";
    try {
      this.broadcaster.publish({
        type: "agent_message_delta",
        taskId: this.taskId,
        timestamp: new Date().toISOString(),
        data: {
          attemptId: this.attemptId,
          stage: this.stage,
          textDelta,
          role: this.role,
        },
      });
    } catch {
      // Broadcaster failure must not abort stage progression. Live
      // output is observability-only.
    }
  }

  dispose(): void {
    this.flush();
  }
}
