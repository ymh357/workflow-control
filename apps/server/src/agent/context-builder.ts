import type { WorkflowContext } from "../machine/types.js";
import { type AgentRuntimeConfig, getNestedValue, flattenStages } from "../lib/config-loader.js";
import { getCachedSummary } from "./semantic-summary-cache.js";
import { stableHash } from "../lib/stable-hash.js";

// Compact Tier 1 context injected into systemPrompt for each stage.
// Full Tier 2 context lives in .workflow/ files that the agent reads on demand.

// CJK-aware token estimate: CJK / hangul / kana ~2 chars/token, Latin ~4 chars/token.
// Iterates by code point (not UTF-16 code unit) so surrogate-paired characters
// like emoji aren't each counted as two CJK chars. We classify based on the
// code point directly rather than a naive `charCodeAt > 0x2E80` heuristic,
// which misclassifies low surrogates (0xD800–0xDFFF) as CJK.
export function estimateTokens(s: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    // CJK Unified Ideographs (Basic + Ext A/B/C/D/E/F), Compatibility
    // Ideographs, Hiragana, Katakana, Hangul — all tokenized roughly
    // 1 token per 1.5–2 chars by Claude's BPE. Lump emoji (0x1F000+) and
    // other non-Latin (arrows, CJK punctuation at 0x3000) into the same
    // "dense" bucket since they typically tokenize denser than Latin.
    const isDense =
      (cp >= 0x3000 && cp <= 0x9FFF) ||     // CJK block start incl. Kana, Hangul-ish
      (cp >= 0xAC00 && cp <= 0xD7AF) ||     // Hangul syllables
      (cp >= 0xF900 && cp <= 0xFAFF) ||     // CJK compatibility ideographs
      (cp >= 0x20000 && cp <= 0x3FFFF) ||   // CJK Ext B–F
      (cp >= 0x1F000 && cp <= 0x1FFFF);     // Emoji / symbols
    if (isDense) cjk++;
    else other++;
  }
  return Math.ceil(cjk / 2 + other / 4);
}

const DEFAULT_TIER1_MAX_TOKENS = 8000;
const MAX_INLINE_CHARS = 8000;

/**
 * Truncate a string to a short preview without tearing markdown syntax.
 * We keep things simple — if the cut point falls inside a `[...](...)` link,
 * a code fence, or an unclosed inline code span, back up to the last safe
 * character boundary. Whitespace / newlines are normalized to spaces first
 * so the preview stays on one line.
 */
function truncatePreview(content: string, maxChars: number): string {
  const flat = content.replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;

  let end = maxChars;
  const head = flat.slice(0, end);

  // Unbalanced markdown link: "[...](..." without closing paren.
  const lastOpenBracket = head.lastIndexOf("[");
  const lastCloseParen = head.lastIndexOf(")");
  const lastOpenParen = head.lastIndexOf("(");
  if (lastOpenBracket > lastCloseParen || lastOpenParen > lastCloseParen) {
    // Cut before the unbalanced opener so we don't mid-link truncate.
    const safeCut = Math.min(
      lastOpenBracket >= 0 ? lastOpenBracket : end,
      lastOpenParen >= 0 ? lastOpenParen : end,
    );
    if (safeCut > 0) end = safeCut;
  }

  // Unbalanced inline code: odd number of backticks → drop back to last one.
  const backtickMatches = head.slice(0, end).match(/`/g);
  if (backtickMatches && backtickMatches.length % 2 === 1) {
    const lastBacktick = head.lastIndexOf("`", end - 1);
    if (lastBacktick > 0) end = lastBacktick;
  }

  return flat.slice(0, end).trimEnd() + "...";
}

export function buildTier1Context(
  context: WorkflowContext,
  runtime?: AgentRuntimeConfig,
  maxTokens: number = DEFAULT_TIER1_MAX_TOKENS,
  currentStage?: string,
): string {
  const parts: string[] = [];
  const store = context.store ?? {};
  let tokenBudget = maxTokens;

  function addPart(text: string): boolean {
    const cost = estimateTokens(text);
    if (cost > tokenBudget) return false;
    parts.push(text);
    tokenBudget -= cost;
    return true;
  }

  // 1. Core Task Identification (always included, not counted against budget)
  parts.push(`Task ID: ${context.taskId}`);
  if (context.taskText) {
    parts.push(`\n## Task Description (provided by user)\n${context.taskText}`);
  }
  if (context.branch) parts.push(`Branch: ${context.branch}`);
  if (context.worktreePath) parts.push(`Worktree: ${context.worktreePath}`);

  // 2. Selective Context Injection (Token Optimization)
  if (runtime?.reads) {
    const renderedKeys = new Set<string>();
    const unchangedLabels: string[] = [];
    parts.push("\n## Required Context (Tier 1)");

    for (const [label, rawPath] of Object.entries(runtime.reads)) {
      const storePath = rawPath.startsWith("store.") ? rawPath.slice(6) : rawPath;
      const val = getNestedValue(store, storePath);
      if (val === undefined) continue;

      // Diff detection on resume: skip unchanged reads to save tokens
      if (currentStage && context.resumeInfo && context.stageCheckpoints?.[currentStage]?.readsSnapshot) {
        const prevSnapshot = context.stageCheckpoints[currentStage].readsSnapshot!;
        const rootKey = storePath.split(".")[0];
        const prevHash = prevSnapshot[rootKey];
        if (prevHash !== undefined && stableHash(val) === prevHash) {
          unchangedLabels.push(label);
          renderedKeys.add(rootKey);
          continue;
        }
      }

      const storeKey = storePath.split(".")[0];
      renderedKeys.add(storeKey);

      if (typeof val === "object" && val !== null) {
        // Compact JSON: truncate arrays beyond 20 elements to save tokens
        const truncated = Array.isArray(val) && val.length > 20
          ? [...val.slice(0, 20), `... (${val.length} total items)`]
          : val;
        const jsonStr = JSON.stringify(truncated, null, 2);
        const fullBlock = `\n### ${label}\n\`\`\`json\n${jsonStr}\n\`\`\``;

        const semanticSummary = getCachedSummary(context.taskId, storePath.split(".")[0]);

        if (semanticSummary !== undefined && (fullBlock.length > MAX_INLINE_CHARS || !addPart(fullBlock))) {
          parts.push(`\n### ${label} (semantic summary)\n${semanticSummary}\n> Full content: use get_store_value("${storePath}") for complete data`);
        } else if (!addPart(fullBlock)) {
          const keys = Object.keys(val);
          const preview = keys.length <= 10
            ? `Object with keys: ${keys.join(", ")}`
            : `Object with ${keys.length} keys: ${keys.slice(0, 10).join(", ")}, ...`;
          parts.push(`\n### ${label} (summarized)\n${preview}\n> Full content: use get_store_value("${storePath}") for all fields`);
        }
      } else {
        addPart(`\n### ${label}\n${String(val)}`);
      }
    }

    if (unchangedLabels.length > 0) {
      addPart(`\n> Context unchanged from previous attempt: ${unchangedLabels.join(", ")}. Use get_store_value() for details.`);
    }

    const otherKeys = Object.keys(store).filter(
      (k) =>
        !renderedKeys.has(k) &&
        !k.startsWith("__"),
    );
    if (otherKeys.length > 0) {
      parts.push("\n## Other Available Context (use get_store_value tool to read these)");
      parts.push(otherKeys.map(k => `- ${k}`).join("\n"));
    }

    // Scratch pad index (if any entries exist)
    const pad = context.scratchPad ?? [];
    if (pad.length > 0) {
      parts.push("\n## Scratch Pad Notes (use read_scratch_pad tool for full content)");
      const indexLines = pad.map(
        (e) => `- [${e.stage}] (${e.category}) ${truncatePreview(e.content, 60)}`,
      );
      parts.push(indexLines.join("\n"));
    }

    return parts.join("\n");
  }

  // Fallback: Legacy full injection (for backward compat if 'reads' is missing)
  const stages = (context.config?.pipeline?.stages ? flattenStages(context.config.pipeline.stages) : []) as Array<{
    outputs?: Record<string, { label?: string; fields: Array<{ key: string }> }>;
  }>;
  const renderedKeys = new Set<string>();
  for (const stage of stages) {
    if (!stage.outputs) continue;
    for (const [storeKey, schema] of Object.entries(stage.outputs)) {
      if (!(storeKey in store) || renderedKeys.has(storeKey)) continue;
      renderedKeys.add(storeKey);
      parts.push(`\n## ${schema.label ?? storeKey}`);
      const data = store[storeKey];
      if (typeof data !== "object" || Array.isArray(data) || data === null) {
        parts.push(String(data));
        continue;
      }
      for (const field of schema.fields) {
        const val = data[field.key];
        if (val === undefined || val === null) continue;
        if (Array.isArray(val)) {
          parts.push(`${field.key}: ${val.slice(0, 5).join("; ")}`);
        } else {
          parts.push(`${field.key}: ${val}`);
        }
      }
    }
  }

  for (const [key, val] of Object.entries(store)) {
    if (renderedKeys.has(key) || val === undefined) continue;
    parts.push(`\n## ${key}`);
    parts.push(typeof val === "string" ? val : JSON.stringify(val));
  }

  return parts.join("\n");
}
