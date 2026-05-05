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
import { wireSourceKeyPrefix } from "../ir/wire-helpers.js";
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
   * Max number of in-attempt continuation rounds when the agent
   * completes its turn but fails the schema check (e.g. forgot to
   * call write_port for some declared output port). Each round
   * resumes the same SDK session via `options.resume = sessionId` and
   * sends a targeted feedback prompt — the agent does NOT redo prior
   * thinking. Default 2 rounds (so up to 3 total turns: original + 2
   * feedbacks). Set to 0 to disable continuation entirely (the legacy
   * behaviour: single shot, fail-on-noncompliance).
   *
   * Why this exists: 9 of the system's failed tasks (50% of
   * pipeline-generator failures) shared the root cause "agent did not
   * call write_port for port 'X'". The legacy maxRetries restarted
   * the whole stage from scratch — wasting all the prior reasoning
   * and giving the agent no specific feedback. Continuation retry is
   * cheaper (1-2 turns vs whole-stage replay) and more effective
   * (the agent sees the exact ports it missed and what was written).
   */
  maxNoncomplianceFeedback?: number;
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
// 2026-04-29 (continuation 9.5): bumped from 10 → 50.
//
// 10 turns was set when stages were narrow (~5 outputs, 1-2 MCP tool
// calls). After the 17-stage investigation skeleton landed, analyzing
// alone needs ~25-30 turns (17 write_port calls + 4-6 mcp catalog tool
// calls + a few thinking/text turns). Other long stages (evidenceGather
// fanout child doing web research; reportAssembly stitching findings
// + tutorials) sit in the same 15-25 range. Keeping 10 was the direct
// cause of dogfood failure #5 (analyzing terminated with reason='error'
// at turn 10 even though 17/17 ports were already written).
//
// 50 is generous but bounded — combined with maxBudgetUsd it caps cost
// per stage. Callers can still override via run_pipeline's maxTurns
// parameter or via PolicySchema.default.budget.maxTurns.
const DEFAULT_MAX_TURNS = 50;
const DEFAULT_MAX_BUDGET_USD = 0.2;
const DEFAULT_CLAUDE_PATH = "claude";
const DEFAULT_MAX_RETRIES = 0;
// 2026-05-06: Default continuation rounds when the agent completes a
// turn but fails the schema check. 2 rounds = up to 3 total turns
// (original + 2 feedbacks), which empirically catches every "forgot
// write_port" regression we have on file without unbounded loops on
// genuinely confused agents.
const DEFAULT_MAX_NONCOMPLIANCE_FEEDBACK = 2;
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
  private readonly maxNoncomplianceFeedback: number;
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
    this.maxNoncomplianceFeedback =
      options.maxNoncomplianceFeedback ?? DEFAULT_MAX_NONCOMPLIANCE_FEEDBACK;
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
      const srcKey = `${wireSourceKeyPrefix(wire)}.${wire.from.port}`;
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
    // Bug 61 (c12+ review): when the AED row INSERT failed, the
    // returned writer is the NoopWriter fallback. Subsequent
    // updateSessionId / updateCost calls silently no-op, so SDK
    // session resume on the next attempt would not find a session_id
    // and cost reporting would stay at $0. Surface a structured log
    // so operators see this as a real failure of the attempt's
    // observability sidecar — the executor still runs (the writer
    // contract preserves "never throw"), but downstream features
    // that depend on AED rows must be considered disabled for
    // this attempt.
    if (writer.degraded) {
      console.error(
        `[real-executor] execution-record writer is degraded ` +
        `(taskId=${taskId} attemptId=${attemptId} stage=${stageName}); ` +
        `SDK resume + cost reporting disabled for this attempt`,
      );
    }

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
        // Bug G runtime guard (D4 dogfood, 2026-04-30): historical IRs in
        // pipeline_versions can have envKeys without a matching ${VAR}
        // reference. The validator (structural.ts ENVKEY_NOT_REFERENCED)
        // rejects new IRs in this shape, but pre-fix versions remain
        // resolvable by name. Fail fast here with a clear actionable
        // message instead of letting the stage spawn the MCP child without
        // the envKey value (which produces an opaque handshake failure
        // that provide_task_secrets cannot recover from).
        const VAR_RE_BUG_G = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
        for (const srv of stage.config.mcpServers) {
          const declared = srv.envKeys ?? [];
          if (declared.length === 0) continue;
          const refs = new Set<string>();
          const collect = (s: string) => {
            const re = new RegExp(VAR_RE_BUG_G.source, "g");
            let m: RegExpExecArray | null;
            while ((m = re.exec(s)) !== null) refs.add(m[1]);
          };
          collect(srv.command);
          for (const a of srv.args ?? []) collect(a);
          if (srv.env) for (const v of Object.values(srv.env)) collect(v);
          const unreferenced = declared.filter((k) => !refs.has(k));
          if (unreferenced.length > 0) {
            const errMsg =
              `IR_BROKEN_ENVKEY_NOT_REFERENCED: stage '${stage.name}' mcpServer '${srv.name}' ` +
              `declares envKey(s) [${unreferenced.join(", ")}] but command/args/env contain no \${${unreferenced[0]}} reference. ` +
              `This pipeline IR was submitted before the validator rule ENVKEY_NOT_REFERENCED was added. ` +
              `provide_task_secrets cannot recover this stage because there is no \${VAR} placeholder for the value to substitute into. ` +
              `Re-submit the pipeline with env: { ${unreferenced.map((k) => `"${k}": "\${${k}}"`).join(", ")} } added to the mcpServer block.`;
            writer.close({ terminationReason: "error" });
            abortController.abort();
            // silent: false — this is an unrecoverable IR-shape error
            // (no amount of retry or secret-provision fixes it). The
            // operator must re-submit a corrected IR. Surfacing the
            // STAGE_FAILED event with the full message lets the runner
            // record the actionable detail in task_finals.
            portRuntime.finishAttempt(attemptId, "error", errMsg, { silent: false });
            return { attemptId, attemptIdx, status: "error" };
          }
        }
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

      // Cross-turn accumulators. The agent may take multiple turns
      // within a single attempt (initial turn + 0..maxNoncomplianceFeedback
      // continuation rounds when schema-check finds missing ports). cost
      // is summed; token counts and sessionId track the latest turn (the
      // SDK's resume path emits cumulative usage on the latest result).
      let totalCostUsd: number | null = null;
      let lastSessionId: string | null = null;
      let lastTokenInput: number | null = null;
      let lastTokenOutput: number | null = null;
      let lastCacheReadInputTokens: number | null = null;
      let lastCacheCreationInputTokens: number | null = null;

      // The user prompt for the current turn. Round 0 = the original
      // userPrompt (built from the IR + inputs). Round 1+ = a feedback
      // prompt enumerating the missing ports the previous turn forgot
      // to write. The agent resumes the same SDK session, so it sees
      // the feedback as the next user message in an ongoing dialogue.
      let turnPrompt = userPrompt;
      // sessionToResume sources: round 0 from the caller (M-R5 per-stage
      // resume OR single-session segment continuation). Round 1+ from
      // the previous round's captured session_id so the agent doesn't
      // have to re-see the system prompt or redo any reasoning.
      let turnResumeSessionId: string | undefined = sessionToResume;
      // Carries across turns if the previous round set agentOutput
      // status=done but failed schema check; null after a successful
      // round, otherwise the missing-port error string for diagnostics.
      let pendingFeedbackErr: string | null = null;

      // For each round we still need the budget calc that depends on
      // turnsAlreadyUsed at start of attempt. After round 0, the SDK's
      // resume already brings in prior turn count, so we pass the same
      // effectiveMaxTurns each round (clampMaxTurns is a per-resume
      // calculation, not a per-attempt one).

      // Loop bound: round = 0 is the initial turn; round 1..N are
      // continuation rounds. Total turns = 1 + maxNoncomplianceFeedback.
      const totalTurns = this.maxNoncomplianceFeedback + 1;
      let lastAgentOutput: AgentMachineOutput | undefined;

      for (let round = 0; round < totalTurns; round++) {
        // Fresh MCP server per turn — SDK's MCP transport is single-use.
        // Each new query() call needs its own server instance, otherwise
        // the SDK throws "Already connected to a transport".
        const mcpServer = this.mcpServerFactory(portRuntime.getDispatcher(), portRuntime);

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
        // queryFn failure (missing / corrupt session file) surfaces as a
        // thrown error inside the stream iteration below; we catch it and
        // restart with a fresh session instead of failing the stage.
        const options: SdkOptions = turnResumeSessionId
          ? { ...baseOptions, resume: turnResumeSessionId }
          : baseOptions;

        const stream = this.queryFn({ prompt: turnPrompt, options });

        // Drive an AgentMachine via the SDK adapter. Per-turn fresh
        // because the prior turn's actor is in the `done` final state
        // and its subscriptions must not leak across turns.
        const agentActor = createActor(createAgentMachine(), {
          input: { stageName, taskId, attemptId },
        });
        agentActor.start();
        const adapter = createSdkAdapter();

        const onAbort = () => {
          // F22: kill the SDK subprocess immediately when the runner interrupts.
          abortController.abort();
          agentActor.send({ type: "INTERRUPT" });
        };
        if (args.signal) {
          // Bug 2 fix (c12+ review): TOCTOU race. Register listener
          // FIRST, then re-check `.aborted`.
          args.signal.addEventListener("abort", onAbort, { once: true });
          if (args.signal.aborted) {
            args.signal.removeEventListener("abort", onAbort);
            abortController.abort();
            agentActor.send({ type: "INTERRUPT" });
          }
        }

        // Per-turn captured values. Reset each round; we accumulate to
        // the outer `total*` / track latest in `last*` after the round
        // finishes.
        let roundSessionId: string | null = null;
        let roundCostUsd: number | null = null;
        let roundTokenInput: number | null = null;
        let roundTokenOutput: number | null = null;
        let roundCacheReadInputTokens: number | null = null;
        let roundCacheCreationInputTokens: number | null = null;

        const deltaThrottler = this.broadcaster
          ? new DeltaThrottler(this.broadcaster, taskId, attemptId, stageName)
          : null;

        const heartbeatTimer = setInterval(() => {
          try { writer.heartbeat(); } catch { /* writer may be closed mid-tick */ }
        }, 30_000);
        heartbeatTimer.unref?.();

        let agentOutput: AgentMachineOutput;
        try {
          agentOutput = await pumpSdkStream({
            stream: stream as AsyncIterable<SdkMessageLike>,
            adapter,
            send: (ev) => {
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
                  roundCostUsd = ev.cost_usd;
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
              if (msg.type === "system" && msg.subtype === "init") {
                const sid = (msg as { session_id?: unknown }).session_id;
                if (typeof sid === "string") {
                  roundSessionId = sid;
                  // M-R5: persist session_id immediately so resume works
                  // even on mid-stage crash.
                  writer.updateSessionId(sid);
                }
                if (externalMcpServers && Object.keys(externalMcpServers).length > 0) {
                  const mcpServersList = (msg as {
                    mcp_servers?: Array<{ name?: unknown; status?: unknown }>;
                  }).mcp_servers ?? [];
                  const declared = Object.keys(externalMcpServers);
                  const failed: string[] = [];
                  const needsAuth: string[] = [];
                  const missing: string[] = [];
                  for (const name of declared) {
                    const entry = mcpServersList.find(
                      (s) => typeof s.name === "string" && s.name === name,
                    );
                    if (!entry) {
                      missing.push(name);
                      continue;
                    }
                    const status = typeof entry.status === "string" ? entry.status : "unknown";
                    if (status === "failed") failed.push(name);
                    else if (status === "needs-auth") needsAuth.push(name);
                  }
                  if (needsAuth.length > 0) {
                    throw new Error(
                      `MCP_NEEDS_AUTH: declared external MCP server(s) ${needsAuth
                        .map((n) => `'${n}'`)
                        .join(", ")} require operator authentication (OAuth or token). ` +
                        `Complete the auth flow and re-run; this is not a retryable failure.`,
                    );
                  }
                  if (failed.length > 0 || missing.length > 0) {
                    const allDead = [...failed, ...missing];
                    throw new Error(
                      `MCP_STARTUP_FAILED: declared external MCP server(s) ${allDead
                        .map((n) => `'${n}'`)
                        .join(", ")} did not connect at session init ` +
                        `(${failed.length} failed, ${missing.length} not enumerated by SDK). ` +
                        `Likely causes: wrong URL for mcp-remote, npm package not found, ` +
                        `server crashed during handshake, or cold-cache spawn exceeding SDK timeout. ` +
                        `Check the attempt's "SDK Stderr" tab for the upstream "Connection failed after Xms" line.`,
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
                    cache_read_input_tokens?: unknown;
                    cache_creation_input_tokens?: unknown;
                  };
                }).usage;
                if (usage) {
                  if (typeof usage.input_tokens === "number") {
                    roundTokenInput = usage.input_tokens;
                  }
                  if (typeof usage.output_tokens === "number") {
                    roundTokenOutput = usage.output_tokens;
                  }
                  if (typeof usage.cache_read_input_tokens === "number") {
                    roundCacheReadInputTokens = usage.cache_read_input_tokens;
                  }
                  if (typeof usage.cache_creation_input_tokens === "number") {
                    roundCacheCreationInputTokens = usage.cache_creation_input_tokens;
                  }
                }
                if (typeof msg.total_cost_usd === "number") {
                  roundCostUsd = msg.total_cost_usd;
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
          agentActor.stop();
          // F22: don't abort the controller here — subsequent rounds
          // need the same controller alive. Abort is owned by the outer
          // try/catch finally and the per-round interrupt handler.
          if (deltaThrottler) deltaThrottler.dispose();
        }

        // Roll round-local capture into outer trackers BEFORE we decide
        // whether to retry or commit, so a feedback round still records
        // its cost / session_id even if it ends up failing too.
        if (roundCostUsd !== null) {
          totalCostUsd = (totalCostUsd ?? 0) + roundCostUsd;
        }
        if (roundSessionId !== null) lastSessionId = roundSessionId;
        if (roundTokenInput !== null) lastTokenInput = roundTokenInput;
        if (roundTokenOutput !== null) lastTokenOutput = roundTokenOutput;
        if (roundCacheReadInputTokens !== null) {
          lastCacheReadInputTokens = roundCacheReadInputTokens;
        }
        if (roundCacheCreationInputTokens !== null) {
          lastCacheCreationInputTokens = roundCacheCreationInputTokens;
        }
        lastAgentOutput = agentOutput;

        // Non-success agent termination: not retryable. The continuation
        // path only handles the "agent finished its turn but missed a
        // port" case. Interrupts, errored SDK results, etc. fail outright.
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
            costUsd: totalCostUsd,
            tokenInput: lastTokenInput,
            tokenOutput: lastTokenOutput,
            cacheReadInputTokens: lastCacheReadInputTokens,
            cacheCreationInputTokens: lastCacheCreationInputTokens,
            sessionId: lastSessionId,
          });
          // F22: abort the SDK controller so any straggler subprocess
          // terminates immediately. abort() is idempotent.
          abortController.abort();
          portRuntime.finishAttempt(attemptId, "error", msg, { silent: failSilently });
          return { attemptId, attemptIdx, status: "error", error: msg };
        }

        // Schema check: did the agent write every declared output port?
        const writtenRows = args.portRuntime
          ? queryAttemptPortWrites(args, attemptId)
          : [];
        const writtenMap = new Map<string, unknown>();
        for (const row of writtenRows) {
          writtenMap.set(row.port, row.value);
        }

        const missingPorts: string[] = [];
        const nestedJsonViolations: Array<{ port: string; nested: string }> = [];
        for (const p of stage.outputs) {
          if (!writtenMap.has(p.name)) {
            missingPorts.push(p.name);
            continue;
          }
          if (p.type.trim() === "string") {
            const v = writtenMap.get(p.name);
            if (typeof v === "string") {
              const nested = detectNestedJson(v);
              if (nested) {
                nestedJsonViolations.push({ port: p.name, nested });
              }
            }
          }
        }

        if (missingPorts.length === 0 && nestedJsonViolations.length === 0) {
          // Success — exit retry loop, fall through to writer.close +
          // finishAttempt success below.
          pendingFeedbackErr = null;
          break;
        }

        // Out of retries: commit the failure with an augmented message
        // so operators see "after N feedback rounds" and know retry was
        // attempted but didn't help. Single-port-missing fail messages
        // preserve the exact pre-2026-05-06 wording so the existing
        // "agent did not call write_port for port 'X'" matchers in tests
        // and dashboards keep working when maxNoncomplianceFeedback === 0.
        const isLastRound = round === totalTurns - 1;
        if (isLastRound) {
          let errMsg: string;
          if (totalTurns === 1) {
            // Legacy form (no feedback retries): preserve exact wording
            // for downstream consumers.
            if (missingPorts.length > 0) {
              errMsg = `schema non-compliant: agent did not call write_port for port '${missingPorts[0]!}'`;
            } else if (nestedJsonViolations.length > 0) {
              const v = nestedJsonViolations[0]!;
              errMsg = `schema non-compliant: port '${v.port}' is declared as string but write_port value appears to contain nested JSON (${v.nested})`;
            } else {
              errMsg = "schema non-compliant"; // unreachable
            }
          } else {
            const errParts: string[] = [];
            if (missingPorts.length > 0) {
              errParts.push(
                `agent did not call write_port for port(s) [${missingPorts
                  .map((n) => `'${n}'`)
                  .join(", ")}]`,
              );
            }
            for (const v of nestedJsonViolations) {
              errParts.push(
                `port '${v.port}' is declared as string but write_port value appears to contain nested JSON (${v.nested})`,
              );
            }
            const suffix = ` (after ${this.maxNoncomplianceFeedback} feedback retr${this.maxNoncomplianceFeedback === 1 ? "y" : "ies"})`;
            errMsg = `schema non-compliant${suffix}: ${errParts.join("; ")}`;
          }
          writer.close({
            terminationReason: "error",
            costUsd: totalCostUsd,
            tokenInput: lastTokenInput,
            tokenOutput: lastTokenOutput,
            cacheReadInputTokens: lastCacheReadInputTokens,
            cacheCreationInputTokens: lastCacheCreationInputTokens,
            sessionId: lastSessionId,
          });
          abortController.abort();
          portRuntime.finishAttempt(attemptId, "error", errMsg, { silent: failSilently });
          return { attemptId, attemptIdx, status: "error", error: errMsg };
        }

        // Build the feedback prompt for the next round. Targeted: lists
        // only the ports the agent missed; tells it explicitly NOT to
        // redo prior work; gives the exact tool call shape.
        pendingFeedbackErr = "missing/nested-json port writes";
        const feedbackLines: string[] = [];
        feedbackLines.push(
          `You completed your turn but the schema check failed. ` +
            `Do NOT redo any prior work — your reasoning and tool calls so far are preserved. ` +
            `Just call the write_port tool for each problem below, then stop.`,
        );
        if (missingPorts.length > 0) {
          feedbackLines.push("");
          feedbackLines.push(`Missing write_port for declared output port(s):`);
          for (const portName of missingPorts) {
            const portDef = stage.outputs.find((p) => p.name === portName);
            const typeHint = portDef ? ` (type: ${portDef.type})` : "";
            feedbackLines.push(`  - '${portName}'${typeHint}`);
          }
        }
        if (nestedJsonViolations.length > 0) {
          feedbackLines.push("");
          feedbackLines.push(`String-typed ports written with embedded JSON (write the unwrapped string value instead):`);
          for (const v of nestedJsonViolations) {
            feedbackLines.push(`  - '${v.port}' (${v.nested})`);
          }
        }
        feedbackLines.push("");
        feedbackLines.push(
          `Use the write_port tool: write_port({stage: "${stageName}", port: "<name>", value: <value>}). ` +
            `Do not emit a final text reply about it — just make the tool call(s).`,
        );
        turnPrompt = feedbackLines.join("\n");
        // Resume from the just-finished round's session so the agent
        // sees the feedback in context, not from scratch.
        turnResumeSessionId = roundSessionId ?? turnResumeSessionId;
        // Loop continues with the next round.
      }

      // Out-of-loop success path: reached only when a round broke out via
      // pendingFeedbackErr === null AND lastAgentOutput.status === "done".
      // The fail-paths above all `return` directly.
      void pendingFeedbackErr;
      void lastAgentOutput;
      writer.close({
        terminationReason: "natural_completion",
        costUsd: totalCostUsd,
        tokenInput: lastTokenInput,
        tokenOutput: lastTokenOutput,
        cacheReadInputTokens: lastCacheReadInputTokens,
        cacheCreationInputTokens: lastCacheCreationInputTokens,
        sessionId: lastSessionId,
      });
      // F22: abort the SDK controller now that the attempt is complete
      // so any straggler subprocess (e.g. mid-tool-result that we no
      // longer care about) terminates immediately. Idempotent.
      if (!abortController.signal.aborted) abortController.abort();
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
