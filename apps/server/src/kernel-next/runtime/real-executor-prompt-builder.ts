// Prompt builder for the real stage executor.
//
// Pure functions that construct the system-prompt `append` passed to
// the Claude Agent SDK for one stage attempt. Extracted from
// real-executor.ts (D34 refactor) so the prompt logic is independently
// testable without pulling in the full executor dependencies.

import type { AgentStage, PipelineIR } from "../ir/schema.js";
import type { MigrationHint } from "../hot-update/migration-hints.js";

// chosen so typical stringified port values under ~1 KiB inline (≈
// 250 tokens), values above are at risk of being multiple KB and
// burning token budget for content the agent may not use.
export const INLINE_PORT_VALUE_CHAR_LIMIT = 1024;

// Stage's user prompt hard-cap. Beyond this we slice + append "[...]"
// to bound the append. Authors are expected to keep stage prompts
// terse; this is a belt-and-braces cap, not a design constraint.
export const PROMPT_SUMMARY_CHAR_LIMIT = 400;

/**
 * Build the system-prompt `append` passed to the Claude Agent SDK
 * for one stage attempt. Exported for unit tests.
 *
 * Size-aware input handling:
 *   - Small port value (JSON.stringify length ≤ INLINE_PORT_VALUE_CHAR_LIMIT):
 *     inline the full value into `### Inputs`.
 *   - Large port value: emit a `<inlined: false>` summary line with
 *     type + byte size and direct the agent to call
 *     `mcp____kernel_next____read_port({taskId, stage, port})` to fetch
 *     the complete value.
 *
 * Saves tokens on large inputs the agent may not need, and (equally
 * important) gives the agent access to the FULL value when it does
 * need it — the prior 400-char truncation showed agents the first
 * 400 chars of a 50 KiB research report, which was silently lossy.
 */
export function buildSystemPromptAppend(
  stage: AgentStage,
  resolvedPrompt: string,
  inputs: Record<string, unknown>,
  ctx: { taskId: string; attemptId: string },
  migrationHint?: MigrationHint | null,
  // P6-12: optional ir so read_port instructions point at the correct
  // upstream stage that produced this input, not at the stage
  // consuming it. When omitted (legacy callers / isolated tests), we
  // fall back to stage.name — which is wrong for any cross-stage wire
  // but preserves pre-fix behavior for existing tests.
  ir?: PipelineIR,
  options?: { continuationMode?: boolean },
): string {
  const inputPortLines = stage.inputs
    .map((p) => `  - ${p.name}: ${p.type}`)
    .join("\n");
  const outputPortLines = stage.outputs
    .map((p) => `  - ${p.name}: ${p.type}`)
    .join("\n");
  const promptSummary =
    resolvedPrompt.length > PROMPT_SUMMARY_CHAR_LIMIT
      ? resolvedPrompt.slice(0, PROMPT_SUMMARY_CHAR_LIMIT) + " [...]"
      : resolvedPrompt;
  // Build a port-name -> source-stage map from ir.wires so
  // formatInputLine can name the right upstream without reimplementing
  // the lookup. External-source wires contribute no stage entry — for
  // those the fallback to stage.name is still wrong but less common
  // (externals are seeded once and typically small).
  const inputSourceStage = new Map<string, string>();
  if (ir) {
    for (const w of ir.wires) {
      if (w.to.stage !== stage.name) continue;
      if (w.from.source !== "stage") continue;
      inputSourceStage.set(w.to.port, w.from.stage);
    }
  }
  const inputDump = Object.keys(inputs).length === 0
    ? "  (no inputs)"
    : Object.entries(inputs)
        .map(([k, v]) =>
          formatInputLine(k, v, inputSourceStage.get(k) ?? stage.name, ctx))
        .join("\n");

  // Per-port write_port call examples grounded in the actual IDs.
  const writeCallExamples = stage.outputs
    .map((p) => {
      const valueExample = exampleValueFor(p.type);
      return `  write_port(taskId="${ctx.taskId}", attemptId="${ctx.attemptId}", stage="${stage.name}", port="${p.name}", value=${valueExample})`;
    })
    .join("\n");

  // Check if inputs are empty or sparse (all provided inputs are empty objects/arrays)
  const allInputsEmpty = Object.entries(inputs).every(
    ([, v]) => v === null || v === undefined || (typeof v === "object" && Object.keys(v as Record<string, unknown>).length === 0),
  );
  const emptyInputsWarning = allInputsEmpty && Object.keys(inputs).length > 0
    ? "\n### IMPORTANT: Empty or sparse inputs detected\nAll provided inputs are empty. You must still emit write_port calls for all output ports. Use appropriate empty/default values:\n" +
      "  - For string ports: use an empty string \"\" or an error message\n" +
      "  - For number ports: use 0 or -1\n" +
      "  - For array ports (string[], etc.): use an empty array []\n" +
      "If you cannot proceed due to missing input data, emit these default values for each port and describe the issue in a string port (e.g., summary or error_message if available)."
    : "";

  const migrationNote = migrationHint ? renderMigrationNote(migrationHint) : "";

  if (options?.continuationMode === true) {
    // Continuation form for single-session mode segments. The SDK has
    // the segment's prior agent turns in conversation history, so we
    // can drop the segment-invariant preamble + Stage-contract block.
    // Per-stage content (Inputs, Task, Output protocol, Identity,
    // CRITICAL RULES) MUST be re-emitted: output ports differ per
    // stage; SDK needs explicit write_port instructions every turn.
    //
    // TODO(future, app-level summary): once a single-session segment
    // grows long (n stages, each with multi-KB reads), the continuation
    // prompt re-injects every input again — even though the SDK has
    // already seen the upstream stage's writes in conversation history.
    // We could let each stage emit a structured `summary` write
    // alongside its real outputs (declared via store_schema) and have
    // downstream stages read the summary instead of the full upstream
    // payload. Trigger condition: cumulative inputDump size > N tokens
    // OR cache_read regression observed in v_segment_continuity. Not
    // doing now — current continuation form is already cache-friendly
    // (Anthropic prompt cache hits the repeated preamble/identity
    // block) and dogfood evidence shows token_input on continuation
    // stages is double-digit. Revisit when a real pipeline shows the
    // problem.

    return [
      "### Inputs",
      inputDump,
      "",
      "### Task",
      promptSummary,
      emptyInputsWarning,
      migrationNote,
      "",
      "### Output protocol (MANDATORY — read carefully)",
      "The ONLY way to emit output for this stage is to call the MCP tool",
      "  `mcp____kernel_next____write_port`",
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
    emptyInputsWarning,
    migrationNote,
    "",
    "### Output protocol (MANDATORY — read carefully)",
    "The ONLY way to emit output for this stage is to call the MCP tool",
    "  `mcp____kernel_next____write_port`",
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

export function exampleValueFor(tsType: string): string {
  const t = tsType.trim();
  if (t === "number") return "42";
  if (t === "boolean") return "true";
  if (t === "string") return "\"example plain text value\"";
  if (t.endsWith("[]") || /^Array</.test(t)) return "[]";
  if (t === "object" || (t.startsWith("{") && t.endsWith("}"))) return "{}";
  return "\"...\"";
}

/**
 * Render one entry of the `### Inputs` block. Inline full JSON for
 * small values; for large values, emit a summary line + read_port
 * instruction so the agent can fetch on demand.
 */
function formatInputLine(
  portName: string,
  value: unknown,
  stageName: string,
  ctx: { taskId: string; attemptId: string },
): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  if (serialized === undefined) serialized = String(value);
  if (serialized.length <= INLINE_PORT_VALUE_CHAR_LIMIT) {
    return `  - ${portName} = ${serialized}`;
  }
  // Large value: emit summary + explicit fetch instruction.
  const typeLabel = typeOfValueForHuman(value);
  return (
    `  - ${portName} [large; ${serialized.length} chars as JSON; type: ${typeLabel}]\n` +
    `      Call mcp____kernel_next____read_port with { taskId: "${ctx.taskId}", stage: "${stageName}", port: "${portName}" }\n` +
    `      to fetch the full value. (Inlining would cost ~${Math.round(serialized.length / 4)} tokens.)`
  );
}

/**
 * Human-friendly type label used in the large-value summary line.
 * Matches the tsType grammar used on port declarations (string,
 * number, boolean, string[], object, etc.) as a hint rather than a
 * strict type assertion.
 */
function typeOfValueForHuman(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) {
    if (v.length === 0) return "array<unknown>";
    const first = v[0];
    const inner = typeof first === "object" ? "object" : typeof first;
    return `array<${inner}>`;
  }
  if (typeof v === "object") return "object";
  return typeof v;
}

/**
 * B9 advisory block injected into the system prompt when a migration
 * hint is consumed for this stage attempt. Rendered conservatively:
 * if there is no diff text we still emit the note so the agent knows
 * the stage was rebuilt on a new pipeline version.
 */
function renderMigrationNote(hint: MigrationHint): string {
  const lines: string[] = [
    "",
    "### Migration note (B9)",
    `This stage is being re-run after a hot-update migration from pipeline`,
    `version ${hint.fromVersion} → ${hint.toVersion}. A prior attempt for`,
    `this stage on the old version was superseded.`,
  ];
  if (hint.note) lines.push(`Context: ${hint.note}`);

  if (hint.previousDiffText && hint.previousDiffText.length > 0) {
    // Cap the inlined diff to keep the system prompt under control. The
    // stage_checkpoints column itself caps at 5 MiB; here we show a
    // narrower excerpt since the agent typically only needs the shape.
    const MAX_INLINE_DIFF_CHARS = 8_000;
    const diff = hint.previousDiffText.length > MAX_INLINE_DIFF_CHARS
      ? hint.previousDiffText.slice(0, MAX_INLINE_DIFF_CHARS) + "\n... (diff truncated in prompt; full diff available in stage_checkpoints table)"
      : hint.previousDiffText;
    lines.push(
      "",
      "Previous attempt's worktree diff (advisory — not automatically applied):",
      "```diff",
      diff,
      "```",
      "You may choose to re-apply compatible parts, diverge intentionally, or",
      "ignore this diff if the pipeline change invalidates it.",
    );
  } else {
    lines.push(
      "No diff available for the superseded attempt (either checkpointing",
      "was disabled or no changes were captured).",
    );
  }
  return lines.join("\n");
}
