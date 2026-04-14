import type { WorkflowContext } from "../machine/types.js";
import { type AgentRuntimeConfig, getNestedValue, flattenStages } from "../lib/config-loader.js";

// Compact Tier 1 context injected into systemPrompt for each stage.
// Full Tier 2 context lives in .workflow/ files that the agent reads on demand.

// CJK-aware token estimate: CJK ~2 chars/token, Latin ~4 chars/token
export function estimateTokens(s: string): number {
  let cjk = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x2E80) cjk++;
  }
  return Math.ceil(cjk / 2 + (s.length - cjk) / 4);
}

const DEFAULT_TIER1_MAX_TOKENS = 8000;
const MAX_INLINE_CHARS = 8000;

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
        const prevVal = prevSnapshot[rootKey];
        if (prevVal !== undefined && JSON.stringify(val) === JSON.stringify(prevVal)) {
          unchangedLabels.push(label);
          renderedKeys.add(rootKey);
          continue;
        }
      }

      const storeKey = storePath.split(".")[0];
      renderedKeys.add(storeKey);

      if (typeof val === "object" && val !== null) {
        const fieldParts: string[] = [];
        for (const [k, v] of Object.entries(val)) {
          if (Array.isArray(v)) {
            fieldParts.push(`${k}: ${v.slice(0, 20).join("; ")}${v.length > 20 ? ` ... (${v.length} total)` : ""}`);
          } else if (typeof v === "object" && v !== null) {
            fieldParts.push(`${k}: ${JSON.stringify(v)}`);
          } else {
            fieldParts.push(`${k}: ${v}`);
          }
        }
        const fullBlock = `\n### ${label}\n${fieldParts.join("\n")}`;

        const semanticSummaryKey = `${storePath.split(".")[0]}.__semantic_summary`;
        const mechanicalSummaryKey = `${storePath.split(".")[0]}.__summary`;

        if (store[semanticSummaryKey] !== undefined && (fullBlock.length > MAX_INLINE_CHARS || !addPart(fullBlock))) {
          // Best: LLM-generated semantic summary
          parts.push(`\n### ${label} (semantic summary)\n${store[semanticSummaryKey]}\n> Full content: use get_store_value("${storePath}") for complete data`);
        } else if (store[mechanicalSummaryKey] !== undefined && fullBlock.length > MAX_INLINE_CHARS) {
          addPart(`\n### ${label} (compact summary)\n${store[mechanicalSummaryKey]}\n> Full content: use get_store_value("${storePath}") for complete data`);
        } else if (!addPart(fullBlock)) {
          if (fullBlock.length > MAX_INLINE_CHARS) {
            parts.push(`\n### ${label} (preview, ${fieldParts.length} fields)\n${fieldParts.slice(0, 5).join("\n")}\n...\n> Full content: use get_store_value("${storePath}") for all ${fieldParts.length} fields`);
          } else {
            const entries = Object.entries(val);
            const summaryParts: string[] = [];
            for (const [k, v] of entries.slice(0, 20)) {
              const s = typeof v === "string" ? v : JSON.stringify(v);
              summaryParts.push(`${k}: ${s.slice(0, 80)}${s.length > 80 ? "..." : ""}`);
            }
            if (entries.length > 20) summaryParts.push(`... and ${entries.length - 20} more fields`);
            parts.push(`\n### ${label} (summarized)\n${summaryParts.join("\n")}`);
          }
        }
      } else {
        addPart(`\n### ${label}\n${String(val)}`);
      }
    }

    if (unchangedLabels.length > 0) {
      addPart(`\n> Context unchanged from previous attempt: ${unchangedLabels.join(", ")}. Use get_store_value() for details.`);
    }

    // List un-injected store keys as indices (Tier 2 references)
    const otherKeys = Object.keys(store).filter(k => !renderedKeys.has(k) && !k.includes(".__summary") && !k.includes(".__semantic_summary"));
    if (otherKeys.length > 0) {
      parts.push("\n## Other Available Context (use get_store_value tool to read these)");
      parts.push(otherKeys.map(k => `- ${k}`).join("\n"));
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
