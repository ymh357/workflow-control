import { describe, it, expect } from "vitest";
import {
  PipelineExportEnvelopeSchema,
  buildEnvelope,
  parseEnvelope,
  EXPORT_FORMAT_V1,
} from "./export-envelope.js";
import { diamondIR } from "../generator-mock/mini-generator.js";
import type { PipelineIR } from "./schema.js";

void PipelineExportEnvelopeSchema; // keep schema export covered by smoke import

function diamondPrompts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of diamondIR().stages) {
    if (s.type === "agent") out[s.config.promptRef] = "dummy";
  }
  return out;
}

describe("buildEnvelope", () => {
  it("produces an envelope with the v1 format literal", () => {
    const env = buildEnvelope({
      pipelineName: "p",
      versionHash: "a".repeat(64),
      parentHash: null,
      createdAt: 1_700_000_000_000,
      ir: diamondIR() as PipelineIR,
      prompts: diamondPrompts(),
      now: 1_700_000_001_000,
    });
    expect(env.format).toBe(EXPORT_FORMAT_V1);
    expect(env.exportedAt).toBe(1_700_000_001_000);
    expect(env.source).toEqual({
      pipelineName: "p",
      versionHash: "a".repeat(64),
      parentHash: null,
      createdAt: 1_700_000_000_000,
    });
    expect(env.prompts).toEqual(diamondPrompts());
  });

  it("round-trips through parseEnvelope without loss", () => {
    const built = buildEnvelope({
      pipelineName: "p",
      versionHash: "b".repeat(64),
      parentHash: "c".repeat(64),
      createdAt: 1,
      ir: diamondIR() as PipelineIR,
      prompts: diamondPrompts(),
      now: 2,
    });
    const parsed = parseEnvelope(JSON.parse(JSON.stringify(built)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.envelope).toEqual(built);
  });
});

describe("parseEnvelope", () => {
  function valid(): unknown {
    return buildEnvelope({
      pipelineName: "p",
      versionHash: "a".repeat(64),
      parentHash: null,
      createdAt: 1,
      ir: diamondIR() as PipelineIR,
      prompts: diamondPrompts(),
      now: 2,
    });
  }

  it("accepts a valid envelope", () => {
    const r = parseEnvelope(valid());
    expect(r.ok).toBe(true);
  });

  it("accepts empty prompts object", () => {
    const v = valid() as Record<string, unknown>;
    v.prompts = {};
    const r = parseEnvelope(v);
    expect(r.ok).toBe(true);
  });

  it("rejects unknown top-level fields (strict schema)", () => {
    const v = valid() as Record<string, unknown>;
    v.extra = "junk";
    const r = parseEnvelope(v);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics[0]!.code).toBe("INVALID_ENVELOPE");
    }
  });

  it("rejects wrong format literal with UNSUPPORTED_FORMAT", () => {
    const v = valid() as Record<string, unknown>;
    v.format = "wfctl-pipeline-export/v2";
    const r = parseEnvelope(v);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics[0]!.code).toBe("UNSUPPORTED_FORMAT");
    }
  });

  it("rejects non-string prompt values", () => {
    const v = valid() as Record<string, unknown>;
    v.prompts = { p1: 42 };
    const r = parseEnvelope(v);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics[0]!.code).toBe("INVALID_ENVELOPE");
    }
  });

  it("rejects non-object root", () => {
    const r = parseEnvelope("not an object");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics[0]!.code).toBe("INVALID_ENVELOPE");
    }
  });

  it("rejects missing source field", () => {
    const v = valid() as Record<string, unknown>;
    delete v.source;
    const r = parseEnvelope(v);
    expect(r.ok).toBe(false);
  });
});
