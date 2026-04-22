// Synth safe-range expansion — subAgents.
//
// Prior iteration (Phase 4.5 T6) restricted AI-synthesised configPatch
// to {promptRef} only. This suite covers the expansion to subAgents
// (the second legitimate AgentStage config field per kernel-next IR
// schema). Structural validation mirrors SubAgentDefSchema so malformed
// entries are rejected rather than shipped.

import { describe, it, expect } from "vitest";
import { createClaudeSdkPatchSynthesizer } from "./claude-sdk-patch-synthesizer.js";
import type { FixSuggestion } from "./propose-pipeline-fix.js";
import type { PipelineIR } from "../ir/schema.js";

function simpleIR(): PipelineIR {
  return {
    name: "p",
    stages: [
      {
        name: "B", type: "agent",
        inputs: [{ name: "x", type: "string" }],
        outputs: [{ name: "y", type: "string" }],
        config: { promptRef: "p-b" },
      },
    ],
    wires: [],
  };
}

function errorSuggestion(): FixSuggestion {
  return {
    kind: "error_status",
    targetStage: "B",
    severity: "error",
    description: "B ended with error",
    rationale: "maybe missing tooling",
  };
}

function fakeStream(messages: Array<{ type: "assistant"; text: string }>) {
  return (async function* () {
    for (const m of messages) {
      if (m.type === "assistant") {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: m.text }] },
        };
      }
    }
    yield { type: "result", subtype: "success" };
  })();
}

describe("claude-sdk-patch-synthesizer — subAgents expansion", () => {
  it("accepts a configPatch containing a valid subAgents array", async () => {
    const synth = createClaudeSdkPatchSynthesizer({
      queryFn: (() => fakeStream([
        {
          type: "assistant",
          text: "```json\n" + JSON.stringify({
            ops: [{
              op: "update_stage_config",
              stage: "B",
              configPatch: {
                subAgents: [{
                  name: "analyst",
                  description: "deep reads on failure traces",
                  prompt: "Inspect the agent_execution_details stream...",
                  tools: ["Read", "Grep"],
                  model: "haiku",
                }],
              },
            }],
          }) + "\n```",
        },
      ])) as never,
    });
    const patch = await synth.synthesize({ suggestion: errorSuggestion(), ir: simpleIR() });
    expect(patch).not.toBeNull();
    const op = patch!.ops[0]!;
    if (op.op !== "update_stage_config") throw new Error("unexpected op");
    const cp = op.configPatch as { subAgents?: unknown };
    expect(Array.isArray(cp.subAgents)).toBe(true);
  });

  it("accepts a configPatch combining promptRef + subAgents", async () => {
    const synth = createClaudeSdkPatchSynthesizer({
      queryFn: (() => fakeStream([
        {
          type: "assistant",
          text: "```json\n" + JSON.stringify({
            ops: [{
              op: "update_stage_config",
              stage: "B",
              configPatch: {
                promptRef: "p-b-v2",
                subAgents: [{
                  name: "scout",
                  description: "lightweight reader",
                  prompt: "Read $input and summarise...",
                }],
              },
            }],
          }) + "\n```",
        },
      ])) as never,
    });
    const patch = await synth.synthesize({ suggestion: errorSuggestion(), ir: simpleIR() });
    expect(patch).not.toBeNull();
    const op = patch!.ops[0]!;
    if (op.op !== "update_stage_config") throw new Error("unexpected op");
    expect(op.configPatch).toMatchObject({
      promptRef: "p-b-v2",
    });
    expect(Array.isArray((op.configPatch as { subAgents?: unknown[] }).subAgents)).toBe(true);
  });

  it("rejects subAgents entries that fail SubAgentDefSchema (invalid name)", async () => {
    const synth = createClaudeSdkPatchSynthesizer({
      queryFn: (() => fakeStream([
        {
          type: "assistant",
          text: "```json\n" + JSON.stringify({
            ops: [{
              op: "update_stage_config",
              stage: "B",
              configPatch: {
                // leading digit violates identifier pattern
                subAgents: [{ name: "9bad", description: "d", prompt: "p" }],
              },
            }],
          }) + "\n```",
        },
      ])) as never,
    });
    const patch = await synth.synthesize({ suggestion: errorSuggestion(), ir: simpleIR() });
    expect(patch).toBeNull();
  });

  it("rejects subAgents entries missing required fields", async () => {
    const synth = createClaudeSdkPatchSynthesizer({
      queryFn: (() => fakeStream([
        {
          type: "assistant",
          text: "```json\n" + JSON.stringify({
            ops: [{
              op: "update_stage_config",
              stage: "B",
              configPatch: {
                // missing `prompt`
                subAgents: [{ name: "foo", description: "x" }],
              },
            }],
          }) + "\n```",
        },
      ])) as never,
    });
    const patch = await synth.synthesize({ suggestion: errorSuggestion(), ir: simpleIR() });
    expect(patch).toBeNull();
  });

  it("still rejects disallowed configPatch keys (only promptRef + subAgents permitted)", async () => {
    const synth = createClaudeSdkPatchSynthesizer({
      queryFn: (() => fakeStream([
        {
          type: "assistant",
          text: "```json\n" + JSON.stringify({
            ops: [{
              op: "update_stage_config",
              stage: "B",
              configPatch: { something: "new" },
            }],
          }) + "\n```",
        },
      ])) as never,
    });
    const patch = await synth.synthesize({ suggestion: errorSuggestion(), ir: simpleIR() });
    expect(patch).toBeNull();
  });

  it("accepts an empty subAgents array (removes subagents)", async () => {
    const synth = createClaudeSdkPatchSynthesizer({
      queryFn: (() => fakeStream([
        {
          type: "assistant",
          text: "```json\n" + JSON.stringify({
            ops: [{
              op: "update_stage_config",
              stage: "B",
              configPatch: { subAgents: [] },
            }],
          }) + "\n```",
        },
      ])) as never,
    });
    const patch = await synth.synthesize({ suggestion: errorSuggestion(), ir: simpleIR() });
    expect(patch).not.toBeNull();
    const op = patch!.ops[0]!;
    if (op.op !== "update_stage_config") throw new Error("unexpected op");
    expect((op.configPatch as { subAgents?: unknown[] }).subAgents).toEqual([]);
  });
});
