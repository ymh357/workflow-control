// Slow-mock diamond used by the dashboard verification path.
//
// Reuses the canonical diamondIR shape (four-stage A -> {B,C} -> D)
// and wraps each handler in a 1.5s sleep so each stage region is
// visible in the SSE stream / dashboard UI for long enough to
// actually see it. A full run takes ~6s on an idle machine:
//   A (1.5s) → B (1.5s) ∥ C (1.5s) → D (1.5s)
//
// No external dependencies. Safe for mock executor — no API keys,
// no network, no filesystem.

import type { StageHandlerMap } from "../runtime/mock-executor.js";

const DEFAULT_STAGE_SLEEP_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function slowDiamondHandlers(
  stageSleepMs: number = DEFAULT_STAGE_SLEEP_MS,
): StageHandlerMap {
  return {
    A: async () => {
      await sleep(stageSleepMs);
      return { x: 10 };
    },
    B: async (inputs) => {
      await sleep(stageSleepMs);
      return { y: `B-got-${inputs.x as number}` };
    },
    C: async (inputs) => {
      await sleep(stageSleepMs);
      return { z: `C-got-${inputs.x as number}` };
    },
    D: async (inputs) => {
      await sleep(stageSleepMs);
      return { final: `${inputs.b as string}+${inputs.c as string}` };
    },
  };
}
