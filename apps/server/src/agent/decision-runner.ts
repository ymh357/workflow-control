import { taskLogger } from "../lib/logger.js";
import type { WorkflowContext } from "../machine/types.js";
import type { LlmDecisionRuntimeConfig } from "../lib/config/types.js";
import { getNestedValue } from "../lib/config-loader.js";

export interface LlmDecisionInput {
  taskId: string;
  stageName: string;
  context: WorkflowContext;
  runtime: LlmDecisionRuntimeConfig;
}

export async function runLlmDecision(
  _taskId: string,
  input: LlmDecisionInput,
): Promise<{ choiceId: string; goto: string }> {
  const { taskId, stageName, context, runtime } = input;
  const log = taskLogger(taskId);

  // Build context from reads
  const readContext: Record<string, unknown> = {};
  if (runtime.reads) {
    for (const [key, rawPath] of Object.entries(runtime.reads)) {
      const path = rawPath.startsWith("store.") ? rawPath.slice(6) : rawPath;
      const value = getNestedValue(context.store, path);
      if (value !== undefined) readContext[key] = value;
    }
  }

  // Build the decision prompt
  const choiceList = runtime.choices
    .map((c) => `- "${c.id}": ${c.description}`)
    .join("\n");

  const fullPrompt = [
    runtime.prompt,
    "",
    "Available choices:",
    choiceList,
    "",
    "Context:",
    JSON.stringify(readContext, null, 2).slice(0, 4000),
    "",
    `Respond with ONLY the choice id (one of: ${runtime.choices.map((c) => c.id).join(", ")}). No explanation.`,
  ].join("\n");

  log.info({ stage: stageName, choices: runtime.choices.map((c) => c.id) }, "Running LLM decision");

  try {
    // @ts-expect-error -- runtime-only dependency, types not installed in this package
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    const response: { content: Array<{ type: string; text?: string }> } = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 50,
      messages: [{ role: "user", content: fullPrompt }],
    });

    const responseText = response.content
      .filter((block: { type: string; text?: string }): block is { type: "text"; text: string } => block.type === "text")
      .map((block: { type: "text"; text: string }) => block.text)
      .join("")
      .trim()
      .toLowerCase();

    // Exact match first
    const exactMatch = runtime.choices.find((c) => responseText === c.id.toLowerCase());
    // Substring match with longest-first to avoid short ID matching inside longer IDs
    const sorted = [...runtime.choices].sort((a, b) => b.id.length - a.id.length);
    const substringMatch = sorted.find((c) => responseText.includes(c.id.toLowerCase()));
    const matched = exactMatch ?? substringMatch;

    if (matched) {
      log.info({ stage: stageName, choiceId: matched.id, goto: matched.goto }, "LLM decision resolved");
      return { choiceId: matched.id, goto: matched.goto };
    }

    // Fallback to default
    const defaultChoice = runtime.choices.find((c) => c.id === runtime.default_choice)!;
    log.warn(
      { stage: stageName, response: responseText, fallback: defaultChoice.id },
      "LLM response did not match any choice, using default",
    );
    return { choiceId: defaultChoice.id, goto: defaultChoice.goto };
  } catch (err) {
    // On any LLM error, use default choice
    const defaultChoice = runtime.choices.find((c) => c.id === runtime.default_choice)!;
    log.error({ stage: stageName, err }, "LLM decision call failed, using default choice");
    return { choiceId: defaultChoice.id, goto: defaultChoice.goto };
  }
}
