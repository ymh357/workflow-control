import { taskLogger } from "../lib/logger.js";

/**
 * Eagerly persist a session ID into the workflow context's stageSessionIds
 * so that retry-on-error can resume the session instead of starting fresh.
 *
 * Also triggers a snapshot flush so that even a process crash preserves the sessionId.
 *
 * Sends a PERSIST_SESSION_ID event rather than mutating context directly —
 * XState context is supposed to be treated as immutable, and mutation bypasses
 * subscribers, breaks reactivity, and can race with the stage's own onDone
 * assign that also touches stageSessionIds.
 *
 * Uses dynamic import to avoid circular dependency:
 * actor-registry -> state-builders -> executor -> stream-processor -> session-persister
 */
export async function persistSessionId(taskId: string, stageName: string, sessionId: string): Promise<void> {
  try {
    const { getWorkflow } = await import("../machine/actor-registry.js");
    const actor = getWorkflow(taskId);
    if (!actor) return;
    // Dispatch as an event so XState applies it through the assign reducer,
    // triggering subscribers (SSE, persistence) and preserving immutability.
    actor.send({ type: "PERSIST_SESSION_ID", stageName, sessionId });
    taskLogger(taskId, stageName).info({ sessionId }, "session ID persisted early to stageSessionIds");

    // Flush snapshot to disk so sessionId survives a process crash
    const { persistSnapshot } = await import("../machine/persistence.js");
    await persistSnapshot(taskId, actor as any);
  } catch {
    // Non-critical — worst case is retry without resume
  }
}
