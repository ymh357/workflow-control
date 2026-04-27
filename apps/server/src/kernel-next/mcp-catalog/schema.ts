import { z } from "zod";

const KEBAB_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const CatalogEntrySchema = z.object({
  id: z.string().min(1).max(64).regex(KEBAB_ID, "id must be kebab-case lowercase"),
  source: z.enum(["builtin", "custom"]),
  schemaVersion: z.literal("1"),

  name: z.string().min(1).max(128),
  description: z.string().min(1).max(1024),
  useCases: z.array(z.string().min(1)).min(1),
  tags: z.array(z.string().min(1)),
  homepage: z.string().url().optional(),

  command: z.string().min(1),
  args: z.array(z.string()),
  packageName: z.string().min(1).optional(),

  envKeys: z.array(z.object({
    name: z.string().min(1).max(128),
    required: z.boolean(),
    description: z.string(),
    obtainUrl: z.string().url().optional(),
    obtainSteps: z.string().optional(),
  })),

  healthCheckTimeoutMs: z.number().int().positive(),

  toolsPreview: z.array(z.object({
    name: z.string().min(1),
    brief: z.string().min(1),
  })).optional(),

  deprecatedAt: z.number().int().positive().optional(),
}).strict();

export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export const RecommendResultSchema = z.object({
  id: z.string().min(1),
  score: z.number().min(0).max(1),
  evidence: z.object({
    matchedTags: z.array(z.string()),
    matchedUseCases: z.array(z.string()),
    matchedDescriptionTerms: z.array(z.string()),
  }),
  llmReason: z.string().optional(),
}).strict();

export type RecommendResult = z.infer<typeof RecommendResultSchema>;

export const CATALOG_DIAGNOSTIC_CODES = [
  "CATALOG_ENTRY_NOT_FOUND",
  "CATALOG_ENTRY_ID_CONFLICT",
  "CATALOG_INVALID_ENTRY",
  "CATALOG_BUILTIN_NOT_WRITABLE",
] as const;

export type CatalogDiagnosticCode = (typeof CATALOG_DIAGNOSTIC_CODES)[number];
