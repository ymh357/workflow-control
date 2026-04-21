// Mock handler registry — diamond-family only.
//
// AI-submitted pipelines and legacy-YAML builtins live in pipeline_versions
// and run through RealStageExecutor with DbPromptResolver. Only the
// in-memory demo/test pipelines (diamond / diamond-slow / diamond-real)
// require synthetic StageHandlerMap plumbing — they never had prompts on
// disk to begin with.
//
// startPipelineRun consults this map AFTER resolving a versionHash: if
// the requested name has an entry here, its handlers are passed to
// runPipeline; its ir is used to seed pipeline_versions if missing so
// that versionHash resolution works uniformly.

import { diamondIR } from "../generator-mock/mini-generator.js";
import { slowDiamondHandlers } from "../demo/slow-diamond.js";
import type { PipelineIR } from "../ir/schema.js";
import type { StageHandlerMap } from "./mock-executor.js";

export interface MockPipelineEntry {
  ir: PipelineIR;
  handlers: StageHandlerMap;
}

export const MOCK_HANDLER_REGISTRY: Record<string, MockPipelineEntry> = {
  diamond: {
    ir: diamondIR(),
    handlers: {
      A: () => ({ x: 10 }),
      B: (inputs) => ({ y: `B-got-${inputs.x as number}` }),
      C: (inputs) => ({ z: `C-got-${inputs.x as number}` }),
      D: (inputs) => ({ final: `${inputs.b as string}+${inputs.c as string}` }),
    },
  },
  "diamond-slow": {
    ir: diamondIR(),
    handlers: slowDiamondHandlers(),
  },
  "diamond-real": {
    ir: diamondIR(),
    handlers: {},
  },
};
