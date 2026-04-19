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
import type { PortIR, AgentStage } from "../ir/schema.js";
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
  mcpServerFactory: (dispatcher: EventDispatcher) => unknown;
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
}

const DEFAULT_MODEL = "claude-haiku-4-5";
const DEFAULT_MAX_TURNS = 10;
const DEFAULT_MAX_BUDGET_USD = 0.2;
const DEFAULT_CLAUDE_PATH = "claude";
const DEFAULT_MAX_RETRIES = 0;

export class RealStageExecutor implements StageExecutor {
  private readonly mcpServerFactory: (dispatcher: EventDispatcher) => unknown;
  private readonly model: string;
  private readonly maxTurns: number;
  private readonly maxBudgetUsd: number;
  private readonly claudePath: string;
  private readonly maxRetries: number;
  private readonly promptResolver: PromptResolver;
  private readonly queryFn: typeof query;

  constructor(options: RealStageExecutorOptions) {
    this.mcpServerFactory = options.mcpServerFactory;
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.maxBudgetUsd = options.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD;
    this.claudePath = options.claudePath ?? DEFAULT_CLAUDE_PATH;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.promptResolver = options.promptResolver ?? new TrivialPromptResolver();
    this.queryFn = options.queryFn ?? query;
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
    const { stageName, taskId, versionHash, portValues, portRuntime } = args;
    const failSilently = !isFinalAttempt;

    // 1. Start attempt.
    const { attemptId, attemptIdx } = portRuntime.startAttempt({
      taskId, versionHash, stageName,
    });

    // 2. Gather inputs from wire sources + record reads.
    const inputs: Record<string, unknown> = {};
    for (const p of stage.inputs) {
      const wire = args.ir.wires.find(
        (w) => w.to.stage === stageName && w.to.port === p.name,
      );
      if (!wire) continue;
      const srcKey = `${wire.from.stage}.${wire.from.port}`;
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

    // 4. System prompt append describing the stage contract — tool-call only.
    const systemPromptAppend = buildSystemPromptAppend(stage, userPrompt, inputs, {
      taskId, attemptId,
    });

    // 4. Run query() and consume stream. Output path is the MCP
    //    `write_port` tool (one call per declared output port). The final
    //    text message is ignored — no outputFormat.json_schema is sent.
    try {
      // Fresh MCP server per attempt — SDK's MCP transport is single-use.
      // The factory receives the machine-bound dispatcher so agent-side
      // write_port calls fire PORT_WRITTEN.
      const mcpServer = this.mcpServerFactory(portRuntime.getDispatcher());
      const options: SdkOptions = {
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: systemPromptAppend,
        },
        mcpServers: {
          __kernel_next__: mcpServer as NonNullable<SdkOptions["mcpServers"]>[string],
        },
        model: this.model,
        maxTurns: this.maxTurns,
        maxBudgetUsd: this.maxBudgetUsd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        disallowedTools: ["ToolSearch", "mcp__claude_ai_*"],
        pathToClaudeCodeExecutable: this.claudePath,
        env: buildChildEnv(),
      };

      const stream = this.queryFn({ prompt: userPrompt, options });

      // A2.2 — drive an AgentMachine via the SDK adapter instead of ad-hoc
      // result scanning. Every SDK message → 0+ AgentEvents → actor.send().
      // The machine reaches `done` (ok) or `error` (SDK returned non-success
      // or an error occurred mid-stream); final state's output carries the
      // diagnostic we surface as stage_attempt error text.
      const agentActor = createActor(createAgentMachine());
      agentActor.start();
      const adapter = createSdkAdapter();

      let agentOutput: AgentMachineOutput;
      try {
        for await (const message of stream) {
          const events = adapter.translate(message as SdkMessageLike);
          for (const ev of events) agentActor.send(ev);
        }
        // Wait for the machine to reach a final state. The SDK stream has
        // already ended, so the terminal event should already be in the
        // actor's snapshot; waitFor below short-circuits if already-final.
        const finalSnap = await waitFor(
          agentActor,
          (s) => s.status === "done",
          { timeout: 5_000 },
        );
        agentOutput = finalSnap.output as AgentMachineOutput;
      } finally {
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
              portRuntime.finishAttempt(attemptId, "error", errMsg, { silent: failSilently });
              return { attemptId, attemptIdx, status: "error", error: errMsg };
            }
          }
        }
      }

      portRuntime.finishAttempt(attemptId, "success");
      return { attemptId, attemptIdx, status: "success" };
    } catch (err) {
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

function buildSystemPromptAppend(
  stage: AgentStage,
  resolvedPrompt: string,
  inputs: Record<string, unknown>,
  ctx: { taskId: string; attemptId: string },
): string {
  const inputPortLines = stage.inputs
    .map((p) => `  - ${p.name}: ${p.type}`)
    .join("\n");
  const outputPortLines = stage.outputs
    .map((p) => `  - ${p.name}: ${p.type}`)
    .join("\n");
  const promptSummary =
    resolvedPrompt.length > 400
      ? resolvedPrompt.slice(0, 400) + " [...]"
      : resolvedPrompt;
  const inputDump = Object.keys(inputs).length === 0
    ? "  (no inputs)"
    : Object.entries(inputs)
        .map(([k, v]) => `  - ${k} = ${safeJson(v, 400)}`)
        .join("\n");

  // Per-port write_port call examples grounded in the actual IDs.
  const writeCallExamples = stage.outputs
    .map((p) => {
      const valueExample = exampleValueFor(p.type);
      return `  write_port(taskId="${ctx.taskId}", attemptId="${ctx.attemptId}", stage="${stage.name}", port="${p.name}", value=${valueExample})`;
    })
    .join("\n");

  return [
    `You are running stage '${stage.name}' in a kernel-next pipeline.`,
    "",
    "### Stage contract",
    "Input ports (already materialized in this message):",
    inputPortLines || "  (none)",
    "Output ports you MUST produce:",
    outputPortLines || "  (none)",
    "",
    "### Inputs",
    inputDump,
    "",
    "### Task",
    promptSummary,
    "",
    "### Output protocol (MANDATORY — read carefully)",
    "The ONLY way to emit output for this stage is to call the MCP tool",
    "  `mcp__kernel_next__write_port`",
    "exactly once per declared output port. The arguments are:",
    "  - taskId      (use the exact string provided below)",
    "  - attemptId   (use the exact string provided below)",
    "  - stage       (this stage's name)",
    "  - port        (one of the declared output port names)",
    "  - value       (the port value — a plain JSON value of the declared type)",
    "",
    "Identity for this attempt (use verbatim):",
    `  taskId    = "${ctx.taskId}"`,
    `  attemptId = "${ctx.attemptId}"`,
    `  stage     = "${stage.name}"`,
    "",
    "Required tool calls for this stage:",
    writeCallExamples || "  (none — this stage has no declared outputs)",
    "",
    "CRITICAL RULES",
    "1. The `value` argument is the RAW port value. For a port declared",
    "   `string`, pass a plain string literal — NOT a JSON-encoded envelope",
    "   like '{\"<port>\": \"...\"}'. For `number`, pass a bare number.",
    "2. Do NOT return a final JSON object in your text reply. The text reply",
    "   is discarded. Only write_port tool calls count.",
    "3. Do NOT call write_port more than once per port. Do NOT omit any",
    "   declared port — missing ports fail the stage.",
    "4. After every declared output port has been written, you may end your",
    "   turn with a short confirmation message (one sentence). The kernel",
    "   only inspects the tool calls.",
  ].join("\n");
}

function exampleValueFor(tsType: string): string {
  const t = tsType.trim();
  if (t === "number") return "42";
  if (t === "boolean") return "true";
  if (t === "string") return "\"example plain text value\"";
  if (t.endsWith("[]") || /^Array</.test(t)) return "[]";
  if (t === "object" || (t.startsWith("{") && t.endsWith("}"))) return "{}";
  return "\"...\"";
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
