import type { DatabaseSync } from "node:sqlite";
import { listEntries } from "./catalog-store.js";
import {
  SCORE_WEIGHTS,
  MIN_SCORE,
  DEFAULT_MAX_RESULTS,
  isStopWord,
} from "./score-weights.js";
import type { RecommendResult } from "./schema.js";

type RecommendOpts = {
  maxResults?: number;
  excludeIds?: string[];
};

export function recommendForTopicLocal(
  db: DatabaseSync,
  topic: string,
  opts: RecommendOpts = {},
): RecommendResult[] {
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;
  const excludeIds = new Set(opts.excludeIds ?? []);

  const tokens = tokenize(topic);
  const normalizedTopic = topic.toLowerCase();

  const entries = listEntries(db).filter((e) => !excludeIds.has(e.id));

  const scored = entries.map((entry) => {
    // useCases score
    let useCaseScore = 0;
    const matchedUseCases: string[] = [];
    for (const useCase of entry.useCases) {
      const tokenScore = tokenOverlapRatio(tokens, tokenize(useCase));
      const subScore = substringMatchRatio(normalizedTopic, useCase.toLowerCase());
      const score = Math.max(tokenScore, subScore);
      if (score > useCaseScore) useCaseScore = score;
      if (score >= MIN_SCORE) matchedUseCases.push(useCase);
    }

    // tags score
    let tagScore = 0;
    const matchedTags: string[] = [];
    for (const tag of entry.tags) {
      const tokenScore = tokenOverlapRatio(tokens, tokenize(tag));
      const subScore = substringMatchRatio(normalizedTopic, tag.toLowerCase());
      const score = Math.max(tokenScore, subScore);
      if (score > tagScore) tagScore = score;
      if (score >= MIN_SCORE) matchedTags.push(tag);
    }

    // description score
    const descTokens = tokenize(entry.description);
    const descTokenScore = tokenOverlapRatio(tokens, descTokens);
    const descSubScore = substringMatchRatio(normalizedTopic, entry.description.toLowerCase());
    const descScore = Math.max(descTokenScore, descSubScore);
    const matchedDescriptionTerms: string[] = descScore >= MIN_SCORE
      ? Array.from(new Set(tokens.filter((t) => entry.description.toLowerCase().includes(t))))
      : [];

    const total =
      useCaseScore * SCORE_WEIGHTS.useCases +
      tagScore * SCORE_WEIGHTS.tags +
      descScore * SCORE_WEIGHTS.description;

    return {
      id: entry.id,
      score: Math.min(1, total),
      evidence: {
        matchedUseCases,
        matchedTags,
        matchedDescriptionTerms,
      },
    } satisfies RecommendResult;
  });

  return scored
    .filter((r) => r.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[\s　,，。.!！?？;；:：、/\\()\[\]{}<>"'`]+/)
    .filter((t) => t.length > 0 && !isStopWord(t));
}

function tokenOverlapRatio(topicTokens: string[], targetTokens: string[]): number {
  if (topicTokens.length === 0 || targetTokens.length === 0) return 0;
  const topicSet = new Set(topicTokens);
  const targetSet = new Set(targetTokens);
  let hits = 0;
  for (const t of topicSet) {
    if (targetSet.has(t)) hits += 1;
  }
  // Ratio relative to the smaller set, so a short topic finding all its tokens
  // in a long useCase still scores 1.0
  const smaller = Math.min(topicSet.size, targetSet.size);
  return hits / smaller;
}

function substringMatchRatio(topic: string, target: string): number {
  if (topic.length === 0 || target.length === 0) return 0;
  // Split topic and target into 2..4-gram windows, count how many of topic's
  // n-grams appear in target. This handles Chinese (no whitespace) and partial
  // English phrase overlap.
  const ngrams = (s: string, n: number): Set<string> => {
    const out = new Set<string>();
    if (s.length < n) return out;
    for (let i = 0; i <= s.length - n; i++) {
      out.add(s.slice(i, i + n));
    }
    return out;
  };

  let bestRatio = 0;
  for (const n of [2, 3, 4]) {
    const topicGrams = ngrams(topic, n);
    if (topicGrams.size === 0) continue;
    const targetGrams = ngrams(target, n);
    let hits = 0;
    for (const g of topicGrams) {
      if (targetGrams.has(g)) hits += 1;
    }
    const ratio = hits / topicGrams.size;
    if (ratio > bestRatio) bestRatio = ratio;
  }
  return bestRatio;
}
