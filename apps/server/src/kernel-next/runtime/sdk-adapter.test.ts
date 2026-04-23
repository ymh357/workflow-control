// A2.1 — SDK adapter tests. Feed it shapes that mirror the observed
// probe output (docs/kernel-next-phase2-b-feasibility.md) and assert
// the emitted AgentEvents match §4.4.

import { describe, it, expect } from "vitest";
import { createSdkAdapter, type SdkMessageLike } from "./sdk-adapter.js";

const init: SdkMessageLike = { type: "system", subtype: "init" };
const text = (text: string): SdkMessageLike => ({
  type: "assistant",
  message: { content: [{ type: "text", content: text as unknown }] },
});
const thinking: SdkMessageLike = {
  type: "assistant",
  message: { content: [{ type: "thinking" }] },
};
const tool_use = (id: string, name: string, input: unknown): SdkMessageLike => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name, input }] },
});
const tool_result = (id: string): SdkMessageLike => ({
  type: "user",
  message: { content: [{ type: "tool_result", id, content: "ok" }] },
});
// The Anthropic Messages API spec (and what the SDK actually emits)
// uses `tool_use_id`, not `id`. Older fixtures/tests used `id`; this
// form is the real-world shape the adapter must handle to populate
// tool_calls_json's result/finishedAt fields.
const tool_result_spec_compliant = (toolUseId: string): SdkMessageLike => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }] },
});
const tool_result_camel = (toolUseId: string): SdkMessageLike => ({
  type: "user",
  message: { content: [{ type: "tool_result", toolUseId, content: "ok" }] },
});
const compact_start = (trigger: "auto" | "manual", pre: number): SdkMessageLike => ({
  type: "system",
  subtype: "compact_boundary",
  compact_metadata: { trigger, pre_tokens: pre },
});
const rate_limit: SdkMessageLike = {
  type: "rate_limit_event",
  rate_limit_info: { utilization: 0.3 },
};
const result_success: SdkMessageLike = {
  type: "result",
  subtype: "success",
  total_cost_usd: 0.01,
  num_turns: 4,
};
const result_err = (subtype: string, err: string): SdkMessageLike => ({
  type: "result",
  subtype,
  error_message: err,
});

describe("sdk-adapter — individual message mapping", () => {
  it("system/init → SDK_INIT", () => {
    const a = createSdkAdapter();
    expect(a.translate(init)).toEqual([{ type: "SDK_INIT" }]);
  });

  it("assistant text-only → ASSISTANT_TEXT", () => {
    const a = createSdkAdapter();
    expect(a.translate(text("hello"))).toEqual([{ type: "ASSISTANT_TEXT" }]);
  });

  it("assistant thinking-only → ASSISTANT_TEXT (no-op in machine)", () => {
    const a = createSdkAdapter();
    expect(a.translate(thinking)).toEqual([{ type: "ASSISTANT_TEXT" }]);
  });

  it("assistant tool_use → TOOL_USE_REQUESTED with id/name/input", () => {
    const a = createSdkAdapter();
    expect(a.translate(tool_use("t1", "write_port", { x: 1 }))).toEqual([
      { type: "TOOL_USE_REQUESTED", id: "t1", name: "write_port", input: { x: 1 } },
    ]);
  });

  it("user tool_result → TOOL_RESULT_RECEIVED", () => {
    const a = createSdkAdapter();
    const evs = a.translate(tool_result("t1"));
    expect(evs).toHaveLength(1);
    expect(evs[0]?.type).toBe("TOOL_RESULT_RECEIVED");
  });

  // Bug fix (post run #19/#20): real SDK emits tool_use_id (Anthropic
  // Messages API spec), not `id`. The adapter was only looking at `id`,
  // so every real-world tool_result was silently dropped and
  // tool_calls_json.result stayed null. Support spec-compliant key.
  it("user tool_result with tool_use_id (spec form) → TOOL_RESULT_RECEIVED with correct id", () => {
    const a = createSdkAdapter();
    const evs = a.translate(tool_result_spec_compliant("toolu_01Q7NHhUa"));
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "TOOL_RESULT_RECEIVED", id: "toolu_01Q7NHhUa" });
  });

  // Defensive: some SDK paths expose camelCase toolUseId on the JS
  // object. Accept both so we're robust against SDK internal renames.
  it("user tool_result with toolUseId (camel form) → TOOL_RESULT_RECEIVED with correct id", () => {
    const a = createSdkAdapter();
    const evs = a.translate(tool_result_camel("toolu_01Q7NHhUa"));
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "TOOL_RESULT_RECEIVED", id: "toolu_01Q7NHhUa" });
  });

  it("rate_limit_event → RATE_LIMIT_SIGNAL with utilization", () => {
    const a = createSdkAdapter();
    expect(a.translate(rate_limit)).toEqual([
      { type: "RATE_LIMIT_SIGNAL", utilization: 0.3 },
    ]);
  });

  it("result/success → RESULT_SUCCESS with cost/turns", () => {
    const a = createSdkAdapter();
    expect(a.translate(result_success)).toEqual([
      { type: "RESULT_SUCCESS", cost_usd: 0.01, num_turns: 4 },
    ]);
  });

  it("result/error_* → RESULT_ERROR with subtype/message", () => {
    const a = createSdkAdapter();
    expect(a.translate(result_err("error_max_turns", "boom"))).toEqual([
      { type: "RESULT_ERROR", subtype: "error_max_turns", message: "boom" },
    ]);
  });
});

describe("sdk-adapter — compact window", () => {
  it("compact_boundary emits COMPACT_STARTED; next non-compact msg prepends COMPACT_ENDED", () => {
    const a = createSdkAdapter();
    expect(a.translate(compact_start("auto", 50_000))).toEqual([
      { type: "COMPACT_STARTED", trigger: "auto", pre_tokens: 50_000 },
    ]);
    const evs = a.translate(text("post-compact"));
    expect(evs).toEqual([{ type: "COMPACT_ENDED" }, { type: "ASSISTANT_TEXT" }]);
  });

  it("back-to-back compact_boundary stays in compact (no synthetic END between)", () => {
    const a = createSdkAdapter();
    a.translate(compact_start("auto", 1));
    const evs = a.translate(compact_start("manual", 2));
    expect(evs).toEqual([{ type: "COMPACT_STARTED", trigger: "manual", pre_tokens: 2 }]);
  });
});

describe("sdk-adapter — observed-template sequence", () => {
  it("A-simple template: init + tool×1 + text + success", () => {
    const a = createSdkAdapter();
    const stream: SdkMessageLike[] = [
      init,
      thinking,
      tool_use("w1", "write_port", {}),
      tool_result("w1"),
      rate_limit,
      thinking,
      text("done"),
      result_success,
    ];
    const out = stream.flatMap((m) => a.translate(m));
    const types = out.map((e) => e.type);
    expect(types).toEqual([
      "SDK_INIT",
      "ASSISTANT_TEXT",
      "TOOL_USE_REQUESTED",
      "TOOL_RESULT_RECEIVED",
      "RATE_LIMIT_SIGNAL",
      "ASSISTANT_TEXT",
      "ASSISTANT_TEXT",
      "RESULT_SUCCESS",
    ]);
    expect(a.unknownMessages).toEqual([]);
  });
});

describe("sdk-adapter — unknown messages", () => {
  it("records unknown message types without faulting", () => {
    const a = createSdkAdapter();
    const evs = a.translate({ type: "future_message_type", subtype: "new" });
    expect(evs).toEqual([]);
    expect(a.unknownMessages).toEqual([{ type: "future_message_type", subtype: "new" }]);
  });

  it("partial_assistant (stream_event) treated as unknown", () => {
    const a = createSdkAdapter();
    const evs = a.translate({ type: "stream_event" } as SdkMessageLike);
    expect(evs).toEqual([]);
  });
});
