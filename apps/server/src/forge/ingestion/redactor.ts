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
//
// IMPORTANT (2026-05-05): every secret pattern must require a non-word
// LEFT boundary (start-of-string OR a non-[A-Za-z0-9_] character).
// Without this, real-world session text like filenames
// "task-finals.sticky-cancel.test.ts" or code like "sk-name-here" gets
// false-positive-redacted because the prefix `sk-` matches as a
// substring inside an identifier. We use a non-capturing lookbehind
// + lookbehind-style anchor via `(?:^|[^A-Za-z0-9_])` and capture the
// secret in group 1; the redactor below handles capture-group offsets.
export const REDACTION_PATTERNS: RedactionPattern[] = [
  { kind: "github-token",   regex: /(?:^|[^A-Za-z0-9_])(ghp_[A-Za-z0-9]{30,})/g },
  { kind: "openai-key",     regex: /(?:^|[^A-Za-z0-9_])(sk-(?:proj-)?[A-Za-z0-9_-]{20,})/g },
  { kind: "slack-token",    regex: /(?:^|[^A-Za-z0-9_])(xox[baprs]-[A-Za-z0-9-]{10,})/g },
  { kind: "aws-access-key", regex: /(?:^|[^A-Za-z0-9_])(AKIA[0-9A-Z]{16})/g },
  { kind: "bearer-token",   regex: /(?:^|[^A-Za-z0-9_])(Bearer\s+[A-Za-z0-9._~+/=-]{20,})/g },
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
      // Use capture group 1 (the secret itself) when present, so the
      // redaction range covers ONLY the secret and not the leading
      // boundary character. Patterns without a capture group fall back
      // to the full match (legacy / hypothetical patterns).
      const secret = m[1] ?? m[0];
      const start = m[1] !== undefined ? m.index + m[0].length - m[1].length : m.index;
      allHits.push({
        kind,
        startIndex: start,
        endIndex: start + secret.length,
        length: secret.length,
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
