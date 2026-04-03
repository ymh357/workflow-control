import { logger } from "./logger.js";

function findAllBalanced(text: string, open: string, close: string): string[] {
  const results: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf(open, pos);
    if (start === -1) break;
    let depth = 0, inString = false, escape = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end !== -1) {
      results.push(text.slice(start, end + 1));
      pos = end + 1;
    } else {
      pos = start + 1;
    }
  }
  return results;
}

// Strip trailing commas before } and ] to handle common LLM output.
// String-aware: skips commas inside quoted strings to avoid corrupting values.
function stripTrailingCommas(s: string): string {
  let result = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; result += ch; continue; }
    if (ch === "\\") { escape = true; result += ch; continue; }
    if (ch === '"') { inString = !inString; result += ch; continue; }
    if (inString) { result += ch; continue; }
    if (ch === ",") {
      // Look ahead: skip whitespace, check if next non-ws char is } or ]
      let j = i + 1;
      while (j < s.length && (s[j] === " " || s[j] === "\t" || s[j] === "\n" || s[j] === "\r")) j++;
      if (j < s.length && (s[j] === "}" || s[j] === "]")) {
        continue; // skip this trailing comma
      }
    }
    result += ch;
  }
  return result;
}

function tryParse(s: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(s);
    if (typeof parsed === "object" && parsed !== null) return parsed;
  } catch { /* try with trailing comma cleanup */ }
  try {
    const parsed = JSON.parse(stripTrailingCommas(s));
    if (typeof parsed === "object" && parsed !== null) return parsed;
  } catch { /* malformed */ }
  return null;
}

export function extractJSON(text: string): Record<string, unknown> {
  // 1. Direct JSON parse
  const direct = tryParse(text);
  if (direct) return direct;

  // 2. JSON code blocks (collect all, pick best)
  const codeBlockMatches = Array.from(text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g));
  if (codeBlockMatches.length > 0) {
    for (let i = codeBlockMatches.length - 1; i >= 0; i--) {
      const result = tryParse(codeBlockMatches[i][1].trim());
      if (result) return result;
    }
  }

  // 3. Balanced extraction — try both { } and [ ], prefer longest match
  const allBraced = findAllBalanced(text, "{", "}");
  const allBracketed = findAllBalanced(text, "[", "]");
  const allCandidates = [...allBraced, ...allBracketed];
  // Sort by length descending; stable sort preserves original order for equal lengths
  allCandidates.sort((a, b) => b.length - a.length);
  for (const candidate of allCandidates) {
    const result = tryParse(candidate);
    if (result) return result;
  }

  logger.error({ textPreview: text.slice(0, 500) }, "extractJSON: no JSON found in agent output");
  throw new Error("Failed to extract JSON from agent output");
}
