import { describe, it, expect } from "vitest";
import { redact, REDACTION_PATTERNS } from "../ingestion/redactor.js";

describe("redact", () => {
  it("redacts GitHub PAT", () => {
    const r = redact("token=ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(r.redacted).toContain("<REDACTED:github-token>");
    expect(r.redacted).not.toContain("ghp_abcdef");
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.kind).toBe("github-token");
  });

  it("redacts OpenAI key", () => {
    const r = redact("OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789AAAA");
    expect(r.redacted).toContain("<REDACTED:openai-key>");
    expect(r.redacted).not.toContain("sk-proj-abcdef");
  });

  it("redacts Slack bot token", () => {
    const r = redact("xoxb-12345-67890-abcdefghijklmnop");
    expect(r.redacted).toContain("<REDACTED:slack-token>");
  });

  it("redacts AWS access key", () => {
    const r = redact("AKIAIOSFODNN7EXAMPLE");
    expect(r.redacted).toContain("<REDACTED:aws-access-key>");
  });

  it("redacts Bearer header", () => {
    const r = redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789");
    expect(r.redacted).toContain("<REDACTED:bearer-token>");
  });

  it("leaves plain text untouched", () => {
    const r = redact("hello world this is a normal message");
    expect(r.redacted).toBe("hello world this is a normal message");
    expect(r.hits).toHaveLength(0);
  });

  it("handles empty string", () => {
    const r = redact("");
    expect(r.redacted).toBe("");
    expect(r.hits).toHaveLength(0);
  });

  it("redacts multiple distinct secrets in one string", () => {
    const r = redact("gh ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa and oa sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(r.hits.length).toBeGreaterThanOrEqual(2);
    expect(r.redacted).toContain("<REDACTED:github-token>");
    expect(r.redacted).toContain("<REDACTED:openai-key>");
  });

  it("handles overlapping patterns deterministically (no double-replacement)", () => {
    const r1 = redact("token sk-test-value-aaaaaaaaaaaaaaaaaaa more");
    const r2 = redact("token sk-test-value-aaaaaaaaaaaaaaaaaaa more");
    expect(r1.redacted).toBe(r2.redacted);
  });

  it("REDACTION_PATTERNS includes all expected kinds", () => {
    const kinds = REDACTION_PATTERNS.map((p) => p.kind);
    expect(kinds).toContain("github-token");
    expect(kinds).toContain("openai-key");
    expect(kinds).toContain("slack-token");
    expect(kinds).toContain("aws-access-key");
    expect(kinds).toContain("bearer-token");
  });

  it("hit indices point at the original (pre-redaction) string", () => {
    const text = "before ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa after";
    const r = redact(text);
    const hit = r.hits[0]!;
    expect(text.slice(hit.startIndex, hit.endIndex)).toMatch(/^ghp_a+$/);
  });

  it("does not match a too-short github token", () => {
    const r = redact("ghp_short");
    expect(r.hits).toHaveLength(0);
    expect(r.redacted).toBe("ghp_short");
  });

  it("redacts adjacent secrets without merging them", () => {
    const r = redact("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AKIAIOSFODNN7EXAMPLE");
    expect(r.hits).toHaveLength(2);
    expect(r.redacted).toBe("<REDACTED:github-token> <REDACTED:aws-access-key>");
  });
});
