// Real Claude Agent SDK — AI patch synthesizer.
//
// Wraps the SDK's `query()` with a minimal one-shot prompt:
//   system prompt  — describe the safe-range constraint + expected JSON shape
//   user prompt    — the failing stage's config + the suggestion rationale
//                    + selected execution-record snippets
//
// The SDK response is expected to contain a JSON block matching
//   { "ops": [ { "op": "update_stage_config", "stage": "<name>",
//                "configPatch": { "promptRef"?: string,
//                                 /* safe-range fields only */ } } ] }
// We parse it best-effort; any deviation returns null (the caller then
// ships the suggestion without a proposedPatch).

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  AiPatchSynthesizer,
  FixSuggestion,
} from "./propose-pipeline-fix.js";
import { SubAgentDefSchema } from "../ir/schema.js";
import type { IRPatch, PipelineIR } from "../ir/schema.js";

export interface ClaudeSdkSynthesizerOptions {
  /** Override the SDK query function (tests inject a stub). */
  queryFn?: typeof query;
  /** Model to ask. Defaults to a fast, cheap model. */
  model?: string;
  /** Cap on turns per synthesize call. Default 3. */
  maxTurns?: number;
}

const DEFAULT_MODEL = "claude-haiku-4-5";
const DEFAULT_MAX_TURNS = 3;

const SYSTEM_PROMPT = `You are a pipeline-fix synthesiser. Given a failing stage's
current configuration plus a diagnostic hint, propose a SINGLE
update_stage_config IRPatch that is most likely to resolve the issue.

OUTPUT FORMAT — output ONLY a JSON code block matching this shape:
\`\`\`json
{
  "ops": [
    {
      "op": "update_stage_config",
      "stage": "<stage name>",
      "configPatch": {
        "promptRef": "<new prompt ref>",
        "subAgents": [
          { "name": "<identifier>", "description": "<one line>",
            "prompt": "<sub-agent prompt body>",
            "tools": ["Read", "Grep", ...],
            "model": "sonnet" | "opus" | "haiku" | "inherit",
            "maxTurns": <positive integer> }
        ]
      }
    }
  ]
}
\`\`\`

HARD CONSTRAINTS (violation → your patch is rejected):
1. You may ONLY emit update_stage_config. No add_stage / remove_stage /
   add_wire / remove_wire / update_port_type.
2. The "stage" field MUST match the target stage named in the input.
3. configPatch may ONLY contain these keys: "promptRef", "subAgents".
   Any other key (budget / reads / writes / MCP / etc.) is rejected.
   Either key is optional; you may include one, both, or neither
   (but include at least one, otherwise the patch is a no-op).
4. subAgents entries MUST have non-empty "name" (starts with letter or
   underscore; letters/digits/underscore/dash only; ≤ 64 chars),
   non-empty "description", non-empty "prompt". "tools" is an optional
   array of strings. "model" is one of sonnet/opus/haiku/inherit.
   "maxTurns" is a positive integer. Passing an empty subAgents array
   is allowed and means "remove all sub-agents from this stage".
5. If you cannot confidently propose a fix, output exactly the string
   \`NO_PATCH\` (no JSON, no code block) — never fabricate.`;

function buildUserPrompt(
  suggestion: FixSuggestion,
  stageConfigJson: string,
): string {
  return [
    `Failing stage: ${suggestion.targetStage}`,
    `Failure kind: ${suggestion.kind} (severity=${suggestion.severity})`,
    "",
    "Description:",
    suggestion.description,
    "",
    "Rationale:",
    suggestion.rationale,
    "",
    "Current stage config:",
    "```json",
    stageConfigJson,
    "```",
    "",
    "Propose a single update_stage_config patch or output NO_PATCH.",
  ].join("\n");
}

function extractJsonBlock(text: string): unknown | null {
  if (text.trim() === "NO_PATCH") return null;
  const match = text.match(/```json\s*([\s\S]*?)```/);
  const body = match ? match[1]!.trim() : text.trim();
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function parsePatch(raw: unknown, expectedStage: string): IRPatch | null {
  if (!raw || typeof raw !== "object") return null;
  const asPatch = raw as { ops?: unknown };
  if (!Array.isArray(asPatch.ops)) return null;
  const ops: IRPatch["ops"] = [];
  for (const op of asPatch.ops as unknown[]) {
    if (!op || typeof op !== "object") return null;
    const typed = op as Record<string, unknown>;
    if (typed.op !== "update_stage_config") return null;
    if (typeof typed.stage !== "string" || typed.stage !== expectedStage) return null;
    if (!typed.configPatch || typeof typed.configPatch !== "object") return null;
    const configPatch = typed.configPatch as Record<string, unknown>;
    // Safe-range allowlist — only AgentStage config fields that currently
    // exist in schema.ts. Expansion to a new field requires updating
    // schema.ts first, then this list + the SYSTEM_PROMPT description.
    const allowedKeys = ["promptRef", "subAgents"];
    for (const k of Object.keys(configPatch)) {
      if (!allowedKeys.includes(k)) return null;
    }
    if (configPatch.promptRef !== undefined && typeof configPatch.promptRef !== "string") return null;
    if (configPatch.subAgents !== undefined) {
      if (!Array.isArray(configPatch.subAgents)) return null;
      // Validate every entry against the SubAgentDefSchema (same Zod
      // schema used by IR submit). A single bad entry rejects the
      // whole patch — the synthesiser can retry or emit NO_PATCH.
      for (const entry of configPatch.subAgents) {
        const parsed = SubAgentDefSchema.safeParse(entry);
        if (!parsed.success) return null;
      }
    }
    ops.push({ op: "update_stage_config", stage: typed.stage, configPatch });
  }
  return ops.length > 0 ? { ops } : null;
}

export function createClaudeSdkPatchSynthesizer(
  opts: ClaudeSdkSynthesizerOptions = {},
): AiPatchSynthesizer {
  const queryFn = opts.queryFn ?? query;
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;

  return {
    async synthesize({ suggestion, ir }): Promise<IRPatch | null> {
      const stage = ir.stages.find((s) => s.name === suggestion.targetStage);
      if (!stage) return null;
      const stageConfigJson = JSON.stringify(stage, null, 2);
      const userPrompt = buildUserPrompt(suggestion, stageConfigJson);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = queryFn({
        prompt: userPrompt,
        options: {
          systemPrompt: { preset: "claude_code", append: SYSTEM_PROMPT },
          maxTurns,
          model,
        } as never,
      });

      // Collect every assistant text block; we parse from the
      // concatenated body so multi-block responses work.
      let assistantText = "";
      try {
        for await (const msg of stream as AsyncIterable<unknown>) {
          const m = msg as { type?: string; message?: { content?: unknown[] } };
          if (m.type !== "assistant") continue;
          const blocks = m.message?.content ?? [];
          for (const b of blocks as Array<{ type?: string; text?: unknown }>) {
            if (b.type === "text" && typeof b.text === "string") {
              assistantText += b.text + "\n";
            }
          }
        }
      } catch {
        return null;
      }

      const parsed = extractJsonBlock(assistantText);
      if (parsed === null) return null;
      return parsePatch(parsed, suggestion.targetStage);
    },
  };
}
