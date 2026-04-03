import { taskLogger } from "../lib/logger.js";

/**
 * Eagerly persist a session ID into the workflow context's stageSessionIds
 * so that retry-on-error can resume the session instead of starting fresh.
 *
 * Also triggers a snapshot flush so that even a process crash preserves the sessionId.
 *
 * Uses dynamic import to avoid circular dependency:
 * actor-registry -> state-builders -> executor -> stream-processor -> session-persister
 */
export async function persistSessionId(taskId: string, stageName: string, sessionId: string): Promise<void> {
  try {
    const { getWorkflow } = await import("../machine/actor-registry.js");
    const actor = getWorkflow(taskId);
    if (!actor) return;
    const snap = actor.getSnapshot();
    const ctx = snap?.context;
    if (ctx?.stageSessionIds) {
      ctx.stageSessionIds[stageName] = sessionId;
      taskLogger(taskId, stageName).info({ sessionId }, "session ID persisted early to stageSessionIds");

      // Flush snapshot to disk so sessionId survives a process crash
      const { persistSnapshot } = await import("../machine/persistence.js");
      await persistSnapshot(taskId, actor as any);
    }
  } catch {
    // Non-critical — worst case is retry without resume
  }
}
