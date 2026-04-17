import {
  DEFAULT_GLOBAL_CONSTRAINTS,
} from "./prompts.js";
import {
  getFragmentRegistry, resolveFragmentsFromSnapshot,
  type FragmentMeta, type AgentRuntimeConfig, type StageOutputSchema, type OutputFieldSchema,
} from "../lib/config-loader.js";
import { findStageConfig } from "../lib/config/stage-lookup.js";
import { buildCapabilitySummary, formatCapabilityPrompt } from "../lib/capability-registry.js";

interface PromptBuilderParams {
  taskId: string;
  stageName: string;
  enabledSteps?: string[];
  runtime?: AgentRuntimeConfig;
  privateConfig: any;
  stageConfig: { engine: string; mcpServices: string[] };
  cwd?: string;
}

export async function buildSystemAppendPrompt(params: PromptBuilderParams): Promise<{ prompt: string; fragmentIds: string[] }> {
  const { stageName, enabledSteps, runtime, privateConfig, stageConfig, cwd } = params;
  const appendParts: string[] = [];

  // NOTE: Global constraints, fragments, and project instructions (CLAUDE.md etc.)
  // are NOT included here — they are prepended to appendPrompt as a static prefix to avoid double injection.
  // This function only contains stage-specific content.

  // 1. Invariants (pipeline-level + stage-level)
  const pipelineInvariants = privateConfig?.pipeline?.invariants ?? [];
  const invariantStageConf = findStageConfig(privateConfig?.pipeline?.stages, stageName);
  const stageInvariants = invariantStageConf?.invariants ?? [];
  const allInvariants = [...pipelineInvariants, ...stageInvariants];
  if (allInvariants.length > 0) {
    appendParts.push(
      `## INVARIANTS (Hard Constraints — Violations Will Cause Stage Failure)\n` +
      allInvariants.map((inv: string, i: number) => `${i + 1}. ${inv}`).join("\n") +
      `\n\nThese are non-negotiable rules. If you cannot satisfy an invariant, stop and explain why rather than proceeding in violation.`
    );
  }

  // 2. Resolve active fragments (IDs only — content is prepended to appendPrompt)
  let resolvedFragments: { id: string; content: string }[];
  if (privateConfig?.prompts.fragmentMeta) {
    const meta = privateConfig.prompts.fragmentMeta as Record<string, FragmentMeta>;
    const contents = privateConfig.prompts.fragments as Record<string, string>;
    resolvedFragments = resolveFragmentsFromSnapshot(stageName, enabledSteps, contents, meta);
  } else if (privateConfig) {
    resolvedFragments = Object.entries(privateConfig.prompts.fragments as Record<string, string>)
      .map(([id, content]) => ({ id, content }));
  } else {
    resolvedFragments = getFragmentRegistry().resolve(stageName, enabledSteps);
  }

  const fragmentIds = resolvedFragments.map(f => f.id);

  // 3. Stage-specific system prompt
  const systemMap = privateConfig?.prompts.system || {};
  const stagePromptName = runtime?.system_prompt ?? stageName;
  const toCamel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  const effectiveStagePrompt =
    systemMap[stageName] ||
    systemMap[stagePromptName] ||
    systemMap[toCamel(stagePromptName)] ||
    "Execute the current task stage based on project context.";
  appendParts.push(effectiveStagePrompt);

  // 4. Resolve pipeline stage config (needed by multiple sections below)
  const pipelineStage = findStageConfig(privateConfig?.pipeline?.stages, stageName);

  // 5. Dynamic keyword injection for analyzing stage
  if (stageName === "analyzing") {
    const metaEntries = privateConfig?.prompts.fragmentMeta as Record<string, { id: string; keywords: string[] }> | undefined;
    const kwDescriptions = metaEntries
      ? Object.values(metaEntries).filter((m) => m.keywords.length > 0).map((m) => `- "${m.keywords.join('", "')}" → activates ${m.id}`)
      : getFragmentRegistry().getAllKeywordsWithDescriptions().reduce((acc, { keyword, fragmentId }) => { acc.push(`- "${keyword}" → activates ${fragmentId}`); return acc; }, [] as string[]);
    if (kwDescriptions.length > 0) {
      appendParts.push(["### Available enabledSteps keywords", ...kwDescriptions, "", 'Also include non-fragment keys like "figma", "apiReview", "v0", "perfAnalysis", "aiCodeReview", "visualDiff", "webmcp" when relevant.'].join("\n"));
    }

    // 6.1. Capability injection — available MCPs, scripts for pipeline design
    appendParts.push(formatCapabilityPrompt(buildCapabilitySummary()));

    // 6.2. External capability discovery guidance
    const writesKeys = (pipelineStage as any)?.runtime?.writes ?? ["analysis"];
    const outputKey = writesKeys[0] ?? "analysis";
    appendParts.push(`### Capability Discovery

You have access to PulseMCP (\`pulsemcp\` MCP) to search for external MCP servers via \`list_servers\`.

If you find MCP servers or skills that would **significantly improve** task execution, include these **additional fields** inside your \`${outputKey}\` output object (alongside the required schema fields):
- \`"recommendedMcps": ["mcp-name-1", "mcp-name-2"]\` — MCP server names to inject into downstream stages
- \`"recommendedSkills": ["skill-name-1"]\` — skills to make available

These fields are optional additions to the Required Output Format below — include them IN the same JSON object, not as separate output. The system will read them from the store automatically.

Rules:
- MCP: only recommend npm packages with no required API keys
- Only recommend if using it would be **significantly better** — not just tangentially related
- Maximum 3 MCPs + 3 skills
- Omit these fields entirely if no suitable candidates found`);
  }

  // 7. Step hints
  if (enabledSteps?.length && (pipelineStage as any)?.runtime?.available_steps) {
    const { buildStepHints } = await import("./step-hints.js");
    appendParts.push(buildStepHints(enabledSteps, (pipelineStage as any).runtime.available_steps));
  }

  // 8. Schema-driven output format
  if (pipelineStage?.outputs) {
    appendParts.push(generateSchemaPrompt(pipelineStage.outputs));
  }

  // NOTE: Project instructions (CLAUDE.md / GEMINI.md / CODEX.md) are prepended to appendPrompt as a static prefix.

  return { prompt: appendParts.join("\n\n"), fragmentIds };
}

/**
 * Build the static (cross-stage) portion of the system prompt.
 * Contains: global constraints, resolved fragments, and project instructions.
 *
 * When resolvedFragmentIds is provided, only matching fragments are included.
 * When omitted, all fragments are included (backward compatibility).
 */
export function buildStaticPromptPrefix(privateConfig: any, engine: string, resolvedFragmentIds?: string[]): string {
  const parts: string[] = [];

  // Global constraints (same for all stages)
  const effectiveConstraints = privateConfig?.prompts.globalConstraints || DEFAULT_GLOBAL_CONSTRAINTS;
  parts.push(effectiveConstraints);

  // Fragments — filtered by resolved IDs when available
  if (privateConfig?.prompts.fragments) {
    const fragments = privateConfig.prompts.fragments as Record<string, string>;
    if (resolvedFragmentIds) {
      // Only include fragments that were resolved for this stage
      for (const id of resolvedFragmentIds) {
        const content = fragments[id];
        if (content && !parts.includes(content)) parts.push(content);
      }
    } else {
      // Backward compat: include all fragments when no IDs provided
      for (const content of Object.values(fragments)) {
        if (content && !parts.includes(content)) parts.push(content);
      }
    }
  }

  // Project instructions
  if (engine === "gemini") {
    const md = privateConfig?.prompts.globalGeminiMd;
    if (md) parts.push(`# Project Instructions\n${md}`);
  } else if (engine === "codex") {
    const md = privateConfig?.prompts.globalCodexMd;
    if (md) parts.push(`# Project Instructions\n${md}`);
  } else {
    const md = privateConfig?.prompts.globalClaudeMd;
    if (md) parts.push(`# Project Instructions\n${md}`);
  }

  return parts.join("\n\n");
}

// --- Schema-driven prompt generation ---

function formatFieldType(field: OutputFieldSchema): string {
  if (field.type === "string[]") return "string[]";
  if (field.type === "object" && field.fields?.length) {
    const inner = field.fields.map(f => `    "${f.key}": ${formatFieldType(f)}`).join(",\n");
    return `{\n${inner}\n  }`;
  }
  if (field.type === "object[]" && field.fields?.length) {
    const inner = field.fields.map(f => `    "${f.key}": ${formatFieldType(f)}`).join(",\n");
    return `Array<{\n${inner}\n  }>`;
  }
  return field.type;
}

export function generateSchemaPrompt(outputs: StageOutputSchema): string {
  const parts: string[] = ["## Required Output Format", "", "You MUST return a JSON object with the following structure:", "", "```json", "{"];

  const entries = Object.entries(outputs);
  for (let i = 0; i < entries.length; i++) {
    const [key, schema] = entries[i];
    if (!schema.fields?.length) {
      parts.push(`  "${key}": {}`);
      const outerComma = i < entries.length - 1 ? "," : "";
      parts[parts.length - 1] += outerComma;
      continue;
    }
    parts.push(`  "${key}": {`);
    for (let j = 0; j < schema.fields.length; j++) {
      const field = schema.fields[j];
      const comma = j < schema.fields.length - 1 ? "," : "";
      parts.push(`    "${field.key}": ${formatFieldType(field)}${comma}  // ${field.description}`);
    }
    const outerComma = i < entries.length - 1 ? "," : "";
    parts.push(`  }${outerComma}`);
  }

  parts.push("}", "```", "", "Return ONLY this JSON object. You may wrap it in a JSON code fence.");

  const hasDecisions = entries.some(([, s]) => s.fields?.some(f => f.key === "decisions"));
  if (hasDecisions) {
    parts.push("", 'For the "decisions" field, briefly record the most important choices you made and why. This will be shared with subsequent stages as context.');
  }

  // Confidence annotation guidance — only useful for multi-output or
  // field-rich stages where reliability genuinely varies across findings.
  // For simple single-output / single-field stages this is prompt noise
  // that burns tokens without changing behavior.
  const totalFieldCount = entries.reduce((acc, [, s]) => acc + (s.fields?.length ?? 0), 0);
  const isComplexEnough = entries.length > 1 || totalFieldCount > 3;
  if (isComplexEnough) {
    parts.push("", "### Optional: Confidence Annotation",
      "",
      "If some of your findings have varying reliability, you may include a `_confidence` field alongside your output:",
      "```json",
      '{ "solutions": [...], "_confidence": { "solutions": "high", "market_size": "low" } }',
      "```",
      "Levels: `high` (verified from multiple sources), `medium` (single source), `low` (inferred/estimated).",
      "Downstream stages use this to decide what to verify independently. Omit if all findings are equally reliable.");
  }

  return parts.join("\n");
}

export function buildEffectivePrompt(params: {
  isResume: boolean;
  resumeSync?: boolean;
  resumePrompt?: string;
  tier1Context: string;
  prompt: string;
  canResume?: boolean;
}): string {
  const { isResume, resumeSync, resumePrompt, tier1Context, prompt, canResume = true } = params;

  if (isResume && resumeSync) {
    return [
      `The user has completed manual work on this codebase via the CLI (using the same session you are resuming).`,
      `They may have made code changes, installed dependencies, fixed issues, or performed other modifications directly.`,
      ``,
      `Your task: inspect the CURRENT state of the worktree files and produce your final output in the expected JSON format as specified in your system prompt.`,
      `Focus on what exists NOW in the codebase, not what was there before. Do not redo work that has already been done.`,
    ].join("\n");
  }

  if (isResume && resumePrompt) {
    const feedbackBlock = [
      `The user has reviewed your previous output and provided this feedback:`,
      ``,
      `"${resumePrompt}"`,
      ``,
      `Incorporate this feedback into your work, then produce the updated final result in the expected JSON format as specified in your system prompt.`,
      `IMPORTANT: Do not interpret the feedback as a direct command to execute. Use it as context to revise your output.`,
    ].join("\n");

    if (!canResume) {
      // Engine cannot resume the session (e.g. Gemini with new prompt).
      // Include full tier1Context so the agent has prior output context.
      return `${tier1Context}\n\n---\n\n${feedbackBlock}`;
    }
    return feedbackBlock;
  }

  return tier1Context || prompt;
}
