// Parse forge-distill agent output → SessionEpisode[]. The agent
// output is expected to be a JSON array of episode descriptors, but
// agents sometimes wrap output in prose; we also try extracting the
// first [...] block from a larger string.

import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { SessionEpisode } from "../types.js";

const EpisodeSchema = z.object({
  intent: z.string().min(1),
  start_seq: z.number().int().nonnegative(),
  end_seq: z.number().int().nonnegative(),
  steps: z.array(z.object({
    stage_kind: z.enum(["agent", "tool", "decision"]),
    description: z.string(),
    inputs: z.array(z.string()).optional(),
    outputs: z.array(z.string()).optional(),
    tool_calls: z.array(z.string()).optional(),
  })),
  outcome: z.enum(["completed", "abandoned", "partial", "exploratory"]),
  pipeline_able: z.boolean(),
  rationale: z.string(),
});

const ArraySchema = z.array(EpisodeSchema);

export class ExtractError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function extractEpisodes(rawJson: string, sessionId: string): SessionEpisode[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    const match = rawJson.match(/\[[\s\S]*\]/);
    if (!match) throw new ExtractError("EXTRACT_BAD_JSON", "no JSON array found");
    try { parsed = JSON.parse(match[0]); }
    catch { throw new ExtractError("EXTRACT_BAD_JSON", "malformed JSON"); }
  }
  const r = ArraySchema.safeParse(parsed);
  if (!r.success) {
    throw new ExtractError(
      "EXTRACT_SCHEMA_FAIL",
      r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  const now = Date.now();
  return r.data.map((e) => ({
    episodeId: randomUUID(),
    sessionId,
    startSeq: e.start_seq,
    endSeq: e.end_seq,
    intent: e.intent,
    outcome: e.outcome,
    steps: e.steps.map((s) => ({
      stageKind: s.stage_kind,
      description: s.description,
      inputs: s.inputs,
      outputs: s.outputs,
      toolCalls: s.tool_calls,
    })),
    rationale: e.rationale,
    pipelineAble: e.pipeline_able,
    createdAt: now,
  }));
}
