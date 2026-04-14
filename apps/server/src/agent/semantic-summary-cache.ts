// In-memory cache for semantic summaries.
// Allows same-process downstream stages to access summaries
// before they're persisted to the store (which is eventual).

const cache = new Map<string, string>();

export function getCachedSummary(taskId: string, storeKey: string): string | undefined {
  return cache.get(`${taskId}:${storeKey}`);
}

export function setCachedSummary(taskId: string, storeKey: string, summary: string): void {
  cache.set(`${taskId}:${storeKey}`, summary);
}

export function clearTaskSummaries(taskId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${taskId}:`)) cache.delete(key);
  }
}
