// Secret-pattern detection. Pure function — runs at the boundary
// before any text is persisted to forge.db OR sent to an external API
// (embedding provider, distillation if cloud-based). Replacement format
// is `<REDACTED:<kind>>` so a downstream reader can see THAT redaction
// occurred without seeing the value.

import type { RedactionHit } from "../types.js";

export interface RedactionPattern {
  kind: string;
  regex: RegExp;
}

// Order matters when patterns overlap; we resolve via earliest-start.
export const REDACTION_PATTERNS: RedactionPattern[] = [
  { kind: "github-token",   regex: /ghp_[A-Za-z0-9]{30,}/g },
  { kind: "openai-key",     regex: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "slack-token",    regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "aws-access-key", regex: /AKIA[0-9A-Z]{16}/g },
  { kind: "bearer-token",   regex: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/g },
];

export interface RedactResult {
  redacted: string;
  hits: RedactionHit[];
}

export function redact(text: string): RedactResult {
  if (!text) return { redacted: text, hits: [] };

  const allHits: Array<RedactionHit & { length: number }> = [];
  for (const { kind, regex } of REDACTION_PATTERNS) {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      allHits.push({
        kind,
        startIndex: m.index,
        endIndex: m.index + m[0].length,
        length: m[0].length,
      });
    }
  }
  allHits.sort((a, b) => a.startIndex - b.startIndex);
  const merged: typeof allHits = [];
  for (const h of allHits) {
    const last = merged[merged.length - 1];
    if (last && h.startIndex < last.endIndex) continue;
    merged.push(h);
  }

  let out = "";
  let cursor = 0;
  for (const h of merged) {
    out += text.slice(cursor, h.startIndex);
    out += `<REDACTED:${h.kind}>`;
    cursor = h.endIndex;
  }
  out += text.slice(cursor);

  return {
    redacted: out,
    hits: merged.map(({ kind, startIndex, endIndex }) => ({ kind, startIndex, endIndex })),
  };
}
