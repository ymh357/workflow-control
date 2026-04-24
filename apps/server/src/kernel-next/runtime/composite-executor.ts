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
  /**
   * Script executor for registry-backed ScriptStages
   * (config.source === "registry"). Consumes the builtin-script
   * registry via ScriptModuleResolver.
   */
  script?: StageExecutor;
  /**
   * D'-3: script executor for inline-source ScriptStages
   * (config.source === "inline"). Compiles config.moduleSource on
   * first invoke per (versionHash, stage) and runs it in-process.
   * When omitted, inline stages surface NO_EXECUTOR_FOR_SCRIPT_SOURCE
   * at runtime.
   */
  inlineScript?: StageExecutor;
  gate?: StageExecutor;
}

export class CompositeStageExecutor implements StageExecutor {
  private readonly agentExecutor: StageExecutor | undefined;
  private readonly scriptExecutor: StageExecutor | undefined;
  private readonly inlineScriptExecutor: StageExecutor | undefined;
  private readonly gateExecutor: StageExecutor | undefined;

  constructor(options: CompositeStageExecutorOptions) {
    this.agentExecutor = options.agent;
    this.scriptExecutor = options.script;
    this.inlineScriptExecutor = options.inlineScript;
    this.gateExecutor = options.gate;
  }

  async executeStage(args: ExecuteStageArgs): Promise<ExecuteStageResult> {
    const stage = args.ir.stages.find((s) => s.name === args.stageName);
    if (!stage) {
      throw new Error(`Stage '${args.stageName}' not in IR`);
    }
    let delegate: StageExecutor | undefined;
    if (stage.type === "agent") {
      delegate = this.agentExecutor;
    } else if (stage.type === "gate") {
      delegate = this.gateExecutor;
    } else if (stage.type === "script") {
      // D'-3: dispatch by config.source. Registry scripts go to the
      // registry executor; inline scripts compile + import their own
      // source.
      delegate = stage.config.source === "inline"
        ? this.inlineScriptExecutor
        : this.scriptExecutor;
      if (!delegate) {
        throw new Error(
          `CompositeStageExecutor: no executor registered for script stage '${stage.name}' ` +
            `with source='${stage.config.source}'. ` +
            `Register ${stage.config.source === "inline" ? "inlineScript" : "script"} in options.`,
        );
      }
    }
    if (!delegate) {
      throw new Error(
        `CompositeStageExecutor: no executor registered for stage type '${stage.type}' ` +
          `(stage '${args.stageName}')`,
      );
    }
    return delegate.executeStage(args);
  }
}
