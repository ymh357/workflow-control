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
   * Optional observer invoked for every raw SDK message BEFORE adapter
   * translation. Lets side-effect consumers (e.g. the execution-record
   * sidecar writer) capture content that the adapter intentionally
   * collapses for the state machine — assistant text/thinking payloads,
   * session_id on system/init, token usage on result/success. Throws
   * from this callback propagate and will abort the stream, same as
   * adapter errors (treated as a defect in the observer, not an SDK
   * failure).
   */
  onSdkMessage?: (msg: SdkMessageLike) => void;
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
 * terminal output.
 *
 * Error semantics (A7.3 Bug 2): the Claude Agent SDK's async iterator
 * may throw at the *end* of a stream when the underlying claude CLI
 * child process exits with a non-zero code (observed: "Claude Code
 * process exited with code 1" after result_success was already
 * delivered). That exit does not retroactively invalidate the
 * business messages we already consumed — if the AgentMachine has
 * already reached its `done` final via result_success, the stage IS
 * successful. So: always call waitForFinal() regardless of whether
 * the iteration threw. If the actor has produced an output
 * (AgentMachine's done/error final), return it. Only if the actor
 * never reached a final do we re-throw the original stream error so
 * the caller can mark the attempt failed.
 *
 * Callers are still expected to install try/finally around this call
 * to stop the actor regardless of outcome.
 */
export async function pumpSdkStream(opts: PumpOptions): Promise<AgentMachineOutput> {
  const { stream, adapter, send, waitForFinal, onSdkMessage } = opts;

  // A7.3 Bug 2: isolate iterator-level errors (the SDK's child
  // process exiting non-zero at stream end, which fires AFTER
  // result_success has been delivered) from adapter-level errors
  // (our own translate/send buggy code). Adapter errors should
  // bubble up immediately — they indicate a real code defect and
  // the actor state is undefined. Iterator errors should allow the
  // actor's already-observed final state to decide the outcome:
  // if result_success reached the AgentMachine, the stage is
  // semantically complete regardless of how the child process died.
  const iterator = stream[Symbol.asyncIterator]();
  let streamError: unknown;
  let streamEnded = false;
  while (!streamEnded) {
    let step: IteratorResult<SdkMessageLike>;
    try {
      step = await iterator.next();
    } catch (err) {
      streamError = err;
      break;
    }
    if (step.done) {
      streamEnded = true;
      break;
    }
    // Observer fires BEFORE translation so sidecar consumers see raw
    // SDK shape (text/thinking payloads, session_id, usage). Throws
    // propagate like adapter errors — observer defects are fatal.
    if (onSdkMessage) onSdkMessage(step.value);
    // Adapter or send throws propagate. These indicate a defect in
    // our translation / actor-send layer, not the SDK exit code.
    const events = adapter.translate(step.value);
    for (const ev of events) send(ev);
  }

  try {
    return await waitForFinal();
  } catch (waitErr) {
    // Actor never reached a terminal state — the stream failure is
    // the real cause; prefer it over the (likely waitFor timeout)
    // secondary error. If there was no stream error, re-throw the
    // wait error.
    throw streamError ?? waitErr;
  }
}
