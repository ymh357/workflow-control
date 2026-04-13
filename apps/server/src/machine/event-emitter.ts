import { appendEvent, loadEvents, type WorkflowEventType } from "./workflow-events.js";

const counters = new Map<string, number>();

export function getNextEventId(taskId: string): number {
  let counter = counters.get(taskId);
  if (counter === undefined) {
    const existing = loadEvents(taskId);
    counter = existing.length > 0 ? existing[existing.length - 1].id + 1 : 1;
    counters.set(taskId, counter);
  }
  return counter;
}

export async function emitWorkflowEvent(
  taskId: string,
  type: WorkflowEventType,
  stage?: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  const id = getNextEventId(taskId);
  counters.set(taskId, id + 1);

  await appendEvent(taskId, {
    id,
    ts: new Date().toISOString(),
    type,
    ...(stage !== undefined && { stage }),
    ...(payload !== undefined && { payload }),
  });
}
