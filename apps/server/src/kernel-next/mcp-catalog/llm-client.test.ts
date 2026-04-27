import { describe, it, expect } from "vitest";
import { z } from "zod";
import { simpleJsonCompletion, type AnthropicLikeClient } from "./llm-client.js";

function fakeClient(responseText: string): AnthropicLikeClient {
  return {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: responseText }],
      }),
    },
  };
}

const schema = z.object({ items: z.array(z.string()) });

describe("simpleJsonCompletion", () => {
  it("parses a clean JSON response", async () => {
    const client = fakeClient(`{"items": ["a", "b"]}`);
    const out = await simpleJsonCompletion({
      client,
      systemPrompt: "system",
      userPrompt: "user",
      schema,
    });
    expect(out).toEqual({ items: ["a", "b"] });
  });

  it("strips markdown code fences", async () => {
    const client = fakeClient("```json\n{\"items\": [\"a\"]}\n```");
    const out = await simpleJsonCompletion({
      client,
      systemPrompt: "system",
      userPrompt: "user",
      schema,
    });
    expect(out).toEqual({ items: ["a"] });
  });

  it("throws on invalid JSON", async () => {
    const client = fakeClient("not json");
    await expect(
      simpleJsonCompletion({
        client,
        systemPrompt: "s",
        userPrompt: "u",
        schema,
      }),
    ).rejects.toThrow(/JSON|parse/i);
  });

  it("throws on schema mismatch", async () => {
    const client = fakeClient(`{"wrong": "shape"}`);
    await expect(
      simpleJsonCompletion({
        client,
        systemPrompt: "s",
        userPrompt: "u",
        schema,
      }),
    ).rejects.toThrow();
  });

  it("throws when model returns no text content", async () => {
    const client: AnthropicLikeClient = {
      messages: {
        create: async () => ({ content: [] }),
      },
    };
    await expect(
      simpleJsonCompletion({
        client,
        systemPrompt: "s",
        userPrompt: "u",
        schema,
      }),
    ).rejects.toThrow(/no text/i);
  });
});
