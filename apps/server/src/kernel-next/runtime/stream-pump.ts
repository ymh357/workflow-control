// Stream pump — drains a Claude Agent SDK message stream into an
// AgentMachine actor.
//
// Extracted from real-executor.ts (A2.3.1) so the same consumption loop
// can be reused both by the current `createActor(AgentMachine)` path AND
// by future XState `invoke`-based nesting (A2.3.2 onward), where the
// invoked child actor is spawned by the parent TaskMachine but still
// needs an external driver to read from the SDK iterable.
//
// Responsibilities:
//   1. For each SDK message, call adapter.translate() to get zero or
//      more AgentEvents.
//   2. Send each event to the actor via the provided `send` callback.
//   3. On stream end, await the actor's final state via the provided
//      `waitForFinal` helper.
//
// The pump is agnostic about actor lifecycle — the caller starts and
// stops the actor. This keeps the pump trivially composable with
// XState's invoke (which owns lifecycle) and with the current manual
// createActor + start/stop pattern.

import type { AgentEvent, AgentMachineOutput } from "./agent-machine.js";
import type { SdkAdapter, SdkMessageLike } from "./sdk-adapter.js";

export interface PumpOptions {
  /** Source of SDK messages. */
  stream: AsyncIterable<SdkMessageLike>;
  /** Adapter translating SDK messages → AgentEvents. */
  adapter: SdkAdapter;
  /** Sends an AgentEvent into the AgentMachine actor. */
  send: (event: AgentEvent) => void;
  /**
   * Called once the SDK stream has ended, to wait for the actor to reach
   * its final state. Returns the AgentMachineOutput from `actor.getSnapshot().output`.
   * Timeout and retry are the caller's responsibility (typically via
   * xstate `waitFor`).
   */
  waitForFinal: () => Promise<AgentMachineOutput>;
}

/**
 * Drain the SDK message stream into the actor, then return the actor's
 * terminal output. Re-throws any error from the stream or from waitForFinal;
 * callers are expected to install try/finally around this call to stop the
 * actor regardless of outcome.
 */
export async function pumpSdkStream(opts: PumpOptions): Promise<AgentMachineOutput> {
  const { stream, adapter, send, waitForFinal } = opts;
  for await (const message of stream) {
    const events = adapter.translate(message);
    for (const ev of events) send(ev);
  }
  return waitForFinal();
}
