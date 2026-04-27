import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";

/**
 * Minimal interface that allows us to inject a fake client in tests.
 * The real Anthropic SDK client satisfies this shape.
 */
export interface AnthropicLikeClient {
  messages: {
    create: (params: {
      model?: string;
      max_tokens?: number;
      system?: string;
      messages?: Array<{ role: "user" | "assistant"; content: string }>;
    }) => Promise<{
      content: Array<{ type: string; text?: string }>;
    }>;
  };
}

export type SimpleJsonCompletionArgs<T> = {
  client?: AnthropicLikeClient;
  systemPrompt: string;
  userPrompt: string;
  schema: z.ZodSchema<T>;
  model?: string;
  maxTokens?: number;
};

let defaultClient: AnthropicLikeClient | null = null;

function getDefaultClient(): AnthropicLikeClient {
  if (defaultClient) return defaultClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set; cannot run LLM-overlay");
  }
  defaultClient = new Anthropic({ apiKey }) as unknown as AnthropicLikeClient;
  return defaultClient;
}

export async function simpleJsonCompletion<T>(
  args: SimpleJsonCompletionArgs<T>,
): Promise<T> {
  const client = args.client ?? getDefaultClient();
  const model = args.model ?? "claude-haiku-4-5";
  const maxTokens = args.maxTokens ?? 500;

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: args.systemPrompt,
    messages: [{ role: "user", content: args.userPrompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || typeof textBlock.text !== "string") {
    throw new Error("LLM response had no text content");
  }
  const text = textBlock.text;

  const json = stripMarkdownAndParseJson(text);

  const validated = args.schema.safeParse(json);
  if (!validated.success) {
    throw new Error(
      `LLM output did not match schema: ${validated.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return validated.data;
}

function stripMarkdownAndParseJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  return JSON.parse(body.trim());
}
