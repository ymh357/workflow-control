// Real Claude-SDK-driven pipeline generator for Phase 2 A.
//
// Unlike generator-mock/mini-generator.ts which hardcodes IR, this module
// lets Claude produce an IR via the MCP `submit_pipeline` tool (or patch
// an existing one via `propose_pipeline_change`). The agent sees the
// full kernel-next MCP surface and the diagnostic feedback loop is the
// SDK's own multi-turn loop: when a tool call returns `{ok:false,
// diagnostics:[...]}`, Claude reads that on the next turn and retries.
//
// The "maxRetries" knob is bounded by `maxTurns` — the SDK owns the
// retry cadence. We measure: did a valid pipeline version land in the
// DB before the stream ended?
//
// This is a generator harness, not an executor; it does NOT run the
// generated pipeline. See generator-real/diamond-generate.ts for the
// stress harness that calls this.
//
// Observation strategy:
//   - Baseline snapshot DB version_hash set before run.
//   - After run, compare to see which new versions appeared.
//   - For `generateSubmit`, one new version == success.
//   - For `generatePatch`, one new version + one new pipeline_proposals
//     row with status='pending' == success.
//   - We do NOT parse intermediate tool_use / tool_result messages. The
//     DB is the single source of truth; if the agent's submit succeeded,
//     the row will exist.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options as SdkOptions } from "@anthropic-ai/claude-agent-sdk";
import type { DatabaseSync } from "node:sqlite";
import type { PipelineIR } from "../ir/schema.js";

const DEFAULT_MODEL = "claude-haiku-4-5";
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_BUDGET_USD = 0.3;
const DEFAULT_CLAUDE_PATH = "claude";

export interface GenerateSubmitArgs {
  /** Natural-language task description handed to the agent. */
  taskDescription: string;
  /** Fresh SDK MCP server (single-use transport). */
  mcpServer: unknown;
  db: DatabaseSync;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  claudePath?: string;
}

export interface GenerateSubmitResult {
  /** A new pipeline_versions row appeared in the DB. */
  ok: boolean;
  /** Hash of the new version (or null if none landed). */
  versionHash: string | null;
  /** IR parsed back from pipeline_versions.ir_json. */
  ir: PipelineIR | null;
  /** Number of assistant turns used. */
  numTurns: number;
  /** Total cost reported by SDK. */
  totalCostUsd: number;
  /** SDK result subtype ('success' | 'error_max_turns' | ...). */
  resultSubtype: string | null;
  /**
   * Number of distinct `submit_pipeline` tool invocations we observed in
   * the stream. A value >1 means Claude retried after at least one
   * rejected submission — the "diagnostic loop saved the run" signal.
   */
  submitAttempts: number;
  /** Durations etc. */
  durationMs: number;
}

export interface GeneratePatchArgs {
  baseVersion: string;
  taskDescription: string;
  mcpServer: unknown;
  db: DatabaseSync;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  claudePath?: string;
}

export interface GeneratePatchResult {
  ok: boolean;
  proposalId: string | null;
  proposedVersion: string | null;
  numTurns: number;
  totalCostUsd: number;
  resultSubtype: string | null;
  proposeAttempts: number;
  durationMs: number;
}

const SUBMIT_TOOL = "mcp__kernel_next__submit_pipeline";
const PROPOSE_TOOL = "mcp__kernel_next__propose_pipeline_change";

/**
 * Ask Claude to produce and submit a fresh pipeline.
 */
export async function generateSubmit(args: GenerateSubmitArgs): Promise<GenerateSubmitResult> {
  const startMs = Date.now();

  // Baseline: versions currently in DB so we can detect what the agent added.
  const baselineHashes = new Set(
    (args.db.prepare(`SELECT version_hash FROM pipeline_versions`).all() as Array<{ version_hash: string }>)
      .map((r) => r.version_hash),
  );

  const systemPromptAppend = buildSubmitSystemPrompt();

  const options: SdkOptions = {
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: systemPromptAppend,
    },
    mcpServers: {
      __kernel_next__: args.mcpServer as NonNullable<SdkOptions["mcpServers"]>[string],
    },
    model: args.model ?? DEFAULT_MODEL,
    maxTurns: args.maxTurns ?? DEFAULT_MAX_TURNS,
    maxBudgetUsd: args.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settingSources: [],
    // Limit surface to kernel-next MCP: no file system, no web, no git.
    // The generator's only job is to call submit_pipeline.
    allowedTools: [SUBMIT_TOOL, "mcp__kernel_next__validate_pipeline"],
    pathToClaudeCodeExecutable: args.claudePath ?? DEFAULT_CLAUDE_PATH,
    env: buildChildEnv(),
  };

  const stream = query({ prompt: args.taskDescription, options });

  const counts = { submit: 0, propose: 0 };
  let resultSubtype: string | null = null;
  let numTurns = 0;
  let totalCostUsd = 0;

  for await (const msg of stream) {
    countToolUses(msg as Record<string, unknown>, counts);
    if ((msg as Record<string, unknown>).type !== "result") continue;
    const r = msg as Record<string, unknown>;
    resultSubtype = typeof r.subtype === "string" ? r.subtype : null;
    numTurns = typeof r.num_turns === "number" ? r.num_turns : 0;
    totalCostUsd = typeof r.total_cost_usd === "number" ? r.total_cost_usd : 0;
  }

  // Any new version row that the agent deposited? Pick the newest.
  const newVersion = args.db.prepare(
    `SELECT version_hash, ir_json FROM pipeline_versions
     ORDER BY created_at DESC LIMIT 1`,
  ).get() as { version_hash: string; ir_json: string } | undefined;

  const landed = newVersion && !baselineHashes.has(newVersion.version_hash);

  return {
    ok: !!landed,
    versionHash: landed ? newVersion!.version_hash : null,
    ir: landed ? (JSON.parse(newVersion!.ir_json) as PipelineIR) : null,
    numTurns,
    totalCostUsd,
    resultSubtype,
    submitAttempts: counts.submit,
    durationMs: Date.now() - startMs,
  };
}

/**
 * Ask Claude to propose a patch against an existing pipeline version.
 */
export async function generatePatch(args: GeneratePatchArgs): Promise<GeneratePatchResult> {
  const startMs = Date.now();

  const baselineProposals = new Set(
    (args.db.prepare(`SELECT proposal_id FROM pipeline_proposals`).all() as Array<{ proposal_id: string }>)
      .map((r) => r.proposal_id),
  );

  // Extract the base IR so we can inline it into the prompt — the agent
  // needs to know the exact stages/ports/wires to patch against.
  const baseRow = args.db.prepare(
    `SELECT ir_json FROM pipeline_versions WHERE version_hash = ?`,
  ).get(args.baseVersion) as { ir_json: string } | undefined;
  if (!baseRow) {
    throw new Error(`baseVersion '${args.baseVersion}' not in DB`);
  }

  const systemPromptAppend = buildPatchSystemPrompt(args.baseVersion, baseRow.ir_json);

  const options: SdkOptions = {
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: systemPromptAppend,
    },
    mcpServers: {
      __kernel_next__: args.mcpServer as NonNullable<SdkOptions["mcpServers"]>[string],
    },
    model: args.model ?? DEFAULT_MODEL,
    maxTurns: args.maxTurns ?? DEFAULT_MAX_TURNS,
    maxBudgetUsd: args.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settingSources: [],
    allowedTools: [PROPOSE_TOOL, "mcp__kernel_next__validate_pipeline"],
    pathToClaudeCodeExecutable: args.claudePath ?? DEFAULT_CLAUDE_PATH,
    env: buildChildEnv(),
  };

  const stream = query({ prompt: args.taskDescription, options });

  const counts = { submit: 0, propose: 0 };
  let resultSubtype: string | null = null;
  let numTurns = 0;
  let totalCostUsd = 0;

  for await (const msg of stream) {
    countToolUses(msg as Record<string, unknown>, counts);
    if ((msg as Record<string, unknown>).type !== "result") continue;
    const r = msg as Record<string, unknown>;
    resultSubtype = typeof r.subtype === "string" ? r.subtype : null;
    numTurns = typeof r.num_turns === "number" ? r.num_turns : 0;
    totalCostUsd = typeof r.total_cost_usd === "number" ? r.total_cost_usd : 0;
  }

  const newProposal = args.db.prepare(
    `SELECT proposal_id, proposed_version, status FROM pipeline_proposals
     WHERE status = 'pending'
     ORDER BY created_at DESC LIMIT 1`,
  ).get() as
    | { proposal_id: string; proposed_version: string | null; status: string }
    | undefined;

  const landed = newProposal && !baselineProposals.has(newProposal.proposal_id);

  return {
    ok: !!landed,
    proposalId: landed ? newProposal!.proposal_id : null,
    proposedVersion: landed ? newProposal!.proposed_version : null,
    numTurns,
    totalCostUsd,
    resultSubtype,
    proposeAttempts: counts.propose,
    durationMs: Date.now() - startMs,
  };
}

// --- helpers ---

function countToolUses(
  msg: Record<string, unknown>,
  counts: { submit: number; propose: number },
): void {
  if (msg.type !== "assistant") return;
  const inner = msg.message as { content?: Array<Record<string, unknown>> } | undefined;
  const content = inner?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type !== "tool_use") continue;
    const name = typeof block.name === "string" ? block.name : "";
    if (name === SUBMIT_TOOL) counts.submit += 1;
    else if (name === PROPOSE_TOOL) counts.propose += 1;
  }
}

function buildSubmitSystemPrompt(): string {
  return [
    "You are the kernel-next pipeline generator. Your sole job is to",
    "produce a valid PipelineIR and submit it via the MCP tool",
    `  \`${SUBMIT_TOOL}\`.`,
    "",
    "### PipelineIR shape (summary)",
    "```",
    "{",
    "  name: string,                           // pipeline name",
    "  stages: Array<{",
    "    name: string,                         // identifier, unique in pipeline",
    "    type: 'agent' | 'script',",
    "    inputs:  Array<{ name: string, type: string }>,  // TS type source",
    "    outputs: Array<{ name: string, type: string }>,",
    "    config: {",
    "      engine?: 'claude',",
    "      prompt?: string,",
    "      script?: string",
    "    }",
    "  }>,",
    "  wires: Array<{",
    "    from: { stage: string, port: string },",
    "    to:   { stage: string, port: string }",
    "  }>",
    "}",
    "```",
    "",
    "### Rules",
    "1. Stage and port names must be valid JS identifiers and not TS",
    "   reserved words (no 'class', 'new', 'type', 'string', etc.). Good",
    "   names: 'scope', 'fetchDocs', 'result'. Bad: 'new', 'type'.",
    "2. Port `type` is a TypeScript type literal, e.g. `string`, `number`,",
    "   `string[]`, `{ topic: string; count: number }`. Do NOT use `any`,",
    "   `unknown`, or function types.",
    "3. Every wire's `from` must reference an existing stage's output port",
    "   and `to` must reference an existing stage's input port. Each input",
    "   port can be driven by at most ONE wire.",
    "4. The wire graph must be a DAG (no cycles).",
    "5. Wire type compatibility: the `from` port's TS type must be",
    "   assignable to the `to` port's TS type. If the validator rejects",
    "   with WIRE_TYPE_MISMATCH you need to change one side.",
    "",
    "### Output protocol",
    "Call the tool exactly ONCE when you're confident the IR is valid:",
    `  ${SUBMIT_TOOL}({ ir: <your IR> })`,
    "",
    "The tool returns `{ok: true, versionHash}` on success or",
    "`{ok: false, diagnostics: [{code, message, context}]}` on failure.",
    "If the submission fails, READ the diagnostics, fix the IR, and call",
    "the tool again. The diagnostic `code` tells you what's wrong:",
    "  - ZOD_PARSE_ERROR: shape mismatch (read `message`/`context.path`)",
    "  - DUPLICATE_STAGE_NAME / DUPLICATE_PORT_NAME",
    "  - WIRE_SOURCE_PORT_MISSING / WIRE_TARGET_PORT_MISSING",
    "  - WIRE_TARGET_ALREADY_DRIVEN (same input driven by two wires)",
    "  - DAG_HAS_CYCLE",
    "  - WIRE_TYPE_MISMATCH: adjust either port's `type`",
    "",
    "You may pre-flight with `mcp__kernel_next__validate_pipeline` if",
    "helpful (same diagnostics, no persistence).",
    "",
    "Do NOT emit the IR as text. Only the tool call counts. Once the tool",
    "returns `{ok:true}`, you're done — end your turn.",
  ].join("\n");
}

function buildPatchSystemPrompt(baseVersion: string, baseIrJson: string): string {
  return [
    "You are patching an existing kernel-next pipeline. Your job is to",
    "produce an IRPatch and submit it via",
    `  \`${PROPOSE_TOOL}\`.`,
    "",
    "### Base pipeline (version to patch against)",
    `  currentVersion = "${baseVersion}"`,
    "",
    "Base IR:",
    "```json",
    baseIrJson,
    "```",
    "",
    "### IRPatch shape",
    "```",
    "{",
    "  ops: Array<",
    "    | { op: 'add_stage', stage: StageIR }",
    "    | { op: 'remove_stage', stageName: string }",
    "    | { op: 'add_wire', wire: WireIR }",
    "    | { op: 'remove_wire', wire: WireIR }",
    "    | { op: 'update_port_type', stage: string, port: string,",
    "        direction: 'in' | 'out', newType: string }",
    "    | { op: 'update_stage_config', stage: string,",
    "        configPatch: { engine?, prompt?, script? } }",
    "  >",
    "}",
    "```",
    "",
    "### Rules",
    "1. All ops are applied IN ORDER to a copy of the base IR, then the",
    "   result is validated as a whole. Intermediate states are NOT",
    "   validated — you can e.g. `add_stage` + `add_wire` in one patch",
    "   where the wire depends on the newly added stage.",
    "2. `remove_stage` cascades: all wires touching that stage are dropped",
    "   automatically.",
    "3. The final IR must satisfy all the same rules as a submit: valid",
    "   identifiers, unique names, DAG, type-compatible wires.",
    "",
    "### Output protocol",
    `  ${PROPOSE_TOOL}({`,
    `    currentVersion: "${baseVersion}",`,
    "    patch: { ops: [ ... ] },",
    "    actor: 'ai:real-generator'",
    "  })",
    "",
    "Returns `{ok:true, proposalId, proposedVersion, autoApplied:false}`",
    "on success or `{ok:false, diagnostics:[...]}` on failure. Fix and",
    "retry on failure. Done when you get `{ok:true}`.",
  ].join("\n");
}

function buildChildEnv(): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") inherited[k] = v;
  }
  inherited.CLAUDECODE = "";
  inherited.CI = "true";
  return inherited;
}
