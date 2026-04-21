import { describe, it, expect } from "vitest";
import {
  normalizePromptContent,
  promptContentHash,
} from "./canonical.js";

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
