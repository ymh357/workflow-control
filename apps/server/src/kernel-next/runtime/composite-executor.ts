// Composite stage executor — routes ExecuteStageArgs to a per-stage-type
// delegate. Terminal design §3.2 has three primitives (agent, script, gate);
// Composite is the single StageExecutor runner sees while keeping each
// variant's implementation isolated.
//
// Missing delegates are a hard error at dispatch time (not construction),
// so tests and harnesses can build a Composite with only the variants they
// exercise. A pipeline that uses a stage type without a registered executor
// surfaces NO_EXECUTOR_FOR_STAGE_TYPE immediately.
//
// Fanout is intentionally NOT handled here. Fanout is an orchestration
// concern (N element attempts + 1 aggregate attempt for a single stage
// region), not a per-stage-type execution concern, and it requires
// runtime access (db, livePortRuntime) that is deliberately absent from
// ExecuteStageArgs. See runner.orchestrateFanoutStage for the full
// rationale.

import type { StageIR } from "../ir/schema.js";
import type {
  ExecuteStageArgs,
  ExecuteStageResult,
  StageExecutor,
} from "./executor.js";

export interface CompositeStageExecutorOptions {
  agent?: StageExecutor;
  script?: StageExecutor;
  gate?: StageExecutor;
}

export class CompositeStageExecutor implements StageExecutor {
  private readonly byType: Partial<Record<StageIR["type"], StageExecutor>>;

  constructor(options: CompositeStageExecutorOptions) {
    this.byType = {
      agent: options.agent,
      script: options.script,
      gate: options.gate,
    };
  }

  async executeStage(args: ExecuteStageArgs): Promise<ExecuteStageResult> {
    const stage = args.ir.stages.find((s) => s.name === args.stageName);
    if (!stage) {
      throw new Error(`Stage '${args.stageName}' not in IR`);
    }
    const delegate = this.byType[stage.type];
    if (!delegate) {
      throw new Error(
        `CompositeStageExecutor: no executor registered for stage type '${stage.type}' ` +
          `(stage '${args.stageName}')`,
      );
    }
    return delegate.executeStage(args);
  }
}
