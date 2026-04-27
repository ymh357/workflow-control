export const SCORE_WEIGHTS = {
  useCases: 0.5,
  tags: 0.3,
  description: 0.2,
} as const;

export const MIN_SCORE = 0.1;

export const DEFAULT_MAX_RESULTS = 5;
export const LLM_OVERLAY_CANDIDATE_LIMIT = 10;

const STOP_WORDS_EN = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "for", "with",
  "by", "from", "is", "are", "was", "were", "be", "been", "being",
  "this", "that", "these", "those", "it", "its", "as",
]);

const STOP_WORDS_ZH = new Set([
  "的", "了", "和", "或", "在", "是", "有", "被", "把", "对", "为", "与",
  "及", "等", "也", "都", "就", "之", "其",
]);

export function isStopWord(word: string): boolean {
  return STOP_WORDS_EN.has(word) || STOP_WORDS_ZH.has(word);
}
