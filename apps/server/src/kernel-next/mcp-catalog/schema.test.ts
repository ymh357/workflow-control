import { describe, it, expect } from "vitest";
import {
  CatalogEntrySchema,
  RecommendResultSchema,
  CATALOG_DIAGNOSTIC_CODES,
} from "./schema.js";

describe("CatalogEntrySchema", () => {
  const validEntry = {
    id: "etherscan",
    source: "builtin" as const,
    schemaVersion: "1" as const,
    name: "Etherscan",
    description: "Read Ethereum onchain data",
    useCases: ["verify tx hash on Ethereum"],
    tags: ["onchain-verification"],
    command: "npx",
    args: ["-y", "@scope/etherscan-mcp"],
    envKeys: [{
      name: "ETHERSCAN_API_KEY",
      required: true,
      description: "Etherscan API key",
      obtainUrl: "https://etherscan.io/apis",
      obtainSteps: "1. Register\n2. Generate key",
    }],
    healthCheckTimeoutMs: 10000,
  };

  it("parses a valid entry", () => {
    const parsed = CatalogEntrySchema.safeParse(validEntry);
    expect(parsed.success).toBe(true);
  });

  it("rejects entry with non-kebab id", () => {
    const bad = { ...validEntry, id: "Ether Scan!" };
    expect(CatalogEntrySchema.safeParse(bad).success).toBe(false);
  });

  it("rejects entry with empty useCases", () => {
    const bad = { ...validEntry, useCases: [] };
    expect(CatalogEntrySchema.safeParse(bad).success).toBe(false);
  });

  it("accepts entry without optional fields", () => {
    const minimal = { ...validEntry };
    delete (minimal as { homepage?: unknown }).homepage;
    delete (minimal as { packageName?: unknown }).packageName;
    delete (minimal as { toolsPreview?: unknown }).toolsPreview;
    delete (minimal as { deprecatedAt?: unknown }).deprecatedAt;
    expect(CatalogEntrySchema.safeParse(minimal).success).toBe(true);
  });

  it("source must be 'builtin' or 'custom'", () => {
    const bad = { ...validEntry, source: "marketplace" };
    expect(CatalogEntrySchema.safeParse(bad).success).toBe(false);
  });

  it("rejects id with trailing hyphen", () => {
    const bad = { ...validEntry, id: "etherscan-" };
    expect(CatalogEntrySchema.safeParse(bad).success).toBe(false);
  });

  it("rejects id with consecutive hyphens", () => {
    const bad = { ...validEntry, id: "ether--scan" };
    expect(CatalogEntrySchema.safeParse(bad).success).toBe(false);
  });

  it("accepts entry with empty envKeys array", () => {
    const noSecret = { ...validEntry, envKeys: [] };
    expect(CatalogEntrySchema.safeParse(noSecret).success).toBe(true);
  });
});

describe("RecommendResultSchema", () => {
  it("parses a result with evidence and llmReason", () => {
    const r = {
      id: "etherscan",
      score: 0.85,
      evidence: {
        matchedTags: ["onchain-verification"],
        matchedUseCases: ["verify tx hash"],
        matchedDescriptionTerms: [],
      },
      llmReason: "Used to verify smart contracts on Ethereum",
    };
    expect(RecommendResultSchema.safeParse(r).success).toBe(true);
  });

  it("score must be 0..1", () => {
    const r = {
      id: "x",
      score: 1.5,
      evidence: { matchedTags: [], matchedUseCases: [], matchedDescriptionTerms: [] },
    };
    expect(RecommendResultSchema.safeParse(r).success).toBe(false);
  });
});

describe("CATALOG_DIAGNOSTIC_CODES", () => {
  it("includes all diagnostic codes for the catalog subsystem", () => {
    expect(CATALOG_DIAGNOSTIC_CODES).toContain("CATALOG_ENTRY_NOT_FOUND");
    expect(CATALOG_DIAGNOSTIC_CODES).toContain("CATALOG_ENTRY_ID_CONFLICT");
    expect(CATALOG_DIAGNOSTIC_CODES).toContain("CATALOG_INVALID_ENTRY");
    expect(CATALOG_DIAGNOSTIC_CODES).toContain("CATALOG_BUILTIN_NOT_WRITABLE");
    expect(CATALOG_DIAGNOSTIC_CODES).toContain("CATALOG_LLM_OVERLAY_UNAVAILABLE");
    expect(CATALOG_DIAGNOSTIC_CODES.length).toBe(5);
  });
});
