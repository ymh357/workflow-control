import type { StateNode } from "./state-builders.js";
import type { PipelineStageConfig, AgentStageConfig, ScriptStageConfig, HumanGateRuntimeConfig, ConditionStageConfig, PipelineCallStageConfig, ForeachStageConfig, LlmDecisionStageConfig } from "../lib/config-loader.js";
import { buildAgentState, buildScriptState, buildHumanGateState, buildConditionState, buildPipelineCallState, buildForeachState, buildLlmDecisionState } from "./state-builders.js";

export type StageBuilderOpts = { blockedTarget?: string; statePrefix?: string; childToGroup?: Map<string, string> };

export function getStageBuilder(stage: PipelineStageConfig): ((nextTarget: string, prevAgentTarget: string, stageConfig: PipelineStageConfig, opts?: StageBuilderOpts) => StateNode) | null {
  if (stage.type === "agent" && stage.runtime?.engine === "llm") {
    return (next, prev, cfg, opts) => buildAgentState(next, prev, cfg as AgentStageConfig, opts);
  }
  if (stage.type === "script" && stage.runtime?.engine === "script") {
    return (next, prev, cfg, opts) => buildScriptState(next, prev, cfg as ScriptStageConfig, opts);
  }
  if (stage.type === "human_confirm" && stage.runtime?.engine === "human_gate") {
    return (next, prev, cfg, opts) => buildHumanGateState(next, prev, {
      ...(cfg.runtime as HumanGateRuntimeConfig),
      name: cfg.name,
    }, opts?.childToGroup);
  }
  if (stage.type === "condition" && stage.runtime?.engine === "condition") {
    return (next, prev, cfg, opts) => buildConditionState(next, prev, cfg as ConditionStageConfig, opts);
  }
  if (stage.type === "pipeline" && stage.runtime?.engine === "pipeline") {
    return (next, prev, cfg, opts) => buildPipelineCallState(next, prev, cfg as PipelineCallStageConfig, opts);
  }
  if (stage.type === "foreach" && stage.runtime?.engine === "foreach") {
    return (next, prev, cfg, opts) => buildForeachState(next, prev, cfg as ForeachStageConfig, opts);
  }
  if (stage.type === "llm_decision" && stage.runtime?.engine === "llm_decision") {
    return (next, prev, cfg, opts) => buildLlmDecisionState(next, prev, cfg as LlmDecisionStageConfig, opts);
  }
  return null;
}
