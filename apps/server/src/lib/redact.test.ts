// B6.#24 + B6.#23 (2026-04-30 review) regression tests for the
// redact module: ensure both the object-walker (redactSensitive) and
// the in-text scanner (redactStringPreview) catch the expanded set
// of provider-specific token shapes.

import { describe, it, expect } from "vitest";
import { redactSensitive, redactStringPreview } from "./redact.js";

describe("redactSensitive — object-key + value-pattern path (B6.#24 expansions)", () => {
  it("redacts client_secret_id key (B6.#24 added)", () => {
    const out = redactSensitive({ client_secret_id: "abc123" }) as Record<string, unknown>;
    expect(out.client_secret_id).toBe("[REDACTED]");
  });

  it("redacts webhook_url key (B6.#24 added)", () => {
    const out = redactSensitive({ webhook_url: "https://hooks.slack.com/services/T0/B0/xxxx" }) as Record<string, unknown>;
    expect(out.webhook_url).toBe("[REDACTED]");
  });

  it("redacts aws_session_token key (B6.#24 added)", () => {
    const out = redactSensitive({ aws_session_token: "FwoGZXIvYXdzE..." }) as Record<string, unknown>;
    expect(out.aws_session_token).toBe("[REDACTED]");
  });

  it("redacts Stripe sk_live_ value as full string match", () => {
    const out = redactSensitive("sk_live_REDACTED_TEST_FIXTURE");
    expect(out).toBe("[REDACTED]");
  });

  it("redacts Anthropic sk-ant- value as full string match", () => {
    const out = redactSensitive("sk-ant-api03-REDACTED_TEST_FIXTURE");
    expect(out).toBe("[REDACTED]");
  });

  it("redacts Google AIza value as full string match", () => {
    const out = redactSensitive("AIzaSyDummyKeyForTestingOnly1234567890");
    expect(out).toBe("[REDACTED]");
  });

  it("preserves non-sensitive plain strings", () => {
    expect(redactSensitive("just some normal text")).toBe("just some normal text");
  });
});

describe("redactStringPreview — in-text token scrubber (B6.#23)", () => {
  it("redacts Anthropic API key embedded in a sentence", () => {
    const text = `Tool returned token sk-ant-api03-REDACTED_TEST_FIXTUREABCDEF in payload.`;
    const out = redactStringPreview(text);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("sk-ant-api03");
  });

  it("redacts GitHub PAT embedded in a sentence", () => {
    const text = `Auth header was Bearer ghp_abcdefghijklmnopqrstuvwxyz1234567890 yesterday.`;
    const out = redactStringPreview(text);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("ghp_");
  });

  it("redacts multiple tokens in one preview", () => {
    const text = `keys: sk-ant-api03-abcdefghijklmnop1 and AKIAIOSFODNN7EXAMPLE both leaked.`;
    const out = redactStringPreview(text);
    const hits = out.match(/\[REDACTED\]/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(out).not.toContain("AKIAIOSFODNN7");
  });

  it("redacts JWT-shaped tokens", () => {
    const text = `id_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c`;
    const out = redactStringPreview(text);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("redacts Stripe live secret key", () => {
    const text = `Customer charge succeeded with sk_live_REDACTED_STRIPE_FIXTURE.`;
    const out = redactStringPreview(text);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("sk_live_REDACT");
  });

  it("preserves text with no tokens unchanged", () => {
    const text = "Failed to extract JSON from agent output: unexpected character.";
    expect(redactStringPreview(text)).toBe(text);
  });

  it("preserves surrounding text around the redacted token", () => {
    const text = "key=sk-ant-abcdefghijklmnop1234567890XX continued";
    const out = redactStringPreview(text);
    expect(out).toContain("key=");
    expect(out).toContain(" continued");
  });
});
