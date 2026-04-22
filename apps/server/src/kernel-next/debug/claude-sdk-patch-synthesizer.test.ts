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
    rationale: "prompt likely too vague",
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

describe("createClaudeSdkPatchSynthesizer", () => {
  it("parses a valid JSON update_stage_config block into an IRPatch", async () => {
    const synth = createClaudeSdkPatchSynthesizer({
      queryFn: (() => fakeStream([
        {
          type: "assistant",
          text: "Reasoning...\n```json\n{ \"ops\": [ { \"op\": \"update_stage_config\", \"stage\": \"B\", \"configPatch\": { \"promptRef\": \"p-b-v2\" } } ] }\n```",
        },
      ])) as never,
    });
    const patch = await synth.synthesize({ suggestion: errorSuggestion(), ir: simpleIR() });
    expect(patch).not.toBeNull();
    expect(patch!.ops).toHaveLength(1);
    expect(patch!.ops[0]).toMatchObject({
      op: "update_stage_config",
      stage: "B",
      configPatch: { promptRef: "p-b-v2" },
    });
  });

  it("returns null when the assistant emits NO_PATCH", async () => {
    const synth = createClaudeSdkPatchSynthesizer({
      queryFn: (() => fakeStream([
        { type: "assistant", text: "NO_PATCH" },
      ])) as never,
    });
    const patch = await synth.synthesize({ suggestion: errorSuggestion(), ir: simpleIR() });
    expect(patch).toBeNull();
  });

  it("returns null on unparseable JSON", async () => {
    const synth = createClaudeSdkPatchSynthesizer({
      queryFn: (() => fakeStream([
        { type: "assistant", text: "```json\nnot-valid-json\n```" },
      ])) as never,
    });
    const patch = await synth.synthesize({ suggestion: errorSuggestion(), ir: simpleIR() });
    expect(patch).toBeNull();
  });

  it("rejects ops that are not update_stage_config (safe-range)", async () => {
    const synth = createClaudeSdkPatchSynthesizer({
      queryFn: (() => fakeStream([
        {
          type: "assistant",
          text: "```json\n{ \"ops\": [ { \"op\": \"remove_stage\", \"stageName\": \"B\" } ] }\n```",
        },
      ])) as never,
    });
    const patch = await synth.synthesize({ suggestion: errorSuggestion(), ir: simpleIR() });
    expect(patch).toBeNull();
  });

  it("rejects configPatch with disallowed keys (only promptRef is currently safe)", async () => {
    const synth = createClaudeSdkPatchSynthesizer({
      queryFn: (() => fakeStream([
        {
          type: "assistant",
          text: "```json\n{ \"ops\": [ { \"op\": \"update_stage_config\", \"stage\": \"B\", \"configPatch\": { \"subAgents\": [] } } ] }\n```",
        },
      ])) as never,
    });
    const patch = await synth.synthesize({ suggestion: errorSuggestion(), ir: simpleIR() });
    expect(patch).toBeNull();
  });

  it("rejects patch whose stage doesn't match the suggestion target", async () => {
    const synth = createClaudeSdkPatchSynthesizer({
      queryFn: (() => fakeStream([
        {
          type: "assistant",
          text: "```json\n{ \"ops\": [ { \"op\": \"update_stage_config\", \"stage\": \"WRONG\", \"configPatch\": { \"promptRef\": \"p\" } } ] }\n```",
        },
      ])) as never,
    });
    const patch = await synth.synthesize({ suggestion: errorSuggestion(), ir: simpleIR() });
    expect(patch).toBeNull();
  });

  it("returns null when the target stage is not in the IR", async () => {
    const synth = createClaudeSdkPatchSynthesizer({
      queryFn: (() => fakeStream([])) as never,
    });
    const patch = await synth.synthesize({
      suggestion: { ...errorSuggestion(), targetStage: "GHOST" },
      ir: simpleIR(),
    });
    expect(patch).toBeNull();
  });

  it("returns null when the SDK stream throws", async () => {
    const synth = createClaudeSdkPatchSynthesizer({
      // eslint-disable-next-line require-yield
      queryFn: (() => (async function* () { throw new Error("network fail"); })()) as never,
    });
    const patch = await synth.synthesize({ suggestion: errorSuggestion(), ir: simpleIR() });
    expect(patch).toBeNull();
  });

  it("accepts JSON embedded without a code fence", async () => {
    const synth = createClaudeSdkPatchSynthesizer({
      queryFn: (() => fakeStream([
        {
          type: "assistant",
          text: "{ \"ops\": [ { \"op\": \"update_stage_config\", \"stage\": \"B\", \"configPatch\": { \"promptRef\": \"p-b-v3\" } } ] }",
        },
      ])) as never,
    });
    const patch = await synth.synthesize({ suggestion: errorSuggestion(), ir: simpleIR() });
    expect(patch).not.toBeNull();
    const op = patch!.ops[0]!;
    if (op.op !== "update_stage_config") throw new Error("unexpected op kind");
    expect(op.configPatch).toEqual({ promptRef: "p-b-v3" });
  });
});
