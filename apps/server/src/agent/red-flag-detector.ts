import { taskLogger } from "../lib/logger.js";

const RED_FLAG_PATTERNS: Array<{ pattern: RegExp; category: string; description: string }> = [
  { pattern: /\b(?:should|probably|likely|might)\s+(?:work|fix|resolve|pass|be\s+(?:fine|ok|correct))/i, category: "unverified_claim", description: "Uncertain language in completion claim" },
  { pattern: /\bI\s+(?:think|believe|assume|expect)\s+(?:this|that|it)\s+(?:should|will|is)/i, category: "unverified_claim", description: "Assumption-based claim without verification" },
  { pattern: /(?:Done!|All\s+done|Fixed!|That\s+should\s+do\s+it|Everything\s+(?:looks|is)\s+good)/i, category: "premature_success", description: "Success declaration without evidence" },
  { pattern: /\bskip(?:ping|ped)?\s+(?:the\s+)?(?:test|verification|check|validation)/i, category: "skipped_verification", description: "Explicitly skipping verification" },
  { pattern: /\bno\s+need\s+to\s+(?:test|check|verify|validate|run)/i, category: "skipped_verification", description: "Dismissing need for verification" },
];

export interface RedFlag {
  category: string;
  description: string;
  matchedText: string;
  position: number;
}

export function detectRedFlags(text: string): RedFlag[] {
  const flags: RedFlag[] = [];
  for (const { pattern, category, description } of RED_FLAG_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      flags.push({ category, description, matchedText: match[0], position: match.index });
    }
  }
  return flags;
}

export class RedFlagAccumulator {
  private buffer = "";
  private flags: RedFlag[] = [];
  private lastCheckPos = 0;
  private readonly checkIntervalChars = 500;

  append(text: string): RedFlag[] {
    this.buffer += text;
    const newFlags: RedFlag[] = [];

    if (this.buffer.length - this.lastCheckPos >= this.checkIntervalChars) {
      const checkStart = Math.max(0, this.lastCheckPos - 100);
      const portion = this.buffer.slice(checkStart);
      const detected = detectRedFlags(portion);

      for (const flag of detected) {
        const adjustedPos = flag.position + checkStart;
        const isDuplicate = this.flags.some(
          (f) => f.category === flag.category && Math.abs(f.position - adjustedPos) < 200
        );
        if (!isDuplicate) {
          const adjusted = { ...flag, position: adjustedPos };
          this.flags.push(adjusted);
          newFlags.push(adjusted);
        }
      }
      this.lastCheckPos = this.buffer.length;
    }

    return newFlags;
  }

  getFlags(): RedFlag[] {
    return this.flags;
  }

  getFlagSummary(): string | null {
    if (this.flags.length === 0) return null;
    const grouped = new Map<string, RedFlag[]>();
    for (const f of this.flags) {
      const list = grouped.get(f.category) ?? [];
      list.push(f);
      grouped.set(f.category, list);
    }
    const lines: string[] = [];
    for (const [cat, flags] of grouped) {
      lines.push(`- ${cat}: ${flags.length}x (e.g. "${flags[0].matchedText}")`);
    }
    return lines.join("\n");
  }
}
