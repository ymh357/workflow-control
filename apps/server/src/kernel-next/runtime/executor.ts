// Stage executor abstraction — unified types + interface for both mock
// (hardcoded-handler dispatch) and real (Claude Agent SDK) executors.
//
// The runner invokes an executor when a stage region enters the `executing`
// substate. The executor is responsible for:
//   1. Starting a stage_attempt via PortRuntime.
//   2. Collecting input port values according to the IR's wires and
//      recording lineage reads.
//   3. Running the stage body (either a local handler or an agent SDK call).
//   4. Writing declared output ports (PortRuntime.writePort dispatches the
//      PORT_WRITTEN event that unblocks downstream stages).
//   5. Finalizing the stage_attempt (success/error).
//
// `handlers` is kept on the shared args shape for backward compatibility with
// the existing runner (which always passes a StageHandlerMap). Real executors
// ignore the field.

import type { PipelineIR } from "../ir/schema.js";
import type { PortRuntime } from "./port-runtime.js";

export interface StageHandlerContext {
  taskId: string;
  stageName: string;
  attemptId: string;
  attemptIdx: number;
}

export type StageHandler = (
  inputs: Record<string, unknown>,
  ctx: StageHandlerContext,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

export interface StageHandlerMap {
  [stageName: string]: StageHandler;
}

export interface ExecuteStageArgs {
  ir: PipelineIR;
  stageName: string;
  taskId: string;
  versionHash: string;
  portValues: Record<string, unknown>; // current in-memory view
  handlers: StageHandlerMap;           // used by MockStageExecutor only
  portRuntime: PortRuntime;
}

export interface ExecuteStageResult {
  attemptId: string;
  attemptIdx: number;
  status: "success" | "error";
  error?: string;
}

/**
 * Common contract implemented by MockStageExecutor (mock-executor.ts) and
 * RealStageExecutor (real-executor.ts). The runner holds one executor
 * instance per run and calls executeStage for each stage entering the
 * `executing` substate.
 */
export interface StageExecutor {
  executeStage(args: ExecuteStageArgs): Promise<ExecuteStageResult>;
}
