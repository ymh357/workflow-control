// Real stage executor — invokes the Claude Agent SDK per stage.
//
// Behaviour contract (see Phase 2 P1 plan):
//   1. Start a stage_attempt via PortRuntime.
//   2. Gather inputs from IR wires + record reads (same as MockStageExecutor).
//   3. Build a JSON-schema that mirrors stage.outputs (one property per
//      declared output port) and pass it to the SDK via `outputFormat:
//      json_schema`. This steers the model toward a strict final JSON object.
//   4. Run `query()` with:
//        - system prompt preset `claude_code` + an append describing the
//          stage contract (ports, expected JSON).
//        - kernel-next MCP (caller supplies the server instance) so tools
//          like read_port / write_port are reachable.
//        - permissions bypassed, dangerous skip enabled, settings sources []
//          (no user profile pollution).
//   5. Consume the stream; take the last `result` message. On success
//      (subtype='success'), parse structured_output if present, else
//      JSON.parse(result). On any non-success result subtype, record error.
//   6. Validate parsed object has one field per declared output port.
//      Missing any field -> record 'schema non-compliant: missing <port>'
//      and finishAttempt error.
//   7. For each declared output port, writePort.
//   8. finishAttempt success, return { attemptId, attemptIdx, status:
//      "success" }.
//
// Non-declared fields in the final JSON are ignored (same stance as
// mock-executor / legacy kernel's filterStoreWrites).

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options as SdkOptions } from "@anthropic-ai/claude-agent-sdk";
import { createActor, waitFor } from "xstate";
import type { PortIR, AgentStage, PipelineIR } from "../ir/schema.js";
import type {
  ExecuteStageArgs,
  ExecuteStageResult,
  StageExecutor,
} from "./executor.js";
import type { EventDispatcher } from "./port-runtime.js";
import type { PromptResolver } from "./prompt-resolver.js";
import { TrivialPromptResolver } from "./prompt-resolver.js";
import { createAgentMachine, type AgentMachineOutput } from "./agent-machine.js";
import { createSdkAdapter, type SdkMessageLike } from "./sdk-adapter.js";
import { pumpSdkStream } from "./stream-pump.js";
import {
  openExecutionRecordWriter,
  type ExecutionRecordWriter,
} from "./execution-record-writer.js";
import type { TerminationReason } from "./execution-record-types.js";
import { promptContentHash } from "../ir/canonical.js";
import { consumeHint, type MigrationHint } from "../hot-update/migration-hints.js";
export {
  buildSystemPromptAppend,
  exampleValueFor,
} from "./real-executor-prompt-builder.js";
import { buildSystemPromptAppend } from "./real-executor-prompt-builder.js";
import { buildSdkBaseOptions } from "./real-executor-sdk-options.js";
import {
  expandMcpServers,
  McpEnvExpansionError,
  type ExpandedMcpServer,
} from "./mcp-servers-expander.js";
import { loadTaskEnvValues } from "./task-env-values.js";
import {
  shouldPause,
  rateLimitBackoffMs,
} from "./rate-limit-backoff.js";
import type { KernelNextBroadcaster } from "../sse/broadcaster.js";

export interface RealStageExecutorOptions {
  /**
   * Factory producing a fresh MCP server per stage invocation. Receives
   * the live machine-bound dispatcher so that agent-side `write_port`
   * tool calls advance the XState runner (PORT_WRITTEN events).
   *
   * The Claude Agent SDK's MCP transport is single-use: once a server
   * instance has been connected inside one `query()` call, reusing it for
   * a second `query()` throws `Already connected to a transport`. Since
   * a pipeline runs N sequential `query()` calls (one per stage attempt),
   * we need a factory instead of a shared instance.
   */
  // Second argument is the runner's live PortRuntime. Pass it to
  // createKernelMcp's `portRuntime` option so MCP-initiated write_port
  // calls reuse the same runtime (and its onPortWritten hook) instead
  // of constructing a fresh one. Ignored by factories that only speak
  // to the dispatcher.
  mcpServerFactory: (
    dispatcher: EventDispatcher,
    portRuntime: import("./port-runtime.js").PortRuntime,
  ) => unknown;
  /** Defaults to "claude-haiku-4-5". */
  model?: string;
  /** Defaults to 10. */
  maxTurns?: number;
  /** Per-stage budget ceiling in USD. Defaults to 0.2. */
  maxBudgetUsd?: number;
  /** Path to the `claude` executable. Defaults to "claude". */
  claudePath?: string;
  /**
   * Max number of retries per stage on recoverable failures (schema
   * non-compliance, bad JSON, etc.). Default 0 (no retry). Each retry
   * starts a fresh stage_attempt with bumped attempt_idx; intermediate
   * failures are recorded silently (DB row status='error') without
   * dispatching STAGE_FAILED, so the machine stays in `executing` and
   * can advance once a retry succeeds.
   */
  maxRetries?: number;
  /**
   * Resolver turning AgentStage.promptRef into the actual user prompt.
   * Defaults to TrivialPromptResolver (promptRef === prompt string).
   * A registry-backed resolver arrives in A2 per design doc §2.3.
   */
  promptResolver?: PromptResolver;
  /**
   * Injection point for the SDK's `query` function. Tests override this
   * with a mock async iterable of SDK messages so RealStageExecutor can
   * be exercised end-to-end through AgentMachine without spawning the
   * Claude CLI. Production callers omit it (the real SDK query is used).
   */
  queryFn?: typeof query;
  /**
   * F3 (2026-04-23): per-task workspace directory. Forwarded to the SDK
   * as `options.cwd` so agents that use relative filesystem paths in
   * prompts (e.g. Write/Edit) stay sandboxed inside the task's own
   * workspace rather than polluting the server process cwd (P6-3 root
   * cause). When omitted, SDK default cwd (= `process.cwd()`) applies.
   * The kernel does NOT create this directory — caller (startPipelineRun)
   * owns allocation + mkdir, matching how worktreeSourceRepo is handled.
   */
  workspaceDir?: string;
  /**
   * P5.3 / D7 — SSE broadcaster for publishing `rate_limit_backoff`
   * events when the SDK's rate_limit_event stream crosses the
   * utilization pause threshold. Optional; when undefined the executor
   * silently skips publishing (tests, offline harnesses). The executor
   * never drives state transitions from a rate-limit signal — this
   * channel is observability-only.
   */
  broadcaster?: KernelNextBroadcaster;
}

// ---- M-R5 session-resume helpers ---------------------------------------
// Exported as pure functions so the resume math is covered without a
// queryFn harness. Consumed by real-executor's resume path and
// independently tested in real-executor.resume.test.ts.

/**
 * Remaining maxTurns budget when resuming an agent session. Subtracts
 * historical turns from the configured ceiling and floors at 1 — the
 * SDK may inject its own system turns on resume (init, context restore)
 * that weren't counted in the prior run, so clamping at 1 is safer than
 * letting the subtraction go negative.
 */
export function clampMaxTurns(configured: number, priorTurns: number): number {
  const remaining = configured - priorTurns;
  return remaining < 1 ? 1 : remaining;
}

/**
 * Sum every `num_turns` field on `result` messages in a serialized
 * agent_stream_json blob. Returns 0 for null / undefined / malformed
 * input. This mirrors the SDK's own turn counter (which only emits
 * num_turns on result messages, not on every assistant/tool entry).
 */
export function parseNumTurnsFromStream(raw: string | null | undefined): number {
  if (!raw) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 0;
  }
  if (!Array.isArray(parsed)) return 0;
  let total = 0;
  for (const entry of parsed) {
    if (
      entry !== null &&
      typeof entry === "object" &&
      (entry as { type?: unknown }).type === "result" &&
      typeof (entry as { num_turns?: unknown }).num_turns === "number"
    ) {
      total += (entry as { num_turns: number }).num_turns;
    }
  }
  return total;
}

const DEFAULT_MODEL = "claude-haiku-4-5";
const DEFAULT_MAX_TURNS = 10;
const DEFAULT_MAX_BUDGET_USD = 0.2;
const DEFAULT_CLAUDE_PATH = "claude";
const DEFAULT_MAX_RETRIES = 0;

export class RealStageExecutor implements StageExecutor {
  private readonly mcpServerFactory: (
    dispatcher: EventDispatcher,
    portRuntime: import("./port-runtime.js").PortRuntime,
  ) => unknown;
  private readonly model: string;
  private readonly maxTurns: number;
  private readonly maxBudgetUsd: number;
  private readonly claudePath: string;
  private readonly maxRetries: number;
  private readonly promptResolver: PromptResolver;
  private readonly queryFn: typeof query;
  private readonly workspaceDir: string | undefined;
  private readonly broadcaster: KernelNextBroadcaster | undefined;

  constructor(options: RealStageExecutorOptions) {
    this.mcpServerFactory = options.mcpServerFactory;
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.maxBudgetUsd = options.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD;
    this.claudePath = options.claudePath ?? DEFAULT_CLAUDE_PATH;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.promptResolver = options.promptResolver ?? new TrivialPromptResolver();
    this.queryFn = options.queryFn ?? query;
    this.workspaceDir = options.workspaceDir;
    this.broadcaster = options.broadcaster;
  }

  async executeStage(args: ExecuteStageArgs): Promise<ExecuteStageResult> {
    const { ir, stageName } = args;

    const stage = ir.stages.find((s) => s.name === stageName);
    if (!stage) throw new Error(`Stage '${stageName}' not in IR`);

    if (stage.type !== "agent") {
      throw new Error(
        `RealStageExecutor only handles agent stages; stage '${stageName}' is type '${stage.type}'. ` +
          `Script/gate dispatch is tracked under kernel-next A1 (see design doc §3.2).`,
      );
    }

    // Retry loop. Total allowed attempts = maxRetries + 1. Intermediate
    // failures are recorded silently (machine stays in `executing`); only
    // the final failure (or any success) surfaces to the machine via
    // PORT_WRITTEN / STAGE_FAILED.
    let lastResult: ExecuteStageResult | undefined;
    const totalAttempts = this.maxRetries + 1;
    for (let i = 0; i < totalAttempts; i++) {
      const isFinalAttempt = i === totalAttempts - 1;
      const result = await this.doAttempt(args, stage, isFinalAttempt);
      lastResult = result;
      if (result.status === "success") return result;
    }
    // If we got here, the last attempt failed. lastResult is always set.
    return lastResult!;
  }

  private async doAttempt(
    args: ExecuteStageArgs,
    stage: AgentStage,
    isFinalAttempt: boolean,
  ): Promise<ExecuteStageResult> {
    const { ir, stageName, taskId, versionHash, portValues, portRuntime, fanoutElementIdx } = args;
    const failSilently = !isFinalAttempt;

    // 1. Start attempt. Forward fanoutElementIdx (B17 full) so fanout_element
    //    rows carry their 0-based index; no-op on non-fanout attempts.
    const { attemptId, attemptIdx } = portRuntime.startAttempt({
      taskId, versionHash, stageName, fanoutElementIdx,
    });

    // 2. Gather inputs from wire sources + record reads.
    const inputs: Record<string, unknown> = {};
    for (const p of stage.inputs) {
      const wire = args.ir.wires.find(
        (w) => w.to.stage === stageName && w.to.port === p.name,
      );
      if (!wire) continue;
      // Bridge: Task 1.2 introduced WireSource. Task 1.3+ will resolve
      // external sources against the externalInputs namespace.
      const fromStage = wire.from.source === "external" ? "__external__" : wire.from.stage;
      const srcKey = `${fromStage}.${wire.from.port}`;
      const value = portValues[srcKey];
      inputs[p.name] = value;
      portRuntime.recordRead({
        attemptId, stageName, portName: p.name, value,
      });
    }

    // 3. Resolve the user prompt via the configured resolver. A2 may plug
    //    in a registry-backed resolver that looks up promptRef in a
    //    userland fragment library; today the trivial resolver returns
    //    promptRef verbatim.
    const userPrompt = this.promptResolver.resolve({
      stage, taskId, attemptId, inputs,
    });

    // 3b. Sidecar: open execution-record writer BEFORE any try/catch so
    //     the close paths below can reference it unconditionally. Writer
    //     is side-effect only — returns a no-op on FK violation or any
    //     DB error, never throws. See spec §5.2.
    const writer: ExecutionRecordWriter = openExecutionRecordWriter(
      portRuntime.getDb(),
      {
        attemptId,
        promptRef: stage.config.promptRef,
        promptContentHash: promptContentHash(userPrompt),
        promptContent: userPrompt,
        model: this.model,
        subAgents: stage.config.subAgents ?? null,
      },
    );

    // 4a. B9 migration hint (if this is the successor attempt of a
    //     superseded one). Consumed atomically so retries of the same
    //     stage inside one run don't re-inject the same hint twice.
    const migrationHint = consumeMigrationHint(portRuntime.getDb(), taskId, stageName);

    // 4b. System prompt append describing the stage contract — tool-call only.
    const systemPromptAppend = buildSystemPromptAppend(stage, userPrompt, inputs, {
      taskId, attemptId,
    }, migrationHint, ir);

    // 4. Run query() and consume stream. Output path is the MCP
    //    `write_port` tool (one call per declared output port). The final
    //    text message is ignored — no outputFormat.json_schema is sent.
    try {
      // Fresh MCP server per attempt — SDK's MCP transport is single-use.
      // The factory receives the machine-bound dispatcher so agent-side
      // write_port calls fire PORT_WRITTEN.
      const mcpServer = this.mcpServerFactory(portRuntime.getDispatcher(), portRuntime);
      const subAgents = stage.config.subAgents;
      // M-R5: clamp maxTurns for resumed sessions so historical turns
      // do not double the budget. Computed from priorNumTurns supplied
      // by the runner; zero on a fresh run leaves the ceiling alone.
      const effectiveMaxTurns = args.resumeSessionId
        ? clampMaxTurns(this.maxTurns, args.priorNumTurns ?? 0)
        : this.maxTurns;
      // P3.5: expand ${VAR} placeholders in stage.config.mcpServers into
      // concrete ExpandedMcpServer records. Precedence: task_env_values
      // (from run_pipeline args) > process.env. Missing variables fail
      // the stage with a MCP_ENV_MISSING diagnostic; downstream stages
      // never see a silent kernel-only fallback.
      let externalMcpServers: Record<string, ExpandedMcpServer> | undefined;
      if (stage.config.mcpServers && stage.config.mcpServers.length > 0) {
        const taskEnv = loadTaskEnvValues(portRuntime.getDb(), taskId);
        try {
          externalMcpServers = expandMcpServers(stage.config.mcpServers, taskEnv);
        } catch (e) {
          if (e instanceof McpEnvExpansionError) {
            const errMsg = `MCP_ENV_MISSING: server '${e.server}' field '${e.fieldKey}' references unset env variable '${e.variable}'`;
            writer.close({ terminationReason: "error" });
            portRuntime.finishAttempt(attemptId, "error", errMsg, { silent: failSilently });
            return { attemptId, attemptIdx, status: "error", error: errMsg };
          }
          throw e;
        }
      }
      // F3: set SDK cwd only when the caller supplied a workspace.
      // Otherwise leave it undefined so the SDK default (process.cwd())
      // stays in force, preserving legacy test expectations.
      const baseOptions: SdkOptions = buildSdkBaseOptions({
        systemPromptAppend,
        kernelMcp: mcpServer as NonNullable<SdkOptions["mcpServers"]>[string],
        model: this.model,
        maxTurns: effectiveMaxTurns,
        maxBudgetUsd: this.maxBudgetUsd,
        claudePath: this.claudePath,
        childEnv: buildChildEnv(),
        subAgents,
        workspaceDir: this.workspaceDir,
        externalMcpServers,
      });
      // M-R5: plumb the resume session id via options.resume when the
      // caller has one. queryFn failure (missing / corrupt session file)
      // surfaces as a thrown error inside the stream iteration below;
      // we catch it and restart with a fresh session instead of failing
      // the stage. Production SDK supports options.resume natively.
      const options: SdkOptions = args.resumeSessionId
        ? { ...baseOptions, resume: args.resumeSessionId }
        : baseOptions;

      const stream = this.queryFn({ prompt: userPrompt, options });

      // A2.2 — drive an AgentMachine via the SDK adapter instead of ad-hoc
      // result scanning. Every SDK message → 0+ AgentEvents → actor.send().
      // The machine reaches `done` (ok) or `error` (SDK returned non-success
      // or an error occurred mid-stream); final state's output carries the
      // diagnostic we surface as stage_attempt error text.
      //
      // A2.3.1 — pass kernel identifiers as XState `input` so the machine's
      // final output carries stage/task/attempt correlation IDs. When this
      // executor is later invoked by TaskMachine (A2.3.2), the parent's
      // `invoke.input` factory will populate the same fields; keeping the
      // wiring consistent on both call paths simplifies the migration.
      const agentActor = createActor(createAgentMachine(), {
        input: { stageName, taskId, attemptId },
      });
      agentActor.start();
      const adapter = createSdkAdapter();

      // A2.3.3 — bridge the parent's AbortSignal to an INTERRUPT event
      // on the inner AgentMachine. When the TaskMachine receives
      // INTERRUPT{stage} and sendTo's the stage's invoked child, the
      // runner's fromCallback aborts this signal; we translate that
      // into the §4.2 INTERRUPT event so the AgentMachine's state
      // matrix (arm on waiting_for_claude, defer on tool loop, etc.)
      // runs as designed. Listener is removed in the finally so we
      // don't leak across sequential stage attempts.
      const onAbort = () => {
        agentActor.send({ type: "INTERRUPT" });
      };
      if (args.signal) {
        if (args.signal.aborted) {
          // Signal already aborted (interrupt fired before executeStage
          // even started — e.g. XState stop-on-create). Send immediately.
          agentActor.send({ type: "INTERRUPT" });
        } else {
          args.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      // Sidecar capture: observe raw SDK messages for fields the
      // adapter intentionally collapses (assistant text/thinking
      // payloads, session_id, cost/usage). These ride alongside the
      // state machine — AgentMachine is the source of truth for
      // lifecycle; the writer records what was said.
      let capturedSessionId: string | null = null;
      let capturedCostUsd: number | null = null;
      let capturedTokenInput: number | null = null;
      let capturedTokenOutput: number | null = null;

      let agentOutput: AgentMachineOutput;
      try {
        // Stream pump extracted to stream-pump.ts so A2.3.2 can reuse it
        // when the AgentMachine is spawned as a TaskMachine invoked child.
        // Stop the actor in the finally below regardless of pump outcome.
        agentOutput = await pumpSdkStream({
          stream: stream as AsyncIterable<SdkMessageLike>,
          adapter,
          send: (ev) => {
            // Mirror SDK-adapter events into the sidecar writer. The
            // adapter emits ASSISTANT_TEXT without the text payload so
            // we capture those contents in onSdkMessage below — here
            // we only fan out tool-use correlation events (which DO
            // carry full id/name/input/output).
            if (ev.type === "TOOL_USE_REQUESTED") {
              writer.appendToolCall({
                id: ev.id,
                name: ev.name,
                input: ev.input,
                result: null,
                isError: false,
                tokenIn: null,
                tokenOut: null,
                durationMs: null,
                startedAt: new Date().toISOString(),
                finishedAt: null,
              });
            } else if (ev.type === "TOOL_RESULT_RECEIVED") {
              writer.completeToolCall(ev.id, {
                result: ev.output,
                finishedAt: new Date().toISOString(),
                ...(ev.isError === true ? { isError: true } : {}),
              });
            } else if (ev.type === "RESULT_SUCCESS") {
              if (typeof ev.cost_usd === "number") {
                capturedCostUsd = ev.cost_usd;
              }
            } else if (ev.type === "COMPACT_STARTED") {
              writer.appendCompactEvent({
                trigger: ev.trigger,
                preTokens: ev.pre_tokens,
                startedAt: new Date().toISOString(),
              });
            } else if (ev.type === "COMPACT_ENDED") {
              writer.completeCompactEvent(new Date().toISOString());
            }
            agentActor.send(ev);
            // P5.3 / D7 — observe the machine's updated rate-limit
            // counter AFTER send; publish a `rate_limit_backoff` SSE
            // event when this signal crossed the pause threshold.
            // The send is synchronous so the counter reflects this
            // exact event. Observability-only: the SDK itself handles
            // the real pacing internally; we surface the suggested
            // backoff so the dashboard can show "throttled by API".
            if (ev.type === "RATE_LIMIT_SIGNAL") {
              const util = ev.utilization;
              if (typeof util === "number" && shouldPause({ utilization: util })) {
                const signalCount = agentActor
                  .getSnapshot().context.consecutiveRateLimitSignals;
                const delayMs = rateLimitBackoffMs(signalCount);
                if (this.broadcaster) {
                  try {
                    this.broadcaster.publish({
                      type: "rate_limit_backoff",
                      taskId,
                      timestamp: new Date().toISOString(),
                      data: {
                        stage: stageName,
                        attemptId,
                        delayMs,
                        signalCount,
                        utilization: util,
                      },
                    });
                  } catch {
                    // broadcaster failure must not abort the stream
                  }
                }
              }
            }
          },
          onSdkMessage: (msg) => {
            // Capture content + metadata that the adapter collapses.
            if (msg.type === "system" && msg.subtype === "init") {
              const sid = (msg as { session_id?: unknown }).session_id;
              if (typeof sid === "string") {
                capturedSessionId = sid;
                // M-R5: persist session_id to DB immediately, not at
                // writer.close(). Mid-stage crash (SIGKILL between now
                // and close) otherwise loses the id — defeating SDK
                // session resume because orphan reconciler can't look
                // up what sid to pass to options.resume.
                writer.updateSessionId(sid);
              }
            }
            if (msg.type === "assistant") {
              const blocks = msg.message?.content ?? [];
              for (const b of blocks) {
                const rec = b as { type?: string; text?: unknown; thinking?: unknown };
                if (rec.type === "text" && typeof rec.text === "string") {
                  writer.appendAgentStream({
                    type: "text",
                    text: rec.text,
                    timestamp: new Date().toISOString(),
                  });
                } else if (rec.type === "thinking") {
                  const thinkingText = typeof rec.thinking === "string"
                    ? rec.thinking
                    : typeof rec.text === "string"
                      ? rec.text
                      : "";
                  writer.appendAgentStream({
                    type: "thinking",
                    text: thinkingText,
                    timestamp: new Date().toISOString(),
                  });
                }
              }
            }
            if (msg.type === "result" && msg.subtype === "success") {
              const usage = (msg as { usage?: { input_tokens?: unknown; output_tokens?: unknown } }).usage;
              if (usage) {
                if (typeof usage.input_tokens === "number") {
                  capturedTokenInput = usage.input_tokens;
                }
                if (typeof usage.output_tokens === "number") {
                  capturedTokenOutput = usage.output_tokens;
                }
              }
              if (typeof msg.total_cost_usd === "number") {
                capturedCostUsd = msg.total_cost_usd;
              }
            }
          },
          waitForFinal: async () => {
            const finalSnap = await waitFor(
              agentActor,
              (s) => s.status === "done",
              { timeout: 5_000 },
            );
            return finalSnap.output as AgentMachineOutput;
          },
        });
      } finally {
        if (args.signal) args.signal.removeEventListener("abort", onAbort);
        // Always stop the actor — even on adapter/stream errors or waitFor
        // timeout. Otherwise XState keeps a subscription alive and a later
        // test iteration's actor may race with this one.
        agentActor.stop();
      }

      if (agentOutput.status !== "done") {
        const diag = agentOutput.diagnostic;
        const msg = diag
          ? diag.message || `result subtype: ${diag.subtype}`
          : agentOutput.status === "interrupted"
            ? `agent interrupted (from=${agentOutput.interruptedFrom ?? "unknown"})`
            : "agent did not complete successfully";
        const termReason: TerminationReason =
          agentOutput.status === "interrupted" ? "interrupted" : "error";
        writer.close({
          terminationReason: termReason,
          costUsd: capturedCostUsd,
          tokenInput: capturedTokenInput,
          tokenOutput: capturedTokenOutput,
          sessionId: capturedSessionId,
        });
        portRuntime.finishAttempt(attemptId, "error", msg, { silent: failSilently });
        return { attemptId, attemptIdx, status: "error", error: msg };
      }

      // 5. Validate: did the agent write every declared output port via
      //    the write_port tool? Query port_values for this specific
      //    attempt. Any missing port is a compliance failure.
      const writtenRows = args.portRuntime
        ? queryAttemptPortWrites(args, attemptId)
        : [];
      const writtenMap = new Map<string, unknown>();
      for (const row of writtenRows) {
        writtenMap.set(row.port, row.value);
      }

      for (const p of stage.outputs) {
        if (!writtenMap.has(p.name)) {
          const errMsg = `schema non-compliant: agent did not call write_port for port '${p.name}'`;
          writer.close({
            terminationReason: "error",
            costUsd: capturedCostUsd,
            tokenInput: capturedTokenInput,
            tokenOutput: capturedTokenOutput,
            sessionId: capturedSessionId,
          });
          portRuntime.finishAttempt(attemptId, "error", errMsg, { silent: failSilently });
          return { attemptId, attemptIdx, status: "error", error: errMsg };
        }
        // Semantic check carried over from json_schema mode: a string port
        // whose value is actually a JSON-encoded object is a common Haiku
        // failure mode even via tool calls.
        if (p.type.trim() === "string") {
          const v = writtenMap.get(p.name);
          if (typeof v === "string") {
            const nested = detectNestedJson(v);
            if (nested) {
              const errMsg = `schema non-compliant: port '${p.name}' is declared as string but write_port value appears to contain nested JSON (${nested})`;
              writer.close({
                terminationReason: "error",
                costUsd: capturedCostUsd,
                tokenInput: capturedTokenInput,
                tokenOutput: capturedTokenOutput,
                sessionId: capturedSessionId,
              });
              portRuntime.finishAttempt(attemptId, "error", errMsg, { silent: failSilently });
              return { attemptId, attemptIdx, status: "error", error: errMsg };
            }
          }
        }
      }

      writer.close({
        terminationReason: "natural_completion",
        costUsd: capturedCostUsd,
        tokenInput: capturedTokenInput,
        tokenOutput: capturedTokenOutput,
        sessionId: capturedSessionId,
      });
      portRuntime.finishAttempt(attemptId, "success");
      return { attemptId, attemptIdx, status: "success" };
    } catch (err) {
      // Writer.close is idempotent — safe to call even if a success/error
      // branch above already closed it before throwing.
      writer.close({ terminationReason: "error" });
      const msg = err instanceof Error ? err.message : String(err);
      portRuntime.finishAttempt(attemptId, "error", msg, { silent: failSilently });
      return { attemptId, attemptIdx, status: "error", error: msg };
    }
  }
}

/**
 * Read all direction='out' port_values rows written during a specific
 * attempt. Used by RealStageExecutor to validate that the agent called
 * write_port for every declared output.
 */
function queryAttemptPortWrites(
  args: ExecuteStageArgs,
  attemptId: string,
): Array<{ port: string; value: unknown }> {
  // Reach through portRuntime to the db via a minimal shim: we don't want
  // to thread a db handle separately. port-runtime owns the db privately,
  // but we only need a read here. Use the runner's dispatcher-indirect
  // path: run a query via the underlying db behind portRuntime. Since
  // PortRuntime doesn't expose db, we rely on the caller's runner to
  // have created port_values rows observable to this same db.
  //
  // Implementation note: portRuntime is constructed in runner.ts with
  // `new PortRuntime(opts.db, dispatcher)`; ExecuteStageArgs does not
  // expose db. We work around by using the runner's portRuntime own
  // `readWritesForAttempt` helper below (added on PortRuntime).
  const rt = args.portRuntime as unknown as {
    readWritesForAttempt?: (attemptId: string) => Array<{ port: string; value: unknown }>;
  };
  if (typeof rt.readWritesForAttempt === "function") {
    return rt.readWritesForAttempt(attemptId);
  }
  return [];
}


// --- helpers ---

/**
 * Project a stage's declared output ports into a JSON-schema object.
 * Simple TS-type -> JSON schema mapping only. Complex TS types (unions,
 * generics, interfaces) are downgraded to `string` — the P1 goal is to
 * measure agent schema compliance on simple shapes, not to encode the full
 * TS type system.
 */
export function portsToJsonSchema(ports: PortIR[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of ports) {
    properties[p.name] = tsTypeToJsonSchema(p.type, p.name);
    required.push(p.name);
  }
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function tsTypeToJsonSchema(tsType: string, portName: string): Record<string, unknown> {
  const trimmed = tsType.trim();

  // boolean
  if (trimmed === "boolean") return { type: "boolean" };

  // number / integer
  if (trimmed === "number") return { type: "number" };

  // string / string literals
  if (trimmed === "string") return { type: "string" };

  // Array forms: T[] or Array<T>
  const arrayMatch = /^(?<inner>.+)\[\]$/.exec(trimmed);
  if (arrayMatch?.groups?.inner) {
    return {
      type: "array",
      items: tsTypeToJsonSchema(arrayMatch.groups.inner, `${portName}[]`),
    };
  }
  const arrayGeneric = /^Array<(?<inner>.+)>$/.exec(trimmed);
  if (arrayGeneric?.groups?.inner) {
    return {
      type: "array",
      items: tsTypeToJsonSchema(arrayGeneric.groups.inner, `${portName}[]`),
    };
  }

  // Plain object literal `{ ... }` or `object`
  if (trimmed === "object" || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    return { type: "object" };
  }

  // Record<string, ...> -> object (no per-property schema without a TS parser)
  if (/^Record<\s*string\s*,/.test(trimmed)) {
    return { type: "object" };
  }

  // Fallback: complex / unsupported TS type -> string. The P1 measurement
  // goal is "does the agent output the declared port keys?", not deep
  // type fidelity. Encoding unsupported types as string avoids blocking
  // experimentation on types the simple projection doesn't understand.
  return { type: "string" };
}

/**
 * Heuristic: does a string value look like it contains an embedded JSON
 * object or array that was supposed to be a sibling at the top level?
 *
 * Catches observed Haiku failure modes like:
 *   - final = '{"final": "..."}'              (top-level object swallowed)
 *   - z     = '{"z": "C saw 42"}'             (stage output swallowed)
 *   - items = '[{"id":"a"}]'                  (array-shaped ports)
 *
 * Returns a short reason string on match, or undefined when the value
 * looks like a plain natural-language string. Tolerates legitimate JSON
 * substrings like '{' or '}' anywhere inside normal prose.
 */
function detectNestedJson(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length < 2) return undefined;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === "{" && last === "}") || (first === "[" && last === "]")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object") {
        return Array.isArray(parsed)
          ? `value parses as JSON array`
          : `value parses as JSON object`;
      }
    } catch {
      // Not valid JSON despite the brackets — probably actual prose that
      // happens to start/end with a brace. Let it through.
    }
  }
  return undefined;
}

/**
 * Wraps consumeHint with a never-throw guard. If the hint table is
 * unavailable or the query fails for any reason, the executor
 * continues without injecting a migration note. B9 is advisory —
 * its absence never fails a stage.
 */
function consumeMigrationHint(
  db: import("node:sqlite").DatabaseSync,
  taskId: string,
  stageName: string,
): MigrationHint | null {
  try {
    return consumeHint(db, taskId, stageName);
  } catch {
    return null;
  }
}

/**
 * Build the env passed to the Claude Agent SDK subprocess.
 *
 * The SDK treats the `env` option as a whole-env override — if we pass
 * `{ ANTHROPIC_API_KEY: undefined, CI: "true" }` the subprocess loses
 * HOME/PATH and can't find the `~/.claude` credentials either. So:
 *   - Inherit the parent process.env as the base (HOME, PATH, NODE_*, etc.)
 *   - Force CLAUDECODE="" and CI="true" (same as legacy stage-executor)
 *   - Only set ANTHROPIC_API_KEY when the parent has it; otherwise let the
 *     Claude CLI fall back to ~/.claude local auth.
 */
function buildChildEnv(): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") inherited[k] = v;
  }
  inherited.CLAUDECODE = "";
  inherited.CI = "true";
  return inherited;
}

function safeJson(v: unknown, maxChars: number): string {
  try {
    const s = JSON.stringify(v);
    if (s === undefined) return String(v);
    return s.length > maxChars ? s.slice(0, maxChars) + " [...]" : s;
  } catch {
    return String(v);
  }
}
