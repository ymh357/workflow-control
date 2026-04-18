// Helpers used by the agent executors to build ExecutionRecord payloads.
// Kept small and pure so they can be unit tested in isolation — the writer
// itself has no knowledge of store / pipeline internals.

import { getNestedValue } from "../config-loader.js";
import type { PromptBlob } from "./types.js";

/**
 * Resolve a stage's `reads` map against the current store, returning the
 * concrete values the agent will actually see. Follows the same
 * "strip-leading-store." convention used elsewhere in the engine (pipeline
 * executor, condition evaluator).
 */
export function resolveReadsSnapshot(
  reads: Record<string, string> | undefined,
  store: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!reads || !store) return {};
  const out: Record<string, unknown> = {};
  for (const [key, rawPath] of Object.entries(reads)) {
    const parentPath = rawPath.startsWith("store.")
      ? rawPath.slice(6)
      : rawPath;
    const value = getNestedValue(store, parentPath);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Build the prompt_blob column value for an ExecutionRecord row.
 *
 * Step 1.3b fills the shape faithfully from what the caller has; fields
 * we can't yet reach from the executor (invariants list, fragment
 * content hashes, output schema) default to empty / null. Step 3
 * (A3 store schema) and Step 2 (A2 pipeline versioning) will tighten
 * the remaining fields.
 */
export function buildPromptBlob(input: {
  tier1: string;
  systemPromptFull: string;
  stagePrompt: string;
  invariants?: string[];
  fragments?: Array<{ id: string; contentHash: string }>;
  outputSchema?: unknown | null;
}): PromptBlob {
  return {
    tier1: input.tier1 ?? "",
    systemPromptFull: input.systemPromptFull ?? "",
    stagePrompt: input.stagePrompt ?? "",
    invariants: input.invariants ?? [],
    fragments: input.fragments ?? [],
    outputSchema: input.outputSchema ?? null,
  };
}

/**
 * Best-effort parse of an agent's resultText into a store-writes object.
 * Agents sometimes return JSON inside a fence, sometimes raw, sometimes
 * with trailing commentary. Returns null when no JSON object can be
 * extracted — we record that honestly in the ExecutionRecord rather
 * than pretending.
 */
export function parseWritesFromResult(
  resultText: string | undefined,
): Record<string, unknown> | null {
  if (!resultText) return null;
  const trimmed = resultText.trim();
  if (!trimmed) return null;

  // Fast path: whole string is JSON.
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }

  // Try fenced JSON.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
  }

  return null;
}
