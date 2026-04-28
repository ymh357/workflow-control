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

import { randomUUID } from "node:crypto";
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
  type ExpandedMcpServer,
} from "./mcp-servers-expander.js";
import { loadTaskEnvValues } from "./task-env-values.js";
import { lookupEntryByCommand } from "../mcp-catalog/catalog-store.js";
import { resolveSecret } from "../mcp-catalog/inventory.js";
import {
  shouldPause,
  rateLimitBackoffMs,
} from "./rate-limit-backoff.js";
import type { KernelNextBroadcaster } from "../sse/broadcaster.js";
import { DeltaThrottler } from "./agent-message-delta.js";

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

/**
 * Promise-based delay that resolves early when `signal` aborts. Used inside
 * the MCP_STARTUP_RETRY backoff so cancel_task / migrate's INTERRUPT can
 * cut a retry-pending attempt short instead of waiting up to 10s for the
 * scheduled timer to elapse. Resolves silently in both cases — the caller
 * is expected to re-check signal.aborted and act accordingly.
 */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const DEFAULT_MODEL = "claude-haiku-4-5";
const DEFAULT_MAX_TURNS = 10;
const DEFAULT_MAX_BUDGET_USD = 0.2;
const DEFAULT_CLAUDE_PATH = "claude";
const DEFAULT_MAX_RETRIES = 0;
// F22 (2026-04-26): Number of free retries granted when an attempt fails with
// MCP_STARTUP_FAILED. Independent of maxRetries because this is an
// infrastructure-level race (cold-start npx) not a stage-logic error.
const MCP_STARTUP_RETRY_BUDGET = 3;

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
    //
    // F22 (2026-04-26): MCP_STARTUP_FAILED is a transient infrastructure
    // error — typically triggered when an `npx -y <package>` MCP subprocess
    // is still cold-starting when the SDK fires its system.init message.
    // We treat it as recoverable independently of the configured maxRetries:
    // up to MCP_STARTUP_RETRY_BUDGET extra attempts are granted, with a
    // short backoff between each so the npx download has time to complete.
    // Once another error type surfaces (genuine stage logic failure), the
    // budget is exhausted and the normal maxRetries gate applies.
    let lastResult: ExecuteStageResult | undefined;
    const totalAttempts = this.maxRetries + 1;
    let mcpStartupRetriesLeft = MCP_STARTUP_RETRY_BUDGET;
    for (let i = 0; i < totalAttempts; i++) {
      // A2 (2026-04-27): if the parent signal aborted BETWEEN attempts —
      // e.g. cancel_task fired during an MCP_STARTUP_RETRY backoff — stop
      // instead of starting another doAttempt. We only short-circuit when
      // a prior attempt already ran (lastResult set); a pre-aborted signal
      // on the first iteration still falls through to doAttempt so the
      // AgentMachine's §4.2 INTERRUPT-from-starting path produces the
      // canonical 'interrupted' diagnostic that callers (tests, runner)
      // already depend on.
      if (args.signal?.aborted && lastResult) {
        return lastResult;
      }
      const isFinalAttempt = i === totalAttempts - 1 && mcpStartupRetriesLeft === 0;
      const result = await this.doAttempt(args, stage, isFinalAttempt);
      lastResult = result;
      if (result.status === "success") return result;
      // F22: detect MCP_STARTUP_FAILED and grant a free retry slot.
      if (
        result.status === "error" &&
        result.error?.includes("MCP_STARTUP_FAILED") &&
        mcpStartupRetriesLeft > 0
      ) {
        mcpStartupRetriesLeft -= 1;
        // Don't advance i — this attempt was free.
        i -= 1;
        // Exponential-ish backoff: 2s, 5s, 10s. Short enough to not hold
        // the runner indefinitely; long enough for a typical npx install.
        const backoffMs =
          MCP_STARTUP_RETRY_BUDGET - mcpStartupRetriesLeft === 1 ? 2000
          : MCP_STARTUP_RETRY_BUDGET - mcpStartupRetriesLeft === 2 ? 5000
          : 10000;
        // A2 (2026-04-27): backoff is abortable. If cancel_task fires
        // mid-sleep, resolve early so the loop's signal check (above)
        // exits the retry budget instead of granting another attempt
        // after the user already asked for cancellation.
        await abortableDelay(backoffMs, args.signal);
      }
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
    // continuationMode iff the stage is a non-first stage WITHIN its segment
    // (the SDK already saw the segment-first stage's full prompt in this
    // same query). A segment-first stage that resumes a prior segment's
    // session uses FULL prompt form per spec §8.4 — see executor.ts
    // ExecuteStageArgs.segmentContinuation.isContinuationStage.
    const systemPromptAppend = buildSystemPromptAppend(stage, userPrompt, inputs, {
      taskId, attemptId,
    }, migrationHint, ir, {
      continuationMode: args.segmentContinuation?.isContinuationStage === true,
    });

    // F22 (2026-04-26): one AbortController per doAttempt call. Passed into
    // the SDK so the subprocess can be killed the moment this attempt is marked
    // terminal. Aborted at every finishAttempt(error/secret_pending/interrupted)
    // exit path and in the inner finally block as belt-and-suspenders. Declared
    // here (outside the outer try) so the catch block can also abort it.
    // Never shared across retries — executeStage calls doAttempt fresh each time.
    const abortController = new AbortController();

    // 4. Run query() and consume stream. Output path is the MCP
    //    `write_port` tool (one call per declared output port). The final
    //    text message is ignored — no outputFormat.json_schema is sent.
    try {
      // Fresh MCP server per attempt — SDK's MCP transport is single-use.
      // The factory receives the machine-bound dispatcher so agent-side
      // write_port calls fire PORT_WRITTEN.
      const mcpServer = this.mcpServerFactory(portRuntime.getDispatcher(), portRuntime);
      const subAgents = stage.config.subAgents;
      // M-R5 + single-session: pick which session_id (if any) to resume.
      // segmentContinuation (single-session mode) takes precedence over
      // M-R5 per-stage resumeSessionId; both can coexist on a resumed
      // pipeline whose runner happens to be in the middle of a segment.
      const sessionToResume =
        args.segmentContinuation?.resumeSessionId ?? args.resumeSessionId;
      const turnsAlreadyUsed =
        args.segmentContinuation?.priorNumTurns ?? args.priorNumTurns ?? 0;
      const effectiveMaxTurns = sessionToResume
        ? clampMaxTurns(this.maxTurns, turnsAlreadyUsed)
        : this.maxTurns;
      // P3.5: expand ${VAR} placeholders in stage.config.mcpServers into
      // concrete ExpandedMcpServer records. Precedence: task_env_values
      // (from run_pipeline args) > process.env.
      //
      // 2026-04-26 F17 secret-gate: missing keys no longer terminate the
      // stage as error. Instead the kernel writes a secret_gate_queue row
      // enumerating every missing envKey, finishes the attempt as
      // secret_pending, and returns a typed secret_pending result so the
      // runner can pause without writing task_finals. The provide_task_secrets
      // MCP tool resolves the row and resumes via the migration path.
      let externalMcpServers: Record<string, ExpandedMcpServer> | undefined;
      if (stage.config.mcpServers && stage.config.mcpServers.length > 0) {
        const expanderDb = portRuntime.getDb();
        const taskEnv = loadTaskEnvValues(expanderDb, taskId);
        // Phase 4: collect any MCP_INVENTORY_DECRYPT_FAILED that fires during
        // resolution so we can include it in the secret-pending error message.
        const decryptFailures: Array<{ entryId: string; envKey: string }> = [];
        const expandResult = expandMcpServers(stage.config.mcpServers, taskEnv, process.env, {
          resolveInventorySecret: (envKey) => {
            for (const decl of stage.config.mcpServers ?? []) {
              const entryId = lookupEntryByCommand(expanderDb, decl.command, decl.args);
              if (!entryId) continue;
              try {
                const v = resolveSecret({ db: expanderDb }, entryId, envKey);
                if (v !== null) return v;
              } catch (e) {
                const d = (e as { diagnostic?: { code?: string; context?: Record<string, unknown> } }).diagnostic;
                if (d?.code === "MCP_INVENTORY_DECRYPT_FAILED") {
                  decryptFailures.push({
                    entryId: String(d.context?.entryId ?? entryId),
                    envKey: String(d.context?.envKey ?? envKey),
                  });
                }
                // Treat as "no value" — secret-gate flow will prompt the
                // operator to refill. The augmented error message below
                // tells them that this is a decrypt failure, not a never-set
                // secret, so they know to re-equip via the catalog page.
              }
            }
            return null;
          },
        });
        if (!expandResult.ok) {
          const db = portRuntime.getDb();
          const secretGateId = randomUUID();
          db.prepare(
            `INSERT INTO secret_gate_queue
               (secret_gate_id, task_id, stage_name, attempt_id, required_keys, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(
            secretGateId,
            taskId,
            stage.name,
            attemptId,
            JSON.stringify(expandResult.missingKeys),
            Date.now(),
          );
          const decryptHint = decryptFailures.length > 0
            ? ` (${decryptFailures.length} stored secret${decryptFailures.length === 1 ? "" : "s"} unreadable: ${decryptFailures.map((f) => `MCP_INVENTORY_DECRYPT_FAILED for entry '${f.entryId}' envKey '${f.envKey}'`).join("; ")} — try re-equipping via /kernel-next/mcp-catalog)`
            : "";
          const errMsg = `MCP_ENV_MISSING: stage '${stage.name}' needs envKeys [${expandResult.missingKeys.join(", ")}]${decryptHint}`;
          writer.close({ terminationReason: "secret_pending" });
          abortController.abort();
          portRuntime.finishAttempt(attemptId, "secret_pending", errMsg, { silent: failSilently });
          return {
            attemptId,
            attemptIdx,
            status: "secret_pending",
            missingKeys: expandResult.missingKeys,
          };
        }
        externalMcpServers = expandResult.servers;
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
        abortController,
        stderr: (chunk) => filterAndAppendSdkStderr(chunk, writer),
      });
      // Plumb the resume session_id (M-R5 per-stage OR single-session
      // segment continuation; segment wins per §6.2). queryFn failure
      // (missing / corrupt session file) surfaces as a thrown error
      // inside the stream iteration below; we catch it and restart with
      // a fresh session instead of failing the stage.
      const options: SdkOptions = sessionToResume
        ? { ...baseOptions, resume: sessionToResume }
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
        // F22: kill the SDK subprocess immediately when the runner interrupts.
        // This prevents the agent from writing port_values after the attempt
        // is terminal. INTERRUPT to agentActor still runs so the §4.2 state
        // matrix executes its normal summary-turn logic.
        abortController.abort();
        agentActor.send({ type: "INTERRUPT" });
      };
      if (args.signal) {
        if (args.signal.aborted) {
          // Signal already aborted (interrupt fired before executeStage
          // even started — e.g. XState stop-on-create). Send immediately.
          abortController.abort();
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
      let capturedCacheReadInputTokens: number | null = null;
      let capturedCacheCreationInputTokens: number | null = null;

      // P7.4 / D29 — throttled live text-delta publisher. Only
      // instantiated when a broadcaster is wired; the pump path
      // tolerates its absence.
      const deltaThrottler = this.broadcaster
        ? new DeltaThrottler(this.broadcaster, taskId, attemptId, stageName)
        : null;

      // Synthetic heartbeat ping (dogfood Finding 8, 2026-04-26).
      // SDK thinking time emits no stream events; without this ping the
      // writer's last_heartbeat_at freezes for the duration of the think
      // (sometimes minutes). Monitors that watch heartbeat for liveness
      // then false-positive-cancel the agent. Ticking every 30s keeps
      // last_heartbeat_at moving regardless of stream activity, so the
      // signal reflects "agent process is alive" rather than "agent is
      // emitting tokens".
      const heartbeatTimer = setInterval(() => {
        try { writer.heartbeat(); } catch { /* writer may be closed mid-tick */ }
      }, 30_000);
      // Don't keep the event loop alive on an idle interval if the test
      // harness has no other handles open.
      heartbeatTimer.unref?.();

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
              // Bug-3 (dogfood): validate that every declared external
              // MCP server surfaced at least one tool. If the SDK spawned
              // the MCP subprocess but it died during initialization (bad
              // URL for mcp-remote, OAuth prompt without TTY, wrong
              // package name, etc.), the SDK silently ships zero tools
              // for that server. Without this check the agent runs with
              // an incomplete toolset, confabulates completion, and the
              // stage ends success=true with no real work done. Surface
              // a hard error instead so the caller sees exactly which
              // MCP never came up. Thrown errors propagate via
              // stream-pump → real-executor catch.
              if (externalMcpServers && Object.keys(externalMcpServers).length > 0) {
                const toolsList = (msg as { tools?: unknown }).tools;
                const advertised = Array.isArray(toolsList)
                  ? (toolsList as unknown[]).filter((t): t is string => typeof t === "string")
                  : [];
                const missing: string[] = [];
                for (const declaredName of Object.keys(externalMcpServers)) {
                  // SDK prefixes MCP tools as `mcp__<serverName>__<tool>`
                  // (Claude Agent SDK convention; our kernel MCP shows
                  // up as `mcp____kernel_next____*`, double underscore
                  // around an empty hyphen-group because our name has
                  // leading/trailing underscores — but external servers
                  // use the single-underscore form around the name).
                  const prefix = `mcp__${declaredName}__`;
                  const found = advertised.some((t) => t.startsWith(prefix));
                  if (!found) missing.push(declaredName);
                }
                if (missing.length > 0) {
                  throw new Error(
                    `MCP_STARTUP_FAILED: declared external MCP server(s) ${missing
                      .map((n) => `'${n}'`)
                      .join(", ")} did not advertise any tools at session init. ` +
                      `Likely causes: wrong URL for mcp-remote, npm package not found, ` +
                      `OAuth flow failed, or server crashed during handshake. ` +
                      `Re-run with verified MCP config or check the SDK stderr stream.`,
                  );
                }
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
                  // P7.4 / D29 — push text block into the throttled SSE
                  // publisher. The SDK delivers assistant messages as
                  // whole blocks (not sub-token deltas), so a single
                  // push per block is the finest granularity available.
                  // Thinking payloads are intentionally excluded — the
                  // dashboard's live panel surfaces user-visible output
                  // only, and thinking often dominates the byte volume.
                  if (deltaThrottler) deltaThrottler.push(rec.text);
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
              const usage = (msg as {
                usage?: {
                  input_tokens?: unknown;
                  output_tokens?: unknown;
                  // SDK v0.2.63 surfaces these two fields on the
                  // result.usage object (snake_case, mirroring the
                  // raw Anthropic API). The SDK's typed ModelUsage
                  // exposes the camelCase equivalents, but the raw
                  // message field is snake_case here.
                  cache_read_input_tokens?: unknown;
                  cache_creation_input_tokens?: unknown;
                };
              }).usage;
              if (usage) {
                if (typeof usage.input_tokens === "number") {
                  capturedTokenInput = usage.input_tokens;
                }
                if (typeof usage.output_tokens === "number") {
                  capturedTokenOutput = usage.output_tokens;
                }
                if (typeof usage.cache_read_input_tokens === "number") {
                  capturedCacheReadInputTokens = usage.cache_read_input_tokens;
                }
                if (typeof usage.cache_creation_input_tokens === "number") {
                  capturedCacheCreationInputTokens = usage.cache_creation_input_tokens;
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
        clearInterval(heartbeatTimer);
        if (args.signal) args.signal.removeEventListener("abort", onAbort);
        // Always stop the actor — even on adapter/stream errors or waitFor
        // timeout. Otherwise XState keeps a subscription alive and a later
        // test iteration's actor may race with this one.
        agentActor.stop();
        // F22 — belt-and-suspenders: abort the SDK controller on every exit
        // path so the subprocess never outlives this doAttempt frame.
        // abort() is idempotent so double-calling (success path, explicit
        // abort paths above) is harmless.
        if (!abortController.signal.aborted) abortController.abort();
        // P7.4 / D29 — flush any pending text so the dashboard sees the
        // tail end of the stream even when the stage ends between
        // flush-interval ticks. dispose() is a no-op when the buffer is
        // empty.
        if (deltaThrottler) deltaThrottler.dispose();
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
          cacheReadInputTokens: capturedCacheReadInputTokens,
          cacheCreationInputTokens: capturedCacheCreationInputTokens,
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
        cacheReadInputTokens: capturedCacheReadInputTokens,
        cacheCreationInputTokens: capturedCacheCreationInputTokens,
        sessionId: capturedSessionId,
      });
      portRuntime.finishAttempt(attemptId, "success");
      return { attemptId, attemptIdx, status: "success" };
    } catch (err) {
      // Writer.close is idempotent — safe to call even if a success/error
      // branch above already closed it before throwing.
      writer.close({ terminationReason: "error" });
      const msg = err instanceof Error ? err.message : String(err);
      // F22: abort the SDK controller so any still-running subprocess
      // (e.g. MCP_STARTUP_FAILED thrown mid-stream) terminates immediately.
      // The inner finally may have already aborted it; abort() is idempotent.
      abortController.abort();
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

// Bug 11 (2026-04-28): patterns that mark a stderr line as "operationally
// relevant" — the kind of failure operators need to see in the attempt
// log. Everything else (the SDK's verbose React/ink debug output, undici
// HTTP traces, telemetry) is dropped to keep agent_stream_json from
// ballooning. Adjust here when you discover a new useful signal.
const SDK_STDERR_INCLUDE_PATTERNS: RegExp[] = [
  /Connection failed after \d+ms/i, // MCP handshake failed (Bug 11 root)
  /MCP server .* failed/i,           // generic SDK MCP failure
  /Failed to connect SDK MCP server/i,
  /Authentication.*failed/i,         // OAuth flow died
  /MCPB.*(?:invalid|failed|error|missing)/i,
];

export function filterAndAppendSdkStderr(
  chunk: string,
  writer: ExecutionRecordWriter,
): void {
  // SDK delivers stderr in arbitrary chunks; split on \n so each meaningful
  // line is recorded (and timestamped) on its own.
  for (const rawLine of chunk.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (!SDK_STDERR_INCLUDE_PATTERNS.some((re) => re.test(line))) continue;
    try {
      writer.appendAgentStream({
        type: "sdk_stderr",
        text: line,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Writer may already be closed during teardown — discard silently.
    }
  }
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
