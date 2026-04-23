// rate-limit-backoff.ts (P5.3 / D7)
//
// Pure helpers for rate-limit aware stage pacing. The agent machine
// receives RATE_LIMIT_SIGNAL events translated by sdk-adapter from the
// Claude Agent SDK's rate_limit_event stream. When utilization is high,
// the runner/executor should emit a dashboard-visible "throttled by API"
// signal rather than letting the SDK error out mid-turn and surfacing as
// an opaque failure.
//
// This module is PURE — no I/O, no SDK imports. Consumers are:
//   - agent-machine.ts (counts consecutive signals in context)
//   - real-executor.ts (publishes rate_limit_backoff SSE when shouldPause)
//
// Defaults:
//   - threshold 0.9 (pause when >= 90% of quota consumed)
//   - base 500ms
//   - cap 30_000ms (never suggest waiting more than 30s between retries)
// All three are exported so tests can pin values.

export const RATE_LIMIT_UTIL_THRESHOLD = 0.9;
export const RATE_LIMIT_BASE_MS = 500;
export const RATE_LIMIT_MAX_MS = 30_000;

export interface RateLimitSignal {
  utilization: number;
}

export function shouldPause(signal: RateLimitSignal): boolean {
  return signal.utilization >= RATE_LIMIT_UTIL_THRESHOLD;
}

/**
 * Exponential back-off suggested delay in ms for the Nth consecutive
 * rate-limit signal (1-based). Values <= 0 are treated as 1. Doubles
 * each signal, capped at RATE_LIMIT_MAX_MS.
 */
export function rateLimitBackoffMs(consecutiveSignals: number): number {
  const n = Math.max(1, consecutiveSignals);
  const exp = RATE_LIMIT_BASE_MS * Math.pow(2, n - 1);
  return Math.min(exp, RATE_LIMIT_MAX_MS);
}
