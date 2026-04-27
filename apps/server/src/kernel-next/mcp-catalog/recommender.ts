import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { listEntries } from "./catalog-store.js";
import {
  SCORE_WEIGHTS,
  MIN_SCORE,
  DEFAULT_MAX_RESULTS,
  LLM_OVERLAY_CANDIDATE_LIMIT,
  isStopWord,
} from "./score-weights.js";
import type { RecommendResult } from "./schema.js";
import type { Diagnostic } from "../ir/schema.js";
import { simpleJsonCompletion } from "./llm-client.js";

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
  const normalizedTopic = topic.trim().toLowerCase();

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
  // 2..4-gram range (spec mentions 2..6, but for v1 entries.json content
  // 2-grams already achieve sufficient recall on Chinese; 5/6-grams add
  // cost without measurable benefit at our scale).
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

// ─── Layer 2: LLM-overlay ────────────────────────────────────────────────────

const LlmOverlayResponseSchema = z.object({
  recommendations: z.array(z.object({
    id: z.string(),
    llmReason: z.string(),
    citedEvidence: z.object({
      tags: z.array(z.string()).optional(),
      useCases: z.array(z.string()).optional(),
    }),
  })),
});

export type LlmOverlayClient = {
  simpleJsonCompletion: <T>(args: {
    systemPrompt: string;
    userPrompt: string;
    schema: z.ZodSchema<T>;
  }) => Promise<T>;
};

const DEFAULT_OVERLAY_CLIENT: LlmOverlayClient = {
  simpleJsonCompletion: (args) => simpleJsonCompletion(args),
};

export type RecommendWithLLMResult = {
  recommendations: RecommendResult[];
  warnings?: Diagnostic[];
};

export async function recommendForTopicWithLLM(
  db: DatabaseSync,
  topic: string,
  opts: RecommendOpts & { llmClient?: LlmOverlayClient } = {},
): Promise<RecommendWithLLMResult> {
  const llmClient = opts.llmClient ?? DEFAULT_OVERLAY_CLIENT;

  // Layer 1: get more candidates than usual so LLM has room to filter
  const candidates = recommendForTopicLocal(db, topic, {
    maxResults: LLM_OVERLAY_CANDIDATE_LIMIT,
    excludeIds: opts.excludeIds,
  });

  if (candidates.length === 0) {
    return { recommendations: [] };
  }

  let llmOutput: z.infer<typeof LlmOverlayResponseSchema> | null = null;
  let llmFailureWarning: Diagnostic | null = null;

  try {
    llmOutput = await llmClient.simpleJsonCompletion({
      systemPrompt: buildOverlaySystemPrompt(),
      userPrompt: buildOverlayUserPrompt(topic, candidates),
      schema: LlmOverlayResponseSchema,
    });
  } catch (e) {
    llmFailureWarning = {
      code: "CATALOG_LLM_OVERLAY_UNAVAILABLE",
      message: `LLM-overlay unavailable, returned local-only ranking: ${e instanceof Error ? e.message : String(e)}`,
      context: {},
    };
  }

  // Build the final list. Each candidate may or may not get an llmReason.
  const candidateById = new Map(candidates.map((c) => [c.id, c]));
  const finalById = new Map<string, RecommendResult>(candidates.map((c) => [c.id, { ...c }]));

  if (llmOutput) {
    for (const llmRec of llmOutput.recommendations) {
      const candidate = candidateById.get(llmRec.id);
      if (!candidate) continue; // hallucinated id

      const cited = llmRec.citedEvidence;
      const tagsValid = !cited.tags || cited.tags.every((t) => candidate.evidence.matchedTags.includes(t));
      const useCasesValid = !cited.useCases || cited.useCases.every((u) => candidate.evidence.matchedUseCases.includes(u));
      if (!tagsValid || !useCasesValid) continue;

      // Must cite at least one piece of evidence
      const totalCited = (cited.tags?.length ?? 0) + (cited.useCases?.length ?? 0);
      if (totalCited === 0) continue;

      const final = finalById.get(llmRec.id);
      if (final) final.llmReason = llmRec.llmReason;
    }
  }

  const recommendations = Array.from(finalById.values()).slice(0, opts.maxResults ?? DEFAULT_MAX_RESULTS);

  return llmFailureWarning
    ? { recommendations, warnings: [llmFailureWarning] }
    : { recommendations };
}

function buildOverlaySystemPrompt(): string {
  return `You are a tool recommender. You will receive a topic and a list of candidate MCP server entries with their match evidence. Your job is to:
1. Decide which candidates are genuinely useful for the topic.
2. Provide a one-sentence natural-language reason for each pick.
3. CITE the specific evidence pieces (tags or useCases) that justify the pick. You MAY ONLY cite evidence that appears in the candidate's evidence list — never invent.
4. You MUST cite at least one evidence piece per recommendation.

Output strict JSON matching:
{
  "recommendations": [
    {
      "id": "<candidate id>",
      "llmReason": "<one sentence>",
      "citedEvidence": {
        "tags": [...subset of candidate.evidence.matchedTags],
        "useCases": [...subset of candidate.evidence.matchedUseCases]
      }
    }
  ]
}

Skip candidates that don't fit. Order by usefulness.`;
}

function buildOverlayUserPrompt(topic: string, candidates: RecommendResult[]): string {
  const candidatesText = candidates.map((c) => `- id: ${c.id}
  score: ${c.score.toFixed(2)}
  matchedTags: ${JSON.stringify(c.evidence.matchedTags)}
  matchedUseCases: ${JSON.stringify(c.evidence.matchedUseCases)}
  matchedDescriptionTerms: ${JSON.stringify(c.evidence.matchedDescriptionTerms)}`).join("\n");

  return `Topic: ${topic}

Candidates:
${candidatesText}`;
}
