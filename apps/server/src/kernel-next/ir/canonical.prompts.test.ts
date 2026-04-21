import { describe, it, expect } from "vitest";
import {
  canonicalizePipeline,
  normalizePromptContent,
  pipelineCanonicalJSON,
  pipelineVersionHash,
  promptContentHash,
  versionHash,
} from "./canonical.js";
import type { PipelineIR } from "./schema.js";

describe("normalizePromptContent", () => {
  it("strips UTF-8 BOM", () => {
    expect(normalizePromptContent("\uFEFFhello\n")).toBe("hello\n");
  });

  it("converts CRLF and lone CR to LF", () => {
    expect(normalizePromptContent("a\r\nb\rc\n")).toBe("a\nb\nc\n");
  });

  it("strips trailing whitespace per line", () => {
    expect(normalizePromptContent("hi  \n  there\t\n")).toBe("hi\n  there\n");
  });

  it("appends a trailing newline when missing", () => {
    expect(normalizePromptContent("hi")).toBe("hi\n");
  });

  it("keeps a single trailing newline intact", () => {
    expect(normalizePromptContent("hi\n")).toBe("hi\n");
  });
});

describe("promptContentHash", () => {
  it("hashes equivalent content to the same digest regardless of CRLF/BOM/trailing-space", () => {
    const a = promptContentHash("hello\n");
    const b = promptContentHash("\uFEFFhello  \r\n");
    expect(a).toBe(b);
  });

  it("returns a 64-char hex sha256", () => {
    const h = promptContentHash("x");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when normalized content differs", () => {
    expect(promptContentHash("a")).not.toBe(promptContentHash("b"));
  });
});

const tinyIR: PipelineIR = {
  name: "tiny",
  stages: [{
    name: "a",
    type: "agent",
    inputs: [],
    outputs: [],
    config: { promptRef: "a" },
  }],
  wires: [],
};

describe("canonicalizePipeline", () => {
  it("sorts prompt keys by codepoint independent of input order", () => {
    const c1 = canonicalizePipeline({ ir: tinyIR, prompts: { b: "B", a: "A" } });
    const c2 = canonicalizePipeline({ ir: tinyIR, prompts: { a: "A", b: "B" } });
    expect(JSON.stringify(c1)).toBe(JSON.stringify(c2));
  });

  it("embeds sha256:<hex> references for each prompt", () => {
    const c = canonicalizePipeline({ ir: tinyIR, prompts: { a: "hello" } });
    const s = JSON.stringify(c);
    expect(s).toMatch(/"a":"sha256:[0-9a-f]{64}"/);
  });
});

describe("pipelineVersionHash", () => {
  it("differs when a prompt changes but IR is the same", () => {
    const h1 = pipelineVersionHash({ ir: tinyIR, prompts: { a: "v1" } });
    const h2 = pipelineVersionHash({ ir: tinyIR, prompts: { a: "v2" } });
    expect(h1).not.toBe(h2);
  });

  it("differs when IR changes but prompts are the same", () => {
    const ir2: PipelineIR = {
      ...tinyIR,
      stages: [{ ...tinyIR.stages[0]!, name: "b" }],
    };
    expect(
      pipelineVersionHash({ ir: tinyIR, prompts: { a: "x" } }),
    ).not.toBe(
      pipelineVersionHash({ ir: ir2, prompts: { a: "x" } }),
    );
  });

  it("is stable across whitespace-only changes in prompts", () => {
    const h1 = pipelineVersionHash({ ir: tinyIR, prompts: { a: "hello\n" } });
    const h2 = pipelineVersionHash({ ir: tinyIR, prompts: { a: "\uFEFFhello  \r\n" } });
    expect(h1).toBe(h2);
  });

  it("empty prompts map is a distinct hash from an IR with no prompts map (no-arg versionHash)", () => {
    const pipelineHash = pipelineVersionHash({ ir: tinyIR, prompts: {} });
    const irOnlyHash = versionHash(tinyIR);
    expect(pipelineHash).not.toBe(irOnlyHash);
  });
});

// Keep pipelineCanonicalJSON referenced so the import is live (it is
// exercised indirectly by pipelineVersionHash, but an explicit type check
// keeps the API surface pinned).
void pipelineCanonicalJSON;
