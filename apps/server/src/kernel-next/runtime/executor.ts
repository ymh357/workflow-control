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
  /**
   * A2.3.3 — cancellation signal plumbed from XState's invoked child.
   * When the TaskMachine receives INTERRUPT{stage}, the runner's
   * fromCallback actor aborts this signal. Executors that host a
   * long-running child (RealStageExecutor → AgentMachine) listen on
   * `signal.addEventListener('abort', ...)` and translate the abort
   * into an INTERRUPT event forwarded to the nested AgentMachine per
   * design §4.2. Executors without a nested machine (MockStageExecutor
   * / ScriptStageExecutor) may ignore the signal; the executor will
   * finish before the invoke is stopped anyway.
   *
   * Optional for backward compatibility — existing callers that don't
   * pass one degrade to "no interrupt support" which is the pre-A2.3.3
   * behaviour.
   */
  signal?: AbortSignal;
  /**
   * B17 full — when this call represents one element of a fanout stage,
   * carries the 0-based element index. Executors forward it to
   * PortRuntime.startAttempt so stage_attempts.fanout_element_idx gets
   * populated. Only meaningful on silent runtimes whose defaultKind is
   * 'fanout_element'; other runtimes silently drop it (see PortRuntime).
   */
  fanoutElementIdx?: number;
  /**
   * M-R5 — when resuming this stage from a prior crash, the SDK
   * session_id to continue. The real executor passes it as
   * `options.resume` so historical turns are not re-billed. On any
   * SDK failure (session file missing / corrupt) the executor falls
   * back silently to a fresh session. Executors that don't run the
   * Claude Agent SDK ignore this field.
   */
  resumeSessionId?: string;
  /**
   * M-R5 — historical num_turns already consumed by the prior run of
   * this stage. Used to clamp `maxTurns` so the resumed session does
   * not double the turn budget. Zero when there is no prior turn count
   * to inherit.
   */
  priorNumTurns?: number;
  /**
   * Single-session segment continuation (spec
   * 2026-04-25-single-session-mode-design §6.2). When set, this stage
   * is a non-first stage in an agent-only segment; the executor must:
   *   - pass `options.resume = resumeSessionId` to the SDK
   *   - clamp `maxTurns` against `priorNumTurns` (segment-wide sum)
   *   - render the prompt in continuation form (skip persona, keep
   *     reads-section)
   *
   * `priorAttempts` is informational — recorded for cross-reference
   * in execution-record but not consumed by the SDK call.
   *
   * Distinct from the existing M-R5 `resumeSessionId`/`priorNumTurns`
   * fields above: those are for crash-recovery resume of a single
   * stage. Both can coexist; segmentContinuation takes precedence
   * when both are set (the segment's session subsumes any per-stage
   * resume since the whole segment is one conversation).
   */
  segmentContinuation?: {
    resumeSessionId: string;
    priorNumTurns: number;
    priorAttempts: string[];
  };
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
