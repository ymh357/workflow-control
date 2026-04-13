import { taskLogger } from "../lib/logger.js";

const MAX_VALUE_CHARS = 4000;

export async function generateSemanticSummary(
  taskId: string,
  storeKey: string,
  value: unknown,
  summaryPrompt: string,
): Promise<string | null> {
  const log = taskLogger(taskId);

  try {
    let serialized = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    if (serialized.length > MAX_VALUE_CHARS) {
      serialized = serialized.slice(0, MAX_VALUE_CHARS) + "\n... [truncated]";
    }

    // @ts-expect-error -- runtime-only dependency, types not installed in this package
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    const response: { content: Array<{ type: string; text?: string }> } = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: `${summaryPrompt}\n\nContent:\n${serialized}`,
        },
      ],
    });

    const text = response.content.find(
      (b: { type: string; text?: string }): b is { type: "text"; text: string } => b.type === "text",
    );
    if (!text) return null;

    log.info({ storeKey, summaryLength: text.text.length }, "Semantic summary generated");
    return text.text;
  } catch (err) {
    log.warn({ err, storeKey }, "Semantic summary generation failed (non-blocking)");
    return null;
  }
}
