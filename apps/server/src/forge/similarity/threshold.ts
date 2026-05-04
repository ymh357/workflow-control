// Cluster ripeness rule. Pure function: given current cluster
// statistics, decide whether the cluster is ripe enough for synthesis.
//
// Rule (from spec):
//   distinct_session_count >= 3
//   AND distinct_day_count >= 2
//   AND (suppressed_until == null OR now >= suppressed_until)

export interface ThresholdInput {
  distinctSessionCount: number;
  distinctDayCount: number;
  suppressedUntil: number | null;
}

export const RIPENESS_MIN_SESSIONS = 3;
export const RIPENESS_MIN_DAYS = 2;

export function evaluateThreshold(c: ThresholdInput, now: number): "forming" | "ripe" {
  if (c.suppressedUntil !== null && now < c.suppressedUntil) return "forming";
  if (c.distinctSessionCount < RIPENESS_MIN_SESSIONS) return "forming";
  if (c.distinctDayCount < RIPENESS_MIN_DAYS) return "forming";
  return "ripe";
}
